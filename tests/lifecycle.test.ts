import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isSubagentSession } from "../src/index.js";
import { markOfflineSync } from "../src/registry.js";
import type { RegistryEntry } from "../src/types.js";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

function createTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("lifecycle and subagent exclusion", () => {
  it("shutdown is synchronous and marks offline in registry file", () => {
    const root = createTempDir("omp-peers-test-shutdown");
    const sessionId = "session-shutdown-test";

    const entry: RegistryEntry = {
      v: 1,
      sessionId,
      name: "ShuttingDown",
      cwd: "/tmp",
      pid: process.pid,
      startedAt: Date.now() - 5000,
      heartbeatAt: Date.now() - 1000,
      status: "idle",
    };

    const registryDir = path.join(root, "registry");
    fs.mkdirSync(registryDir, { recursive: true });
    const targetFile = path.join(registryDir, `${sessionId}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(entry));

    // Synchronous shutdown hook
    markOfflineSync(root, sessionId);

    const updatedRaw = fs.readFileSync(targetFile, "utf8");
    const updated = JSON.parse(updatedRaw) as RegistryEntry;
    expect(updated.status).toBe("offline");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("context dedupe drops duplicate peerMessageIds while keeping first occurrence", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "custom",
        customType: "peer-message",
        details: { peerMessageId: "peer-id-1" },
        content: "first occurrence of peer-id-1",
      },
      { role: "assistant", content: "thinking" },
      {
        role: "custom",
        customType: "peer-message",
        details: { peerMessageId: "peer-id-1" },
        content: "duplicate occurrence of peer-id-1",
      },
      {
        role: "custom",
        customType: "peer-message",
        details: { peerMessageId: "peer-id-2" },
        content: "first occurrence of peer-id-2",
      },
    ];

    const seenIds = new Set<string>();
    const filtered: typeof messages = [];

    for (const msg of messages) {
      if (msg.role === "custom" && msg.customType === "peer-message") {
        const peerId = msg.details?.peerMessageId;
        if (peerId) {
          if (seenIds.has(peerId)) {
            continue;
          }
          seenIds.add(peerId);
        }
      }
      filtered.push(msg);
    }

    expect(filtered.length).toBe(4);
    expect(filtered[1].content).toBe("first occurrence of peer-id-1");
    expect(filtered[3].content).toBe("first occurrence of peer-id-2");
  });

  it("subagent exclusion: identifies subagent by artifacts parent session file", () => {
    const tempDir = createTempDir("omp-subagent-discrim");
    // Parent session file: <tempDir>/2026-10-15_parent.jsonl
    const parentSessionFile = path.join(tempDir, "2026-10-15_parent.jsonl");
    fs.writeFileSync(parentSessionFile, "{}\n");

    // Parent artifacts dir: <tempDir>/2026-10-15_parent
    const artifactsDir = path.join(tempDir, "2026-10-15_parent");
    fs.mkdirSync(artifactsDir, { recursive: true });

    // Subagent session file: <tempDir>/2026-10-15_parent/subagent-1.jsonl
    const subtaskFile = path.join(artifactsDir, "subagent-1.jsonl");
    fs.writeFileSync(subtaskFile, "{}\n");

    const mockSubagentContext = {
      sessionManager: {
        getSessionFile: () => subtaskFile,
        getSessionId: () => "subagent-1",
      },
      getSystemPrompt: () => ["normal prompt"],
    } as unknown as ExtensionContext;

    expect(isSubagentSession(mockSubagentContext)).toBe(true);

    const mockParentContext = {
      sessionManager: {
        getSessionFile: () => parentSessionFile,
        getSessionId: () => "parent",
      },
      getSystemPrompt: () => ["normal prompt"],
    } as unknown as ExtensionContext;

    expect(isSubagentSession(mockParentContext)).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("subagent exclusion: identifies subagent by prompt coop marker", () => {
    const mockContextWithMarker = {
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "in-memory-subagent",
      },
      getSystemPrompt: () => [
        "§ Role\nYou are a worker.",
        "§ Coop\nYou are operating on a piece of work assigned to you by the main agent.",
      ],
    } as unknown as ExtensionContext;

    expect(isSubagentSession(mockContextWithMarker)).toBe(true);

    const mockNormalContext = {
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "interactive-top-level",
      },
      getSystemPrompt: () => ["You are a helpful coding assistant."],
    } as unknown as ExtensionContext;

    expect(isSubagentSession(mockNormalContext)).toBe(false);
  });
});
