import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import incomingPromptTemplate from "./prompts/incoming.md" with { type: "text" };
import {
  claimOldestMessage,
  ensureDir,
  markDelivered,
  reclaimDeadPidClaims,
  reclaimReleasedClaims,
  retireOwnerSync,
  trace,
  writeClaimRecord,
} from "./mailbox.js";
import { findPersistedPeerMessage } from "./transcript.js";
import type {
  ClaimedMessageRecord,
  ClaimOwner,
  DeliveryHost,
  DeliveryMode,
  PeerMessageEnvelope,
} from "./types.js";

const RETRY_DELAYS = [250, 500, 1000, 2000, 5000] as const;

interface TrackedMessage {
  record: ClaimedMessageRecord;
  claimedPath: string;
}

export function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderIncomingPrompt(message: PeerMessageEnvelope): string {
  const values: Record<string, string> = {
    name: escapeXmlAttr(message.from.name),
    sessionId: escapeXmlAttr(message.from.sessionId),
    cwd: escapeXmlAttr(message.from.cwd),
    sentIso: new Date(message.sentAt).toISOString(),
    body: message.body,
  };
  return incomingPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
}

export function isRunAborted(messages: readonly unknown[]): boolean {
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    const details = message.details;
    if (message.role === "toolResult" && details && typeof details === "object" &&
      (details as Record<string, unknown>).source === "assistant_stop_aborted") return true;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const value = messages[index];
    if (value && typeof value === "object") {
      const message = value as Record<string, unknown>;
      if (message.role === "assistant") return message.stopReason === "aborted" || message.stopReason === "error";
    }
  }
  return false;
}

export class DeliveryStateMachine {
  #root: string;
  #sessionId: string;
  #owner: ClaimOwner;
  #host: DeliveryHost;
  #isActive: () => boolean;
  #tracked = new Map<string, TrackedMessage>();
  #watcher: fs.FSWatcher | null = null;
  #pollTimer: NodeJS.Timeout | undefined;
  #processing = false;
  #stopped = false;

  constructor(root: string, sessionId: string, owner: ClaimOwner, host: DeliveryHost, isActive: () => boolean) {
    this.#root = root;
    this.#sessionId = sessionId;
    this.#owner = owner;
    this.#host = host;
    this.#isActive = isActive;
  }

  async start(): Promise<void> {
    if (!this.#canDeliver()) return;
    this.#pollTimer = setInterval(() => { void this.processInbox(); }, 500);
    this.#pollTimer.unref();
    const inbox = path.join(this.#root, "inbox", this.#sessionId);
    try {
      await ensureDir(inbox);
      if (!this.#canDeliver()) return;
      await reclaimReleasedClaims(this.#root, this.#sessionId);
      if (!this.#canDeliver()) return;
      await reclaimDeadPidClaims(this.#root, this.#sessionId);
      if (!this.#canDeliver()) return;
    } catch (error) {
      trace(this.#root, "recovery_unavailable", { sessionId: this.#sessionId, error: String(error) });
      return;
    }
    try {
      this.#watcher = fs.watch(inbox, () => { void this.processInbox(); });
    } catch (error) {
      trace(this.#root, "watch_unavailable", { sessionId: this.#sessionId, error: String(error) });
    }
    await this.processInbox();
  }

  stop(): void {
    this.#stopped = true;
    try { this.#watcher?.close(); } catch {}
    this.#watcher = null;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    try { retireOwnerSync(this.#root, this.#sessionId, this.#owner); } catch (error) {
      trace(this.#root, "retirement_unavailable", { sessionId: this.#sessionId, error: String(error) });
    }
  }

  async processInbox(): Promise<void> {
    if (this.#processing || !this.#canDeliver()) return;
    this.#processing = true;
    try {
      await this.#reconcileTracked();
      if (!this.#canDeliver()) return;
      await reclaimReleasedClaims(this.#root, this.#sessionId);
      if (!this.#canDeliver()) return;
      await reclaimDeadPidClaims(this.#root, this.#sessionId);
      if (!this.#canDeliver()) return;
      while (this.#canDeliver()) {
        const claimed = await claimOldestMessage(this.#root, this.#sessionId, this.#owner, () => this.#canDeliver());
        if (!this.#canDeliver() || !claimed) break;
        const tracked = { record: claimed.record, claimedPath: claimed.claimedPath };
        this.#tracked.set(claimed.record.envelope.id, tracked);
        await this.#reconcileOne(tracked);
        if (!this.#canDeliver()) break;
        if (!this.#tracked.has(claimed.record.envelope.id)) continue;
        if (tracked.record.phase === "pending" && !tracked.record.aborted) {
          await this.#submit(tracked, this.#host.isIdle() ? "woke" : "steered");
        }
        if (!this.#canDeliver() || this.#host.isIdle()) break;
      }
    } catch (error) {
      trace(this.#root, "process_failed", { sessionId: this.#sessionId, error: String(error) });
    } finally {
      this.#processing = false;
    }
  }

  async onMessageEnd(event: {
    customType?: string;
    details?: Record<string, unknown>;
    message?: { customType?: string; details?: Record<string, unknown> };
  }): Promise<void> {
    const details = event.details ?? event.message?.details;
    const type = event.customType ?? event.message?.customType;
    if (type !== "peer-message" || details?.toSessionId !== this.#sessionId || typeof details.peerMessageId !== "string") return;
    const tracked = this.#tracked.get(details.peerMessageId);
    if (tracked) await this.#markAccepted(tracked);
  }

  async onAgentEnd(messages: readonly unknown[]): Promise<{ isAborted: boolean }> {
    const aborted = isRunAborted(messages);
    if (aborted) {
      for (const tracked of this.#tracked.values()) {
        if (tracked.record.phase !== "submitted") continue;
        tracked.record.aborted = true;
        try { await writeClaimRecord(tracked.claimedPath, tracked.record); } catch (error) {
          trace(this.#root, "abort_state_unavailable", { messageId: tracked.record.envelope.id, error: String(error) });
        }
      }
    }
    await this.#reconcileTracked();
    return { isAborted: aborted };
  }

  getInFlightCount(): number {
    return this.#tracked.size;
  }

  #canDeliver(): boolean {
    return !this.#stopped && this.#isActive() && this.#host.getSessionId() === this.#sessionId;
  }

  #isMemoryAccepted(id: string): boolean {
    try {
      return this.#host.getEntries().some((value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as Record<string, unknown>;
        const message = entry.message && typeof entry.message === "object"
          ? entry.message as Record<string, unknown>
          : entry;
        if ((message.role !== "custom" && message.type !== "custom_message") || message.customType !== "peer-message") return false;
        const details = message.details;
        return !!details && typeof details === "object" &&
          (details as Record<string, unknown>).peerMessageId === id &&
          (details as Record<string, unknown>).toSessionId === this.#sessionId;
      });
    } catch (error) {
      trace(this.#root, "entries_unavailable", { sessionId: this.#sessionId, error: String(error) });
      return false;
    }
  }

  async #reconcileTracked(): Promise<void> {
    for (const tracked of [...this.#tracked.values()]) await this.#reconcileOne(tracked);
  }

  async #reconcileOne(tracked: TrackedMessage): Promise<void> {
    if (!this.#canDeliver()) return;
    const { envelope } = tracked.record;
    const disk = await findPersistedPeerMessage(this.#host.getSessionFile(), this.#sessionId, envelope.id);
    if (!this.#canDeliver()) return;
    if (disk === "present") {
      try {
        await markDelivered(this.#root, tracked.record, tracked.claimedPath, this.#lastMode(tracked));
        this.#tracked.delete(envelope.id);
      } catch (error) {
        trace(this.#root, "confirmation_unavailable", { messageId: envelope.id, error: String(error) });
      }
      return;
    }
    if (tracked.record.phase !== "accepted" && this.#isMemoryAccepted(envelope.id)) await this.#markAccepted(tracked);
    if (!this.#canDeliver() || tracked.record.phase === "accepted") return;
    const attempt = tracked.record.attempts.at(-1);
    if (!attempt || Date.now() >= attempt.retryAfter) {
      if (this.#host.isIdle() && !this.#host.hasPendingMessages()) {
        await this.#submit(tracked, tracked.record.aborted ? "appended" : "woke");
      }
    }
  }

  async #markAccepted(tracked: TrackedMessage): Promise<void> {
    if (!this.#canDeliver() || tracked.record.phase === "accepted") return;
    tracked.record.phase = "accepted";
    try {
      await writeClaimRecord(tracked.claimedPath, tracked.record);
    } catch (error) {
      trace(this.#root, "acceptance_unavailable", { messageId: tracked.record.envelope.id, error: String(error) });
    }
  }

  async #submit(tracked: TrackedMessage, mode: DeliveryMode): Promise<void> {
    if (!this.#canDeliver()) return;
    const attemptNumber = tracked.record.attempts.length;
    const delay = RETRY_DELAYS[Math.min(attemptNumber, RETRY_DELAYS.length - 1)];
    tracked.record.phase = "submitted";
    tracked.record.attempts.push({ id: randomUUID(), mode, submittedAt: Date.now(), retryAfter: Date.now() + delay });
    if (tracked.record.attempts.length > 32) tracked.record.attempts.shift();
    try {
      await writeClaimRecord(tracked.claimedPath, tracked.record);
    } catch (error) {
      trace(this.#root, "attempt_unavailable", { messageId: tracked.record.envelope.id, error: String(error) });
      return;
    }
    if (!this.#canDeliver()) return;
    const payload = {
      customType: "peer-message",
      content: renderIncomingPrompt(tracked.record.envelope),
      display: true,
      details: {
        peerMessageId: tracked.record.envelope.id,
        toSessionId: this.#sessionId,
        from: tracked.record.envelope.from,
        summary: tracked.record.envelope.summary,
        body: tracked.record.envelope.body,
        sentAt: tracked.record.envelope.sentAt,
      },
      attribution: "agent" as const,
    };
    try {
      this.#host.sendMessage(payload, mode === "steered"
        ? { triggerTurn: true, deliverAs: "steer" }
        : { triggerTurn: mode === "woke" });
      trace(this.#root, "message_submitted", { messageId: tracked.record.envelope.id, mode, attempt: attemptNumber + 1 });
    } catch (error) {
      trace(this.#root, "submission_rejected", { messageId: tracked.record.envelope.id, mode, error: String(error) });
    }
    if (this.#canDeliver() && this.#isMemoryAccepted(tracked.record.envelope.id)) await this.#markAccepted(tracked);
  }

  #lastMode(tracked: TrackedMessage): DeliveryMode {
    return tracked.record.attempts.at(-1)?.mode ?? "woke";
  }
}
