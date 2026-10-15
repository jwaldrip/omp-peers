import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DeliveryStateMachine } from "../src/delivery.js";
import { readReceipt, writeMessage } from "../src/mailbox.js";
import type { DeliveryHost, PeerMessageEnvelope } from "../src/types.js";

function createTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

class MockDeliveryHost implements DeliveryHost {
  public idle = true;
  public pending = false;
  public sentMessages: Array<{
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: {
        peerMessageId: string;
        from: { sessionId: string; name: string; cwd: string };
        summary?: string;
        body: string;
        sentAt: number;
      };
      attribution: "agent";
    };
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
  }> = [];
  public entries: Array<Record<string, unknown>> = [];

  isIdle(): boolean {
    return this.idle;
  }

  hasPendingMessages(): boolean {
    return this.pending;
  }

  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: {
        peerMessageId: string;
        from: { sessionId: string; name: string; cwd: string };
        summary?: string;
        body: string;
        sentAt: number;
      };
      attribution: "agent";
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): void {
    this.sentMessages.push({ message, options });
  }

  getEntries(): readonly unknown[] {
    return this.entries;
  }
}

describe("delivery state machine", () => {
  it("delivers to idle host with mode woke and triggerTurn: true", async () => {
    const root = createTempDir("omp-peers-test-woke");
    const sessionId = "target-session-woke";
    const host = new MockDeliveryHost();
    host.idle = true;

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-woke-1",
      from: { sessionId: "sender-1", name: "Sender", cwd: "/tmp" },
      to: sessionId,
      body: "Wake up turn",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);
    await sm.processInbox();

    expect(host.sentMessages.length).toBe(1);
    const sent = host.sentMessages[0];
    expect(sent.options?.triggerTurn).toBe(true);
    expect(sent.options?.deliverAs).toBeUndefined();
    expect(sent.message.customType).toBe("peer-message");
    expect(sent.message.details.peerMessageId).toBe("msg-woke-1");

    // Simulate message_end event from the session
    await sm.onMessageEnd({
      customType: "peer-message",
      details: { peerMessageId: "msg-woke-1" },
    });

    const receipt = await readReceipt(root, "sender-1", "msg-woke-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("delivered");
    expect(receipt?.mode).toBe("woke");

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers to streaming host with mode steered and deliverAs: steer", async () => {
    const root = createTempDir("omp-peers-test-steered");
    const sessionId = "target-session-steered";
    const host = new MockDeliveryHost();
    host.idle = false; // streaming

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-steer-1",
      from: { sessionId: "sender-2", name: "Sender2", cwd: "/tmp" },
      to: sessionId,
      body: "Steer into turn",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);
    await sm.processInbox();

    expect(host.sentMessages.length).toBe(1);
    const sent = host.sentMessages[0];
    expect(sent.options?.triggerTurn).toBe(true);
    expect(sent.options?.deliverAs).toBe("steer");

    // Simulate message_end event from the session
    await sm.onMessageEnd({
      customType: "peer-message",
      details: { peerMessageId: "msg-steer-1" },
    });

    const receipt = await readReceipt(root, "sender-2", "msg-steer-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.mode).toBe("steered");

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("handles abort: re-submits unacked message with NO triggerTurn (mode appended)", async () => {
    const root = createTempDir("omp-peers-test-abort");
    const sessionId = "target-session-abort";
    const host = new MockDeliveryHost();
    host.idle = false; // streaming when message arrives

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-abort-1",
      from: { sessionId: "sender-3", name: "Sender3", cwd: "/tmp" },
      to: sessionId,
      body: "Abort recovery test",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);
    await sm.processInbox();

    // 1st send: steered into the stream
    expect(host.sentMessages.length).toBe(1);
    expect(host.sentMessages[0].options?.deliverAs).toBe("steer");

    // Stream gets aborted: agent_end fires with stopReason: "aborted"
    host.idle = true;
    host.pending = false;

    await sm.onAgentEnd([
      { role: "assistant", stopReason: "aborted" },
    ]);

    // Should have re-submitted with triggerTurn: false
    expect(host.sentMessages.length).toBe(2);
    const resubmitted = host.sentMessages[1];
    expect(resubmitted.options?.triggerTurn).toBe(false);
    expect(resubmitted.message.details.peerMessageId).toBe("msg-abort-1");

    // Receipt should be marked mode "appended"
    const receipt = await readReceipt(root, "sender-3", "msg-abort-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("delivered");
    expect(receipt?.mode).toBe("appended");

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not re-submit while hasPendingMessages() is true", async () => {
    const root = createTempDir("omp-peers-test-pending");
    const sessionId = "target-session-pending";
    const host = new MockDeliveryHost();
    host.idle = false;

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-pending-1",
      from: { sessionId: "sender-4", name: "Sender4", cwd: "/tmp" },
      to: sessionId,
      body: "Pending messages test",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);
    await sm.processInbox();
    expect(host.sentMessages.length).toBe(1);

    // Host has queued next-turn messages waiting
    host.idle = true;
    host.pending = true;

    await sm.onAgentEnd([{ role: "assistant", stopReason: "aborted" }]);

    // Should NOT have re-submitted yet
    expect(host.sentMessages.length).toBe(1);

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("acks via getEntries() if message is present in session entries", async () => {
    const root = createTempDir("omp-peers-test-entries");
    const sessionId = "target-session-entries";
    const host = new MockDeliveryHost();
    host.idle = false;

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-entries-1",
      from: { sessionId: "sender-5", name: "Sender5", cwd: "/tmp" },
      to: sessionId,
      body: "Ack via entries test",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);
    await sm.processInbox();

    // Populate entries as if the session manager recorded it
    host.entries.push({
      type: "custom_message",
      customType: "peer-message",
      details: { peerMessageId: "msg-entries-1" },
    });

    host.idle = true;
    await sm.onAgentEnd([{ role: "assistant", stopReason: "stop" }]);

    const receipt = await readReceipt(root, "sender-5", "msg-entries-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("delivered");
    expect(receipt?.mode).toBe("steered");

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
