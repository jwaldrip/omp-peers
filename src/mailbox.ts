import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ClaimedMessageRecord,
  ClaimOwner,
  DeliveryAttempt,
  DeliveryMode,
  DeliveryReceipt,
  PeerMessageEnvelope,
} from "./types.js";

const MAX_TEXT_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function getPeersDir(): string {
  const envDir = process.env.OMP_PEERS_DIR;
  return envDir?.trim() ? path.resolve(envDir.trim()) : path.join(os.homedir(), ".omp", "peer-mail");
}

export function trace(root: string, event: string, data: Record<string, unknown>): void {
  if (process.env.OMP_PEERS_TRACE !== "1") return;
  try {
    fs.appendFileSync(path.join(root, "trace.jsonl"), `${JSON.stringify({ ts: Date.now(), event, ...data })}\n`, { mode: 0o600 });
  } catch {}
}

export function ensureDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dirPath, 0o700); } catch {}
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try { await fs.promises.chmod(dirPath, 0o700); } catch {}
}

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Date.now() + 365 * 24 * 60 * 60 * 1000;
}

function text(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function parseEnvelope(value: unknown, expectedTo?: string): PeerMessageEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const from = record.from;
  if (
    record.v !== 1 || !isSafeId(record.id) || !isSafeId(record.to) ||
    (expectedTo !== undefined && record.to !== expectedTo) || !isTimestamp(record.sentAt) ||
    !from || typeof from !== "object" || !text(record.body) ||
    (record.summary !== undefined && !text(record.summary, 4096))
  ) return null;
  const sender = from as Record<string, unknown>;
  if (!isSafeId(sender.sessionId) || !text(sender.name, 4096) || !text(sender.cwd, MAX_TEXT_BYTES)) return null;
  return record as unknown as PeerMessageEnvelope;
}

export function parseClaimOwner(value: unknown): ClaimOwner | null {
  if (!value || typeof value !== "object") return null;
  const owner = value as Record<string, unknown>;
  if (!isSafeId(owner.instanceId) || !SAFE_INSTANCE_ID.test(owner.instanceId) ||
    typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
    typeof owner.generation !== "number" || !Number.isSafeInteger(owner.generation) || owner.generation < 0) return null;
  return owner as unknown as ClaimOwner;
}

function parseAttempt(value: unknown): DeliveryAttempt | null {
  if (!value || typeof value !== "object") return null;
  const attempt = value as Record<string, unknown>;
  if (!isSafeId(attempt.id) || !isTimestamp(attempt.submittedAt) || !isTimestamp(attempt.retryAfter) ||
    (attempt.mode !== "woke" && attempt.mode !== "steered" && attempt.mode !== "appended")) return null;
  return attempt as unknown as DeliveryAttempt;
}

export function parseClaimRecord(value: unknown, expectedTo?: string): ClaimedMessageRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || (record.phase !== "pending" && record.phase !== "submitted" && record.phase !== "accepted") ||
    typeof record.aborted !== "boolean" || !Array.isArray(record.attempts)) return null;
  const envelope = parseEnvelope(record.envelope, expectedTo);
  const owner = parseClaimOwner(record.owner);
  const attempts = record.attempts.map(parseAttempt);
  if (!envelope || !owner || attempts.some((attempt) => attempt === null)) return null;
  return record as unknown as ClaimedMessageRecord;
}

export function parseReceipt(value: unknown, expectedId?: string): DeliveryReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  if (receipt.v !== 1 || receipt.status !== "delivered" || !isSafeId(receipt.id) ||
    (expectedId !== undefined && receipt.id !== expectedId) || !isSafeId(receipt.to) ||
    !isTimestamp(receipt.deliveredAt) || (receipt.mode !== "woke" && receipt.mode !== "steered" && receipt.mode !== "appended")) return null;
  return receipt as unknown as DeliveryReceipt;
}

function filenameFor(message: PeerMessageEnvelope): string {
  return `${message.sentAt}-${message.id}.json`;
}

function assertEnvelope(message: PeerMessageEnvelope): void {
  if (!parseEnvelope(message)) throw new Error("Invalid peer message envelope");
}

function assertRecord(record: ClaimedMessageRecord): void {
  if (!parseClaimRecord(record, record.envelope.to)) throw new Error("Invalid claimed peer message record");
}

function assertReceipt(receipt: DeliveryReceipt): void {
  if (!parseReceipt(receipt, receipt.id)) throw new Error("Invalid delivery receipt");
}

export async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const temp = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    await fs.promises.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temp, filePath);
  } catch (error) {
    try { await fs.promises.unlink(temp); } catch {}
    throw error;
  }
}

export function writeAtomicFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const temp = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

export function quarantine(root: string, source: string, reason: string): void {
  const destination = path.join(root, "quarantine", `${Date.now()}-${randomUUID()}.json`);
  try {
    ensureDirSync(path.dirname(destination));
    fs.renameSync(source, destination);
    fs.writeFileSync(`${destination}.reason`, reason, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    trace(root, "quarantine_failed", { source, reason, error: String(error) });
  }
}

export async function writeMessage(root: string, message: PeerMessageEnvelope): Promise<string> {
  assertEnvelope(message);
  const target = path.join(root, "inbox", message.to, filenameFor(message));
  await writeAtomicFile(target, JSON.stringify(message));
  trace(root, "message_written", { messageId: message.id, to: message.to });
  return target;
}

function ownerDir(root: string, sessionId: string, owner: ClaimOwner): string {
  return path.join(root, "inbox", sessionId, "claimed", owner.instanceId);
}

function ownerPath(root: string, sessionId: string, owner: ClaimOwner): string {
  return path.join(ownerDir(root, sessionId, owner), "owner.json");
}

function writeOwner(root: string, sessionId: string, owner: ClaimOwner): void {
  writeAtomicFileSync(ownerPath(root, sessionId, owner), JSON.stringify(owner));
}

export async function claimOldestMessage(
  root: string,
  sessionId: string,
  owner: ClaimOwner,
  isCurrent: () => boolean = () => true,
): Promise<{ record: ClaimedMessageRecord; claimedPath: string } | null> {
  if (!isSafeId(sessionId) || !parseClaimOwner(owner)) throw new Error("Invalid claim owner or recipient");
  const inbox = path.join(root, "inbox", sessionId);
  let names: string[];
  try { names = await fs.promises.readdir(inbox); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureDir(inbox);
      return null;
    }
    trace(root, "inbox_unavailable", { sessionId, error: String(error) });
    return null;
  }
  const files = names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  if (files.length === 0 || !isCurrent()) return null;
  // Acquisition is a synchronous critical section: retirement cannot run between the
  // rename and the durable record write and leave a late claim under an old owner.
  const claimed = ownerDir(root, sessionId, owner);
  ensureDirSync(claimed);
  writeOwner(root, sessionId, owner);
  for (const name of files) {
    const source = path.join(inbox, name);
    const target = path.join(claimed, name);
    try { fs.renameSync(source, target); } catch { continue; }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) quarantine(root, target, "malformed message JSON");
      else trace(root, "message_read_failed", { source: target, error: String(error) });
      continue;
    }
    const recovered = parseClaimRecord(raw, sessionId);
    const parsed = recovered?.envelope ?? parseEnvelope(raw, sessionId);
    if (!parsed || name !== filenameFor(parsed)) {
      quarantine(root, target, "invalid envelope or filename");
      continue;
    }
    const record: ClaimedMessageRecord = recovered
      ? { ...recovered, owner, phase: recovered.phase === "accepted" ? "pending" : recovered.phase,
          aborted: recovered.aborted || recovered.phase === "accepted" }
      : { v: 1, envelope: parsed, phase: "pending", owner, attempts: [], aborted: false };
    writeAtomicFileSync(target, JSON.stringify(record));
    trace(root, "message_claimed", { messageId: parsed.id, sessionId, instanceId: owner.instanceId });
    return { record, claimedPath: target };
  }
  return null;
}

export async function writeClaimRecord(claimedPath: string, record: ClaimedMessageRecord): Promise<void> {
  assertRecord(record);
  if (path.basename(claimedPath) !== filenameFor(record.envelope)) throw new Error("Claim filename does not match envelope");
  writeAtomicFileSync(claimedPath, JSON.stringify(record));
}

export function retireOwnerSync(root: string, sessionId: string, owner: ClaimOwner): void {
  if (!isSafeId(sessionId) || !parseClaimOwner(owner)) return;
  const source = ownerDir(root, sessionId, owner);
  if (!fs.existsSync(source)) return;
  const destination = path.join(root, "inbox", sessionId, "released", `${owner.instanceId}-${Date.now()}-${randomUUID()}`);
  ensureDirSync(path.dirname(destination));
  fs.renameSync(source, destination);
  trace(root, "owner_retired", { sessionId, instanceId: owner.instanceId });
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function restoreRecord(root: string, sessionId: string, source: string): Promise<boolean> {
  let record: ClaimedMessageRecord | null = null;
  try {
    const raw = JSON.parse(await fs.promises.readFile(source, "utf8"));
    record = parseClaimRecord(raw, sessionId);
    const envelope = record ? null : parseEnvelope(raw, sessionId);
    if (envelope) record = { v: 1, envelope, phase: "pending",
      owner: { instanceId: "recovered-owner", pid: process.pid, generation: 0 }, attempts: [], aborted: false };
  } catch (error) {
    trace(root, "reclaim_read_failed", { source, error: String(error) });
    return false;
  }
  if (!record || path.basename(source) !== filenameFor(record.envelope)) {
    await quarantine(root, source, "invalid claimed record or filename");
    return false;
  }
  const destination = path.join(root, "inbox", sessionId, filenameFor(record.envelope));
  try {
    await fs.promises.rename(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") trace(root, "reclaim_failed", { source, error: String(error) });
    return false;
  }
}

async function reclaimDirectory(root: string, sessionId: string, directory: string, onlyDeadOwner: boolean): Promise<number> {
  let owner: ClaimOwner | null = null;
  try { owner = parseClaimOwner(JSON.parse(await fs.promises.readFile(path.join(directory, "owner.json"), "utf8"))); } catch (error) {
    trace(root, "owner_read_failed", { directory, error: String(error) });
    return 0;
  }
  if (!owner) {
    await quarantine(root, path.join(directory, "owner.json"), "invalid owner manifest");
    return 0;
  }
  if (onlyDeadOwner && isPidAlive(owner.pid)) return 0;
  let files: string[];
  try { files = await fs.promises.readdir(directory); } catch (error) {
    trace(root, "claim_dir_unavailable", { directory, error: String(error) });
    return 0;
  }
  let reclaimed = 0;
  for (const file of files) {
    if (!file.endsWith(".json") || file === "owner.json") continue;
    if (await restoreRecord(root, sessionId, path.join(directory, file))) reclaimed++;
  }
  return reclaimed;
}

export async function reclaimReleasedClaims(root: string, sessionId: string): Promise<number> {
  const released = path.join(root, "inbox", sessionId, "released");
  let names: string[];
  try { names = await fs.promises.readdir(released); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    trace(root, "released_unavailable", { sessionId, error: String(error) });
    return 0;
  }
  let reclaimed = 0;
  for (const name of names) reclaimed += await reclaimDirectory(root, sessionId, path.join(released, name), false);
  return reclaimed;
}

export async function reclaimDeadPidClaims(root: string, sessionId: string): Promise<number> {
  const claimed = path.join(root, "inbox", sessionId, "claimed");
  let names: string[];
  try { names = await fs.promises.readdir(claimed); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    trace(root, "claims_unavailable", { sessionId, error: String(error) });
    return 0;
  }
  let reclaimed = 0;
  for (const name of names) reclaimed += await reclaimDirectory(root, sessionId, path.join(claimed, name), true);
  return reclaimed;
}

export async function markDelivered(
  root: string,
  record: ClaimedMessageRecord,
  claimedPath: string,
  mode: DeliveryMode,
): Promise<void> {
  assertRecord(record);
  const { envelope } = record;
  const destination = path.join(root, "delivered", envelope.to, filenameFor(envelope));
  await ensureDir(path.dirname(destination));
  try { await fs.promises.rename(claimedPath, destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const archive = parseClaimRecord(JSON.parse(await fs.promises.readFile(destination, "utf8")), envelope.to);
      if (!archive || archive.envelope.id !== envelope.id) throw new Error("missing archive after claim transition");
    } catch { throw error; }
  }
  const receipt: DeliveryReceipt = { v: 1, id: envelope.id, to: envelope.to, status: "delivered", mode, deliveredAt: Date.now() };
  assertReceipt(receipt);
  await writeAtomicFile(path.join(root, "receipts", envelope.from.sessionId, `${envelope.id}.json`), JSON.stringify(receipt));
  trace(root, "message_confirmed", { messageId: envelope.id, to: envelope.to, mode });
}

export async function readReceipt(root: string, fromSessionId: string, messageId: string): Promise<DeliveryReceipt | null> {
  if (!isSafeId(fromSessionId) || !isSafeId(messageId)) return null;
  const source = path.join(root, "receipts", fromSessionId, `${messageId}.json`);
  try {
    const receipt = parseReceipt(JSON.parse(await fs.promises.readFile(source, "utf8")), messageId);
    if (!receipt) await quarantine(root, source, "invalid receipt");
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") trace(root, "receipt_unavailable", { source, error: String(error) });
    return null;
  }
}

export async function waitForReceipt(root: string, fromSessionId: string, messageId: string, timeoutMs: number): Promise<DeliveryReceipt | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await readReceipt(root, fromSessionId, messageId);
    if (receipt) return receipt;
    await Bun.sleep(40);
  }
  return readReceipt(root, fromSessionId, messageId);
}

async function countIn(directory: string, fromSessionId: string, expectedTo: string): Promise<number> {
  let files: string[];
  try { files = await fs.promises.readdir(directory); } catch { return 0; }
  let count = 0;
  for (const file of files) {
    if (!file.endsWith(".json") || file === "owner.json") continue;
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(directory, file), "utf8"));
      const envelope = parseEnvelope(raw, expectedTo) ?? parseClaimRecord(raw, expectedTo)?.envelope;
      if (envelope && (!fromSessionId || envelope.from.sessionId === fromSessionId)) count++;
    } catch {}
  }
  return count;
}

export async function countUndeliveredMessages(root: string, fromSessionId: string, toSessionId: string): Promise<number> {
  const inbox = path.join(root, "inbox", toSessionId);
  let count = await countIn(inbox, fromSessionId, toSessionId);
  for (const group of ["claimed", "released"]) {
    const base = path.join(inbox, group);
    let dirs: string[];
    try { dirs = await fs.promises.readdir(base); } catch { continue; }
    for (const dir of dirs) count += await countIn(path.join(base, dir), fromSessionId, toSessionId);
  }
  return count;
}

export async function pruneMailbox(root: string): Promise<void> {
  const oldest = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const group of ["delivered", "receipts"]) {
    const base = path.join(root, group);
    let dirs: string[];
    try { dirs = await fs.promises.readdir(base); } catch { continue; }
    for (const dir of dirs) {
      let files: string[];
      try { files = await fs.promises.readdir(path.join(base, dir)); } catch { continue; }
      for (const file of files) {
        const source = path.join(base, dir, file);
        try { if ((await fs.promises.stat(source)).mtimeMs < oldest) await fs.promises.unlink(source); } catch {}
      }
    }
  }
}
