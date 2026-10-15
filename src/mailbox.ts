import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { DeliveryReceipt, PeerMessageEnvelope } from "./types.js";

export function getPeersDir(): string {
  const envDir = process.env.OMP_PEERS_DIR;
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim());
  }
  return path.join(os.homedir(), ".omp", "peer-mail");
}

export function trace(root: string, event: string, data: Record<string, unknown>): void {
  if (process.env.OMP_PEERS_TRACE !== "1") {
    return;
  }
  try {
    const tracePath = path.join(root, "trace.jsonl");
    const entry = JSON.stringify({ ts: Date.now(), event, ...data }) + "\n";
    fs.appendFileSync(tracePath, entry, { mode: 0o600 });
  } catch {
    // Ignore trace write failures
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(dirPath, 0o700);
  } catch {
    // Ignore chmod failure
  }
}

export function ensureDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod failure
  }
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpFile = path.join(
    dir,
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tmp`
  );
  try {
    await fs.promises.writeFile(tmpFile, content, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.promises.chmod(tmpFile, 0o600);
    } catch {
      // Ignore chmod error
    }
    await fs.promises.rename(tmpFile, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export function writeAtomicFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tmpFile = path.join(
    dir,
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tmp`
  );
  try {
    fs.writeFileSync(tmpFile, content, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {
      // Ignore chmod error
    }
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export async function writeMessage(
  root: string,
  message: PeerMessageEnvelope
): Promise<string> {
  const inboxDir = path.join(root, "inbox", message.to);
  const filename = `${message.sentAt}-${message.id}.json`;
  const targetPath = path.join(inboxDir, filename);
  await writeAtomicFile(targetPath, JSON.stringify(message, null, 2));
  trace(root, "message_written", {
    messageId: message.id,
    from: message.from.sessionId,
    to: message.to,
    path: targetPath,
  });
  return targetPath;
}

export async function claimOldestMessage(
  root: string,
  sessionId: string,
  pid: number
): Promise<{ message: PeerMessageEnvelope; claimedPath: string } | null> {
  const inboxDir = path.join(root, "inbox", sessionId);
  const claimedDir = path.join(inboxDir, "claimed", String(pid));

  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(inboxDir);
  } catch {
    return null;
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();

  if (jsonFiles.length === 0) {
    return null;
  }

  await ensureDir(claimedDir);

  for (const filename of jsonFiles) {
    const src = path.join(inboxDir, filename);
    const dest = path.join(claimedDir, filename);
    try {
      await fs.promises.rename(src, dest);
      const raw = await fs.promises.readFile(dest, "utf8");
      const message = JSON.parse(raw) as PeerMessageEnvelope;
      trace(root, "message_claimed", {
        messageId: message.id,
        sessionId,
        pid,
        dest,
      });
      return { message, claimedPath: dest };
    } catch {
      // File may have been claimed by another process or renamed, try next
      continue;
    }
  }

  return null;
}

export async function reclaimDeadPidClaims(
  root: string,
  sessionId: string
): Promise<number> {
  const claimedBase = path.join(root, "inbox", sessionId, "claimed");
  const inboxDir = path.join(root, "inbox", sessionId);

  let pidDirs: string[] = [];
  try {
    pidDirs = await fs.promises.readdir(claimedBase);
  } catch {
    return 0;
  }

  let reclaimedCount = 0;

  for (const pidStr of pidDirs) {
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || isPidAlive(pid)) {
      continue;
    }

    const pidDir = path.join(claimedBase, pidStr);
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(pidDir);
    } catch {
      continue;
    }

    for (const filename of files) {
      if (!filename.endsWith(".json")) continue;
      const src = path.join(pidDir, filename);
      const dest = path.join(inboxDir, filename);
      try {
        await fs.promises.rename(src, dest);
        reclaimedCount++;
        trace(root, "claim_reclaimed", {
          sessionId,
          deadPid: pid,
          filename,
        });
      } catch {
        // Ignore if unable to rename
      }
    }

    try {
      await fs.promises.rmdir(pidDir);
    } catch {
      // Ignore if not empty
    }
  }

  return reclaimedCount;
}

export async function markDelivered(
  root: string,
  message: PeerMessageEnvelope,
  claimedPath: string,
  mode: "woke" | "steered" | "appended"
): Promise<void> {
  const deliveredDir = path.join(root, "delivered", message.to);
  const filename = path.basename(claimedPath);
  const deliveredPath = path.join(deliveredDir, filename);

  await ensureDir(deliveredDir);
  try {
    await fs.promises.rename(claimedPath, deliveredPath);
  } catch {
    // If rename failed (already moved), ignore
  }

  const receipt: DeliveryReceipt = {
    id: message.id,
    to: message.to,
    status: "delivered",
    mode,
    deliveredAt: Date.now(),
  };

  const receiptPath = path.join(root, "receipts", message.from.sessionId, `${message.id}.json`);
  await writeAtomicFile(receiptPath, JSON.stringify(receipt, null, 2));

  trace(root, "message_delivered", {
    messageId: message.id,
    from: message.from.sessionId,
    to: message.to,
    mode,
  });
}

export async function readReceipt(
  root: string,
  fromSessionId: string,
  messageId: string
): Promise<DeliveryReceipt | null> {
  const receiptPath = path.join(root, "receipts", fromSessionId, `${messageId}.json`);
  try {
    const raw = await fs.promises.readFile(receiptPath, "utf8");
    return JSON.parse(raw) as DeliveryReceipt;
  } catch {
    return null;
  }
}

export async function waitForReceipt(
  root: string,
  fromSessionId: string,
  messageId: string,
  timeoutMs: number
): Promise<DeliveryReceipt | null> {
  const initial = await readReceipt(root, fromSessionId, messageId);
  if (initial) return initial;
  if (timeoutMs <= 0) return null;

  const { promise, resolve } = Promise.withResolvers<DeliveryReceipt | null>();
  const receiptsDir = path.join(root, "receipts", fromSessionId);
  await ensureDir(receiptsDir);

  let watcher: fs.FSWatcher | null = null;
  let pollInterval: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const cleanup = () => {
    settled = true;
    clearTimeout(timeoutTimer);
    clearInterval(pollInterval);
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }
  };

  const check = async () => {
    if (settled) return;
    const r = await readReceipt(root, fromSessionId, messageId);
    if (r && !settled) {
      cleanup();
      resolve(r);
    }
  };

  timeoutTimer = setTimeout(() => {
    if (!settled) {
      cleanup();
      resolve(null);
    }
  }, timeoutMs);

  try {
    watcher = fs.watch(receiptsDir, () => {
      void check();
    });
  } catch {
    // fs.watch fallback to polling
  }

  pollInterval = setInterval(() => {
    void check();
  }, 40);

  return promise;
}

export async function countUndeliveredMessages(
  root: string,
  fromSessionId: string,
  toSessionId: string
): Promise<number> {
  const inboxDir = path.join(root, "inbox", toSessionId);
  let count = 0;

  try {
    const entries = await fs.promises.readdir(inboxDir);
    for (const f of entries) {
      if (f.endsWith(".json") && !f.startsWith(".")) {
        try {
          const raw = await fs.promises.readFile(path.join(inboxDir, f), "utf8");
          const msg = JSON.parse(raw) as PeerMessageEnvelope;
          if (msg.from.sessionId === fromSessionId) {
            count++;
          }
        } catch {
          // Ignore read error
        }
      }
    }
  } catch {
    // Inbox dir might not exist
  }

  const claimedBase = path.join(inboxDir, "claimed");
  try {
    const pidDirs = await fs.promises.readdir(claimedBase);
    for (const pidStr of pidDirs) {
      const pidDir = path.join(claimedBase, pidStr);
      try {
        const files = await fs.promises.readdir(pidDir);
        for (const f of files) {
          if (f.endsWith(".json")) {
            try {
              const raw = await fs.promises.readFile(path.join(pidDir, f), "utf8");
              const msg = JSON.parse(raw) as PeerMessageEnvelope;
              if (msg.from.sessionId === fromSessionId) {
                count++;
              }
            } catch {
              // Ignore read error
            }
          }
        }
      } catch {
        // Ignore read error
      }
    }
  } catch {
    // Claimed base might not exist
  }

  return count;
}

export async function pruneMailbox(root: string): Promise<void> {
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  const deliveredRoot = path.join(root, "delivered");
  try {
    const sessionDirs = await fs.promises.readdir(deliveredRoot);
    for (const sDir of sessionDirs) {
      const fullDir = path.join(deliveredRoot, sDir);
      try {
        const files = await fs.promises.readdir(fullDir);
        for (const f of files) {
          const filePath = path.join(fullDir, f);
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs > maxAge) {
            await fs.promises.unlink(filePath);
          }
        }
      } catch {
        // Ignore per-dir error
      }
    }
  } catch {
    // Delivered root might not exist
  }

  const receiptsRoot = path.join(root, "receipts");
  try {
    const senderDirs = await fs.promises.readdir(receiptsRoot);
    for (const sDir of senderDirs) {
      const fullDir = path.join(receiptsRoot, sDir);
      try {
        const files = await fs.promises.readdir(fullDir);
        for (const f of files) {
          const filePath = path.join(fullDir, f);
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs > maxAge) {
            await fs.promises.unlink(filePath);
          }
        }
      } catch {
        // Ignore per-dir error
      }
    }
  } catch {
    // Receipts root might not exist
  }
}
