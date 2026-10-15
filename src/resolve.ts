import { getSessionRef } from "./registry.js";
import type { SessionInfo } from "./types.js";

export interface TargetResolved {
  success: true;
  session: SessionInfo;
}

export interface TargetResolutionFailed {
  success: false;
  error: string;
  kind: "self" | "ambiguous" | "not_found";
}

export type TargetResolution = TargetResolved | TargetResolutionFailed;

function formatAmbiguousCandidate(candidate: SessionInfo): string {
  return `${candidate.name} [${candidate.id8}] - ${candidate.effectiveStatus} - ${candidate.cwd}`;
}

export function resolveTarget(
  target: string,
  currentSessionId: string,
  candidates: SessionInfo[]
): TargetResolution {
  const raw = target.trim();
  if (!raw) {
    return {
      success: false,
      error: "not_found: Target identifier is empty.",
      kind: "not_found",
    };
  }

  // Strip leading '@' if provided
  const cleaned = raw.startsWith("@") ? raw.slice(1).trim() : raw;
  const cleanCurrentId = currentSessionId.replace(/-/g, "").toLowerCase();

  // Check exact self-target by full sessionId
  if (
    cleaned === currentSessionId ||
    cleaned.toLowerCase() === currentSessionId.toLowerCase() ||
    cleaned.replace(/-/g, "").toLowerCase() === cleanCurrentId
  ) {
    return {
      success: false,
      error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
      kind: "self",
    };
  }

  // Step 1: Exact sessionId match among candidates
  const exactSession = candidates.find(
    (c) =>
      c.sessionId.toLowerCase() === cleaned.toLowerCase() ||
      c.sessionId.replace(/-/g, "").toLowerCase() === cleaned.replace(/-/g, "").toLowerCase()
  );
  if (exactSession) {
    return { success: true, session: exactSession };
  }

  // Step 2: Name [ref] / @Name [ref] match
  // ref matches when it equals the tail ref (last 8 hex chars), or is a prefix of full ID (hyphens ignored)
  const bracketMatch = cleaned.match(/^(.+?)\s*\[([0-9a-fA-F-]+)\]$/);
  if (bracketMatch) {
    const targetName = bracketMatch[1].trim().toLowerCase();
    const refRaw = bracketMatch[2].toLowerCase();
    const cleanRef = refRaw.replace(/-/g, "");

    const refMatches = candidates.filter((c) => {
      const cRef = c.id8.toLowerCase();
      const cFullClean = c.sessionId.replace(/-/g, "").toLowerCase();
      return cRef === refRaw || cFullClean.startsWith(cleanRef);
    });

    if (refMatches.length === 1) {
      if (refMatches[0].sessionId.toLowerCase() === currentSessionId.toLowerCase()) {
        return {
          success: false,
          error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
          kind: "self",
        };
      }
      return { success: true, session: refMatches[0] };
    }

    if (refMatches.length > 1) {
      const nameAndRefMatches = refMatches.filter(
        (c) => c.name.toLowerCase() === targetName
      );
      if (nameAndRefMatches.length === 1) {
        if (nameAndRefMatches[0].sessionId.toLowerCase() === currentSessionId.toLowerCase()) {
          return {
            success: false,
            error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
            kind: "self",
          };
        }
        return { success: true, session: nameAndRefMatches[0] };
      }
      if (nameAndRefMatches.length > 1) {
        const list = nameAndRefMatches.map(formatAmbiguousCandidate).join("\n  ");
        return {
          success: false,
          error: `Ambiguous target "${cleaned}". Matches ${nameAndRefMatches.length} sessions:\n  ${list}`,
          kind: "ambiguous",
        };
      }
      const list = refMatches.map(formatAmbiguousCandidate).join("\n  ");
      return {
        success: false,
        error: `Ambiguous target "${cleaned}". Matches ${refMatches.length} sessions:\n  ${list}`,
        kind: "ambiguous",
      };
    }

    // Check if target was current session
    const currentRef = getSessionRef(currentSessionId).toLowerCase();
    if (currentRef === refRaw || cleanCurrentId.startsWith(cleanRef) || cleanCurrentId.endsWith(cleanRef)) {
      return {
        success: false,
        error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
        kind: "self",
      };
    }
  }

  // Step 3: Unique sessionId prefix or tail ref (>= 4 chars hex, hyphens ignored)
  const cleanTarget = cleaned.replace(/-/g, "");
  if (cleanTarget.length >= 4 && /^[0-9a-fA-F]+$/.test(cleanTarget)) {
    const targetMatches = candidates.filter((c) => {
      const cFullClean = c.sessionId.replace(/-/g, "").toLowerCase();
      const cRef = c.id8.toLowerCase();
      return cRef === cleanTarget.toLowerCase() || cFullClean.startsWith(cleanTarget.toLowerCase());
    });

    const matchesSelf =
      cleanCurrentId.startsWith(cleanTarget.toLowerCase()) ||
      cleanCurrentId.endsWith(cleanTarget.toLowerCase());

    if (targetMatches.length === 1 && !matchesSelf) {
      return { success: true, session: targetMatches[0] };
    }

    if (targetMatches.length === 0 && matchesSelf) {
      return {
        success: false,
        error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
        kind: "self",
      };
    }

    if (targetMatches.length > 1) {
      const list = targetMatches.map(formatAmbiguousCandidate).join("\n  ");
      return {
        success: false,
        error: `Ambiguous session identifier "${cleaned}". Matches ${targetMatches.length} sessions:\n  ${list}`,
        kind: "ambiguous",
      };
    }
  }

  // Step 4: Exact case-insensitive name
  const nameMatches = candidates.filter(
    (c) => c.name.toLowerCase() === cleaned.toLowerCase()
  );
  if (nameMatches.length > 0) {
    const liveMatches = nameMatches.filter((c) => c.isLive);
    if (liveMatches.length === 1) {
      return { success: true, session: liveMatches[0] };
    }
    if (liveMatches.length > 1) {
      const list = liveMatches.map(formatAmbiguousCandidate).join("\n  ");
      return {
        success: false,
        error: `Ambiguous target name "${cleaned}". Matches ${liveMatches.length} live sessions:\n  ${list}`,
        kind: "ambiguous",
      };
    }
    // Zero live matches, check offline matches
    const offlineMatches = nameMatches.filter((c) => !c.isLive);
    if (offlineMatches.length === 1) {
      return { success: true, session: offlineMatches[0] };
    }
    if (offlineMatches.length > 1) {
      const list = offlineMatches.map(formatAmbiguousCandidate).join("\n  ");
      return {
        success: false,
        error: `Ambiguous offline target name "${cleaned}". Matches ${offlineMatches.length} sessions:\n  ${list}`,
        kind: "ambiguous",
      };
    }
  }

  // Step 5: Unique case-insensitive substring among live sessions
  const liveCandidates = candidates.filter((c) => c.isLive);
  const substringMatches = liveCandidates.filter((c) =>
    c.name.toLowerCase().includes(cleaned.toLowerCase())
  );
  if (substringMatches.length === 1) {
    return { success: true, session: substringMatches[0] };
  }
  if (substringMatches.length > 1) {
    const list = substringMatches.map(formatAmbiguousCandidate).join("\n  ");
    return {
      success: false,
      error: `Ambiguous substring match for "${cleaned}". Matches ${substringMatches.length} live sessions:\n  ${list}`,
      kind: "ambiguous",
    };
  }

  // Not found: list up to 5 live suggestions as Name [ref]
  const suggestions = liveCandidates.slice(0, 5).map((c) => `${c.name} [${c.id8}]`);
  let suggestionsText = "No live sessions currently registered.";
  if (suggestions.length > 0) {
    suggestionsText = `Available live sessions:\n  ${suggestions.join("\n  ")}`;
  }

  return {
    success: false,
    error: `not_found: No session matches "${target}". ${suggestionsText}`,
    kind: "not_found",
  };
}
