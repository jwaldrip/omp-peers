import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import listPiDescription from "./prompts/list-pi.md" with { type: "text" };
import sendPiMessageDescription from "./prompts/send-pi-message.md" with { type: "text" };
import { DeliveryStateMachine } from "./delivery.js";
import { getPeersDir, retireOwnerSync, trace, waitForReceipt, writeMessage } from "./mailbox.js";
import { formatSessionLine, getSessionRef, listSessions, markOfflineSync, writeRegistryEntry } from "./registry.js";
import { resolveTarget } from "./resolve.js";
import { installPeerAutocomplete, registerPeerRenderer } from "./ui.js";
import type { ClaimOwner, RegistryEntry, SendPiMessageDetails } from "./types.js";

interface DeliveryBinding { sessionId: string; owner: ClaimOwner; active: boolean; startedAt: number; }

export function isSubagentSession(ctx: ExtensionContext): boolean {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sessionFile) return false;
  try { return fs.existsSync(`${path.dirname(sessionFile)}.jsonl`); } catch { return false; }
}

export default function ompPeersExtension(pi: ExtensionAPI): void {
  const root = getPeersDir();
  let binding: DeliveryBinding | null = null;
  let generation = 0;
  let deliveryMachine: DeliveryStateMachine | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let lastRegisteredName = "";
  let subagent = false;
  let autocompleteInstalled = false;
  let retiredSessionId = "";
  let reactivationTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;

  const retire = (): void => {
    const retiring = binding;
    generation++;
    if (!retiring) return;
    retiring.active = false;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    deliveryMachine?.stop();
    deliveryMachine = null;
    binding = null;
    retiredSessionId = retiring.sessionId;
    try { retireOwnerSync(root, retiring.sessionId, retiring.owner); } catch (error) {
      trace(root, "retirement_unavailable", { sessionId: retiring.sessionId, error: String(error) });
    }
    markOfflineSync(root, retiring.sessionId, retiring.owner.instanceId);
  };

  const updateHeartbeat = async (ctx: ExtensionContext, force?: "idle" | "busy" | "offline"): Promise<void> => {
    const current = binding;
    if (subagent || !current?.active || ctx.sessionManager.getSessionId() !== current.sessionId) return;
    const name = pi.getSessionName() || `${path.basename(ctx.cwd)}-${getSessionRef(current.sessionId)}`;
    lastRegisteredName = name;
    const entry: RegistryEntry = {
      v: 1, sessionId: current.sessionId, name, cwd: ctx.cwd, pid: process.pid,
      instanceId: current.owner.instanceId, startedAt: current.startedAt, heartbeatAt: Date.now(),
      status: force ?? (ctx.isIdle() ? "idle" : "busy"),
    };
    try { await writeRegistryEntry(root, entry); } catch (error) {
      trace(root, "heartbeat_unavailable", { sessionId: current.sessionId, error: String(error) });
    }
  };

  const setupSession = async (ctx: ExtensionContext): Promise<void> => {
    if (isSubagentSession(ctx)) {
      retire();
      subagent = true;
      const activeTools = pi.getActiveTools();
      const filtered = activeTools.filter((tool) => tool !== "list_pi" && tool !== "send_pi_message");
      if (filtered.length !== activeTools.length) void pi.setActiveTools(filtered);
      return;
    }
    subagent = false;
    const sessionId = ctx.sessionManager.getSessionId();
    if (binding?.active && binding.sessionId === sessionId) return;
    retire();
    const next: DeliveryBinding = {
      sessionId,
      owner: { instanceId: randomUUID(), pid: process.pid, generation },
      active: true,
      startedAt: Date.now(),
    };
    binding = next;
    retiredSessionId = "";
    clearInterval(reactivationTimer);
    reactivationTimer = undefined;
    await updateHeartbeat(ctx);
    if (!next.active || binding !== next || ctx.sessionManager.getSessionId() !== sessionId) return;
    const host = {
      isIdle: () => ctx.isIdle(),
      hasPendingMessages: () => ctx.hasPendingMessages(),
      getSessionId: () => ctx.sessionManager.getSessionId(),
      getSessionFile: () => ctx.sessionManager.getSessionFile(),
      sendMessage: (payload: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
        if (!next.active || binding !== next || ctx.sessionManager.getSessionId() !== next.sessionId) throw new Error("Peer delivery binding is no longer current");
        pi.sendMessage(payload, options);
      },
      getEntries: () => ctx.sessionManager.getEntries(),
    };
    const machine = new DeliveryStateMachine(root, sessionId, next.owner, host, () =>
      next.active && binding === next && ctx.sessionManager.getSessionId() === next.sessionId,
    );
    deliveryMachine = machine;
    await machine.start();
    if (!next.active || binding !== next || ctx.sessionManager.getSessionId() !== sessionId) { machine.stop(); return; }
    heartbeatTimer = setInterval(() => { void updateHeartbeat(ctx); }, 5000);
    heartbeatTimer.unref();
    if (!autocompleteInstalled) {
      autocompleteInstalled = true;
      installPeerAutocomplete(ctx, () => listSessions(root, binding?.sessionId ?? "", false));
    }
  };

  const reactivateIfCurrent = (ctx: ExtensionContext): void => {
    if (!binding && retiredSessionId && ctx.sessionManager.getSessionId() === retiredSessionId) void setupSession(ctx);
  };

  const pauseForTransition = (ctx: ExtensionContext): void => {
    retire();
    clearInterval(reactivationTimer);
    reactivationTimer = setInterval(() => {
      if (shuttingDown || binding?.active) {
        clearInterval(reactivationTimer);
        reactivationTimer = undefined;
        return;
      }
      // A canceled transition has no completion event in OMP 18.11.0. Retry the actually
      // selected session automatically; recipient tags still fence late host admissions.
      void setupSession(ctx).catch((error) => trace(root, "reactivation_unavailable", { error: String(error) }));
    }, 500);
    reactivationTimer.unref();
  };

  pi.on("session_start", async (_event, ctx) => { await setupSession(ctx); });
  pi.on("session_before_switch", (_event, ctx) => { if (!subagent) pauseForTransition(ctx); });
  pi.on("session_before_branch", (_event, ctx) => { if (!subagent) pauseForTransition(ctx); });
  pi.on("session_switch", async (_event, ctx) => { await setupSession(ctx); });
  pi.on("session_branch", async (_event, ctx) => { await setupSession(ctx); });
  pi.on("session_shutdown", () => {
    shuttingDown = true;
    clearInterval(reactivationTimer);
    reactivationTimer = undefined;
    if (!subagent) retire();
  });
  pi.on("turn_start", async (_event, ctx) => { reactivateIfCurrent(ctx); await updateHeartbeat(ctx, "busy"); });
  pi.on("agent_start", async (_event, ctx) => { reactivateIfCurrent(ctx); await updateHeartbeat(ctx, "busy"); });
  pi.on("turn_end", async (_event, ctx) => { await updateHeartbeat(ctx); void deliveryMachine?.processInbox(); });
  pi.on("agent_end", async (event, ctx) => { await updateHeartbeat(ctx); await deliveryMachine?.onAgentEnd(event.messages); void deliveryMachine?.processInbox(); });
  pi.on("message_end", async (event) => { await deliveryMachine?.onMessageEnd(event as Parameters<DeliveryStateMachine["onMessageEnd"]>[0]); });

  pi.on("context", (event, ctx) => {
    const currentSessionId = ctx.sessionManager.getSessionId();
    const seen = new Set<string>();
    let modified = false;
    const messages: AgentMessage[] = [];
    for (const message of event.messages) {
      if (message.role === "custom" && message.customType === "peer-message") {
        const details = message.details as { peerMessageId?: unknown; toSessionId?: unknown } | undefined;
        const peerMessageId = details?.peerMessageId;
        const intendedSessionId = details?.toSessionId;
        if (intendedSessionId !== currentSessionId || typeof peerMessageId !== "string" || seen.has(peerMessageId)) {
          modified = true;
          continue;
        }
        seen.add(peerMessageId);
      }
      messages.push(message);
    }
    return modified ? { messages } : undefined;
  });

  registerPeerRenderer(pi, () => binding?.sessionId ?? "");

  const listPiSchema = pi.typebox.Type.Object({
    include_offline: pi.typebox.Type.Optional(pi.typebox.Type.Boolean({ description: "Include offline sessions active in the last 7 days" })),
  });
  pi.registerTool({
    name: "list_pi", label: "List Pi Sessions", description: listPiDescription.trim(), loadMode: "essential", parameters: listPiSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (isSubagentSession(ctx)) return { isError: true, content: [{ type: "text", text: "Subagent sessions cannot call peer messaging tools." }] };
      const sessions = await listSessions(root, ctx.sessionManager.getSessionId(), params.include_offline === true);
      return { content: [{ type: "text", text: sessions.length ? sessions.map(formatSessionLine).join("\n") : "No other sessions found." }] };
    },
  });

  const sendPiMessageSchema = pi.typebox.Type.Object({
    target: pi.typebox.Type.String({ description: "Recipient sessionId, Name [ref], @Name [ref], unique prefix, or name" }),
    message: pi.typebox.Type.String({ description: "Message content (maximum 64 KiB UTF-8)" }),
    summary: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Optional one-line summary for TUI collapsed display" })),
  });
  pi.registerTool({
    name: "send_pi_message", label: "Send Pi Message", description: sendPiMessageDescription.trim(), loadMode: "essential", parameters: sendPiMessageSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (isSubagentSession(ctx)) return { isError: true, content: [{ type: "text", text: "Subagent sessions cannot call peer messaging tools." }] };
      const senderId = ctx.sessionManager.getSessionId();
      const bytes = Buffer.byteLength(params.message, "utf8");
      if (bytes > 64 * 1024) return { isError: true, content: [{ type: "text", text: `Message exceeds maximum allowed size of 64 KiB (size: ${bytes} bytes).` }] };
      const resolution = resolveTarget(params.target, senderId, await listSessions(root, senderId, true));
      if (!resolution.success) return { isError: true, content: [{ type: "text", text: resolution.error }] };
      const recipient = resolution.session;
      const envelope = {
        v: 1 as const, id: randomUUID(),
        from: { sessionId: senderId, name: lastRegisteredName || pi.getSessionName() || `${path.basename(ctx.cwd)}-${getSessionRef(senderId)}`, cwd: ctx.cwd },
        to: recipient.sessionId, summary: params.summary, body: params.message, sentAt: Date.now(),
      };
      await writeMessage(root, envelope);
      const receipt = recipient.isLive ? await waitForReceipt(root, senderId, envelope.id, 3000) : null;
      const status: SendPiMessageDetails["status"] = receipt ? "delivered" : recipient.isLive ? "queued" : "queued_offline";
      const details: SendPiMessageDetails = { status, mode: receipt?.mode, messageId: envelope.id, recipient: { sessionId: recipient.sessionId, name: recipient.name, cwd: recipient.cwd, live: recipient.isLive } };
      const text = receipt
        ? `Delivered to ${recipient.name} [${recipient.id8}]; confirmed in its persisted transcript.`
        : recipient.isLive
          ? `Stored durably for ${recipient.name} [${recipient.id8}]; waiting for transcript confirmation. Delivery continues automatically.`
          : `${recipient.name} [${recipient.id8}] is offline; the envelope is queued for its next persistent session.`;
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerCommand("peers", {
    description: "Display registered OMP peers and local mailbox status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const currentSessionId = ctx.sessionManager.getSessionId();
      const sessions = await listSessions(root, currentSessionId, true);
      const message = [
        "OMP Peers status:", `  Current session: ${currentSessionId}`, `  Mailbox directory: ${root}`,
        "  Delivery is at-least-once. Delivered means confirmed in the recipient transcript.",
        "  Ephemeral sessions without a persisted transcript cannot provide durable resume proof.", "", "Registered sessions:",
        `  Pending receipt: ${deliveryMachine?.getInFlightCount() ?? 0} message(s).`,
        ...(sessions.length ? sessions.map((session) => `  ${formatSessionLine(session)}`) : ["  (no other sessions found)"]),
      ].join("\n");
      ctx.ui?.notify?.(message);
    },
  });
}
