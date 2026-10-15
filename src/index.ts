import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { DeliveryStateMachine } from "./delivery.js";
import {
  getPeersDir,
  writeMessage,
  waitForReceipt,
  trace,
} from "./mailbox.js";
import {
  formatSessionLine,
  listSessions,
  markOfflineSync,
  writeRegistryEntry,
} from "./registry.js";
import { resolveTarget } from "./resolve.js";
import type { RegistryEntry, SendPiMessageDetails } from "./types.js";

export function isSubagentSession(ctx: ExtensionContext): boolean {
  // Check 1: session file inside parent session's artifacts directory
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    const parentSessionFile = `${path.dirname(sessionFile)}.jsonl`;
    try {
      if (fs.existsSync(parentSessionFile)) {
        return true;
      }
    } catch {
      // Ignore fs check failure
    }
  }

  // Check 2: system prompt contains subagent marker
  const systemPrompt = ctx.getSystemPrompt?.() || [];
  for (const part of systemPrompt) {
    if (
      part.includes("assigned to you by the main agent") ||
      part.includes("Yield protocol:") ||
      part.includes("§ Coop")
    ) {
      return true;
    }
  }

  return false;
}

export default function ompPeersExtension(pi: ExtensionAPI): void {
  const root = getPeersDir();
  let currentSessionId = "";
  let deliveryMachine: DeliveryStateMachine | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let lastRegisteredName = "";
  let isSubagent = false;

  const updateHeartbeat = async (ctx: ExtensionContext, forceStatus?: "idle" | "busy" | "offline"): Promise<void> => {
    if (isSubagent || !currentSessionId) return;
    const isIdle = forceStatus ? forceStatus === "idle" : ctx.isIdle();
    const status = forceStatus ?? (isIdle ? "idle" : "busy");
    const name = pi.getSessionName() || `${path.basename(ctx.cwd)}-${currentSessionId.slice(0, 8)}`;
    lastRegisteredName = name;

    const entry: RegistryEntry = {
      v: 1,
      sessionId: currentSessionId,
      name,
      cwd: ctx.cwd,
      pid: process.pid,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      status,
    };

    try {
      await writeRegistryEntry(root, entry);
    } catch {
      // Ignore heartbeat write failure
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (isSubagentSession(ctx)) {
      isSubagent = true;
      const activeTools = pi.getActiveTools();
      const filtered = activeTools.filter((t) => t !== "list_pi" && t !== "send_pi_message");
      if (filtered.length !== activeTools.length) {
        void pi.setActiveTools(filtered);
      }
      return;
    }

    currentSessionId = ctx.sessionManager.getSessionId();
    trace(root, "session_start", { sessionId: currentSessionId, cwd: ctx.cwd });

    await updateHeartbeat(ctx);

    // Start delivery state machine
    const host = {
      isIdle: () => ctx.isIdle(),
      hasPendingMessages: () => ctx.hasPendingMessages(),
      sendMessage: (payload: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
        pi.sendMessage(payload, options);
      },
      getEntries: () => ctx.sessionManager.getEntries(),
    };

    deliveryMachine = new DeliveryStateMachine(root, currentSessionId, process.pid, host);
    await deliveryMachine.start();

    // Heartbeat every 5s
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      void updateHeartbeat(ctx);
    }, 5000);
    heartbeatTimer.unref();

    // Autocomplete provider for '@'
    if (ctx.hasUI && typeof ctx.ui?.addAutocompleteProvider === "function") {
      try {
        ctx.ui.addAutocompleteProvider((baseProvider) => {
          return {
            async getSuggestions(lines, cursorLine, cursorCol) {
              const line = lines[cursorLine] || "";
              const textBeforeCursor = line.slice(0, cursorCol);
              const atMatch = textBeforeCursor.match(/@(\S*)$/);
              if (!atMatch) {
                return baseProvider.getSuggestions(lines, cursorLine, cursorCol);
              }
              const query = atMatch[1].toLowerCase();
              const sessions = await listSessions(root, currentSessionId, false);
              const matched = sessions.filter(
                (s) =>
                  s.name.toLowerCase().includes(query) ||
                  s.id8.toLowerCase().includes(query)
              );
              const items = matched.map((s) => ({
                value: `@${s.name} [${s.id8}]`,
                label: `@${s.name} [${s.id8}]`,
                description: `${s.effectiveStatus} - ${s.cwd}`,
              }));
              return {
                items,
                prefix: atMatch[0],
              };
            },
            applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
              if (item.value.startsWith("@")) {
                const line = lines[cursorLine] || "";
                const before = line.slice(0, cursorCol - prefix.length);
                const after = line.slice(cursorCol);
                const newLine = before + item.value + " " + after;
                const newLines = [...lines];
                newLines[cursorLine] = newLine;
                return {
                  lines: newLines,
                  cursorLine,
                  cursorCol: before.length + item.value.length + 1,
                };
              }
              return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            },
          };
        });
      } catch {
        // Autocomplete setup skipped if not supported
      }
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (isSubagent) return;
    if (currentSessionId) {
      markOfflineSync(root, currentSessionId);
    }
    if (deliveryMachine) {
      deliveryMachine.stop();
    }

    currentSessionId = ctx.sessionManager.getSessionId();
    await updateHeartbeat(ctx);

    const host = {
      isIdle: () => ctx.isIdle(),
      hasPendingMessages: () => ctx.hasPendingMessages(),
      sendMessage: (payload: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
        pi.sendMessage(payload, options);
      },
      getEntries: () => ctx.sessionManager.getEntries(),
    };

    deliveryMachine = new DeliveryStateMachine(root, currentSessionId, process.pid, host);
    await deliveryMachine.start();
  });

  pi.on("session_branch", async (_event, ctx) => {
    if (isSubagent) return;
    if (currentSessionId) {
      markOfflineSync(root, currentSessionId);
    }
    if (deliveryMachine) {
      deliveryMachine.stop();
    }

    currentSessionId = ctx.sessionManager.getSessionId();
    await updateHeartbeat(ctx);

    const host = {
      isIdle: () => ctx.isIdle(),
      hasPendingMessages: () => ctx.hasPendingMessages(),
      sendMessage: (payload: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
        pi.sendMessage(payload, options);
      },
      getEntries: () => ctx.sessionManager.getEntries(),
    };

    deliveryMachine = new DeliveryStateMachine(root, currentSessionId, process.pid, host);
    await deliveryMachine.start();
  });

  pi.on("turn_start", async (_event, ctx) => {
    await updateHeartbeat(ctx, "busy");
  });

  pi.on("agent_start", async (_event, ctx) => {
    await updateHeartbeat(ctx, "busy");
  });

  pi.on("turn_end", async (_event, ctx) => {
    await updateHeartbeat(ctx);
    if (deliveryMachine) {
      void deliveryMachine.processInbox();
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    await updateHeartbeat(ctx);
    if (deliveryMachine) {
      await deliveryMachine.onAgentEnd(event.messages);
      void deliveryMachine.processInbox();
    }
  });

  pi.on("message_end", async (event) => {
    if (deliveryMachine) {
      await deliveryMachine.onMessageEnd(event as Parameters<DeliveryStateMachine["onMessageEnd"]>[0]);
    }
  });

  pi.on("session_shutdown", (_event) => {
    if (isSubagent) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;

    if (deliveryMachine) {
      deliveryMachine.stop();
      deliveryMachine = null;
    }

    if (currentSessionId) {
      markOfflineSync(root, currentSessionId);
    }
  });

  // Context deduplication: drop duplicate peer-message IDs
  pi.on("context", (event) => {
    const seenIds = new Set<string>();
    let modified = false;
    const filtered: AgentMessage[] = [];

    for (const msg of event.messages) {
      if (msg.role === "custom" && msg.customType === "peer-message") {
        const details = msg.details as { peerMessageId?: string } | undefined;
        const peerId = details?.peerMessageId;
        if (peerId) {
          if (seenIds.has(peerId)) {
            modified = true;
            continue;
          }
          seenIds.add(peerId);
        }
      }
      filtered.push(msg);
    }

    if (modified) {
      return { messages: filtered };
    }
  });

  // Message renderer
  pi.registerMessageRenderer("peer-message", (message, options) => {
    const details = message.details as {
      from?: { name?: string; sessionId?: string };
      summary?: string;
      body?: string;
    } | undefined;
    const name = details?.from?.name ?? "peer";
    const id8 = (details?.from?.sessionId ?? "").slice(0, 8);
    const body = details?.body ?? (typeof message.content === "string" ? message.content : "");
    const firstLine = body.split("\n")[0] ?? "";
    const summary = details?.summary || firstLine;
    const header = `peer ${name} [${id8}]: ${summary}`;

    if (!options.expanded) {
      return {
        render() {
          return [header];
        },
      };
    }

    return {
      render() {
        return [header, ...body.split("\n")];
      },
    };
  });

  // Register list_pi tool
  const listPiSchema = pi.typebox.Type.Object({
    include_offline: pi.typebox.Type.Optional(
      pi.typebox.Type.Boolean({
        description: "Include offline sessions active in the last 7 days",
      })
    ),
  });

  pi.registerTool({
    name: "list_pi",
    label: "List Pi Sessions",
    description: "List other active or offline OMP sessions on this machine.",
    loadMode: "essential",
    parameters: listPiSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (isSubagentSession(ctx)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Subagent sessions cannot call peer messaging tools." }],
        };
      }

      const activeSessionId = ctx.sessionManager?.getSessionId() || currentSessionId;
      const sessions = await listSessions(root, activeSessionId, params.include_offline === true);

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No other sessions found." }],
        };
      }

      const lines = sessions.map(formatSessionLine);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });

  // Register send_pi_message tool
  const sendPiMessageSchema = pi.typebox.Type.Object({
    target: pi.typebox.Type.String({
      description: "Recipient sessionId, Name [id8], @Name [id8], unique prefix, or name",
    }),
    message: pi.typebox.Type.String({
      description: "Message content (maximum 64 KiB UTF-8)",
    }),
    summary: pi.typebox.Type.Optional(
      pi.typebox.Type.String({
        description: "Optional one-line summary for TUI collapsed display",
      })
    ),
  });

  pi.registerTool({
    name: "send_pi_message",
    label: "Send Pi Message",
    description: "Send a message to another OMP session on this machine.",
    loadMode: "essential",
    parameters: sendPiMessageSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (isSubagentSession(ctx)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Subagent sessions cannot call peer messaging tools." }],
        };
      }

      const activeSessionId = ctx.sessionManager?.getSessionId() || currentSessionId;

      // Message size cap: 64 KiB UTF-8
      const byteLength = Buffer.byteLength(params.message, "utf8");
      if (byteLength > 64 * 1024) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Message exceeds maximum allowed size of 64 KiB (size: ${byteLength} bytes).`,
            },
          ],
        };
      }

      // Query candidates (including offline)
      const candidates = await listSessions(root, activeSessionId, true);
      const resolution = resolveTarget(params.target, activeSessionId, candidates);

      if (!resolution.success) {
        return {
          isError: true,
          content: [{ type: "text", text: resolution.error }],
        };
      }

      const recipient = resolution.session;
      const messageId = randomUUID();
      const senderName =
        lastRegisteredName ||
        pi.getSessionName() ||
        `${path.basename(ctx.cwd)}-${activeSessionId.slice(0, 8)}`;

      const envelope = {
        v: 1 as const,
        id: messageId,
        from: {
          sessionId: activeSessionId,
          name: senderName,
          cwd: ctx.cwd,
        },
        to: recipient.sessionId,
        summary: params.summary,
        body: params.message,
        sentAt: Date.now(),
      };

      // Write durably to recipient's inbox
      await writeMessage(root, envelope);

      let status: "delivered" | "queued" | "queued_offline" = "queued";
      let mode: "woke" | "steered" | "appended" | undefined;
      let responseText = "";

      if (recipient.isLive) {
        // Wait up to 3s for receipt
        const receipt = await waitForReceipt(root, activeSessionId, messageId, 3000);
        if (receipt) {
          status = "delivered";
          mode = receipt.mode;
          if (mode === "woke") {
            responseText = `Delivered to ${recipient.name} [${recipient.id8}]; started a turn.`;
          } else if (mode === "steered") {
            responseText = `Delivered to ${recipient.name} [${recipient.id8}]; injected into its running turn.`;
          } else {
            responseText = `Delivered to ${recipient.name} [${recipient.id8}]; appended.`;
          }
        } else {
          status = "queued";
          responseText = `${recipient.name} [${recipient.id8}] is busy; stored durably and will be injected at its next step boundary.`;
        }
      } else {
        status = "queued_offline";
        responseText = `${recipient.name} [${recipient.id8}] is not running; stored durably and delivered when that session resumes.`;
      }

      const details: SendPiMessageDetails = {
        status,
        mode,
        messageId,
        recipient: {
          sessionId: recipient.sessionId,
          name: recipient.name,
          cwd: recipient.cwd,
          live: recipient.isLive,
        },
      };

      return {
        content: [{ type: "text", text: responseText }],
        details,
      };
    },
  });

  // Register /peers slash command
  pi.registerCommand("peers", {
    description: "Display registered OMP peers and local mailbox status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const activeSessionId = ctx.sessionManager?.getSessionId() || currentSessionId;
      const sessions = await listSessions(root, activeSessionId, true);

      const inboxDir = path.join(root, "inbox", activeSessionId);
      let pendingCount = 0;
      let claimedCount = 0;

      try {
        const inboxFiles = await fs.promises.readdir(inboxDir);
        pendingCount = inboxFiles.filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
      } catch {}

      try {
        const claimedBase = path.join(inboxDir, "claimed");
        const pids = await fs.promises.readdir(claimedBase);
        for (const p of pids) {
          const files = await fs.promises.readdir(path.join(claimedBase, p));
          claimedCount += files.filter((f) => f.endsWith(".json")).length;
        }
      } catch {}

      const inFlightCount = deliveryMachine?.getInFlightCount() ?? 0;

      const lines: string[] = [
        "OMP Peers status:",
        `  Current session: ${activeSessionId}`,
        `  Mailbox directory: ${root}`,
        `  Inbox state: ${pendingCount} pending, ${claimedCount} claimed, ${inFlightCount} in-flight`,
        "",
        "Registered sessions:",
      ];

      if (sessions.length === 0) {
        lines.push("  (no other sessions found)");
      } else {
        for (const s of sessions) {
          lines.push(`  ${formatSessionLine(s)}`);
        }
      }

      if (ctx.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(lines.join("\n"));
      } else {
        process.stdout.write(lines.join("\n") + "\n");
      }
    },
  });
}
