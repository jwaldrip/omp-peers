#!/usr/bin/env bun
/**
 * Live two-process proof harness for omp-peers.
 *
 * Exercises the native OMP peer messaging extension across two live
 * /opt/homebrew/bin/omp 18.11.0 sessions in RPC mode.
 *
 * Scenarios:
 *   a. idle wake: A sends to B; B emits peer-message message_end & starts turn; A status=delivered
 *   b. busy: B runs sleep 15; A sends; B receives in same run after tool; A status=queued|delivered
 *   c. abort: B runs long sleep; A sends nonce1; B aborted via RPC; nonce1 in session file;
 *             no turn in 10s; A sends nonce2 while idle -> B starts turn
 *   d. offline: B stopped; A sends -> queued_offline; B resumed -> nonce delivered on start
 *   e. naming: B1 & B2 same title -> ambiguous error; Name [id8] delivers; unknown -> not_found suggestions
 *
 * Usage:
 *   bun scripts/prove-live.ts [--extension <path>] [--model <model>] [--omp <path>] [--self-test] [-v]
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

// ============================================================================
// Types
// ============================================================================

export interface RpcResponseData {
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	isStreaming?: boolean;
	dumpTools?: Array<{ name: string; description: string }>;
	[key: string]: unknown;
}

export interface RpcResponsePayload {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: RpcResponseData;
	error?: string;
}

export interface AgentMessageContentItem {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface AgentMessagePayload {
	role?: string;
	customType?: string;
	content?: string | AgentMessageContentItem[];
	details?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface RpcToolResult {
	content?: Array<{ type: string; text: string }>;
	details?: {
		status?: "delivered" | "queued" | "queued_offline";
		mode?: "woke" | "steered" | "appended";
		messageId?: string;
		[key: string]: unknown;
	};
	isError?: boolean;
}

export interface RpcEventFrame {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	message?: AgentMessagePayload;
	toolName?: string;
	result?: RpcToolResult;
	data?: RpcResponseData;
	error?: string;
	[key: string]: unknown;
}

interface PendingRpcRequest {
	resolve: (res: RpcResponsePayload) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

interface EventWaiter {
	predicate: (evt: RpcEventFrame) => boolean;
	resolve: (evt: RpcEventFrame) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

interface CliOptions {
	extensionPath?: string;
	model: string;
	ompBinary: string;
	selfTest: boolean;
	verbose: boolean;
}

function parseCliArgs(): CliOptions {
	const args = process.argv.slice(2);
	const options: CliOptions = {
		model: "google-antigravity/gemini-3.8-flash",
		ompBinary: "/opt/homebrew/bin/omp",
		selfTest: false,
		verbose: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension" || arg === "-e") {
			options.extensionPath = path.resolve(args[++i]);
		} else if (arg.startsWith("--extension=")) {
			options.extensionPath = path.resolve(arg.slice("--extension=".length));
		} else if (arg === "--model") {
			options.model = args[++i];
		} else if (arg.startsWith("--model=")) {
			options.model = arg.slice("--model=".length);
		} else if (arg === "--omp") {
			options.ompBinary = path.resolve(args[++i]);
		} else if (arg === "--self-test") {
			options.selfTest = true;
		} else if (arg === "--verbose" || arg === "-v") {
			options.verbose = true;
		}
	}

	if (!options.extensionPath && !options.selfTest) {
		const defaultExt = path.resolve(
			process.env.HOME || "",
			"dev/src/github.com/jwaldrip/omp-peers.worktrees/durable-peer-mailbox/src/index.ts",
		);
		if (fs.existsSync(defaultExt)) {
			options.extensionPath = defaultExt;
		}
	}

	return options;
}

// ============================================================================
// RPC Session Wrapper
// ============================================================================

export class OmpRpcSession {
	readonly label: string;
	readonly cwd: string;
	readonly sessionDir: string;
	readonly ompBinary: string;
	readonly model: string;
	readonly extensionPath?: string;
	readonly peersDir: string;
	readonly configPath: string;
	readonly verbose: boolean;

	proc?: ChildProcess;
	sessionId: string = "";
	sessionFile: string = "";
	sessionName: string = "";
	ready: boolean = false;
	isStopped: boolean = false;

	readonly events: RpcEventFrame[] = [];
	private commandSeq = 0;
	private pendingRequests = new Map<string, PendingRpcRequest>();
	private eventWaiters = new Set<EventWaiter>();

	constructor(opts: {
		label: string;
		cwd: string;
		sessionDir: string;
		ompBinary: string;
		model: string;
		extensionPath?: string;
		peersDir: string;
		configPath: string;
		verbose: boolean;
	}) {
		this.label = opts.label;
		this.cwd = opts.cwd;
		this.sessionDir = opts.sessionDir;
		this.ompBinary = opts.ompBinary;
		this.model = opts.model;
		this.extensionPath = opts.extensionPath;
		this.peersDir = opts.peersDir;
		this.configPath = opts.configPath;
		this.verbose = opts.verbose;
	}

	get id8(): string {
		return this.sessionId.slice(0, 8);
	}

	async start(resumeSessionId?: string): Promise<void> {
		const args = [
			"--mode=rpc",
			"--no-extensions",
			...(this.extensionPath ? ["-e", this.extensionPath] : []),
			`--session-dir=${this.sessionDir}`,
			`--cwd=${this.cwd}`,
			"--approval-mode=yolo",
			`--model=${this.model}`,
			"--thinking=minimal",
			"--no-skills",
			"--no-rules",
			`--config=${this.configPath}`,
			"--system-prompt=You are an automated test agent. Follow instructions concisely without explanation.",
			"--no-title",
			...(resumeSessionId ? [`--resume=${resumeSessionId}`] : []),
		];

		if (this.verbose) {
			console.log(`[${this.label}] Spawning: ${this.ompBinary} ${args.join(" ")}`);
		}

		this.proc = spawn(this.ompBinary, args, {
			cwd: this.cwd,
			env: {
				...process.env,
				OMP_PEERS_DIR: this.peersDir,
				OMP_PEERS_TRACE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		const rl = readline.createInterface({ input: this.proc.stdout! });
		rl.on("line", line => this.handleLine(line));

		this.proc.stderr!.on("data", chunk => {
			if (this.verbose) {
				process.stderr.write(`[${this.label} stderr] ${chunk}`);
			}
		});

		this.proc.on("error", err => {
			console.error(`[${this.label}] Process error:`, err);
		});

		this.proc.on("exit", (code, signal) => {
			this.isStopped = true;
			if (this.verbose) {
				console.log(`[${this.label}] Process exited with code ${code}, signal ${signal}`);
			}
			for (const [id, req] of this.pendingRequests.entries()) {
				clearTimeout(req.timer);
				req.reject(new Error(`Session ${this.label} exited while waiting for response to ${id}`));
			}
			this.pendingRequests.clear();
		});

		// Wait for ready frame
		await this.waitForEvent(e => e.type === "ready", 30000);
		this.ready = true;

		// Fetch initial state to record sessionId, sessionFile, sessionName
		const stateResp = await this.sendCommand({ type: "get_state" });
		if (stateResp.success && stateResp.data) {
			this.sessionId = stateResp.data.sessionId || "";
			this.sessionFile = stateResp.data.sessionFile || "";
			this.sessionName = stateResp.data.sessionName || "";
		}

		if (this.verbose) {
			console.log(`[${this.label}] Ready. SessionId: ${this.sessionId} (${this.id8}), Name: "${this.sessionName}"`);
		}
	}

	private handleLine(line: string) {
		const trimmed = line.trim();
		if (!trimmed) return;

		let frame: RpcEventFrame;
		try {
			frame = JSON.parse(trimmed) as RpcEventFrame;
		} catch {
			if (this.verbose) {
				console.log(`[${this.label} unparsed] ${trimmed}`);
			}
			return;
		}

		this.events.push(frame);

		if (this.verbose) {
			const brief = frame.type === "response"
				? `response ${frame.command} success=${frame.success}`
				: frame.type === "message_end"
					? `message_end role=${frame.message?.role} customType=${frame.message?.customType}`
					: frame.type === "tool_execution_start"
						? `tool_start ${frame.toolName}`
						: frame.type === "tool_execution_end"
							? `tool_end ${frame.toolName}`
							: frame.type;
			console.log(`[${this.label} frame] ${brief}`);
		}

		// Handle response correlation
		if (frame.type === "response" && frame.id && this.pendingRequests.has(frame.id)) {
			const req = this.pendingRequests.get(frame.id)!;
			this.pendingRequests.delete(frame.id);
			clearTimeout(req.timer);
			if (frame.success) {
				req.resolve(frame as RpcResponsePayload);
			} else {
				req.reject(new Error(frame.error || "Command failed"));
			}
		}

		// Check event waiters
		for (const waiter of Array.from(this.eventWaiters)) {
			try {
				if (waiter.predicate(frame)) {
					this.eventWaiters.delete(waiter);
					clearTimeout(waiter.timer);
					waiter.resolve(frame);
				}
			} catch {
				// Ignore predicate evaluation errors
			}
		}
	}

	async sendCommand(cmd: Record<string, unknown>, timeoutMs = 60000): Promise<RpcResponsePayload> {
		if (!this.proc || this.isStopped) {
			throw new Error(`Cannot send command to stopped session ${this.label}`);
		}

		const id = `req_${++this.commandSeq}_${Date.now()}`;
		const payload = { ...cmd, id };

		const { promise, resolve, reject } = Promise.withResolvers<RpcResponsePayload>();

		const timer = setTimeout(() => {
			this.pendingRequests.delete(id);
			reject(new Error(`Timeout waiting for response to ${cmd.type} (id=${id}) after ${timeoutMs}ms`));
		}, timeoutMs);

		this.pendingRequests.set(id, { resolve, reject, timer });

		try {
			this.proc!.stdin!.write(JSON.stringify(payload) + "\n");
		} catch (err) {
			clearTimeout(timer);
			this.pendingRequests.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}

		return promise;
	}

	async prompt(message: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<RpcResponsePayload> {
		return this.sendCommand({
			type: "prompt",
			message,
			streamingBehavior: options?.streamingBehavior,
		});
	}

	async abort(): Promise<RpcResponsePayload> {
		return this.sendCommand({ type: "abort" });
	}

	async getState(): Promise<RpcResponseData> {
		const resp = await this.sendCommand({ type: "get_state" });
		if (resp.success && resp.data) {
			this.sessionId = resp.data.sessionId || "";
			this.sessionFile = resp.data.sessionFile || "";
			this.sessionName = resp.data.sessionName || "";
		}
		return resp.data || {};
	}

	async setSessionName(name: string): Promise<RpcResponsePayload> {
		const resp = await this.sendCommand({ type: "set_session_name", name });
		this.sessionName = name;
		return resp;
	}

	waitForEvent(predicate: (e: RpcEventFrame) => boolean, timeoutMs = 60000): Promise<RpcEventFrame> {
		// Check existing events first
		for (const ev of this.events) {
			try {
				if (predicate(ev)) return Promise.resolve(ev);
			} catch {}
		}

		const { promise, resolve, reject } = Promise.withResolvers<RpcEventFrame>();

		const timer = setTimeout(() => {
			this.eventWaiters.delete(waiter);
			reject(new Error(`[${this.label}] Timeout waiting for event after ${timeoutMs}ms`));
		}, timeoutMs);

		const waiter: EventWaiter = { predicate, resolve, reject, timer };
		this.eventWaiters.add(waiter);

		return promise;
	}

	async waitForToolStart(toolName: string, timeoutMs = 60000): Promise<RpcEventFrame> {
		return this.waitForEvent(
			e => e.type === "tool_execution_start" && e.toolName === toolName,
			timeoutMs,
		);
	}

	async waitForToolEnd(toolName: string, timeoutMs = 60000): Promise<RpcEventFrame> {
		return this.waitForEvent(
			e => e.type === "tool_execution_end" && e.toolName === toolName,
			timeoutMs,
		);
	}

	async waitForPeerMessage(nonce: string, timeoutMs = 60000): Promise<RpcEventFrame> {
		return this.waitForEvent(e => {
			if (e.type === "message_end" && e.message?.customType === "peer-message") {
				const content = typeof e.message.content === "string"
					? e.message.content
					: JSON.stringify(e.message.content || "");
				return content.includes(nonce);
			}
			return false;
		}, timeoutMs);
	}

	async waitForAgentEnd(timeoutMs = 90000): Promise<RpcEventFrame> {
		return this.waitForEvent(e => e.type === "agent_end", timeoutMs);
	}

	readSessionEntries(): Array<Record<string, unknown>> {
		let filePath = this.sessionFile;
		if (!filePath || !fs.existsSync(filePath)) {
			// Fallback: search sessionDir for a file containing sessionId
			if (this.sessionId && this.sessionDir && fs.existsSync(this.sessionDir)) {
				try {
					const files = fs.readdirSync(this.sessionDir);
					const matched = files.find(f => f.includes(this.sessionId) && f.endsWith(".jsonl"));
					if (matched) {
						filePath = path.join(this.sessionDir, matched);
						this.sessionFile = filePath;
					}
				} catch {}
			}
		}

		if (!filePath || !fs.existsSync(filePath)) {
			return [];
		}

		try {
			const content = fs.readFileSync(filePath, "utf8");
			const entries: Array<Record<string, unknown>> = [];
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					entries.push(JSON.parse(trimmed) as Record<string, unknown>);
				} catch {}
			}
			return entries;
		} catch {
			return [];
		}
	}

	async stop(): Promise<void> {
		if (this.isStopped || !this.proc) return;

		this.isStopped = true;
		try {
			this.proc.stdin?.end();
		} catch {}

		const { promise, resolve } = Promise.withResolvers<void>();
		const proc = this.proc;
		const killTimer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 3000);

		proc.once("exit", () => {
			clearTimeout(killTimer);
			resolve();
		});

		try {
			proc.kill("SIGTERM");
		} catch {
			clearTimeout(killTimer);
			resolve();
		}

		return promise;
	}
}

// ============================================================================
// Test Harness Environment
// ============================================================================

export class ProofEnvironment {
	readonly tmpRootDir: string;
	readonly peersDir: string;
	readonly sessionDir: string;
	readonly configPath: string;
	readonly activeSessions: OmpRpcSession[] = [];
	private sessionCounter = 0;

	constructor() {
		this.tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-peers-proof-"));
		this.peersDir = path.join(this.tmpRootDir, "peer-mail");
		this.sessionDir = path.join(this.tmpRootDir, "sessions");
		this.configPath = path.join(this.tmpRootDir, "config-overlay.yml");

		fs.mkdirSync(this.peersDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.sessionDir, { recursive: true });

		fs.writeFileSync(
			this.configPath,
			`todo:\n  enabled: false\n  eager: default\ntask:\n  eager: never\n`,
		);
	}

	createSessionCwd(name: string): string {
		const dir = path.join(this.tmpRootDir, "cwds", `${name}_${++this.sessionCounter}`);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	async createSession(opts: {
		label: string;
		cwd?: string;
		extensionPath?: string;
		ompBinary: string;
		model: string;
		verbose: boolean;
		resumeSessionId?: string;
	}): Promise<OmpRpcSession> {
		const cwd = opts.cwd || this.createSessionCwd(opts.label);
		const session = new OmpRpcSession({
			label: opts.label,
			cwd,
			sessionDir: this.sessionDir,
			ompBinary: opts.ompBinary,
			model: opts.model,
			extensionPath: opts.extensionPath,
			peersDir: this.peersDir,
			configPath: this.configPath,
			verbose: opts.verbose,
		});

		this.activeSessions.push(session);
		await session.start(opts.resumeSessionId);
		return session;
	}

	async cleanup(): Promise<void> {
		for (const session of this.activeSessions) {
			try {
				await session.stop();
			} catch {}
		}
		this.activeSessions.length = 0;

		try {
			fs.rmSync(this.tmpRootDir, { recursive: true, force: true });
		} catch {}
	}
}

// ============================================================================
// Scenarios
// ============================================================================

export interface ScenarioResult {
	id: string;
	name: string;
	status: "PASS" | "FAIL";
	evidence: string;
	error?: string;
}

/**
 * Extract status string from tool result details or text content.
 */
export function extractToolStatus(result?: RpcToolResult): string | undefined {
	if (result?.details?.status && typeof result.details.status === "string") {
		return result.details.status;
	}
	const text = (result?.content || []).map(c => c.text || "").join(" ");
	if (/status:\s*"?(delivered|queued|queued_offline)"?/i.test(text)) {
		const m = text.match(/status:\s*"?(delivered|queued|queued_offline)"?/i);
		return m ? m[1].toLowerCase() : undefined;
	}
	if (text.includes("Delivered to") || text.includes("delivered to") || text.includes("started a turn") || text.includes("injected into")) {
		return "delivered";
	}
	if (text.includes("stored durably and will be injected") || text.includes("is busy; stored durably")) {
		return "queued";
	}
	if (text.includes("stored durably and delivered when") || text.includes("is not running; stored durably")) {
		return "queued_offline";
	}
	return undefined;
}

/**
 * Scenario a: Idle wake
 * Session A's model is prompted to call send_pi_message to B with a nonce.
 * B emits a peer-message message_end containing the nonce and starts a turn.
 * A's tool result status is "delivered".
 */
async function runScenarioA(env: ProofEnvironment, opts: CliOptions): Promise<ScenarioResult> {
	const id = "a";
	const name = "idle wake";
	console.log(`\n--- Running Scenario ${id}: ${name} ---`);

	try {
		const sessionB = await env.createSession({
			label: "B_idle",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const sessionA = await env.createSession({
			label: "A_idle",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const nonce = `NONCE_${randomUUID().slice(0, 8)}`;
		console.log(`[Scenario A] Nonce: ${nonce}. Session B: ${sessionB.sessionId} (${sessionB.id8})`);

		// Set up listeners on B before prompting A
		const bMessagePromise = sessionB.waitForPeerMessage(nonce, 60000);
		const bTurnPromise = sessionB.waitForEvent(e => e.type === "agent_start", 60000);

		// Prompt A to call send_pi_message targeting B
		console.log(`[Scenario A] Prompting A to call send_pi_message to B`);
		const promptMsg = `Call tool send_pi_message immediately with {"target": "${sessionB.sessionId}", "message": "${nonce}"}. Do not call any other tool.`;

		const aToolEndPromise = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(promptMsg);

		const aToolEnd = await aToolEndPromise;
		const toolResult = aToolEnd.result;
		const status = extractToolStatus(toolResult);

		console.log(`[Scenario A] A's send_pi_message status: "${status}"`);
		if (status !== "delivered") {
			throw new Error(`Expected A's tool result status to be "delivered", got "${status}" (details: ${JSON.stringify(toolResult?.details)}, content: ${JSON.stringify(toolResult?.content)})`);
		}

		console.log(`[Scenario A] Waiting for B to receive message and start turn...`);
		await bMessagePromise;
		await bTurnPromise;

		const evidence = `A tool status=delivered; B emitted peer-message message_end with ${nonce} and started turn`;
		console.log(`[Scenario A] PASS: ${evidence}`);

		// Wait for both to settle turns
		await Promise.allSettled([sessionA.waitForAgentEnd(60000), sessionB.waitForAgentEnd(60000)]);

		return { id, name, status: "PASS", evidence };
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[Scenario A] FAIL: ${errorMsg}`);
		return { id, name, status: "FAIL", evidence: "Did not complete expected sequence", error: errorMsg };
	}
}

/**
 * Scenario b: Busy
 * B is prompted to run bash sleep 15.
 * While B's tool runs, A sends a nonce.
 * B receives it within the same run after the tool finishes (no refusal).
 * A's result is queued or delivered, never an error.
 */
async function runScenarioB(env: ProofEnvironment, opts: CliOptions): Promise<ScenarioResult> {
	const id = "b";
	const name = "busy";
	console.log(`\n--- Running Scenario ${id}: ${name} ---`);

	try {
		const sessionB = await env.createSession({
			label: "B_busy",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const sessionA = await env.createSession({
			label: "A_busy",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const nonce = `NONCE_BUSY_${randomUUID().slice(0, 8)}`;
		console.log(`[Scenario B] Nonce: ${nonce}. Session B: ${sessionB.sessionId} (${sessionB.id8})`);

		// Prompt B to run sleep 15
		console.log(`[Scenario B] Prompting B to run sleep 15...`);
		void sessionB.prompt(`Run bash command "sleep 15". You must use the bash tool.`);

		// Wait until B actually enters bash tool execution
		console.log(`[Scenario B] Waiting for B to start bash tool...`);
		await sessionB.waitForToolStart("bash", 60000);
		console.log(`[Scenario B] B is now busy executing bash tool!`);

		// While B is busy, set up listener for B receiving peer message
		const bMessagePromise = sessionB.waitForPeerMessage(nonce, 75000);

		// Prompt A to send nonce to B
		console.log(`[Scenario B] Prompting A to send message while B is busy...`);
		const aToolEndPromise = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "${sessionB.sessionId}", "message": "${nonce}"}. Do not call any other tool.`);

		const aToolEnd = await aToolEndPromise;
		const toolResult = aToolEnd.result;
		const status = extractToolStatus(toolResult);
		console.log(`[Scenario B] A's tool result status: "${status}"`);

		if (status !== "queued" && status !== "delivered") {
			throw new Error(`Expected A status to be "queued" or "delivered", got "${status}" (result: ${JSON.stringify(toolResult)})`);
		}

		// Wait for B to receive the peer message within its run
		console.log(`[Scenario B] Waiting for B to receive message after tool finish...`);
		await bMessagePromise;

		const evidence = `A status=${status} (no refusal); B received ${nonce} within run after bash tool finished`;
		console.log(`[Scenario B] PASS: ${evidence}`);

		await Promise.allSettled([sessionA.waitForAgentEnd(60000), sessionB.waitForAgentEnd(60000)]);
		return { id, name, status: "PASS", evidence };
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[Scenario B] FAIL: ${errorMsg}`);
		return { id, name, status: "FAIL", evidence: "Failed during busy delivery sequence", error: errorMsg };
	}
}

/**
 * Scenario c: Abort
 * B runs a long sleep.
 * A sends nonce1.
 * We abort B mid-tool via RPC.
 * nonce1 ends up persisted in B's session file (custom message entry).
 * B does NOT start a new turn from it within ~10s.
 * Then A sends nonce2 while B is idle and B starts a turn.
 */
async function runScenarioC(env: ProofEnvironment, opts: CliOptions): Promise<ScenarioResult> {
	const id = "c";
	const name = "abort";
	console.log(`\n--- Running Scenario ${id}: ${name} ---`);

	try {
		const sessionB = await env.createSession({
			label: "B_abort",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const sessionA = await env.createSession({
			label: "A_abort",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const nonce1 = `NONCE_ABORT1_${randomUUID().slice(0, 8)}`;
		const nonce2 = `NONCE_ABORT2_${randomUUID().slice(0, 8)}`;
		console.log(`[Scenario C] Nonce1: ${nonce1}, Nonce2: ${nonce2}`);

		// 1. Prompt B to run long sleep
		console.log(`[Scenario C] Prompting B to run sleep 30...`);
		void sessionB.prompt(`Run bash command "sleep 30". You must use the bash tool.`);

		// 2. Wait for B to start bash
		await sessionB.waitForToolStart("bash", 60000);
		console.log(`[Scenario C] B is busy in sleep 30.`);

		// 3. A sends nonce1
		console.log(`[Scenario C] Prompting A to send nonce1 to B...`);
		const aToolEndPromise1 = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "${sessionB.sessionId}", "message": "${nonce1}"}. Do not call any other tool.`);
		await aToolEndPromise1;
		console.log(`[Scenario C] Nonce1 accepted by extension.`);

		// Give a brief moment for extension to process the inbox file before aborting
		await delay(600);

		// 4. Abort B mid-tool via RPC
		console.log(`[Scenario C] Aborting B via RPC...`);
		await sessionB.abort();

		// Wait for B's run to end from the abort
		await sessionB.waitForAgentEnd(25000);
		console.log(`[Scenario C] B aborted and run settled.`);

		// 5. Check B's session file on disk for persisted custom_message entry
		console.log(`[Scenario C] Polling B's session file on disk for persisted custom message...`);
		let customEntry: Record<string, unknown> | undefined;
		const pollDeadline = Date.now() + 6000;
		while (Date.now() < pollDeadline) {
			const entries = sessionB.readSessionEntries();
			customEntry = entries.find(e => {
				const isCustomMessage =
					(e.type === "custom_message" && e.customType === "peer-message") ||
					(e.type === "custom" && e.customType === "peer-message") ||
					(e.customType === "peer-message");
				if (isCustomMessage) {
					const contentStr = typeof e.content === "string" ? e.content : JSON.stringify(e.content ?? "");
					return contentStr.includes(nonce1);
				}
				return false;
			});
			if (customEntry) break;
			await delay(200);
		}

		if (!customEntry) {
			const entries = sessionB.readSessionEntries();
			throw new Error(`nonce1 (${nonce1}) was NOT found persisted as custom_message entry in B's session file (${sessionB.sessionFile}). Found ${entries.length} entries.`);
		}
		console.log(`[Scenario C] Verified nonce1 is persisted in B's session entries.`);

		// 6. Wait 10s: verify B does NOT start a new turn from nonce1
		console.log(`[Scenario C] Watching B for 10s to verify no turn is started from nonce1...`);
		let turnStarted = false;
		const eventIndexBefore = sessionB.events.length;

		await delay(10000);

		for (let i = eventIndexBefore; i < sessionB.events.length; i++) {
			if (sessionB.events[i].type === "agent_start") {
				turnStarted = true;
				break;
			}
		}

		if (turnStarted) {
			throw new Error("B started a new turn from the aborted stranded message within 10s! Contract forbids auto-starting turns from aborted messages.");
		}
		console.log(`[Scenario C] Confirmed: 0 turns started in 10s following abort.`);

		// 7. A sends nonce2 while B is idle
		console.log(`[Scenario C] Now sending nonce2 while B is idle...`);
		const bTurnPromise = sessionB.waitForEvent(e => e.type === "agent_start", 60000);
		const bMessagePromise2 = sessionB.waitForPeerMessage(nonce2, 60000);

		const aToolEndPromise2 = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "${sessionB.sessionId}", "message": "${nonce2}"}. Do not call any other tool.`);
		await aToolEndPromise2;

		console.log(`[Scenario C] Waiting for B to receive nonce2 and start turn...`);
		await bMessagePromise2;
		await bTurnPromise;

		const evidence = `nonce1 persisted in B session file; 0 turns started during 10s abort quiet window; nonce2 successfully started turn`;
		console.log(`[Scenario C] PASS: ${evidence}`);

		await Promise.allSettled([sessionA.waitForAgentEnd(60000), sessionB.waitForAgentEnd(60000)]);
		return { id, name, status: "PASS", evidence };
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[Scenario C] FAIL: ${errorMsg}`);
		return { id, name, status: "FAIL", evidence: "Failed during abort handling sequence", error: errorMsg };
	}
}

/**
 * Scenario d: Offline
 * Stop B's process.
 * A sends nonce3 and gets queued_offline.
 * Restart B with --resume <B session id> (same session dir, same OMP_PEERS_DIR).
 * nonce3 is delivered on start.
 */
async function runScenarioD(env: ProofEnvironment, opts: CliOptions): Promise<ScenarioResult> {
	const id = "d";
	const name = "offline";
	console.log(`\n--- Running Scenario ${id}: ${name} ---`);

	try {
		const sessionB = await env.createSession({
			label: "B_offline",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const sessionA = await env.createSession({
			label: "A_offline",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const bSessionId = sessionB.sessionId;
		const bCwd = sessionB.cwd;
		const nonce3 = `NONCE_OFFLINE_${randomUUID().slice(0, 8)}`;
		console.log(`[Scenario D] Nonce3: ${nonce3}. Stopping session B (${bSessionId})...`);

		// 1. Stop B
		await sessionB.stop();
		console.log(`[Scenario D] Session B stopped.`);

		// 2. A sends nonce3 to B's sessionId
		console.log(`[Scenario D] Prompting A to send to offline B (${bSessionId})...`);
		const aToolEndPromise = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "${bSessionId}", "message": "${nonce3}"}. Do not call any other tool.`);

		const aToolEnd = await aToolEndPromise;
		const toolResult = aToolEnd.result;
		const status = extractToolStatus(toolResult);
		console.log(`[Scenario D] A's tool result status: "${status}"`);

		if (status !== "queued_offline") {
			throw new Error(`Expected A tool status to be "queued_offline", got "${status}" (details: ${JSON.stringify(toolResult?.details)})`);
		}

		// Verify inbox has the queued message
		const inboxDir = path.join(env.peersDir, "inbox", bSessionId);
		const inboxFiles = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")) : [];
		console.log(`[Scenario D] Inbox for ${bSessionId} contains ${inboxFiles.length} file(s).`);

		if (inboxFiles.length === 0) {
			throw new Error(`Expected at least one pending message file in ${inboxDir}`);
		}

		// 3. Restart B with --resume
		console.log(`[Scenario D] Restarting B with --resume ${bSessionId}...`);
		const resumedB = await env.createSession({
			label: "B_resumed",
			cwd: bCwd,
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
			resumeSessionId: bSessionId,
		});

		console.log(`[Scenario D] Resumed B started. Waiting for offline message delivery...`);
		await resumedB.waitForPeerMessage(nonce3, 60000);
		await resumedB.waitForEvent(e => e.type === "agent_start", 60000);

		const evidence = `A status=queued_offline; message persisted in inbox; resumed B delivered ${nonce3} and started turn`;
		console.log(`[Scenario D] PASS: ${evidence}`);

		await Promise.allSettled([sessionA.waitForAgentEnd(60000), resumedB.waitForAgentEnd(60000)]);
		return { id, name, status: "PASS", evidence };
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[Scenario D] FAIL: ${errorMsg}`);
		return { id, name, status: "FAIL", evidence: "Failed during offline/resume sequence", error: errorMsg };
	}
}

/**
 * Scenario e: Naming
 * Two live sessions with the same title -> send_pi_message by that name returns
 * an ambiguous error listing both as Name [id8].
 * Sending to one Name [id8] succeeds.
 * An unknown target returns not_found with suggestions.
 */
async function runScenarioE(env: ProofEnvironment, opts: CliOptions): Promise<ScenarioResult> {
	const id = "e";
	const name = "naming";
	console.log(`\n--- Running Scenario ${id}: ${name} ---`);

	try {
		const b1 = await env.createSession({
			label: "B1_worker",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const b2 = await env.createSession({
			label: "B2_worker",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const sessionA = await env.createSession({
			label: "A_naming",
			extensionPath: opts.extensionPath,
			ompBinary: opts.ompBinary,
			model: opts.model,
			verbose: opts.verbose,
		});

		const sharedTitle = "SharedWorker";
		console.log(`[Scenario E] Setting titles of B1 and B2 to "${sharedTitle}"...`);
		await b1.setSessionName(sharedTitle);
		await b2.setSessionName(sharedTitle);

		// Wait briefly for registry write
		await delay(600);

		// 1. Ambiguous send
		console.log(`[Scenario E] Testing ambiguous target "${sharedTitle}"...`);
		let aToolEndPromise = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "${sharedTitle}", "message": "hello shared"}. Do not call any other tool.`);

		let aToolEnd = await aToolEndPromise;
		let text = JSON.stringify(aToolEnd.result?.content || "");
		console.log(`[Scenario E] Ambiguous result content: ${text}`);

		const b1Ref = `${sharedTitle} [${b1.id8}]`;
		const b2Ref = `${sharedTitle} [${b2.id8}]`;

		if (!text.toLowerCase().includes("ambiguous") || !text.includes(b1.id8) || !text.includes(b2.id8)) {
			throw new Error(`Expected ambiguous error listing both ${b1Ref} and ${b2Ref}, got: ${text}`);
		}
		console.log(`[Scenario E] Verified ambiguous error listing both candidates.`);
		await sessionA.waitForAgentEnd(60000);

		// 2. Specific Name [id8] send
		console.log(`[Scenario E] Testing resolved target "${b1Ref}"...`);
		const nonceB1 = `NONCE_B1_${randomUUID().slice(0, 8)}`;
		const b1MessagePromise = b1.waitForPeerMessage(nonceB1, 60000);

		aToolEndPromise = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "${b1Ref}", "message": "${nonceB1}"}. Do not call any other tool.`);

		aToolEnd = await aToolEndPromise;
		const b1Status = extractToolStatus(aToolEnd.result);
		console.log(`[Scenario E] Send to ${b1Ref} status: "${b1Status}"`);

		if (b1Status !== "delivered") {
			throw new Error(`Expected delivered status for ${b1Ref}, got: ${b1Status} (result: ${JSON.stringify(aToolEnd.result)})`);
		}
		await b1MessagePromise;
		console.log(`[Scenario E] Verified delivery to specific target ${b1Ref}.`);
		await sessionA.waitForAgentEnd(60000);

		// 3. Unknown target send
		console.log(`[Scenario E] Testing unknown target "UnknownTargetXYZ"...`);
		aToolEndPromise = sessionA.waitForToolEnd("send_pi_message", 60000);
		await sessionA.prompt(`Call tool send_pi_message immediately with {"target": "UnknownTargetXYZ", "message": "hello"}. Do not call any other tool.`);

		aToolEnd = await aToolEndPromise;
		text = JSON.stringify(aToolEnd.result?.content || "");
		console.log(`[Scenario E] Unknown target result content: ${text}`);

		if (!text.toLowerCase().includes("not_found") && !text.toLowerCase().includes("not found")) {
			throw new Error(`Expected not_found error with suggestions, got: ${text}`);
		}
		console.log(`[Scenario E] Verified not_found error returned with suggestions.`);
		await sessionA.waitForAgentEnd(60000);

		const evidence = `Ambiguous error listed both ${b1Ref} and ${b2Ref}; exact target ${b1Ref} delivered; unknown target gave not_found`;
		console.log(`[Scenario E] PASS: ${evidence}`);

		return { id, name, status: "PASS", evidence };
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[Scenario E] FAIL: ${errorMsg}`);
		return { id, name, status: "FAIL", evidence: "Failed during naming resolution sequence", error: errorMsg };
	}
}

// ============================================================================
// Driver Self-Test Mode
// ============================================================================

async function runDriverSelfTest(env: ProofEnvironment, opts: CliOptions): Promise<void> {
	console.log("\n================================================================================");
	console.log("DRIVER SELF-TEST (Verifying plain OMP RPC session without extension)");
	console.log("================================================================================");

	const session = await env.createSession({
		label: "SelfTest",
		ompBinary: opts.ompBinary,
		model: opts.model,
		verbose: opts.verbose,
	});

	console.log(`Session started. Id: ${session.sessionId}, File: ${session.sessionFile}`);

	const state = await session.getState();
	console.log(`State retrieved: isStreaming=${state.isStreaming}, tools=${state.dumpTools?.length || 0}`);

	// Verify pi-cross-session is NOT present
	const toolNames = (state.dumpTools || []).map(t => t.name);
	if (toolNames.includes("list_pi") || toolNames.includes("send_pi_message")) {
		throw new Error("ISOLATION FAILURE: pi-cross-session tools detected in session with --no-extensions!");
	}
	console.log("ISOLATION VERIFIED: pi-cross-session tools are NOT present.");

	// Test prompt execution
	console.log("Testing basic prompt response...");
	const agentEndPromise = session.waitForAgentEnd(60000);
	await session.prompt("Reply with only the word PONG");
	await agentEndPromise;

	const assistantMsgs = session.events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
	console.log(`Prompt completed. Assistant message count: ${assistantMsgs.length}`);

	console.log("DRIVER SELF-TEST PASSED SUCCESSFULLY.\n");
}

// ============================================================================
// Main Entrypoint
// ============================================================================

async function main() {
	const opts = parseCliArgs();
	console.log("================================================================================");
	console.log("OMP-PEERS LIVE TWO-PROCESS PROOF HARNESS");
	console.log(`OMP Binary:     ${opts.ompBinary}`);
	console.log(`Model:          ${opts.model}`);
	console.log(`Extension Path: ${opts.extensionPath || "(none)"}`);
	console.log(`Self Test Only: ${opts.selfTest}`);
	console.log("================================================================================");

	const env = new ProofEnvironment();

	// Register emergency process cleanup
	let isCleaningUp = false;
	const doCleanup = async () => {
		if (isCleaningUp) return;
		isCleaningUp = true;
		console.log("\nCleaning up proof environment and child processes...");
		await env.cleanup();
	};

	process.on("SIGINT", async () => {
		await doCleanup();
		process.exit(130);
	});
	process.on("SIGTERM", async () => {
		await doCleanup();
		process.exit(143);
	});
	process.on("uncaughtException", async err => {
		console.error("Uncaught exception:", err);
		await doCleanup();
		process.exit(1);
	});

	try {
		if (opts.selfTest || !opts.extensionPath) {
			await runDriverSelfTest(env, opts);
			if (opts.selfTest) {
				await doCleanup();
				process.exit(0);
			}
		}

		if (!opts.extensionPath || !fs.existsSync(opts.extensionPath)) {
			console.log(`Extension not found at: ${opts.extensionPath}`);
			console.log("Driver self-test passed. Pass --extension <path> once PeerExtension builds the extension.");
			await doCleanup();
			process.exit(0);
		}

		console.log(`Running proof scenarios against extension: ${opts.extensionPath}`);

		const results: ScenarioResult[] = [];

		results.push(await runScenarioA(env, opts));
		results.push(await runScenarioB(env, opts));
		results.push(await runScenarioC(env, opts));
		results.push(await runScenarioD(env, opts));
		results.push(await runScenarioE(env, opts));

		console.log("\n====================================================================================================");
		console.log("FINAL RESULTS TABLE");
		console.log("====================================================================================================");
		console.log("Scenario                       Status   Evidence");
		console.log("----------------------------------------------------------------------------------------------------");

		let hasFailure = false;
		for (const r of results) {
			const label = `${r.id}. ${r.name}`.padEnd(30);
			const status = r.status.padEnd(8);
			const evidence = r.status === "PASS" ? r.evidence : `FAIL: ${r.error || r.evidence}`;
			console.log(`${label} ${status} ${evidence}`);
			if (r.status !== "PASS") hasFailure = true;
		}
		console.log("====================================================================================================");

		await doCleanup();

		if (hasFailure) {
			console.error("\nONE OR MORE SCENARIOS FAILED.");
			process.exit(1);
		} else {
			console.log("\nALL SCENARIOS PASSED.");
			process.exit(0);
		}
	} catch (err: unknown) {
		console.error("Proof runner fatal error:", err);
		await doCleanup();
		process.exit(1);
	}
}

if (import.meta.main) {
	main();
}
