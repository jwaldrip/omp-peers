import * as fs from "node:fs";
import * as path from "node:path";
import incomingPromptTemplate from "./prompts/incoming.md" with { type: "text" };
import {
  claimOldestMessage,
  ensureDir,
  markDelivered,
  reclaimDeadPidClaims,
  trace,
} from "./mailbox.js";
import type { DeliveryHost, PeerMessageEnvelope } from "./types.js";

export interface InFlightMessage {
  envelope: PeerMessageEnvelope;
  claimedPath: string;
  mode: "woke" | "steered" | "appended";
  submittedAt: number;
}

export interface PendingResubmitItem {
  envelope: PeerMessageEnvelope;
  claimedPath: string;
  mode: "woke" | "appended";
  lastSentAt?: number;
}

export function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderIncomingPrompt(msg: PeerMessageEnvelope): string {
  const sentIso = new Date(msg.sentAt).toISOString();
  const values: Record<string, string> = {
    name: escapeXmlAttr(msg.from.name),
    sessionId: escapeXmlAttr(msg.from.sessionId),
    cwd: escapeXmlAttr(msg.from.cwd),
    sentIso: escapeXmlAttr(sentIso),
    body: msg.body,
  };
  return incomingPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
}

export function isRunAborted(messages: readonly unknown[]): boolean {
  for (const m of messages) {
    if (m && typeof m === "object") {
      const msg = m as Record<string, unknown>;
      if (msg.role === "toolResult") {
        const details = msg.details as Record<string, unknown> | undefined;
        if (details?.source === "assistant_stop_aborted") {
          return true;
        }
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object") {
      const msg = m as Record<string, unknown>;
      if (msg.role === "assistant") {
        return msg.stopReason === "aborted" || msg.stopReason === "error";
      }
    }
  }

  return false;
}

export class DeliveryStateMachine {
  private readonly root: string;
  private readonly sessionId: string;
  private readonly pid: number;
  private readonly host: DeliveryHost;

  private inFlight = new Map<string, InFlightMessage>();
  private pendingResubmit = new Map<string, PendingResubmitItem>();

  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | undefined;
  private isProcessing = false;
  private isStopped = false;

  constructor(root: string, sessionId: string, pid: number, host: DeliveryHost) {
    this.root = root;
    this.sessionId = sessionId;
    this.pid = pid;
    this.host = host;
  }

  public async start(): Promise<void> {
    const inboxDir = path.join(this.root, "inbox", this.sessionId);
    await ensureDir(inboxDir);

    try {
      await reclaimDeadPidClaims(this.root, this.sessionId);
    } catch {
      // Ignore recovery error on startup
    }

    try {
      this.watcher = fs.watch(inboxDir, () => {
        void this.processInbox();
      });
    } catch {
      // Watcher failed, rely on polling
    }

    this.pollTimer = setInterval(() => {
      void this.processInbox();
    }, 1000);
    this.pollTimer.unref();

    void this.processInbox();
  }

  public stop(): void {
    this.isStopped = true;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  public async processInbox(): Promise<void> {
    if (this.isProcessing || this.isStopped) {
      return;
    }
    this.isProcessing = true;

    try {
      // 1. Check acks against entries
      await this.checkAckAgainstEntries();

      // 2. Handle pending resubmissions once idle and no pending messages
      if (this.pendingResubmit.size > 0 && this.host.isIdle() && !this.host.hasPendingMessages()) {
        const now = Date.now();
        for (const [id, item] of Array.from(this.pendingResubmit.entries())) {
          // Check if already in entries
          if (this.isEntryInStore(id)) {
            this.pendingResubmit.delete(id);
            await markDelivered(this.root, item.envelope, item.claimedPath, item.mode);
            continue;
          }

          const payload = {
            customType: "peer-message",
            content: renderIncomingPrompt(item.envelope),
            display: true,
            details: {
              peerMessageId: item.envelope.id,
              from: {
                sessionId: item.envelope.from.sessionId,
                name: item.envelope.from.name,
                cwd: item.envelope.from.cwd,
              },
              summary: item.envelope.summary,
              body: item.envelope.body,
              sentAt: item.envelope.sentAt,
            },
            attribution: "agent" as const,
          };

          if (item.mode === "appended") {
            // Do not re-send the same message within 10s (sendMessage is async in omp)
            if (item.lastSentAt && now - item.lastSentAt < 10000) {
              continue;
            }
            item.lastSentAt = now;
            this.host.sendMessage(payload, { triggerTurn: false });

            // If immediately visible in store, ack right away
            if (this.isEntryInStore(id)) {
              this.pendingResubmit.delete(id);
              await markDelivered(this.root, item.envelope, item.claimedPath, "appended");
            }
          } else {
            // mode: woke
            this.pendingResubmit.delete(id);
            this.inFlight.set(id, {
              envelope: item.envelope,
              claimedPath: item.claimedPath,
              mode: "woke",
              submittedAt: Date.now(),
            });
            this.host.sendMessage(payload, { triggerTurn: true });
            // After one woke submission, stop in this pass
            return;
          }
        }
      }

      // 3. Process incoming messages from disk
      await reclaimDeadPidClaims(this.root, this.sessionId);

      while (!this.isStopped) {
        const claimed = await claimOldestMessage(this.root, this.sessionId, this.pid);
        if (!claimed) {
          break;
        }

        const isIdle = this.host.isIdle();
        const mode: "woke" | "steered" = isIdle ? "woke" : "steered";

        const payload = {
          customType: "peer-message",
          content: renderIncomingPrompt(claimed.message),
          display: true,
          details: {
            peerMessageId: claimed.message.id,
            from: {
              sessionId: claimed.message.from.sessionId,
              name: claimed.message.from.name,
              cwd: claimed.message.from.cwd,
            },
            summary: claimed.message.summary,
            body: claimed.message.body,
            sentAt: claimed.message.sentAt,
          },
          attribution: "agent" as const,
        };

        const sendOptions = isIdle
          ? { triggerTurn: true }
          : { triggerTurn: true, deliverAs: "steer" as const };

        this.inFlight.set(claimed.message.id, {
          envelope: claimed.message,
          claimedPath: claimed.claimedPath,
          mode,
          submittedAt: Date.now(),
        });

        trace(this.root, "submitting_message", {
          messageId: claimed.message.id,
          sessionId: this.sessionId,
          mode,
          isIdle,
        });

        this.host.sendMessage(payload, sendOptions);

        await this.checkAckAgainstEntries();

        if (mode === "woke") {
          // After one woke submission, stop claiming in this pass so the recipient
          // transitions to streaming and subsequent messages are steered
          break;
        }
      }
    } catch {
      // Ignore inbox processing error
    } finally {
      this.isProcessing = false;
    }
  }

  private isEntryInStore(id: string): boolean {
    let entries: readonly unknown[] = [];
    try {
      entries = this.host.getEntries();
    } catch {
      return false;
    }
    return entries.some((e: unknown) => {
      if (!e || typeof e !== "object") return false;
      const rec = e as Record<string, unknown>;
      const isCustomMessage =
        rec.customType === "peer-message" ||
        rec.type === "custom_message" ||
        rec.type === "custom";
      if (!isCustomMessage) return false;
      const details = rec.details as Record<string, unknown> | undefined;
      return details?.peerMessageId === id;
    });
  }

  public async checkAckAgainstEntries(): Promise<void> {
    if (this.inFlight.size === 0 && this.pendingResubmit.size === 0) return;

    for (const [id] of Array.from(this.inFlight.entries())) {
      if (this.isEntryInStore(id)) {
        await this.ackMessage(id);
      }
    }

    for (const [id, item] of Array.from(this.pendingResubmit.entries())) {
      if (this.isEntryInStore(id)) {
        this.pendingResubmit.delete(id);
        await markDelivered(this.root, item.envelope, item.claimedPath, item.mode);
      }
    }
  }

  public async onMessageEnd(event: {
    customType?: string;
    details?: Record<string, unknown>;
    message?: { customType?: string; details?: Record<string, unknown> };
  }): Promise<void> {
    const isPeerMessage =
      event.customType === "peer-message" ||
      event.message?.customType === "peer-message";

    if (!isPeerMessage) return;

    const peerId =
      event.details?.peerMessageId ||
      event.message?.details?.peerMessageId;

    if (typeof peerId === "string") {
      await this.ackMessage(peerId);
    }
  }

  public async onAgentEnd(messages: readonly unknown[]): Promise<{ isAborted: boolean }> {
    await this.checkAckAgainstEntries();

    const isAborted = isRunAborted(messages);

    // Any message still in inFlight at agent_end was not recorded during the run
    for (const [id, item] of Array.from(this.inFlight.entries())) {
      if (this.isEntryInStore(id)) {
        await this.ackMessage(id);
        continue;
      }

      this.inFlight.delete(id);
      this.pendingResubmit.set(id, {
        envelope: item.envelope,
        claimedPath: item.claimedPath,
        mode: isAborted ? "appended" : "woke",
      });
    }

    return { isAborted };
  }

  public async ackMessage(
    peerId: string,
    forcedMode?: "woke" | "steered" | "appended"
  ): Promise<void> {
    const item = this.inFlight.get(peerId);
    if (!item) return;

    this.inFlight.delete(peerId);
    const mode = forcedMode ?? item.mode;

    try {
      await markDelivered(this.root, item.envelope, item.claimedPath, mode);
    } catch {
      // Ignore markDelivered error
    }
  }

  public getInFlightCount(): number {
    return this.inFlight.size + this.pendingResubmit.size;
  }
}
