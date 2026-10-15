import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  claimOldestMessage,
  ensureDir,
  markDelivered,
  pruneMailbox,
  reclaimDeadPidClaims,
  waitForReceipt,
  writeAtomicFile,
  writeMessage,
} from "../src/mailbox.js";
import type { PeerMessageEnvelope } from "../src/types.js";

function createTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("mailbox storage and concurrency", () => {
  it("concurrent claim has exactly one winner", async () => {
    const root = createTempDir("omp-peers-test-claim");
    const sessionId = "session-target-12345678";
    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-single-winner",
      from: {
        sessionId: "session-sender",
        name: "Sender",
        cwd: "/tmp",
      },
      to: sessionId,
      body: "Test payload",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);

    // 10 concurrent processes trying to claim the same message
    const claimPromises = Array.from({ length: 10 }, (_, i) => {
      const simulatedPid = 20000 + i;
      return claimOldestMessage(root, sessionId, simulatedPid);
    });

    const results = await Promise.all(claimPromises);
    const winners = results.filter((r) => r !== null);

    expect(winners.length).toBe(1);
    expect(winners[0]?.message.id).toBe("msg-single-winner");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("claims under a dead pid return to the inbox", async () => {
    const root = createTempDir("omp-peers-test-dead-pid");
    const sessionId = "session-target-reclaim";
    const deadPid = 99999999; // Highly unlikely to exist
    const inboxDir = path.join(root, "inbox", sessionId);
    const deadClaimDir = path.join(inboxDir, "claimed", String(deadPid));
    await ensureDir(deadClaimDir);

    const filename = "1000-dead-msg.json";
    const deadMsgPath = path.join(deadClaimDir, filename);
    const envelope: PeerMessageEnvelope = {
      v: 1,
      id: "dead-msg-1",
      from: { sessionId: "s-1", name: "S1", cwd: "/tmp" },
      to: sessionId,
      body: "stranded",
      sentAt: 1000,
    };
    await writeAtomicFile(deadMsgPath, JSON.stringify(envelope));

    const reclaimed = await reclaimDeadPidClaims(root, sessionId);
    expect(reclaimed).toBe(1);

    const restoredPath = path.join(inboxDir, filename);
    expect(fs.existsSync(restoredPath)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("send to an offline session is durable and claimed by later registration", async () => {
    const root = createTempDir("omp-peers-test-offline-send");
    const offlineSessionId = "offline-target-session-id";
    const envelope: PeerMessageEnvelope = {
      v: 1,
      id: "offline-msg-42",
      from: { sessionId: "sender-session", name: "Sender", cwd: "/tmp" },
      to: offlineSessionId,
      body: "Offline delivery test",
      sentAt: Date.now(),
    };

    // Sender writes message to offline session inbox
    await writeMessage(root, envelope);

    // Verify inbox file exists on disk
    const inboxDir = path.join(root, "inbox", offlineSessionId);
    const files = await fs.promises.readdir(inboxDir);
    expect(files.some((f) => f.includes("offline-msg-42"))).toBe(true);

    // Later, session wakes up and claims the message
    const myPid = process.pid;
    const claimed = await claimOldestMessage(root, offlineSessionId, myPid);
    expect(claimed).not.toBeNull();
    expect(claimed?.message.id).toBe("offline-msg-42");
    expect(claimed?.message.body).toBe("Offline delivery test");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("waitForReceipt observes delivery receipts", async () => {
    const root = createTempDir("omp-peers-test-receipt");
    const fromSessionId = "sender-session-id";
    const toSessionId = "recipient-session-id";
    const messageId = "msg-receipt-test";

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: messageId,
      from: { sessionId: fromSessionId, name: "Sender", cwd: "/tmp" },
      to: toSessionId,
      body: "test receipt",
      sentAt: Date.now(),
    };

    const claimedPath = path.join(root, "inbox", toSessionId, "claimed", `${process.pid}`, "test.json");
    await writeAtomicFile(claimedPath, JSON.stringify(msg));

    const waitPromise = waitForReceipt(root, fromSessionId, messageId, 2000);

    // Write receipt directly without arbitrary setTimeout delay
    await markDelivered(root, msg, claimedPath, "woke");

    const receipt = await waitPromise;
    expect(receipt).not.toBeNull();
    expect(receipt?.id).toBe(messageId);
    expect(receipt?.mode).toBe("woke");
    expect(receipt?.status).toBe("delivered");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("pruneMailbox removes delivered files and receipts older than 7 days", async () => {
    const root = createTempDir("omp-peers-test-prune");
    const sessionId = "session-prune";
    const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;

    const deliveredDir = path.join(root, "delivered", sessionId);
    await ensureDir(deliveredDir);
    const oldDeliveredFile = path.join(deliveredDir, "old-delivered.json");
    await writeAtomicFile(oldDeliveredFile, "{}");
    fs.utimesSync(oldDeliveredFile, new Date(oldTimestamp), new Date(oldTimestamp));

    const receiptsDir = path.join(root, "receipts", sessionId);
    await ensureDir(receiptsDir);
    const oldReceiptFile = path.join(receiptsDir, "old-receipt.json");
    await writeAtomicFile(oldReceiptFile, "{}");
    fs.utimesSync(oldReceiptFile, new Date(oldTimestamp), new Date(oldTimestamp));

    await pruneMailbox(root);

    expect(fs.existsSync(oldDeliveredFile)).toBe(false);
    expect(fs.existsSync(oldReceiptFile)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
