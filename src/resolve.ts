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
  const currentId8 = currentSessionId.slice(0, 8).toLowerCase();

  // Check self-target immediately
  if (
    cleaned === currentSessionId ||
    cleaned.toLowerCase() === currentSessionId.toLowerCase() ||
    cleaned.toLowerCase() === currentId8
  ) {
    return {
      success: false,
      error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
      kind: "self",
    };
  }

  // Step 1: Exact sessionId match
  const exactSession = candidates.find(
    (c) => c.sessionId.toLowerCase() === cleaned.toLowerCase()
  );
  if (exactSession) {
    return { success: true, session: exactSession };
  }

  // Step 2: Name [id8] / @Name [id8] match
  const bracketMatch = cleaned.match(/^(.+?)\s*\[([0-9a-fA-F]{8,})\]$/);
  if (bracketMatch) {
    const id8 = bracketMatch[2].toLowerCase();
    if (currentSessionId.toLowerCase().startsWith(id8)) {
      return {
        success: false,
        error: `Self-target is not allowed. Cannot send message to current session (${raw}).`,
        kind: "self",
      };
    }
    const matched = candidates.find((c) =>
      c.sessionId.toLowerCase().startsWith(id8)
    );
    if (matched) {
      return { success: true, session: matched };
    }
  }

  // Step 3: Unique sessionId prefix (>= 4 chars hex)
  if (cleaned.length >= 4 && /^[0-9a-fA-F-]+$/.test(cleaned)) {
    const prefixMatches = candidates.filter((c) =>
      c.sessionId.toLowerCase().startsWith(cleaned.toLowerCase())
    );
    if (prefixMatches.length === 1) {
      return { success: true, session: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      const list = prefixMatches.map(formatAmbiguousCandidate).join("\n  ");
      return {
        success: false,
        error: `Ambiguous session ID prefix "${cleaned}". Matches ${prefixMatches.length} sessions:\n  ${list}`,
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

  // Not found: list up to 5 live suggestions as Name [id8]
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
