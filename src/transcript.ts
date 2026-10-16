import * as fs from "node:fs";

export type TranscriptPresence = "present" | "absent" | "unavailable";

function isMatchingPeerMessage(value: unknown, peerMessageId: string, toSessionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : record;
  if (message.role !== "custom" || message.customType !== "peer-message") return false;
  const details = message.details;
  if (!details || typeof details !== "object") return false;
  const data = details as Record<string, unknown>;
  return data.peerMessageId === peerMessageId && data.toSessionId === toSessionId;
}

function hasSessionHeader(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.type === "session" || record.type === "session_header") && record.id === sessionId;
}

export async function findPersistedPeerMessage(
  sessionFile: string | undefined,
  sessionId: string,
  peerMessageId: string,
): Promise<TranscriptPresence> {
  if (!sessionFile) return "unavailable";
  let raw: string;
  try {
    raw = await fs.promises.readFile(sessionFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
  let hasHeader = false;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      hasHeader ||= hasSessionHeader(entry, sessionId);
      if (hasHeader && isMatchingPeerMessage(entry, peerMessageId, sessionId)) return "present";
    } catch {
      return "unavailable";
    }
  }
  return hasHeader ? "absent" : "unavailable";
}
