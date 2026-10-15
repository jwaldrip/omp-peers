import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureDir,
  isPidAlive,
  writeAtomicFile,
  writeAtomicFileSync,
  countUndeliveredMessages,
} from "./mailbox.js";
import type { RegistryEntry, SessionInfo } from "./types.js";

export function resolveGitBranch(cwd: string): string {
  try {
    const gitPath = path.join(cwd, ".git");
    if (!fs.existsSync(gitPath)) {
      return "unknown";
    }

    const stat = fs.statSync(gitPath);
    let headPath = "";

    if (stat.isDirectory()) {
      headPath = path.join(gitPath, "HEAD");
    } else if (stat.isFile()) {
      const gitFileContent = fs.readFileSync(gitPath, "utf8").trim();
      const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
      if (!match) {
        return "unknown";
      }
      const rawGitDir = match[1].trim();
      const resolvedGitDir = path.isAbsolute(rawGitDir)
        ? rawGitDir
        : path.resolve(cwd, rawGitDir);
      headPath = path.join(resolvedGitDir, "HEAD");
    }

    if (!headPath || !fs.existsSync(headPath)) {
      return "unknown";
    }

    const headContent = fs.readFileSync(headPath, "utf8").trim();
    if (headContent.startsWith("ref: refs/heads/")) {
      return headContent.slice("ref: refs/heads/".length).trim();
    }
    if (/^[0-9a-fA-F]{40}$/.test(headContent)) {
      return headContent.slice(0, 8);
    }
    return headContent;
  } catch {
    return "unknown";
  }
}

export async function writeRegistryEntry(root: string, entry: RegistryEntry): Promise<void> {
  const registryDir = path.join(root, "registry");
  const targetPath = path.join(registryDir, `${entry.sessionId}.json`);
  await writeAtomicFile(targetPath, JSON.stringify(entry, null, 2));
}

export function writeRegistryEntrySync(root: string, entry: RegistryEntry): void {
  const registryDir = path.join(root, "registry");
  const targetPath = path.join(registryDir, `${entry.sessionId}.json`);
  writeAtomicFileSync(targetPath, JSON.stringify(entry, null, 2));
}

export async function markOffline(root: string, sessionId: string): Promise<void> {
  const targetPath = path.join(root, "registry", `${sessionId}.json`);
  try {
    const raw = await fs.promises.readFile(targetPath, "utf8");
    const entry = JSON.parse(raw) as RegistryEntry;
    entry.status = "offline";
    entry.heartbeatAt = Date.now();
    await writeAtomicFile(targetPath, JSON.stringify(entry, null, 2));
  } catch {
    // If reading or writing fails, ignore
  }
}

export function markOfflineSync(root: string, sessionId: string): void {
  const targetPath = path.join(root, "registry", `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const entry = JSON.parse(raw) as RegistryEntry;
    entry.status = "offline";
    entry.heartbeatAt = Date.now();
    writeAtomicFileSync(targetPath, JSON.stringify(entry, null, 2));
  } catch {
    // If reading or writing fails, ignore
  }
}

export function isSessionLive(entry: RegistryEntry): boolean {
  if (entry.status === "offline") {
    return false;
  }
  return isPidAlive(entry.pid);
}

export async function gcRegistry(root: string): Promise<void> {
  const registryDir = path.join(root, "registry");
  const now = Date.now();
  const maxOfflineAge = 14 * 24 * 60 * 60 * 1000; // 14 days

  let files: string[] = [];
  try {
    files = await fs.promises.readdir(registryDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(registryDir, file);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const entry = JSON.parse(raw) as RegistryEntry;
      const live = isSessionLive(entry);
      if (!live && now - entry.heartbeatAt > maxOfflineAge) {
        // Check if inbox is empty
        const inboxDir = path.join(root, "inbox", entry.sessionId);
        let hasMessages = false;
        try {
          const inboxFiles = await fs.promises.readdir(inboxDir);
          if (inboxFiles.some((f) => f.endsWith(".json") && !f.startsWith("."))) {
            hasMessages = true;
          }
        } catch {
          // No inbox dir
        }

        if (!hasMessages) {
          const claimedDir = path.join(inboxDir, "claimed");
          try {
            const pids = await fs.promises.readdir(claimedDir);
            for (const p of pids) {
              const pFiles = await fs.promises.readdir(path.join(claimedDir, p));
              if (pFiles.some((f) => f.endsWith(".json"))) {
                hasMessages = true;
                break;
              }
            }
          } catch {
            // No claimed dir
          }
        }

        if (!hasMessages) {
          await fs.promises.unlink(filePath);
        }
      }
    } catch {
      // Ignore read/parse error
    }
  }
}

export async function listSessions(
  root: string,
  currentSessionId: string,
  includeOffline = false
): Promise<SessionInfo[]> {
  const registryDir = path.join(root, "registry");
  await ensureDir(registryDir);

  // Run periodic GC on list
  void gcRegistry(root);

  let files: string[] = [];
  try {
    files = await fs.promises.readdir(registryDir);
  } catch {
    return [];
  }

  const now = Date.now();
  const maxIncludeOfflineAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const results: SessionInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const filePath = path.join(registryDir, file);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const entry = JSON.parse(raw) as RegistryEntry;
      if (entry.sessionId === currentSessionId) {
        continue;
      }

      const live = isSessionLive(entry);
      const effectiveStatus: "idle" | "busy" | "offline" = live ? entry.status : "offline";

      if (!live && !includeOffline) {
        continue;
      }

      if (!live && includeOffline && now - entry.heartbeatAt > maxIncludeOfflineAge) {
        continue;
      }

      const branch = resolveGitBranch(entry.cwd);
      const undeliveredCount = await countUndeliveredMessages(root, currentSessionId, entry.sessionId);

      results.push({
        sessionId: entry.sessionId,
        id8: entry.sessionId.slice(0, 8),
        name: entry.name,
        cwd: entry.cwd,
        branch,
        pid: entry.pid,
        startedAt: entry.startedAt,
        heartbeatAt: entry.heartbeatAt,
        status: entry.status,
        effectiveStatus,
        isLive: live,
        undeliveredCount,
      });
    } catch {
      // Ignore corrupt or unreadable entries
    }
  }

  // Sort: live first, then by heartbeatAt descending
  results.sort((a, b) => {
    if (a.isLive !== b.isLive) {
      return a.isLive ? -1 : 1;
    }
    return b.heartbeatAt - a.heartbeatAt;
  });

  return results;
}

export function formatSessionLine(info: SessionInfo): string {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - info.heartbeatAt) / 1000));
  let line = `${info.name} [${info.id8}] - ${info.effectiveStatus} - ${info.cwd} - ${info.branch} - session ${info.sessionId} - active ${elapsedSec}s ago`;
  if (info.undeliveredCount && info.undeliveredCount > 0) {
    line += ` - ${info.undeliveredCount} undelivered`;
  }
  return line;
}
