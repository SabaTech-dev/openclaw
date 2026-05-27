import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { uniqueStrings } from "../shared/string-normalization.js";

export { loadCombinedSessionEntriesForGateway } from "../config/sessions/combined-session-entries-gateway.js";

export type SessionTranscriptHitIdentity = {
  stem: string;
  liveStem?: string;
  ownerAgentId?: string;
  archived?: boolean;
};

const TRANSCRIPT_KEY_PREFIX = "transcript:";
const USAGE_COUNTED_SESSION_ID_RE = /^(.+)\.jsonl\.(?:reset|deleted)\..+$/;
const QMD_ARCHIVE_STEM_RE = /^(.+)-jsonl-(reset|deleted)-(.+)$/;
const QMD_ARCHIVE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[tT](\d{2}-\d{2}-\d{2})(?:(?:\.|-)(\d{3}))?[zZ]$/;

function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  const match = USAGE_COUNTED_SESSION_ID_RE.exec(fileName);
  return match?.[1] ?? null;
}

function restoreQmdNormalizedArchiveTimestamp(timestamp: string): string | null {
  const match = QMD_ARCHIVE_TIMESTAMP_RE.exec(timestamp);
  if (!match) {
    return null;
  }
  const [, date, time, milliseconds] = match;
  return `${date}T${time}${milliseconds ? `.${milliseconds}` : ""}Z`;
}

function restoreQmdNormalizedArchiveName(mdStem: string): string | null {
  const match = QMD_ARCHIVE_STEM_RE.exec(mdStem);
  if (!match) {
    return null;
  }
  const [, sessionId, reason, timestamp] = match;
  const restoredTimestamp = restoreQmdNormalizedArchiveTimestamp(timestamp);
  return restoredTimestamp ? `${sessionId}.jsonl.${reason}.${restoredTimestamp}` : null;
}

function normalizeQmdSessionStem(stem: string): string {
  return stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseSessionsPath(hitPath: string): { base: string; ownerAgentId?: string } | null {
  if (!hitPath.startsWith(TRANSCRIPT_KEY_PREFIX)) {
    return null;
  }
  const parts = hitPath.slice(TRANSCRIPT_KEY_PREFIX.length).split(":");
  const agentId = parts.shift()?.trim();
  const sessionId = parts.join(":").trim();
  if (!agentId || !sessionId) {
    return null;
  }
  return { base: sessionId, ownerAgentId: normalizeAgentId(agentId) };
}

function parseQmdSessionsPath(hitPath: string): SessionTranscriptHitIdentity | null {
  const normalized = hitPath.replace(/\\/g, "/");
  if (!normalized.startsWith("qmd/") || !normalized.endsWith(".md")) {
    return null;
  }
  const base = normalized.split("/").findLast(Boolean);
  const mdStem = base?.slice(0, -".md".length);
  if (!mdStem) {
    return null;
  }
  const exportedArchiveStem = parseUsageCountedSessionIdFromFileName(mdStem);
  if (exportedArchiveStem && mdStem !== `${exportedArchiveStem}.jsonl`) {
    return { stem: exportedArchiveStem, liveStem: mdStem, archived: true };
  }
  const restoredArchiveName = restoreQmdNormalizedArchiveName(mdStem);
  if (restoredArchiveName) {
    const archivedStem = parseUsageCountedSessionIdFromFileName(restoredArchiveName);
    if (archivedStem && restoredArchiveName !== `${archivedStem}.jsonl`) {
      return { stem: archivedStem, liveStem: mdStem, archived: true };
    }
  }
  return { stem: mdStem, archived: false };
}

/**
 * Derive transcript stem `S` from a memory search hit key for `source === "sessions"`.
 * Session memory hits use opaque SQLite-backed keys: `transcript:<agent>:<session>`.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}

export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const parsed = parseSessionsPath(hitPath);
  if (parsed) {
    return { stem: parsed.base, ownerAgentId: parsed.ownerAgentId };
  }
  return parseQmdSessionsPath(hitPath);
}

/**
 * Map transcript stem to canonical session row keys across all agents.
 * Session tools visibility and agent-to-agent policy are enforced by the caller (e.g.
 * `createSessionVisibilityGuard`), including cross-agent cases.
 */
export function resolveTranscriptStemToSessionKeys(params: {
  entries: Record<string, SessionEntry>;
  stem: string;
  archivedOwnerAgentId?: string;
  allowQmdSlugFallback?: boolean;
}): string[] {
  const matches: string[] = [];

  for (const [sessionKey, entry] of Object.entries(params.entries)) {
    if (entry.sessionId === params.stem) {
      matches.push(sessionKey);
    }
  }
  const deduped = uniqueStrings(matches);
  if (deduped.length > 0) {
    return deduped;
  }
  const normalizedStem = normalizeQmdSessionStem(params.stem);
  if (params.allowQmdSlugFallback === true && normalizedStem) {
    for (const [sessionKey, entry] of Object.entries(params.entries)) {
      const entrySessionId = normalizeOptionalString(entry.sessionId);
      if (entrySessionId && normalizeQmdSessionStem(entrySessionId) === normalizedStem) {
        matches.push(sessionKey);
      }
    }
  }
  const normalizedDeduped = uniqueStrings(matches);
  if (normalizedDeduped.length > 0) {
    return normalizedDeduped.length === 1 ? normalizedDeduped : [];
  }
  const archivedOwnerAgentId = normalizeOptionalString(params.archivedOwnerAgentId);
  return archivedOwnerAgentId
    ? [`agent:${normalizeAgentId(archivedOwnerAgentId)}:${params.stem}`]
    : [];
}
