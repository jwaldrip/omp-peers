import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@oh-my-pi/pi-tui";
import { installPeerAutocomplete, registerPeerRenderer } from "../src/ui.js";
import type { SessionInfo } from "../src/types.js";

type Suggestions = { items: AutocompleteItem[]; prefix: string };
type RenderMessage = Parameters<MessageRenderer>[0];

function rendererHarness(currentSessionId: () => string = () => "recipient"): MessageRenderer {
  let captured: MessageRenderer | undefined;
  const api = {
    registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>) {
      expect(customType).toBe("peer-message");
      captured = renderer as MessageRenderer;
    },
  } as unknown as ExtensionAPI;
  registerPeerRenderer(api, currentSessionId);
  if (!captured) throw new Error("Missing peer renderer");
  return captured;
}

function message(body: string, summary?: string, toSessionId = "recipient"): RenderMessage {
  return {
    role: "custom",
    customType: "peer-message",
    content: body,
    display: true,
    timestamp: 1,
    details: {
      peerMessageId: "message-id",
      toSessionId,
      from: { sessionId: "11111111-1111-1111-1111-123456789abc", name: "Main", cwd: "/work/omp-peers" },
      summary,
      body,
      sentAt: 1,
    },
  };
}

function render(renderer: MessageRenderer, value: RenderMessage, expanded: boolean, width: number): readonly string[] {
  const component = renderer(value, { expanded }, {} as Parameters<MessageRenderer>[2]);
  if (!component) throw new Error("Missing peer component");
  return component.render(width);
}

function recoverLines(rows: readonly string[], logicalLines: string[], width: number): string {
  let offset = 0;
  const recovered: string[] = [];
  for (const line of logicalLines) {
    const count = Math.max(1, Math.ceil(visibleWidth(line) / width));
    const joined = rows.slice(offset, offset + count).join("");
    recovered.push(joined.slice(0, line.length));
    expect(joined.slice(line.length)).toMatch(/^ *$/);
    offset += count;
  }
  expect(offset).toBe(rows.length);
  return recovered.join("\n");
}

function peer(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "22222222-2222-2222-2222-123456789abc",
    id8: "56789abc",
    name: "Main",
    cwd: "/work/omp-peers",
    branch: "fix/peer-ui",
    pid: process.pid,
    startedAt: 1,
    heartbeatAt: 1,
    status: "busy",
    effectiveStatus: "busy",
    isLive: true,
    ...overrides,
  };
}

function wrapProvider(base: AutocompleteProvider, listPeers: () => Promise<SessionInfo[]> = async () => [peer()]): AutocompleteProvider {
  let factory: Parameters<ExtensionContext["ui"]["addAutocompleteProvider"]>[0] | undefined;
  const ctx = {
    hasUI: true,
    ui: {
      addAutocompleteProvider(next: Parameters<ExtensionContext["ui"]["addAutocompleteProvider"]>[0]) {
        factory = next;
      },
    },
  } as unknown as ExtensionContext;
  installPeerAutocomplete(ctx, listPeers);
  if (!factory) throw new Error("Missing peer autocomplete factory");
  return factory(base);
}

class StatefulProvider implements AutocompleteProvider {
  #marker = "base";
  calls: { method: string; args: unknown[] }[] = [];
  suggestions: Suggestions | null = { items: [{ value: "@README.md", label: "@README.md" }], prefix: "@Ma" };
  applied = { lines: ["base"], cursorLine: 0, cursorCol: 4, onApplied: () => {} };

  #record(method: string, args: unknown[]): void {
    this.calls.push({ method: `${this.#marker}.${method}`, args });
  }

  async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>): Promise<Suggestions | null> {
    this.#record("getSuggestions", args);
    if (this.suggestions) args[4]?.(this.suggestions);
    return this.suggestions;
  }

  applyCompletion(...args: Parameters<AutocompleteProvider["applyCompletion"]>) {
    this.#record("applyCompletion", args);
    return this.applied;
  }

  getInlineHint(...args: Parameters<NonNullable<AutocompleteProvider["getInlineHint"]>>): string {
    this.#record("getInlineHint", args);
    return this.#marker;
  }

  trySyncSlashCompletion(...args: Parameters<NonNullable<AutocompleteProvider["trySyncSlashCompletion"]>>): Suggestions | null {
    this.#record("trySyncSlashCompletion", args);
    return this.suggestions;
  }

  trySyncInlineReplace(...args: Parameters<NonNullable<AutocompleteProvider["trySyncInlineReplace"]>>) {
    this.#record("trySyncInlineReplace", args);
    return { replaceLen: 3, insert: this.#marker };
  }

  async getForceFileSuggestions(...args: Parameters<NonNullable<AutocompleteProvider["getForceFileSuggestions"]>>): Promise<Suggestions | null> {
    this.#record("getForceFileSuggestions", args);
    return this.suggestions;
  }

  shouldTriggerFileCompletion(...args: Parameters<NonNullable<AutocompleteProvider["shouldTriggerFileCompletion"]>>): boolean {
    this.#record("shouldTriggerFileCompletion", args);
    return true;
  }
}

describe("peer renderer", () => {
  it("normalizes summary, sender and fallback previews to one safe physical row", () => {
    const renderer = rendererHarness();
    const value = message("first\tline\nsecond", "\x1b[31mready\t\r\nstatus\x1b[0m\x00\x07\x1b[2J");
    expect(render(renderer, value, false, 80)).toEqual(["peer Main [56789abc]: ready status"]);
    expect(render(renderer, message("first\tline\nsecond"), false, 80)).toEqual(["peer Main [56789abc]: first line"]);
    expect(render(renderer, message("first\tline\nsecond", " \r\n\t"), false, 80)).toEqual(["peer Main [56789abc]: first line"]);
    value.details = {
      ...(value.details as object),
      from: { name: "\x1b[31mMain\x1b[0m\t\nstatus\x07", sessionId: "12345678", cwd: "/work" },
    };
    expect(render(renderer, value, false, 80)).toEqual(["peer Main status [12345678]: ready status"]);
  });

  for (const width of [40, 80]) {
    it(`renders complete body and bounded rows at ${width} columns on the installed TUI`, () => {
      const renderer = rendererHarness();
      const digits = "0123456789".repeat(17);
      const wide = "界".repeat(85);
      const combining = "e\u0301".repeat(120);
      const body = `\x1b]0;status\x07\x1b[36m${digits}\x1b[0m\tEND\x00\x07\x1b[2J\r\n${wide}\n\n${combining}\nlast-line`;
      const summary = `\x1b[31mDeploy\tstatus\r\nready\x1b[0m\x07\x1b[2J ${"0123456789".repeat(11)}`;
      const header = `peer Main [56789abc]: Deploy status ready ${"0123456789".repeat(11)}`;
      const cleanBody = `${digits}   END\n${wide}\n\n${combining}\nlast-line`;
      const value = message(body, summary);
      const collapsed = render(renderer, value, false, width);
      const expanded = render(renderer, value, true, width);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]).toEndWith("…");
      for (const row of [...collapsed, ...expanded]) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        expect(row).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      }
      expect(recoverLines(expanded, [header, ...cleanBody.split("\n")], width)).toBe(`${header}\n${cleanBody}`);
      if (process.env.OMP_PEERS_UI_PROBE === "1") {
        process.stdout.write(`UI_RENDER_PROBE ${JSON.stringify({
          width,
          collapsedRows: collapsed.length,
          collapsedMaxWidth: Math.max(...collapsed.map(visibleWidth)),
          expandedRows: expanded.length,
          expandedMaxWidth: Math.max(...expanded.map(visibleWidth)),
          recoveredBodyCharacters: cleanBody.length,
          controlBytes: 0,
        })}\n${collapsed.map((row) => `collapsed |${row}|`).join("\n")}\n${expanded.map((row) => `expanded  |${row}|`).join("\n")}\n`);
      }
    });
  }

  it("checks the recipient again when an already-created component renders after a switch", () => {
    let selectedSession = "recipient";
    const renderer = rendererHarness(() => selectedSession);
    for (const expanded of [false, true]) {
      const component = renderer(message("body", "status"), { expanded }, {} as Parameters<MessageRenderer>[2]);
      if (!component) throw new Error("Missing peer component");
      expect(component.render(40).length).toBeGreaterThan(0);
      selectedSession = "other-recipient";
      expect(component.render(40)).toEqual([]);
      selectedSession = "recipient";
      expect(component.render(40).length).toBeGreaterThan(0);
    }
    expect(render(renderer, message("body", "status", "other-recipient"), true, 80)).toEqual([]);
    const missingRecipient = message("body");
    missingRecipient.details = undefined;
    expect(render(renderer, missingRecipient, false, 80)).toEqual([]);
  });
});

describe("peer autocomplete", () => {
  it("forwards cancellation, partial callbacks, optional hooks and their receiver", async () => {
    const base = new StatefulProvider();
    const wrapped = wrapProvider(base);
    const lines = ["@Ma"];
    const signal = new AbortController().signal;
    const partials: Suggestions[] = [];
    const onPartial = (result: Suggestions) => partials.push(result);
    const result = await wrapped.getSuggestions(lines, 0, 3, signal, onPartial);
    expect(base.calls[0]).toEqual({ method: "base.getSuggestions", args: [lines, 0, 3, signal, onPartial] });
    expect(partials).toEqual([base.suggestions!]);
    expect(result?.items[0]?.value).toBe("@Main [56789abc]");
    expect(result?.items[1]).toBe(base.suggestions?.items[0]);
    expect(wrapped.getInlineHint?.(lines, 0, 3)).toBe("base");
    expect(wrapped.trySyncSlashCompletion?.("/sta")).toBe(base.suggestions);
    expect(wrapped.trySyncInlineReplace?.("READ")).toEqual({ replaceLen: 3, insert: "base" });
    expect(await wrapped.getForceFileSuggestions?.(lines, 0, 3, signal)).toBe(base.suggestions);
    expect(wrapped.shouldTriggerFileCompletion?.(lines, 0, 3)).toBe(true);
    expect(base.calls.slice(1)).toEqual([
      { method: "base.getInlineHint", args: [lines, 0, 3] },
      { method: "base.trySyncSlashCompletion", args: ["/sta"] },
      { method: "base.trySyncInlineReplace", args: ["READ"] },
      { method: "base.getForceFileSuggestions", args: [lines, 0, 3, signal] },
      { method: "base.shouldTriggerFileCompletion", args: [lines, 0, 3] },
    ]);
  });

  it("delegates base items with identical peer values and completion callbacks intact", async () => {
    const base = new StatefulProvider();
    const fileItem = { value: "@Main [56789abc]", label: "@Main [56789abc]" };
    base.suggestions = { items: [fileItem], prefix: "@Ma" };
    const wrapped = wrapProvider(base);
    const result = await wrapped.getSuggestions(["@Ma"], 0, 3);
    expect(result?.items).toHaveLength(2);
    expect(wrapped.applyCompletion(["@Ma"], 0, 3, fileItem, "@Ma")).toBe(base.applied);
    expect(base.calls.at(-1)?.method).toBe("base.applyCompletion");
    const generated = result?.items[0];
    if (!generated) throw new Error("Missing peer candidate");
    expect(wrapped.applyCompletion(["@Ma"], 0, 3, generated, "@Ma")).toEqual({
      lines: ["@Main [56789abc] "], cursorLine: 0, cursorCol: 17,
    });
  });

  it("keeps peer ownership across refreshes and replaces only the live token", async () => {
    const base = new StatefulProvider();
    base.suggestions = null;
    const wrapped = wrapProvider(base);
    const result = await wrapped.getSuggestions(["send @Ma"], 0, 8);
    const generated = result?.items[0];
    if (!generated) throw new Error("Missing peer candidate");
    expect(await wrapped.getSuggestions(["@zz"], 0, 3)).toBeNull();
    const original = ["first line", "send @Main suffix", "last line"];
    expect(wrapped.applyCompletion(original, 1, 10, generated, "@Ma")).toEqual({
      lines: ["first line", "send @Main [56789abc]  suffix", "last line"], cursorLine: 1, cursorCol: 22,
    });
    expect(original).toEqual(["first line", "send @Main suffix", "last line"]);
  });

  it("preserves incompatible base prefixes and ordinary tokens without peer discovery", async () => {
    const base = new StatefulProvider();
    let discoveries = 0;
    const wrapped = wrapProvider(base, async () => { discoveries++; return [peer()]; });
    for (const prefix of ["Ma", "send @Ma", ""]) {
      base.suggestions = { items: [{ value: "README.md", label: "README.md" }], prefix };
      expect(await wrapped.getSuggestions(["send @Ma"], 0, 8)).toBe(base.suggestions);
    }
    for (const line of ["READ", "/sta", "Main@example.com", '@"Main']) {
      expect(await wrapped.getSuggestions([line], 0, line.length)).toBe(base.suggestions);
    }
    expect(discoveries).toBe(0);
  });

  it("adds name and ref matches when the base has no candidates and leaves misses intact", async () => {
    const base = new StatefulProvider();
    base.suggestions = null;
    const wrapped = wrapProvider(base, async () => [peer(), peer({ name: "PeerUIFix", id8: "1234abcd", effectiveStatus: "idle" })]);
    const result = await wrapped.getSuggestions(["@1234"], 0, 5);
    expect(result).toEqual({
      prefix: "@1234",
      items: [{ value: "@PeerUIFix [1234abcd]", label: "@PeerUIFix [1234abcd]", description: "idle - /work/omp-peers" }],
    });
    expect(await wrapped.getSuggestions(["@missing"], 0, 8)).toBeNull();
  });

  it("honors cancellation before and during peer discovery", async () => {
    const base = new StatefulProvider();
    base.suggestions = null;
    const aborted = new AbortController();
    aborted.abort();
    let discoveries = 0;
    const wrapped = wrapProvider(base, async () => { discoveries++; return [peer()]; });
    expect(await wrapped.getSuggestions(["@Ma"], 0, 3, aborted.signal)).toBeNull();
    expect(discoveries).toBe(0);
    const during = new AbortController();
    const cancelling = wrapProvider(base, async () => { during.abort(); return [peer()]; });
    expect(await cancelling.getSuggestions(["@Ma"], 0, 3, during.signal)).toBeNull();
  });

  it("preserves absent optional hooks and skips non-UI contexts", () => {
    const minimal: AutocompleteProvider = {
      async getSuggestions() { return null; },
      applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
    };
    const wrapped = wrapProvider(minimal);
    expect(wrapped.getInlineHint).toBeUndefined();
    expect(wrapped.trySyncSlashCompletion).toBeUndefined();
    expect(wrapped.trySyncInlineReplace).toBeUndefined();
    expect(wrapped.getForceFileSuggestions).toBeUndefined();
    expect(wrapped.shouldTriggerFileCompletion).toBeUndefined();
    installPeerAutocomplete({ hasUI: false } as ExtensionContext, async () => []);
    installPeerAutocomplete({ hasUI: true, ui: {} } as ExtensionContext, async () => []);
  });

  it("retains real 18.11.0 READ Tab, @file, inline hints and sync slash selection alongside @peer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-peers-ui-"));
    try {
      fs.writeFileSync(path.join(dir, "README.md"), "omp-peers");
      const base = new CombinedAutocompleteProvider([{ name: "status", getInlineHint: () => "status" }], dir);
      const wrapped = wrapProvider(base);
      const signal = new AbortController().signal;
      expect(wrapped.shouldTriggerFileCompletion?.(["READ"], 0, 4)).toBe(true);
      const forced = await wrapped.getForceFileSuggestions?.(["READ"], 0, 4, signal);
      const file = forced?.items.find((item) => item.value === "README.md");
      if (!file || !forced) throw new Error("Missing READ Tab file candidate");
      const fileApplied = wrapped.applyCompletion(["READ"], 0, 4, file, forced.prefix);
      expect(fileApplied).toEqual(base.applyCompletion(["READ"], 0, 4, file, forced.prefix));
      expect(fileApplied.lines).toEqual(["README.md"]);
      const atFiles = await wrapped.getSuggestions(["@READ"], 0, 5, signal);
      const atFile = atFiles?.items.find((item) => item.value === "@README.md");
      if (!atFile || !atFiles) throw new Error("Missing @file candidate");
      const atApplied = wrapped.applyCompletion(["@READ"], 0, 5, atFile, atFiles.prefix);
      expect(atApplied).toEqual(base.applyCompletion(["@READ"], 0, 5, atFile, atFiles.prefix));
      expect(atApplied.lines).toEqual(["@README.md "]);
      expect(wrapped.getInlineHint?.(["/status "], 0, 8)).toBe("status");
      const slash = wrapped.trySyncSlashCompletion?.("/sta");
      expect(slash?.items[0]?.value).toBe("status");
      if (!slash?.items[0]) throw new Error("Missing synchronous slash candidate");
      expect(wrapped.applyCompletion(["/sta"], 0, 4, slash.items[0], slash.prefix).lines).toEqual(["/status "]);
      const peers = await wrapped.getSuggestions(["@Ma"], 0, 3, signal);
      const selectedPeer = peers?.items.find((item) => item.value === "@Main [56789abc]");
      if (!selectedPeer || !peers) throw new Error("Missing @peer candidate");
      expect(wrapped.applyCompletion(["@Ma"], 0, 3, selectedPeer, peers.prefix).lines).toEqual(["@Main [56789abc] "]);
      if (process.env.OMP_PEERS_UI_PROBE === "1") {
        process.stdout.write(`UI_AUTOCOMPLETE_PROBE ${JSON.stringify({
          runtime: "18.11.0",
          forceFile: fileApplied.lines[0],
          atFile: atApplied.lines[0],
          inlineHint: wrapped.getInlineHint?.(["/status "], 0, 8),
          syncSlash: slash.items[0].value,
          peerSelection: selectedPeer.value,
          optionalInlineReplace: "forwarded with receiver in stateful probe",
        })}\n`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
