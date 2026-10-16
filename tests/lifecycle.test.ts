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
      instanceId: "shutdown-instance",
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
    } as unknown as ExtensionContext;

    expect(isSubagentSession(mockSubagentContext)).toBe(true);

    const mockParentContext = {
      sessionManager: {
        getSessionFile: () => parentSessionFile,
        getSessionId: () => "parent",
      },
    } as unknown as ExtensionContext;

    expect(isSubagentSession(mockParentContext)).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
