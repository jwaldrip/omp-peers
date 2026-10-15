import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  Text,
  replaceTabs,
  truncateToWidth,
  wrapLiteralLine,
  type AutocompleteItem,
} from "@oh-my-pi/pi-tui";
import { getSessionRef } from "./registry.js";
import type { SessionInfo } from "./types.js";

interface PeerMessageDetails {
  peerMessageId: string;
  toSessionId: string;
  from: { sessionId: string; name: string; cwd: string };
  summary?: string;
  body: string;
  sentAt: number;
}

function plainText(text: string): string {
  return replaceTabs(stripVTControlCharacters(text))
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function singleLine(text: string): string {
  return plainText(text).replace(/\s+/g, " ").trim();
}

export function registerPeerRenderer(pi: ExtensionAPI, currentSessionId: () => string): void {
  pi.registerMessageRenderer<PeerMessageDetails>("peer-message", (message, options) => {
    const details = message.details;
    const name = singleLine(details?.from.name ?? "") || "peer";
    const ref = singleLine(getSessionRef(details?.from.sessionId ?? ""));
    const body = plainText(details?.body ?? (typeof message.content === "string" ? message.content : ""));
    const summary = singleLine(details?.summary ?? "") || singleLine(body.split("\n", 1)[0] ?? "");
    const header = `peer ${name} [${ref}]: ${summary}`;
    // Literal wrapping preserves spaces and indentation in peer-supplied code as well as prose.
    const expanded = options.expanded
      ? new Text(`${header}\n${body}`, 0, 0).setWrapLine(wrapLiteralLine)
      : undefined;

    return {
      render(width) {
        // Check on every render: a previously built component can outlive a session switch.
        if (details?.toSessionId !== currentSessionId()) return [];
        if (width <= 0) return [""];
        return expanded ? expanded.render(width) : [truncateToWidth(header, width)];
      },
      invalidate() {
        expanded?.invalidate();
      },
    };
  });
}

function peerPrefix(line: string, cursorCol: number): string | undefined {
  // Use the built-in file provider's token boundaries, including quoted/assigned tokens.
  return line.slice(0, cursorCol).match(/(?:^|[ \t"'=])(@[^\s"'=]*)$/)?.[1];
}

export function installPeerAutocomplete(ctx: ExtensionContext, listPeers: () => Promise<SessionInfo[]>): void {
  if (!ctx.hasUI || typeof ctx.ui?.addAutocompleteProvider !== "function") return;

  ctx.ui.addAutocompleteProvider((baseProvider) => {
    // Identity, rather than value, keeps identically named file items with their own provider.
    const peerItems = new WeakSet<AutocompleteItem>();

    return {
      async getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
        const baseResult = await baseProvider.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);
        const prefix = peerPrefix(lines[cursorLine] ?? "", cursorCol);
        if (!prefix || signal?.aborted || (baseResult && baseResult.prefix !== prefix)) return baseResult;

        const query = prefix.slice(1).toLowerCase();
        const sessions = await listPeers();
        if (signal?.aborted) return baseResult;
        const items = sessions
          .filter((session) => session.name.toLowerCase().includes(query) || session.id8.toLowerCase().includes(query))
          .map((session) => {
            const item: AutocompleteItem = {
              value: `@${session.name} [${session.id8}]`,
              label: `@${session.name} [${session.id8}]`,
              description: `${session.effectiveStatus} - ${session.cwd}`,
            };
            peerItems.add(item);
            return item;
          });
        if (items.length === 0) return baseResult;
        return { items: [...items, ...(baseResult?.items ?? [])], prefix };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const line = lines[cursorLine] ?? "";
        const livePrefix = peerPrefix(line, cursorCol);
        if (!peerItems.has(item) || !livePrefix) {
          return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        }
        const before = line.slice(0, cursorCol - livePrefix.length);
        const after = line.slice(cursorCol);
        const newLines = [...lines];
        newLines[cursorLine] = `${before}${item.value} ${after}`;
        return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
      },
      getInlineHint: baseProvider.getInlineHint?.bind(baseProvider),
      trySyncSlashCompletion: baseProvider.trySyncSlashCompletion?.bind(baseProvider),
      trySyncInlineReplace: baseProvider.trySyncInlineReplace?.bind(baseProvider),
      getForceFileSuggestions: baseProvider.getForceFileSuggestions?.bind(baseProvider),
      shouldTriggerFileCompletion: baseProvider.shouldTriggerFileCompletion?.bind(baseProvider),
    };
  });
}
