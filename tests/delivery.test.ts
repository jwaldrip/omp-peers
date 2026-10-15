import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DeliveryStateMachine, renderIncomingPrompt } from "../src/delivery.js";
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
  public autoRecordAppended = true;

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
    if (this.autoRecordAppended && options?.triggerTurn === false) {
      this.entries.push({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
        attribution: message.attribution,
        timestamp: Date.now(),
      });
    }
  }

  getEntries(): readonly unknown[] {
    return this.entries;
  }
}

describe("delivery state machine", () => {
  it("renders prompt with special regex replacement strings and nested template markers safely", () => {
    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-prompt-test",
      from: {
        sessionId: "01a13deb-test-session",
        name: "Sender with {{body}} and <evil>",
        cwd: "/Users/test/dir & paths",
      },
      to: "recipient-session",
      body: "Price is $100 & $&, ref is $1 and token is $$done",
      sentAt: 1700000000000,
    };

    const rendered = renderIncomingPrompt(msg);

    // Verify msg.body replacement patterns ($&, $1, $$) are treated literally
    expect(rendered).toContain("Price is $100 & $&, ref is $1 and token is $$done");

    // Verify name containing {{body}} was not recursively replaced with the body
    expect(rendered).toContain('from="Sender with {{body}} and &lt;evil&gt;"');

    // Verify XML attribute escaping for & and <
    expect(rendered).toContain('cwd="/Users/test/dir &amp; paths"');
  });

  it("delivers to idle host with mode woke and triggerTurn: true, stopping after 1 woke claim", async () => {
    const root = createTempDir("omp-peers-test-woke");
    const sessionId = "target-session-woke";
    const host = new MockDeliveryHost();
    host.idle = true;

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg1: PeerMessageEnvelope = {
      v: 1,
      id: "msg-woke-1",
      from: { sessionId: "sender-1", name: "Sender", cwd: "/tmp" },
      to: sessionId,
      body: "Wake up turn 1",
      sentAt: 1000,
    };
    const msg2: PeerMessageEnvelope = {
      v: 1,
      id: "msg-woke-2",
      from: { sessionId: "sender-1", name: "Sender", cwd: "/tmp" },
      to: sessionId,
      body: "Wake up turn 2",
      sentAt: 2000,
    };

    await writeMessage(root, msg1);
    await writeMessage(root, msg2);

    await sm.processInbox();

    expect(host.sentMessages.length).toBe(1);
    const sent = host.sentMessages[0];
    expect(sent.options?.triggerTurn).toBe(true);
    expect(sent.options?.deliverAs).toBeUndefined();
    expect(sent.message.details.peerMessageId).toBe("msg-woke-1");

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
    host.idle = false;

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

  it("handles abort: resubmission occurs when idle without pending messages (mode appended)", async () => {
    const root = createTempDir("omp-peers-test-abort");
    const sessionId = "target-session-abort";
    const host = new MockDeliveryHost();
    host.idle = false;

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

    expect(host.sentMessages.length).toBe(1);
    expect(host.sentMessages[0].options?.deliverAs).toBe("steer");

    await sm.onAgentEnd([
      { role: "user", content: "run tool" },
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", details: { source: "assistant_stop_aborted" } },
    ]);

    host.idle = true;
    host.pending = false;

    await sm.processInbox();

    expect(host.sentMessages.length).toBe(2);
    const resubmitted = host.sentMessages[1];
    expect(resubmitted.options?.triggerTurn).toBe(false);
    expect(resubmitted.message.details.peerMessageId).toBe("msg-abort-1");

    const receipt = await readReceipt(root, "sender-3", "msg-abort-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("delivered");
    expect(receipt?.mode).toBe("appended");

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not re-send appended message within 10s backoff window while awaiting store entry", async () => {
    const root = createTempDir("omp-peers-test-backoff");
    const sessionId = "target-session-backoff";
    const host = new MockDeliveryHost();
    host.idle = false;
    // Simulate omp where store entry is not written on the same synchronous tick
    host.autoRecordAppended = false;

    const sm = new DeliveryStateMachine(root, sessionId, process.pid, host);

    const msg: PeerMessageEnvelope = {
      v: 1,
      id: "msg-backoff-1",
      from: { sessionId: "sender-backoff", name: "Sender", cwd: "/tmp" },
      to: sessionId,
      body: "Async store test",
      sentAt: Date.now(),
    };

    await writeMessage(root, msg);
    await sm.processInbox();
    expect(host.sentMessages.length).toBe(1);

    await sm.onAgentEnd([
      { role: "assistant", stopReason: "aborted" },
    ]);

    host.idle = true;
    host.pending = false;

    // First idle pass: sends once with triggerTurn: false
    await sm.processInbox();
    expect(host.sentMessages.length).toBe(2);

    // Immediate second pass (e.g. next 1s poll tick): entry is still not in store,
    // but within 10s it should NOT re-send
    await sm.processInbox();
    expect(host.sentMessages.length).toBe(2);

    // Now entry appears in the store
    host.entries.push({
      type: "custom_message",
      customType: "peer-message",
      details: { peerMessageId: "msg-backoff-1" },
    });

    // Third pass: observes entry in store, acknowledges and removes from pendingResubmit
    await sm.processInbox();
    const receipt = await readReceipt(root, "sender-backoff", "msg-backoff-1");
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

    await sm.onAgentEnd([{ role: "assistant", stopReason: "aborted" }]);

    host.idle = true;
    host.pending = true;

    await sm.processInbox();

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

    host.entries.push({
      type: "custom_message",
      customType: "peer-message",
      details: { peerMessageId: "msg-entries-1" },
    });

    host.idle = true;
    await sm.checkAckAgainstEntries();

    const receipt = await readReceipt(root, "sender-5", "msg-entries-1");
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("delivered");
    expect(receipt?.mode).toBe("steered");

    sm.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
