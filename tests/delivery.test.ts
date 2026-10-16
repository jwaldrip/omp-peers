import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeliveryStateMachine, renderIncomingPrompt } from "../src/delivery.js";
import { readReceipt, writeMessage } from "../src/mailbox.js";
import type { ClaimOwner, DeliveryHost, PeerMessageEnvelope, PeerPayloadDetails } from "../src/types.js";

function temp(prefix: string): string {
  const directory = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function wait(milliseconds: number): Promise<void> {
  const deferred = Promise.withResolvers<void>();
  setTimeout(deferred.resolve, milliseconds);
  return deferred.promise;
}

function envelope(id: string, to: string): PeerMessageEnvelope {
  return { v: 1, id, from: { sessionId: "sender-session", name: "Sender", cwd: "/tmp" }, to, body: "body $& {{nested}}", sentAt: Date.now() };
}

class Host implements DeliveryHost {
  idle = true;
  pending = false;
  sessionFile: string;
  entries: unknown[] = [];
  sent: PeerPayloadDetails[] = [];
  #sessionId: string;

  constructor(sessionId: string, sessionFile: string) {
    this.#sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  isIdle(): boolean { return this.idle; }
  hasPendingMessages(): boolean { return this.pending; }
  getSessionId(): string { return this.#sessionId; }
  getSessionFile(): string { return this.sessionFile; }
  getEntries(): readonly unknown[] { return this.entries; }
  sendMessage(message: { details: PeerPayloadDetails }, _options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void {
    this.sent.push(message.details);
  }

  switchTo(sessionId: string): void { this.#sessionId = sessionId; }
}

function machine(root: string, sessionId: string, host: Host): DeliveryStateMachine {
  const owner: ClaimOwner = { instanceId: "delivery-instance", pid: process.pid, generation: 1 };
  return new DeliveryStateMachine(root, sessionId, owner, host, () => host.getSessionId() === sessionId);
}

function writeTranscript(file: string, sessionId: string, messageId?: string): void {
  const entries: unknown[] = [{ type: "session", id: sessionId }];
  if (messageId) entries.push({ type: "custom_message", id: `entry-${messageId}`, customType: "peer-message", details: { peerMessageId: messageId, toSessionId: sessionId } });
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("delivery recovery", () => {
  it("preserves template content safely", () => {
    expect(renderIncomingPrompt(envelope("template-message", "recipient-session"))).toContain("body $& {{nested}}");
  });

  it("retries an unobserved void submission without an agent_end and stops once memory accepts", async () => {
    const root = temp("omp-peers-retry");
    const sessionId = "recipient-session";
    const transcript = path.join(root, "recipient.jsonl");
    writeTranscript(transcript, sessionId);
    const host = new Host(sessionId, transcript);
    const delivery = machine(root, sessionId, host);
    await writeMessage(root, envelope("retry-message", sessionId));
    await delivery.start();
    await delivery.processInbox();
    expect(host.sent.length).toBe(1);
    await wait(300);
    await delivery.processInbox();
    expect(host.sent.length).toBeGreaterThan(1);
    host.entries.push({ role: "custom", customType: "peer-message", details: { peerMessageId: "retry-message", toSessionId: sessionId } });
    await delivery.processInbox();
    const acceptedCount = host.sent.length;
    await wait(300);
    await delivery.processInbox();
    expect(host.sent.length).toBe(acceptedCount);
    delivery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not report delivered until the matching entry is persisted on disk", async () => {
    const root = temp("omp-peers-confirm");
    const sessionId = "recipient-session";
    const transcript = path.join(root, "recipient.jsonl");
    writeTranscript(transcript, sessionId);
    const host = new Host(sessionId, transcript);
    const delivery = machine(root, sessionId, host);
    await writeMessage(root, envelope("confirm-message", sessionId));
    await delivery.start();
    await delivery.processInbox();
    host.entries.push({ role: "custom", customType: "peer-message", details: { peerMessageId: "confirm-message", toSessionId: sessionId } });
    await delivery.processInbox();
    expect(await readReceipt(root, "sender-session", "confirm-message")).toBeNull();
    writeTranscript(transcript, sessionId, "confirm-message");
    await delivery.processInbox();
    expect((await readReceipt(root, "sender-session", "confirm-message"))?.status).toBe("delivered");
    delivery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not reinject after a crash when disk already contains the exact message", async () => {
    const root = temp("omp-peers-crash");
    const sessionId = "recipient-session";
    const transcript = path.join(root, "recipient.jsonl");
    writeTranscript(transcript, sessionId, "crash-message");
    const host = new Host(sessionId, transcript);
    const delivery = machine(root, sessionId, host);
    await writeMessage(root, envelope("crash-message", sessionId));
    await delivery.start();
    await delivery.processInbox();
    expect(host.sent).toHaveLength(0);
    expect((await readReceipt(root, "sender-session", "crash-message"))?.status).toBe("delivered");
    delivery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not inject into a replacement session after an awaited claim", async () => {
    const root = temp("omp-peers-fence");
    const sessionId = "recipient-session";
    const transcript = path.join(root, "recipient.jsonl");
    writeTranscript(transcript, sessionId);
    const host = new Host(sessionId, transcript);
    const delivery = machine(root, sessionId, host);
    await writeMessage(root, envelope("fence-message", sessionId));
    host.switchTo("replacement-session");
    await delivery.start();
    await delivery.processInbox();
    expect(host.sent).toHaveLength(0);
    delivery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
