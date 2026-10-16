#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ProofEnvironment, type OmpRpcSession } from "./prove-live.js";
import { waitForReceipt, writeMessage } from "../src/mailbox.js";
import type { PeerMessageEnvelope } from "../src/types.js";

interface Options {
  extensionPath: string;
  ompBinary: string;
  model: string;
  verbose: boolean;
}

function optionsFromArgs(): Options {
  const options: Options = {
    extensionPath: path.resolve(import.meta.dir, "../src/index.ts"),
    ompBinary: "/opt/homebrew/bin/omp",
    model: "google-antigravity/gemini-3.8-flash",
    verbose: false,
  };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--extension" || value === "-e") options.extensionPath = path.resolve(args[++index]);
    else if (value.startsWith("--extension=")) options.extensionPath = path.resolve(value.slice("--extension=".length));
    else if (value === "--omp") options.ompBinary = path.resolve(args[++index]);
    else if (value.startsWith("--omp=")) options.ompBinary = path.resolve(value.slice("--omp=".length));
    else if (value === "--model") options.model = args[++index];
    else if (value.startsWith("--model=")) options.model = value.slice("--model=".length);
    else if (value === "--verbose" || value === "-v") options.verbose = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function peerEnvelope(id: string, to: string, nonce: string): PeerMessageEnvelope {
  return {
    v: 1,
    id,
    from: { sessionId: "recovery-proof-sender", name: "Recovery proof", cwd: process.cwd() },
    to,
    body: nonce,
    sentAt: Date.now(),
  };
}

function appendPersistedPeerMessage(sessionFile: string, sessionId: string, messageId: string, envelope: PeerMessageEnvelope): void {
  const existing = fs.readFileSync(sessionFile, "utf8");
  const hasHeader = existing.split("\n").some((line) => {
    try {
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
      return (parsed.type === "session" || parsed.type === "session_header") && parsed.id === sessionId;
    } catch {
      return false;
    }
  });
  if (!hasHeader) throw new Error(`Session file has no header for ${sessionId}: ${sessionFile}`);
  fs.appendFileSync(sessionFile, `${JSON.stringify({
    type: "custom_message",
    message: {
      customType: "peer-message",
      details: { peerMessageId: messageId, toSessionId: sessionId, from: envelope.from, body: envelope.body, sentAt: envelope.sentAt },
    },
  })}\n`);
}

function peerEvents(session: OmpRpcSession, nonce: string): number {
  return session.events.filter((event) => {
    if (event.type !== "message_end" || event.message?.customType !== "peer-message") return false;
    const content = typeof event.message.content === "string" ? event.message.content : JSON.stringify(event.message.content ?? "");
    return content.includes(nonce);
  }).length;
}

async function switchAwayAndBack(session: OmpRpcSession): Promise<{ sessionId: string; sessionFile: string }> {
  const before = await session.getState();
  const originalFile = before.sessionFile;
  if (!originalFile) throw new Error(`get_state did not provide an original session file: ${JSON.stringify(before)}`);
  const created = await session.sendCommand({ type: "new_session" });
  if (!created.success || created.data?.cancelled) throw new Error(`new_session was cancelled: ${JSON.stringify(created)}`);
  const other = await session.getState();
  if (!other.sessionFile || other.sessionFile === originalFile) throw new Error(`new_session did not select a distinct session file: ${JSON.stringify(other)}`);
  const switched = await session.sendCommand({ type: "switch_session", sessionPath: originalFile });
  if (!switched.success || switched.data?.cancelled) throw new Error(`switch_session was cancelled: ${JSON.stringify(switched)}`);
  const returned = await session.getState();
  if (returned.sessionFile !== originalFile || !returned.sessionId) {
    throw new Error(`switch_session did not restore the original session file: ${JSON.stringify(returned)}`);
  }
  return { sessionId: returned.sessionId, sessionFile: originalFile };
}

async function verifySwitchDelivery(env: ProofEnvironment, session: OmpRpcSession): Promise<{ sessionId: string; sessionFile: string }> {
  const original = await switchAwayAndBack(session);
  const nonce = `recovery-switch-${randomUUID()}`;
  const messageId = `recovery-switch-${randomUUID()}`;
  const checkpoint = session.markEventCheckpoint();
  await writeMessage(env.peersDir, peerEnvelope(messageId, original.sessionId, nonce));
  await session.waitForPeerMessage(nonce, 60_000, checkpoint);
  const receipt = await waitForReceipt(env.peersDir, "recovery-proof-sender", messageId, 60_000);
  if (!receipt || receipt.id !== messageId) throw new Error(`No receipt after same-process switch recovery for ${messageId}`);
  console.log(`OBSERVED switch-back delivery: session=${original.sessionId} nonce=${nonce} receipt=${receipt.status}/${receipt.mode}`);
  return original;
}

async function verifyRestartDoesNotWake(env: ProofEnvironment, session: OmpRpcSession, original: { sessionId: string; sessionFile: string }, opts: Options): Promise<void> {
  await session.stop();
  const nonce = `recovery-restart-${randomUUID()}`;
  const messageId = `recovery-restart-${randomUUID()}`;
  const envelope = peerEnvelope(messageId, original.sessionId, nonce);
  await writeMessage(env.peersDir, envelope);
  appendPersistedPeerMessage(original.sessionFile, original.sessionId, messageId, envelope);
  const resumed = await env.createSession({
    label: "recovery-resumed",
    cwd: session.cwd,
    extensionPath: opts.extensionPath,
    ompBinary: opts.ompBinary,
    model: opts.model,
    verbose: opts.verbose,
    resumeSessionId: original.sessionId,
  });
  const state = await resumed.getState();
  if (state.sessionFile !== original.sessionFile) throw new Error(`--resume selected ${state.sessionFile}, expected ${original.sessionFile}`);
  const receipt = await waitForReceipt(env.peersDir, "recovery-proof-sender", messageId, 15_000);
  if (!receipt || receipt.id !== messageId) throw new Error(`Restart did not acknowledge disk-recorded message ${messageId}`);
  const duplicateMessages = peerEvents(resumed, nonce);
  const wakeEvents = resumed.events.filter((event) => event.type === "agent_start").length;
  if (duplicateMessages !== 0 || wakeEvents !== 0) {
    throw new Error(`Restart reinjected disk-recorded message: peerMessageEvents=${duplicateMessages}, agentStarts=${wakeEvents}, nonce=${nonce}`);
  }
  console.log(`OBSERVED restart recovery: session=${state.sessionId} nonce=${nonce} receipt=${receipt.status}/${receipt.mode} peerMessageEvents=0 agentStarts=0`);
}

async function main(): Promise<void> {
  const opts = optionsFromArgs();
  if (!fs.existsSync(opts.ompBinary)) throw new Error(`OMP binary not found: ${opts.ompBinary}`);
  if (!fs.existsSync(opts.extensionPath)) throw new Error(`Extension not found: ${opts.extensionPath}`);
  console.log(`OMP recovery proof: binary=${opts.ompBinary} extension=${opts.extensionPath}`);
  console.log(`Model=${opts.model}. The first real wake may invoke this configured provider.`);
  const env = new ProofEnvironment();
  try {
    const session = await env.createSession({ label: "recovery-primary", extensionPath: opts.extensionPath, ompBinary: opts.ompBinary, model: opts.model, verbose: opts.verbose });
    const original = await verifySwitchDelivery(env, session);
    await verifyRestartDoesNotWake(env, session, original, opts);
  } finally {
    await env.cleanup();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`RECOVERY PROOF FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
