import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ompPeersExtension from "../src/index.js";
import { DeliveryStateMachine } from "../src/delivery.js";
import { readReceipt, writeMessage } from "../src/mailbox.js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ClaimOwner, DeliveryHost, PeerMessageEnvelope, PeerPayloadDetails } from "../src/types.js";

type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;
interface LifecycleHarness { current: { sessionId: string }; handlers: Map<string, LifecycleHandler>; api: ExtensionAPI; context: ExtensionContext; sent: PeerPayloadDetails[]; }

function temp(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)); }
function envelope(id: string, to: string, sentAt = Date.now()): PeerMessageEnvelope { return { v: 1, id, from: { sessionId: "sender-session", name: "Sender", cwd: "/tmp/sender" }, to, body: `body:${id}`, sentAt }; }
function transcript(file: string, sessionId: string, messageId?: string): void {
  const entries: unknown[] = [{ type: "session", id: sessionId }];
  if (messageId) entries.push({ type: "custom_message", message: { customType: "peer-message", details: { peerMessageId: messageId, toSessionId: sessionId } } });
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

class Host implements DeliveryHost {
  idle = true; pending = false; entries: unknown[] = []; sent: Array<{ details: PeerPayloadDetails; options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } }> = []; sessionFile: string | undefined; sessionId: string;
  constructor(sessionId: string, sessionFile: string | undefined) { this.sessionId = sessionId; this.sessionFile = sessionFile; }
  isIdle(): boolean { return this.idle; }
  hasPendingMessages(): boolean { return this.pending; }
  getSessionId(): string { return this.sessionId; }
  getSessionFile(): string | undefined { return this.sessionFile; }
  getEntries(): readonly unknown[] { return this.entries; }
  sendMessage(message: { customType: string; content: string; display: boolean; details: PeerPayloadDetails; attribution: "agent" }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void { this.sent.push({ details: message.details, options }); }
}

function machine(root: string, sessionId: string, host: Host, instanceId = "recovery-instance"): DeliveryStateMachine {
  const claimOwner: ClaimOwner = { instanceId, pid: process.pid, generation: 1 };
  return new DeliveryStateMachine(root, sessionId, claimOwner, host, () => host.getSessionId() === sessionId);
}

async function eventually(root: string, assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 300; attempt++) {
    try { assertion(); return; } catch (error) { lastError = error; await fs.promises.readdir(root); }
  }
  throw lastError;
}

function lifecycleHarness(initialSessionId: string, root: string): LifecycleHarness {
  const current = { sessionId: initialSessionId };
  const handlers = new Map<string, LifecycleHandler>();
  const sent: PeerPayloadDetails[] = [];
  const files = new Map<string, string>();
  const api = {
    on(event: string, handler: LifecycleHandler): void { handlers.set(event, handler); }, getSessionName(): string { return "recovery test"; }, getActiveTools(): string[] { return []; }, setActiveTools(): Promise<void> { return Promise.resolve(); }, sendMessage(message: { details: PeerPayloadDetails }): void { sent.push(message.details); }, registerMessageRenderer(): void {}, registerTool(): void {}, registerCommand(): void {},
    typebox: { Type: { Object: (): object => ({}), Optional: (): object => ({}), Boolean: (): object => ({}), String: (): object => ({}) } },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: path.join(root, "cwd"), isIdle: (): boolean => true, hasPendingMessages: (): boolean => false,
    sessionManager: {
      getSessionId: (): string => current.sessionId,
      getSessionFile: (): string => { const existing = files.get(current.sessionId); if (existing) return existing; const created = path.join(root, `${current.sessionId}.jsonl`); transcript(created, current.sessionId); files.set(current.sessionId, created); return created; },
      getEntries: (): unknown[] => [],
    },
  } as unknown as ExtensionContext;
  return { current, handlers, api, context, sent };
}

async function invoke(harness: LifecycleHarness, event: string): Promise<void> { const handler = harness.handlers.get(event); if (!handler) throw new Error(`Missing ${event} lifecycle handler`); await handler({}, harness.context); }

describe("recovery contracts", () => {
  it("releases an unacknowledged same-PID claim on switch and redelivers only after returning to its original session", async () => {
    const root = temp("omp-peers-lifecycle-switch"); const oldRoot = process.env.OMP_PEERS_DIR; process.env.OMP_PEERS_DIR = root;
    try {
      const harness = lifecycleHarness("session-original", root); ompPeersExtension(harness.api); await invoke(harness, "session_start");
      await writeMessage(root, envelope("switch-back-message", "session-original"));
      await invoke(harness, "turn_end");
      await eventually(root, () => expect(harness.sent).toHaveLength(1));
      await invoke(harness, "session_before_switch"); harness.current.sessionId = "session-other"; await invoke(harness, "session_switch"); expect(harness.sent).toHaveLength(1);
      await invoke(harness, "session_before_switch"); harness.current.sessionId = "session-original"; await invoke(harness, "session_switch");
      await invoke(harness, "turn_end");
      await eventually(root, () => expect(harness.sent.length).toBeGreaterThan(1));
      expect(harness.sent.every((details) => details.toSessionId === "session-original")).toBe(true);
    } finally { process.env.OMP_PEERS_DIR = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("fences a suspended filesystem claim when the host session changes", async () => {
    const root = temp("omp-peers-suspended-fence"); const sessionId = "recipient-session"; const file = path.join(root, "recipient.jsonl"); transcript(file, sessionId); const host = new Host(sessionId, file); const delivery = machine(root, sessionId, host);
    try { await writeMessage(root, envelope("suspended-claim", sessionId)); const processing = delivery.processInbox(); host.sessionId = "replacement-session"; await processing; expect(host.sent).toHaveLength(0); } finally { delivery.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not receipt memory-only acceptance until exact custom_message persistence has the matching session header", async () => {
    const root = temp("omp-peers-acceptance-disk"); const sessionId = "recipient-session"; const file = path.join(root, "recipient.jsonl"); transcript(file, sessionId); const host = new Host(sessionId, file); const delivery = machine(root, sessionId, host);
    try {
      await writeMessage(root, envelope("memory-only", sessionId)); await delivery.processInbox();
      host.entries.push({ role: "custom", customType: "peer-message", details: { peerMessageId: "memory-only", toSessionId: sessionId } }); await delivery.processInbox(); expect(await readReceipt(root, "sender-session", "memory-only")).toBeNull();
      fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "other-session" })}\n${JSON.stringify({ type: "custom_message", message: { customType: "peer-message", details: { peerMessageId: "memory-only", toSessionId: sessionId } } })}\n`); await delivery.processInbox(); expect(await readReceipt(root, "sender-session", "memory-only")).toBeNull();
      transcript(file, sessionId, "memory-only"); await delivery.processInbox(); expect((await readReceipt(root, "sender-session", "memory-only"))?.status).toBe("delivered");
    } finally { delivery.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("acknowledges a restart from the exact disk-recorded id without reinjecting", async () => {
    const root = temp("omp-peers-restart-disk"); const sessionId = "recipient-session"; const file = path.join(root, "recipient.jsonl"); transcript(file, sessionId, "restart-exact-id"); const host = new Host(sessionId, file); const delivery = machine(root, sessionId, host);
    try { await writeMessage(root, envelope("restart-exact-id", sessionId)); await delivery.processInbox(); expect(host.sent).toHaveLength(0); expect((await readReceipt(root, "sender-session", "restart-exact-id"))?.status).toBe("delivered"); } finally { delivery.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("quarantines corrupt recovered traversal records and delivers the valid next envelope", async () => {
    const root = temp("omp-peers-corrupt-recovery"); const sessionId = "recipient-session"; const file = path.join(root, "recipient.jsonl"); transcript(file, sessionId); const host = new Host(sessionId, file); const delivery = machine(root, sessionId, host); const recoveredOwner: ClaimOwner = { instanceId: "recovered-owner", pid: process.pid, generation: 1 };
    try {
      const released = path.join(root, "inbox", sessionId, "released", "corrupt-owner"); fs.mkdirSync(released, { recursive: true }); fs.writeFileSync(path.join(released, "owner.json"), JSON.stringify(recoveredOwner)); fs.writeFileSync(path.join(released, "1-corrupt.json"), JSON.stringify({ v: 1, envelope: { ...envelope("../traversal", sessionId, 1), id: "../traversal" }, phase: "pending", owner: recoveredOwner, attempts: [], aborted: false }));
      await writeMessage(root, envelope("valid-after-corruption", sessionId, 2)); await delivery.processInbox(); expect(host.sent.map((message) => message.details.peerMessageId)).toEqual(["valid-after-corruption"]); expect(fs.readdirSync(path.join(root, "quarantine")).length).toBeGreaterThan(0);
    } finally { delivery.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("retries a receipt write after archive transition without a second send", async () => {
    const root = temp("omp-peers-receipt-retry"); const sessionId = "recipient-session"; const file = path.join(root, "recipient.jsonl"); transcript(file, sessionId); const host = new Host(sessionId, file); const delivery = machine(root, sessionId, host);
    try {
      await writeMessage(root, envelope("receipt-retry", sessionId)); await delivery.processInbox(); expect(host.sent).toHaveLength(1); fs.mkdirSync(path.join(root, "receipts"), { recursive: true }); fs.writeFileSync(path.join(root, "receipts", "sender-session"), "blocks receipt directory"); transcript(file, sessionId, "receipt-retry"); await delivery.processInbox(); expect(await readReceipt(root, "sender-session", "receipt-retry")).toBeNull(); expect(host.sent).toHaveLength(1);
      fs.rmSync(path.join(root, "receipts", "sender-session")); await delivery.processInbox(); expect((await readReceipt(root, "sender-session", "receipt-retry"))?.status).toBe("delivered"); expect(host.sent).toHaveLength(1);
    } finally { delivery.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("retries an uncertain attempt on its clock without agent_end, then never retries an accepted message while disk persistence is slow", async () => {
    const root = temp("omp-peers-clock-retry"); const sessionId = "recipient-session"; const file = path.join(root, "recipient.jsonl"); let now = 100_000; const realNow = Date.now; Date.now = (): number => now; const host = new Host(sessionId, file); const delivery = machine(root, sessionId, host);
    try {
      transcript(file, sessionId); await writeMessage(root, envelope("clock-retry", sessionId, now)); await delivery.processInbox(); expect(host.sent).toHaveLength(1); now += 249; await delivery.processInbox(); expect(host.sent).toHaveLength(1); now += 1; await delivery.processInbox(); expect(host.sent).toHaveLength(2);
      await delivery.onMessageEnd({ customType: "peer-message", details: { peerMessageId: "clock-retry", toSessionId: sessionId } }); now += 60_000; await delivery.processInbox(); expect(host.sent).toHaveLength(2); expect(await readReceipt(root, "sender-session", "clock-retry")).toBeNull();
    } finally { Date.now = realNow; delivery.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
