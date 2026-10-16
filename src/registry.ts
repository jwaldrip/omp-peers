import * as fs from "node:fs";
import * as path from "node:path";
import {
  countUndeliveredMessages,
  ensureDir,
  isPidAlive,
  isSafeId,
  quarantine,
  trace,
  writeAtomicFileSync,
} from "./mailbox.js";
import type { RegistryEntry, SessionInfo } from "./types.js";

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function parseRegistryEntry(value: unknown, filename?: string): RegistryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.v !== 1 || !isSafeId(entry.sessionId) || (filename !== undefined && filename !== `${entry.sessionId}.json`) ||
    !isSafeId(entry.instanceId) || typeof entry.name !== "string" || typeof entry.cwd !== "string" ||
    typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid <= 0 ||
    !validTimestamp(entry.startedAt) || !validTimestamp(entry.heartbeatAt) ||
    (entry.status !== "idle" && entry.status !== "busy" && entry.status !== "offline")) return null;
  return entry as unknown as RegistryEntry;
}

function assertRegistryEntry(entry: RegistryEntry): void {
  if (!parseRegistryEntry(entry, `${entry.sessionId}.json`)) throw new Error("Invalid peer registry record");
}

export function getSessionRef(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(-8);
}

export function resolveGitBranch(cwd: string): string {
  try {
    const gitPath = path.join(cwd, ".git");
    if (!fs.existsSync(gitPath)) return "unknown";
    const stat = fs.statSync(gitPath);
    const headPath = stat.isDirectory()
      ? path.join(gitPath, "HEAD")
      : (() => {
        const match = fs.readFileSync(gitPath, "utf8").trim().match(/^gitdir:\s*(.+)$/m);
        return match ? path.join(path.isAbsolute(match[1].trim()) ? match[1].trim() : path.resolve(cwd, match[1].trim()), "HEAD") : "";
      })();
    if (!headPath || !fs.existsSync(headPath)) return "unknown";
    const head = fs.readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length).trim();
    return /^[0-9a-fA-F]{40}$/.test(head) ? head.slice(0, 8) : head;
  } catch { return "unknown"; }
}

export async function writeRegistryEntry(root: string, entry: RegistryEntry): Promise<void> {
  writeRegistryEntrySync(root, entry);
}

export function writeRegistryEntrySync(root: string, entry: RegistryEntry): void {
  assertRegistryEntry(entry);
  writeAtomicFileSync(path.join(root, "registry", `${entry.sessionId}.json`), JSON.stringify(entry));
}

export async function markOffline(root: string, sessionId: string): Promise<void> {
  const target = path.join(root, "registry", `${sessionId}.json`);
  try {
    const entry = parseRegistryEntry(JSON.parse(await fs.promises.readFile(target, "utf8")), `${sessionId}.json`);
    if (!entry) throw new Error("invalid registry entry");
    entry.status = "offline";
    entry.heartbeatAt = Date.now();
    await writeRegistryEntry(root, entry);
  } catch (error) { trace(root, "registry_offline_failed", { sessionId, error: String(error) }); }
}

export function markOfflineSync(root: string, sessionId: string, instanceId?: string): void {
  const target = path.join(root, "registry", `${sessionId}.json`);
  try {
    const entry = parseRegistryEntry(JSON.parse(fs.readFileSync(target, "utf8")), `${sessionId}.json`);
    if (!entry) throw new Error("invalid registry entry");
    if (instanceId && entry.instanceId !== instanceId) return;
    entry.status = "offline";
    entry.heartbeatAt = Date.now();
    writeRegistryEntrySync(root, entry);
  } catch (error) { trace(root, "registry_offline_failed", { sessionId, error: String(error) }); }
}

export function isSessionLive(entry: RegistryEntry): boolean {
  return entry.status !== "offline" && isPidAlive(entry.pid);
}

export async function gcRegistry(root: string): Promise<void> {
  const registry = path.join(root, "registry");
  let files: string[];
  try { files = await fs.promises.readdir(registry); } catch { return; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const source = path.join(registry, file);
    try {
      const entry = parseRegistryEntry(JSON.parse(await fs.promises.readFile(source, "utf8")), file);
      if (!entry) { quarantine(root, source, "invalid registry entry"); continue; }
      if (isSessionLive(entry) || Date.now() - entry.heartbeatAt <= 14 * 24 * 60 * 60 * 1000) continue;
      if (await countUndeliveredMessages(root, "", entry.sessionId) === 0) await fs.promises.unlink(source);
    } catch (error) { trace(root, "registry_unavailable", { source, error: String(error) }); }
  }
}

export async function listSessions(root: string, currentSessionId: string, includeOffline = false): Promise<SessionInfo[]> {
  const registry = path.join(root, "registry");
  await ensureDir(registry);
  void gcRegistry(root);
  let files: string[];
  try { files = await fs.promises.readdir(registry); } catch (error) {
    trace(root, "registry_unavailable", { error: String(error) });
    return [];
  }
  const results: SessionInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const source = path.join(registry, file);
    try {
      const entry = parseRegistryEntry(JSON.parse(await fs.promises.readFile(source, "utf8")), file);
      if (!entry) { quarantine(root, source, "invalid registry entry"); continue; }
      if (entry.sessionId === currentSessionId) continue;
      const live = isSessionLive(entry);
      if (!live && (!includeOffline || Date.now() - entry.heartbeatAt > 7 * 24 * 60 * 60 * 1000)) continue;
      results.push({
        sessionId: entry.sessionId,
        id8: getSessionRef(entry.sessionId),
        name: entry.name,
        cwd: entry.cwd,
        branch: resolveGitBranch(entry.cwd),
        pid: entry.pid,
        startedAt: entry.startedAt,
        heartbeatAt: entry.heartbeatAt,
        status: entry.status,
        effectiveStatus: live ? entry.status : "offline",
        isLive: live,
        undeliveredCount: await countUndeliveredMessages(root, currentSessionId, entry.sessionId),
      });
    } catch (error) {
      if (error instanceof SyntaxError) quarantine(root, source, "malformed registry JSON");
      else trace(root, "registry_unavailable", { source, error: String(error) });
    }
  }
  return results.sort((left, right) => left.isLive === right.isLive ? right.heartbeatAt - left.heartbeatAt : left.isLive ? -1 : 1);
}

export function formatSessionLine(info: SessionInfo): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - info.heartbeatAt) / 1000));
  return `${info.name} [${info.id8}] - ${info.effectiveStatus} - ${info.cwd} - ${info.branch} - session ${info.sessionId} - active ${elapsed}s ago${info.undeliveredCount ? ` - ${info.undeliveredCount} undelivered` : ""}`;
}
