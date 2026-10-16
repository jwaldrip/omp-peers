export interface ClaimOwner {
  instanceId: string;
  pid: number;
  generation: number;
}

export interface RegistryEntry {
  v: 1;
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
  instanceId: string;
  startedAt: number;
  heartbeatAt: number;
  status: "idle" | "busy" | "offline";
}

export interface SessionInfo {
  sessionId: string;
  id8: string;
  name: string;
  cwd: string;
  branch: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  status: "idle" | "busy" | "offline";
  effectiveStatus: "idle" | "busy" | "offline";
  isLive: boolean;
  undeliveredCount?: number;
}

export interface PeerMessageEnvelope {
  v: 1;
  id: string;
  from: {
    sessionId: string;
    name: string;
    cwd: string;
  };
  to: string;
  summary?: string;
  body: string;
  sentAt: number;
}

export type DeliveryMode = "woke" | "steered" | "appended";
export type DeliveryPhase = "pending" | "submitted" | "accepted";

export interface DeliveryAttempt {
  id: string;
  mode: DeliveryMode;
  submittedAt: number;
  retryAfter: number;
}

export interface ClaimedMessageRecord {
  v: 1;
  envelope: PeerMessageEnvelope;
  phase: DeliveryPhase;
  owner: ClaimOwner;
  attempts: DeliveryAttempt[];
  aborted: boolean;
}

export interface DeliveryReceipt {
  v: 1;
  id: string;
  to: string;
  status: "delivered";
  mode: DeliveryMode;
  deliveredAt: number;
}

export interface SendPiMessageDetails {
  status: "delivered" | "accepted" | "unconfirmed" | "uncertain" | "queued" | "queued_offline";
  mode?: DeliveryMode;
  messageId: string;
  recipient: {
    sessionId: string;
    name: string;
    cwd: string;
    live: boolean;
  };
}

export interface PeerPayloadDetails {
  peerMessageId: string;
  toSessionId: string;
  from: { sessionId: string; name: string; cwd: string };
  summary?: string;
  body: string;
  sentAt: number;
}

export interface DeliveryHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: PeerPayloadDetails;
      attribution: "agent";
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): void;
  getEntries(): readonly unknown[];
}
