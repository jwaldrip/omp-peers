export interface RegistryEntry {
  v: 1;
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
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

export interface DeliveryReceipt {
  id: string;
  to: string;
  status: "delivered";
  mode: "woke" | "steered" | "appended";
  deliveredAt: number;
}

export interface SendPiMessageDetails {
  status: "delivered" | "queued" | "queued_offline";
  mode?: "woke" | "steered" | "appended";
  messageId: string;
  recipient: {
    sessionId: string;
    name: string;
    cwd: string;
    live: boolean;
  };
}

export interface DeliveryHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
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
  ): void;
  getEntries(): any[];
}
