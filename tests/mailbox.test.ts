import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claimOldestMessage,
  markDelivered,
  readReceipt,
  reclaimReleasedClaims,
  retireOwnerSync,
  writeMessage,
} from "../src/mailbox.js";
import type { ClaimOwner, PeerMessageEnvelope } from "../src/types.js";

function temp(prefix: string): string {
  const directory = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function envelope(id: string, to: string): PeerMessageEnvelope {
  return { v: 1, id, from: { sessionId: "sender-session", name: "Sender", cwd: "/tmp" }, to, body: "payload", sentAt: Date.now() };
}

function owner(instanceId: string, generation = 0): ClaimOwner {
  return { instanceId, pid: process.pid, generation };
}

describe("durable mailbox", () => {
  it("uses delivery instance ownership instead of pid ownership", async () => {
    const root = temp("omp-peers-owners");
    const sessionId = "recipient-session";
    await writeMessage(root, envelope("message-owner", sessionId));
    const first = await claimOldestMessage(root, sessionId, owner("instance-one"));
    expect(first?.record.owner.instanceId).toBe("instance-one");
    retireOwnerSync(root, sessionId, owner("instance-one"));
    expect(await reclaimReleasedClaims(root, sessionId)).toBe(1);
    const second = await claimOldestMessage(root, sessionId, owner("instance-two", 1));
    expect(second?.record.owner.instanceId).toBe("instance-two");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips corrupt oldest records and claims the next valid envelope", async () => {
    const root = temp("omp-peers-corrupt");
    const sessionId = "recipient-session";
    const inbox = path.join(root, "inbox", sessionId);
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "1-bad.json"), "not json");
    await writeMessage(root, { ...envelope("valid-message", sessionId), sentAt: 2 });
    const claimed = await claimOldestMessage(root, sessionId, owner("instance-valid"));
    expect(claimed?.record.envelope.id).toBe("valid-message");
    expect(fs.readdirSync(path.join(root, "quarantine")).length).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects traversal identifiers without writing outside the mailbox", async () => {
    const root = temp("omp-peers-traversal");
    await expect(writeMessage(root, envelope("../escape", "recipient-session"))).rejects.toThrow("Invalid peer message envelope");
    expect(fs.existsSync(path.join(path.dirname(root), "escape.json"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("retries the receipt transition after archive moved first", async () => {
    const root = temp("omp-peers-receipt");
    const sessionId = "recipient-session";
    const claimed = await (async () => {
      await writeMessage(root, envelope("message-receipt", sessionId));
      return claimOldestMessage(root, sessionId, owner("instance-receipt"));
    })();
    if (!claimed) throw new Error("expected claimed envelope");
    const archive = path.join(root, "delivered", sessionId, `${claimed.record.envelope.sentAt}-${claimed.record.envelope.id}.json`);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.renameSync(claimed.claimedPath, archive);
    await markDelivered(root, claimed.record, claimed.claimedPath, "woke");
    expect((await readReceipt(root, "sender-session", "message-receipt"))?.status).toBe("delivered");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
