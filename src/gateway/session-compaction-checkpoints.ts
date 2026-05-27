import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  CURRENT_SESSION_VERSION,
  type SessionHeader,
  type TranscriptEntry as PiTranscriptEntry,
} from "../agents/transcript/session-transcript-contract.js";
import { patchSessionEntry } from "../config/sessions.js";
import type {
  SessionCompactionCheckpoint,
  SessionCompactionCheckpointReason,
  SessionEntry,
} from "../config/sessions.js";
import {
  deleteSqliteSessionTranscript,
  deleteSqliteSessionTranscriptSnapshot,
  getSqliteSessionTranscriptStats,
  loadSqliteSessionTranscriptEvents,
  readLatestSqliteSessionTranscriptLeafId,
  recordSqliteSessionTranscriptSnapshot,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveGatewaySessionDatabaseTarget } from "./session-utils.js";

const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25;
export const MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION = 128 * 1024 * 1024;

export type CapturedCompactionCheckpointSnapshot = {
  agentId: string;
  path?: string;
  sourceSessionId: string;
  sessionId: string;
  sessionFile?: string;
  leafId: string;
};

type ForkedCompactionCheckpointTranscript = {
  sessionId: string;
};

function checkpointSnapshotStorageKey(checkpoint: SessionCompactionCheckpoint): string {
  const sessionFile = checkpoint.preCompaction.sessionFile?.trim();
  return sessionFile ? `file:${sessionFile}` : `sqlite:${checkpoint.preCompaction.sessionId}`;
}

function checkpointSnapshotBytes(
  checkpoint: SessionCompactionCheckpoint,
  snapshotBytesByKey: ReadonlyMap<string, number>,
): number {
  const bytes = snapshotBytesByKey.get(checkpointSnapshotStorageKey(checkpoint));
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function trimSessionCheckpoints(
  checkpoints: SessionCompactionCheckpoint[] | undefined,
  snapshotBytesByKey: ReadonlyMap<string, number> = new Map(),
): {
  kept: SessionCompactionCheckpoint[] | undefined;
  removed: SessionCompactionCheckpoint[];
} {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { kept: undefined, removed: [] };
  }
  const countTrimmed = checkpoints.slice(-MAX_COMPACTION_CHECKPOINTS_PER_SESSION);
  const countRemoved = checkpoints.slice(0, Math.max(0, checkpoints.length - countTrimmed.length));
  const keptNewestFirst: SessionCompactionCheckpoint[] = [];
  const byteRemovedNewestFirst: SessionCompactionCheckpoint[] = [];
  let retainedBytes = 0;
  for (let index = countTrimmed.length - 1; index >= 0; index -= 1) {
    const checkpoint = countTrimmed[index];
    if (!checkpoint) {
      continue;
    }
    const checkpointBytes = checkpointSnapshotBytes(checkpoint, snapshotBytesByKey);
    const alwaysKeepNewestCheckpoint = keptNewestFirst.length === 0;
    if (
      alwaysKeepNewestCheckpoint ||
      retainedBytes + checkpointBytes <= MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION
    ) {
      keptNewestFirst.push(checkpoint);
      retainedBytes += checkpointBytes;
    } else {
      byteRemovedNewestFirst.push(checkpoint);
    }
  }
  const kept = keptNewestFirst.toReversed();
  return {
    kept: kept.length > 0 ? kept : undefined,
    removed: [...countRemoved, ...byteRemovedNewestFirst.toReversed()],
  };
}

function sessionStoreCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return Array.isArray(entry?.compactionCheckpoints) ? [...entry.compactionCheckpoints] : [];
}

async function collectCheckpointSnapshotBytes(params: {
  agentId: string;
  path?: string;
  checkpoints: readonly SessionCompactionCheckpoint[];
}): Promise<Map<string, number>> {
  const bytesByKey = new Map<string, number>();
  for (const checkpoint of params.checkpoints) {
    const key = checkpointSnapshotStorageKey(checkpoint);
    if (bytesByKey.has(key)) {
      continue;
    }
    const sessionFile = checkpoint.preCompaction.sessionFile?.trim();
    if (sessionFile) {
      try {
        const stat = await fs.stat(sessionFile);
        bytesByKey.set(key, stat.isFile() ? stat.size : 0);
      } catch {
        bytesByKey.set(key, 0);
      }
      continue;
    }
    const stats = getSqliteSessionTranscriptStats({
      agentId: params.agentId,
      path: params.path,
      sessionId: checkpoint.preCompaction.sessionId,
    });
    bytesByKey.set(
      key,
      stats && Number.isFinite(stats.jsonlBytes) && stats.jsonlBytes > 0 ? stats.jsonlBytes : 0,
    );
  }
  return bytesByKey;
}

export function resolveSessionCompactionCheckpointReason(params: {
  trigger?: "budget" | "overflow" | "manual";
  timedOut?: boolean;
}): SessionCompactionCheckpointReason {
  if (params.trigger === "manual") {
    return "manual";
  }
  if (params.timedOut) {
    return "timeout-retry";
  }
  if (params.trigger === "overflow") {
    return "overflow-retry";
  }
  return "auto-threshold";
}

function cloneTranscriptEvents(events: unknown[]): PiTranscriptEntry[] | null {
  const entries = events.filter((event): event is PiTranscriptEntry =>
    Boolean(event && typeof event === "object"),
  );
  const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
  if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
    return null;
  }
  return structuredClone(entries);
}

function loadTranscriptEntriesFromSqlite(params: {
  agentId: string;
  path?: string;
  sessionId: string;
}): PiTranscriptEntry[] | null {
  const agentId = params.agentId.trim() || DEFAULT_AGENT_ID;
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return null;
  }
  return cloneTranscriptEvents(
    loadSqliteSessionTranscriptEvents({
      agentId,
      path: params.path,
      sessionId,
    }).map((entry) => entry.event),
  );
}

function normalizeSnapshotMaxBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES;
}

function getBoundedTranscriptStats(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  maxBytes?: number;
}) {
  const agentId = params.agentId.trim() || DEFAULT_AGENT_ID;
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return null;
  }
  const stats = getSqliteSessionTranscriptStats({
    agentId,
    path: params.path,
    sessionId,
  });
  const maxBytes = normalizeSnapshotMaxBytes(params.maxBytes);
  return stats && stats.jsonlBytes <= maxBytes ? { agentId, sessionId, stats } : null;
}

function loadBoundedTranscriptEntriesFromSqlite(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  maxBytes?: number;
}): PiTranscriptEntry[] | null {
  const bounded = getBoundedTranscriptStats(params);
  return bounded
    ? loadTranscriptEntriesFromSqlite({
        agentId: bounded.agentId,
        path: params.path,
        sessionId: bounded.sessionId,
      })
    : null;
}

async function loadBoundedTranscriptEntriesFromLegacyFile(params: {
  sessionFile?: string;
  maxBytes?: number;
}): Promise<PiTranscriptEntry[] | null> {
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return null;
  }
  const maxBytes = normalizeSnapshotMaxBytes(params.maxBytes);
  try {
    const stat = await fs.stat(sessionFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
      return null;
    }
    const entries = (await fs.readFile(sessionFile, "utf-8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
    return cloneTranscriptEvents(entries);
  } catch {
    return null;
  }
}

function latestEntryId(entries: readonly PiTranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; id?: unknown } | undefined;
    if (entry?.type === "session") {
      return null;
    }
    if (typeof entry?.id === "string" && entry.id.trim()) {
      return entry.id.trim();
    }
  }
  return null;
}

export async function readSessionLeafIdFromTranscriptAsync(
  scope: { agentId: string; path?: string; sessionId: string },
  maxBytes = MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES,
): Promise<string | null> {
  const bounded = getBoundedTranscriptStats({ ...scope, maxBytes });
  if (!bounded) {
    return null;
  }
  return readLatestSqliteSessionTranscriptLeafId({
    agentId: bounded.agentId,
    path: scope.path,
    sessionId: bounded.sessionId,
  });
}

export async function forkCompactionCheckpointTranscriptAsync(params: {
  sourceSessionId: string;
  sourceSessionFile?: string;
  agentId: string;
  path?: string;
  targetCwd?: string;
  maxBytes?: number;
}): Promise<ForkedCompactionCheckpointTranscript | null> {
  const legacyFileEntries = await loadBoundedTranscriptEntriesFromLegacyFile({
    sessionFile: params.sourceSessionFile,
    maxBytes: params.maxBytes,
  });
  const entries =
    legacyFileEntries ??
    loadBoundedTranscriptEntriesFromSqlite({
      agentId: params.agentId,
      path: params.path,
      sessionId: params.sourceSessionId,
      maxBytes: params.maxBytes,
    });
  if (!entries) {
    return null;
  }
  const sourceHeader = entries[0] as SessionHeader | undefined;
  if (!sourceHeader) {
    return null;
  }
  const targetCwd = params.targetCwd ?? sourceHeader.cwd ?? process.cwd();
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const agentId = params.agentId.trim() || DEFAULT_AGENT_ID;
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: targetCwd,
    parentTranscriptScope: {
      agentId,
      sessionId: params.sourceSessionId,
    },
  };

  try {
    replaceSqliteSessionTranscriptEvents({
      agentId,
      path: params.path,
      sessionId,
      events: [
        header,
        ...entries.filter((entry) => (entry as { type?: unknown }).type !== "session"),
      ],
    });
    return { sessionId };
  } catch {
    return null;
  }
}

/**
 * Capture a bounded pre-compaction transcript snapshot from SQLite without
 * blocking the Gateway event loop on large transcript materialization.
 */
export async function captureCompactionCheckpointSnapshotAsync(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  maxBytes?: number;
}): Promise<CapturedCompactionCheckpointSnapshot | null> {
  const bounded = getBoundedTranscriptStats(params);
  if (!bounded) {
    return null;
  }
  const entries = loadTranscriptEntriesFromSqlite({
    agentId: params.agentId,
    path: params.path,
    sessionId: bounded.sessionId,
  });
  if (!entries) {
    return null;
  }
  const sourceHeader = entries[0] as SessionHeader | undefined;
  const leafId = latestEntryId(entries);
  if (!sourceHeader?.id || !leafId) {
    return null;
  }
  const snapshotSessionId = randomUUID();
  const snapshotAgentId = params.agentId.trim() || DEFAULT_AGENT_ID;
  const snapshotHeader: SessionHeader = {
    ...sourceHeader,
    id: snapshotSessionId,
    timestamp: new Date().toISOString(),
    parentTranscriptScope: {
      agentId: snapshotAgentId,
      sessionId: sourceHeader.id,
    },
  };
  replaceSqliteSessionTranscriptEvents({
    agentId: snapshotAgentId,
    path: params.path,
    sessionId: snapshotSessionId,
    events: [
      snapshotHeader,
      ...entries.filter((entry) => (entry as { type?: unknown }).type !== "session"),
    ],
  });
  recordSqliteSessionTranscriptSnapshot({
    agentId: snapshotAgentId,
    path: params.path,
    sessionId: sourceHeader.id,
    snapshotId: snapshotSessionId,
    reason: "pre-compaction",
    eventCount: entries.length,
    metadata: {
      leafId,
      sourceSessionId: sourceHeader.id,
      snapshotSessionId,
    },
  });
  return {
    agentId: snapshotAgentId,
    path: params.path,
    sourceSessionId: sourceHeader.id,
    sessionId: snapshotSessionId,
    leafId,
  };
}

export async function cleanupCompactionCheckpointSnapshot(
  snapshot: CapturedCompactionCheckpointSnapshot | null | undefined,
): Promise<void> {
  if (!snapshot) {
    return;
  }
  deleteSqliteSessionTranscriptSnapshot({
    agentId: snapshot.agentId,
    path: snapshot.path,
    sessionId: snapshot.sourceSessionId,
    snapshotId: snapshot.sessionId,
  });
  deleteSqliteSessionTranscript({
    agentId: snapshot.agentId,
    path: snapshot.path,
    sessionId: snapshot.sessionId,
  });
}

export async function persistSessionCompactionCheckpoint(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  reason: SessionCompactionCheckpointReason;
  snapshot: CapturedCompactionCheckpointSnapshot;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  postLeafId?: string;
  postEntryId?: string;
  createdAt?: number;
}): Promise<SessionCompactionCheckpoint | null> {
  const target = resolveGatewaySessionDatabaseTarget({
    cfg: params.cfg,
    key: params.sessionKey,
  });
  const createdAt = params.createdAt ?? Date.now();
  const checkpoint: SessionCompactionCheckpoint = {
    checkpointId: randomUUID(),
    sessionKey: target.canonicalKey,
    sessionId: params.sessionId,
    createdAt,
    reason: params.reason,
    ...(typeof params.tokensBefore === "number" ? { tokensBefore: params.tokensBefore } : {}),
    ...(typeof params.tokensAfter === "number" ? { tokensAfter: params.tokensAfter } : {}),
    ...(params.summary?.trim() ? { summary: params.summary.trim() } : {}),
    ...(params.firstKeptEntryId?.trim()
      ? { firstKeptEntryId: params.firstKeptEntryId.trim() }
      : {}),
    preCompaction: {
      sessionId: params.snapshot.sessionId,
      leafId: params.snapshot.leafId,
    },
    postCompaction: {
      sessionId: params.sessionId,
      ...(params.postLeafId?.trim() ? { leafId: params.postLeafId.trim() } : {}),
      ...(params.postEntryId?.trim() ? { entryId: params.postEntryId.trim() } : {}),
    },
  };

  let stored = false;
  let trimmedCheckpoints:
    | {
        kept: SessionCompactionCheckpoint[] | undefined;
        removed: SessionCompactionCheckpoint[];
      }
    | undefined;
  await patchSessionEntry({
    agentId: target.agentId,
    path: target.databasePath,
    sessionKey: target.canonicalKey,
    update: async (existing) => {
      if (!existing.sessionId) {
        return null;
      }
      const checkpoints = sessionStoreCheckpoints(existing);
      checkpoints.push(checkpoint);
      const snapshotBytesByKey = await collectCheckpointSnapshotBytes({
        agentId: target.agentId,
        path: target.databasePath,
        checkpoints,
      });
      trimmedCheckpoints = trimSessionCheckpoints(checkpoints, snapshotBytesByKey);
      stored = true;
      return {
        updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
        compactionCheckpoints: trimmedCheckpoints.kept,
      };
    },
  });

  if (!stored) {
    log.warn("skipping compaction checkpoint persist: session not found", {
      sessionKey: params.sessionKey,
    });
    return null;
  }
  for (const removed of trimmedCheckpoints?.removed ?? []) {
    if (removed.preCompaction.sessionFile) {
      continue;
    }
    deleteSqliteSessionTranscriptSnapshot({
      agentId: target.agentId,
      path: target.databasePath,
      sessionId: removed.sessionId,
      snapshotId: removed.preCompaction.sessionId,
    });
    deleteSqliteSessionTranscript({
      agentId: target.agentId,
      path: target.databasePath,
      sessionId: removed.preCompaction.sessionId,
    });
  }
  return checkpoint;
}

export function listSessionCompactionCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return sessionStoreCheckpoints(entry).toSorted((a, b) => b.createdAt - a.createdAt);
}

export function getSessionCompactionCheckpoint(params: {
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined;
  checkpointId: string;
}): SessionCompactionCheckpoint | undefined {
  const checkpointId = params.checkpointId.trim();
  if (!checkpointId) {
    return undefined;
  }
  return listSessionCompactionCheckpoints(params.entry).find(
    (checkpoint) => checkpoint.checkpointId === checkpointId,
  );
}
