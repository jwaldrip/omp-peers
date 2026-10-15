import { describe, expect, it } from "bun:test";
import { getSessionRef } from "../src/registry.js";
import { resolveTarget } from "../src/resolve.js";
import type { SessionInfo } from "../src/types.js";

function makeSession(
  sessionId: string,
  name: string,
  status: "idle" | "busy" | "offline",
  isLive: boolean,
  cwd = "/Users/jwaldrip/dev/proj"
): SessionInfo {
  return {
    sessionId,
    id8: getSessionRef(sessionId),
    name,
    cwd,
    branch: "main",
    pid: 1234,
    startedAt: Date.now() - 10000,
    heartbeatAt: Date.now() - 2000,
    status,
    effectiveStatus: isLive ? status : "offline",
    isLive,
  };
}

describe("target resolution", () => {
  const currentSessionId = "01a13deb-c001-4000-8000-000000000001";
  const sLive1 = makeSession("01a13deb-a111-4000-8000-000000000002", "WorkerOne", "idle", true);
  const sLive2 = makeSession("01a13deb-b222-4000-8000-000000000003", "WorkerTwo", "busy", true);
  const sSharedPrefix1 = makeSession("01a13deb-c333-4000-8000-aaaa00000004", "PrefixAlpha", "idle", true);
  const sSharedPrefix2 = makeSession("01a13deb-d444-4000-8000-bbbb00000005", "PrefixBeta", "busy", true);
  const sLiveShared1 = makeSession("01a13deb-e555-4000-8000-cccc00000006", "SharedName", "idle", true);
  const sLiveShared2 = makeSession("01a13deb-f666-4000-8000-dddd00000007", "SharedName", "busy", true);
  const sOfflineOnly = makeSession("01a13deb-0777-4000-8000-eeee00000008", "OfflineWorker", "offline", false);

  const allSessions = [
    sLive1,
    sLive2,
    sSharedPrefix1,
    sSharedPrefix2,
    sLiveShared1,
    sLiveShared2,
    sOfflineOnly,
  ];

  it("resolves exact sessionId", () => {
    const res = resolveTarget(sLive1.sessionId, currentSessionId, allSessions);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.session.sessionId).toBe(sLive1.sessionId);
    }
  });

  it("resolves Name [ref] and @Name [ref] using tail ref", () => {
    const res1 = resolveTarget(`WorkerOne [${sLive1.id8}]`, currentSessionId, allSessions);
    expect(res1.success).toBe(true);
    if (res1.success) {
      expect(res1.session.sessionId).toBe(sLive1.sessionId);
    }

    const res2 = resolveTarget(`@WorkerOne [${sLive1.id8}]`, currentSessionId, allSessions);
    expect(res2.success).toBe(true);
    if (res2.success) {
      expect(res2.session.sessionId).toBe(sLive1.sessionId);
    }
  });

  it("resolves unique sessionId prefix (>= 4 chars)", () => {
    const res = resolveTarget("01a13deba111", currentSessionId, allSessions);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.session.sessionId).toBe(sLive1.sessionId);
    }
  });

  it("returns ambiguous error for non-unique prefix", () => {
    // All sessions start with 01a13deb
    const res = resolveTarget("01a13deb", currentSessionId, allSessions);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.kind).toBe("ambiguous");
      expect(res.error.toLowerCase()).toContain("ambiguous");
    }
  });

  it("resolves exact case-insensitive name with single live match", () => {
    const res = resolveTarget("workerone", currentSessionId, allSessions);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.session.sessionId).toBe(sLive1.sessionId);
    }
  });

  it("returns ambiguous error for exact name with multiple live matches", () => {
    const res = resolveTarget("SharedName", currentSessionId, allSessions);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.kind).toBe("ambiguous");
      expect(res.error.toLowerCase()).toContain("ambiguous");
      expect(res.error).toContain(sLiveShared1.id8);
      expect(res.error).toContain(sLiveShared2.id8);
      expect(res.error).toContain(sLiveShared1.cwd);
    }
  });

  it("resolves offline session by exact name when zero live matches exist", () => {
    const res = resolveTarget("OfflineWorker", currentSessionId, allSessions);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.session.sessionId).toBe(sOfflineOnly.sessionId);
    }
  });

  it("resolves unique case-insensitive substring among live sessions", () => {
    const res = resolveTarget("kerTwo", currentSessionId, allSessions);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.session.sessionId).toBe(sLive2.sessionId);
    }
  });

  it("returns not_found with live suggestions for unknown target", () => {
    const res = resolveTarget("NonExistentSession", currentSessionId, allSessions);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.kind).toBe("not_found");
      expect(res.error.toLowerCase()).toContain("not_found");
      expect(res.error).toContain("WorkerOne");
      expect(res.error).toContain("WorkerTwo");
    }
  });

  it("rejects self-target explicitly", () => {
    const resById = resolveTarget(currentSessionId, currentSessionId, allSessions);
    expect(resById.success).toBe(false);
    if (!resById.success) {
      expect(resById.kind).toBe("self");
      expect(resById.error.toLowerCase()).toContain("self-target");
    }

    const currentRef = getSessionRef(currentSessionId);
    const resByRef = resolveTarget(currentRef, currentSessionId, allSessions);
    expect(resByRef.success).toBe(false);
    if (!resByRef.success) {
      expect(resByRef.kind).toBe("self");
    }

    const resByName = resolveTarget(`Current [${currentRef}]`, currentSessionId, allSessions);
    expect(resByName.success).toBe(false);
    if (!resByName.success) {
      expect(resByName.kind).toBe("self");
    }
  });
});
