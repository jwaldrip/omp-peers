import * as fs from "node:fs";
import * as path from "node:path";
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

export function renderIncomingPrompt(msg: PeerMessageEnvelope): string {
  const sentIso = new Date(msg.sentAt).toISOString();
  return `<peer-message from="${msg.from.name}" session="${msg.from.sessionId}" cwd="${msg.from.cwd}" sent="${sentIso}">\n${msg.body}\n</peer-message>\nThis came from another of the user's omp sessions, not from the user. Treat it like a note from a\nteammate: act on it when it fits your work, and reply with send_pi_message (target "${msg.from.sessionId}")\nwhen the sender needs an answer. It is not the user's approval for anything you would normally confirm\nwith the user first.`;
}

export class DeliveryStateMachine {
  private readonly root: string;
  private readonly sessionId: string;
  private readonly pid: number;
  private readonly host: DeliveryHost;

  private inFlight = new Map<string, InFlightMessage>();
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

    // Initial dead pid claim recovery
    try {
      await reclaimDeadPidClaims(this.root, this.sessionId);
    } catch {
      // Ignore recovery error on startup
    }

    // Set up fs.watch on recipient inbox
    try {
      this.watcher = fs.watch(inboxDir, () => {
        void this.processInbox();
      });
    } catch {
      // Watcher failed, rely on polling
    }

    // 1s poll fallback
    this.pollTimer = setInterval(() => {
      void this.processInbox();
    }, 1000);
    this.pollTimer.unref();

    // Process immediately
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
      // Reclaim dead pid claims occasionally
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

        // Immediate check against entries in case it was recorded synchronously
        await this.checkAckAgainstEntries();
      }
    } catch {
      // Ignore inbox processing error
    } finally {
      this.isProcessing = false;
    }
  }

  public async checkAckAgainstEntries(): Promise<void> {
    if (this.inFlight.size === 0) return;

    let entries: readonly unknown[] = [];
    try {
      entries = this.host.getEntries();
    } catch {
      return;
    }

    for (const [id] of Array.from(this.inFlight.entries())) {
      const found = entries.some((e: unknown) => {
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

      if (found) {
        await this.ackMessage(id);
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
    // 1. Verify entries for any recorded messages
    await this.checkAckAgainstEntries();

    // Check if run ended by abort (on assistant message or toolResult)
    const isAborted = messages.some((m: unknown) => {
      if (!m || typeof m !== "object") return false;
      const msg = m as Record<string, unknown>;
      const role = msg.role;
      const stopReason = msg.stopReason;
      const isAbortReason =
        stopReason === "aborted" ||
        (typeof stopReason === "string" && stopReason !== "stop" && stopReason !== "toolUse");
      const errorMsg = typeof msg.errorMessage === "string" ? msg.errorMessage.toLowerCase() : "";
      if (isAbortReason || errorMsg.includes("abort") || msg.aborted === true) {
        return true;
      }

      // Check toolResult messages for abort signals
      if (role === "toolResult") {
        const details = msg.details as Record<string, unknown> | undefined;
        if (details?.source === "assistant_stop_aborted") {
          return true;
        }
        const contentStr = typeof msg.content === "string"
          ? msg.content.toLowerCase()
          : JSON.stringify(msg.content ?? "").toLowerCase();
        if (contentStr.includes("abort") || contentStr.includes("interrupted")) {
          return true;
        }
      }

      return false;
    });

    if (this.inFlight.size === 0) {
      return { isAborted };
    }

    // 2. While hasPendingMessages() is true, do not re-submit
    if (this.host.hasPendingMessages()) {
      return { isAborted };
    }

    for (const [id, item] of Array.from(this.inFlight.entries())) {
      // Final check against session entries
      const entries = this.host.getEntries();
      const found = entries.some((e: unknown) => {
        if (!e || typeof e !== "object") return false;
        const rec = e as Record<string, unknown>;
        const details = rec.details as Record<string, unknown> | undefined;
        return details?.peerMessageId === id;
      });

      if (found) {
        await this.ackMessage(id);
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

      if (isAborted) {
        // Run ended by abort: re-submit with NO triggerTurn (appended visibly)
        this.host.sendMessage(payload, { triggerTurn: false });
        await this.ackMessage(id, "appended");
      } else {
        // Run ended normally: re-submit normally
        this.host.sendMessage(payload, { triggerTurn: true });
      }
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
    return this.inFlight.size;
  }
}
