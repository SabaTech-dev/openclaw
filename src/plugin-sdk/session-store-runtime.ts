// SQLite session row helpers plus deprecated session-store compatibility shims.

import path from "node:path";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveStateDir } from "../config/paths.js";
import { loadSqliteSessionEntries } from "../config/sessions/session-entries.sqlite.js";
import { normalizeSessionEntries } from "../config/sessions/session-entry-normalize.js";
import { validateSessionId } from "../config/sessions/session-id.js";
import { resolveAndPersistSessionTranscriptScope } from "../config/sessions/session-scope.js";
import { resolveSessionRowEntry } from "../config/sessions/store-entry.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt as readSqliteSessionUpdatedAt,
  recordSessionMetaFromInbound as recordSessionMetaFromInboundSqlite,
  updateLastRoute as updateLastRouteSqlite,
  upsertSessionEntry,
} from "../config/sessions/store.js";
import type { SessionEntry, SessionScope } from "../config/sessions/types.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveUserPath } from "../utils.js";

export { closeOpenClawAgentDatabasesForTest };
export { resolveSessionRowEntry };
export { resolveAndPersistSessionTranscriptScope };
export { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  appendSqliteSessionTranscriptEvent,
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptBoundedEvents,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
export {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  upsertSessionEntry,
};
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export type { SessionEntry, SessionScope };

type SessionRowOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
};

type SaveSessionStoreOptions = {
  skipMaintenance?: boolean;
  activeSessionKey?: string;
  allowDropAcpMetaSessionKeys?: string[];
  onWarn?: (warning: unknown) => void | Promise<void>;
  onMaintenanceApplied?: (report: unknown) => void | Promise<void>;
  maintenanceOverride?: unknown;
  maintenanceConfig?: unknown;
};

type CompatSessionEntry = SessionEntry & { sessionFile?: string };

function optionsWithEnv(agentId: string, env?: NodeJS.ProcessEnv): SessionRowOptions {
  return env ? { agentId, env } : { agentId };
}

function parseSessionStorePath(storePath: string): { agentId: string; stateDir: string } | null {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) !== "sessions.json") {
    return null;
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(sessionsDir) !== "sessions") {
    return null;
  }
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    return null;
  }
  const agentId = path.basename(agentDir);
  if (!agentId) {
    return null;
  }
  return {
    agentId: normalizeAgentId(agentId),
    stateDir: path.dirname(agentsDir),
  };
}

function resolveSessionRowOptionsFromStorePath(
  storePath: string,
  fallback?: { agentId?: string; env?: NodeJS.ProcessEnv },
): SessionRowOptions {
  const parsed = parseSessionStorePath(storePath);
  if (!parsed) {
    if (fallback?.agentId) {
      return optionsWithEnv(normalizeAgentId(fallback.agentId), fallback.env);
    }
    throw new Error(
      "Custom sessions.json paths are not supported by the SQLite session-store compatibility API. Pass a canonical OpenClaw sessions path or use the row APIs with an explicit agentId.",
    );
  }
  return optionsWithEnv(parsed.agentId, {
    ...process.env,
    OPENCLAW_STATE_DIR: parsed.stateDir,
  });
}

function resolveSessionRowOptions(params: {
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
}): SessionRowOptions {
  if (params.storePath) {
    const resolved = resolveSessionRowOptionsFromStorePath(params.storePath, params);
    return params.env
      ? optionsWithEnv(resolved.agentId, {
          ...params.env,
          OPENCLAW_STATE_DIR: resolved.env?.OPENCLAW_STATE_DIR,
        })
      : resolved;
  }
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined) ??
    DEFAULT_AGENT_ID;
  return optionsWithEnv(normalizeAgentId(agentId), params.env);
}

export function clearSessionStoreCacheForTest(): void {
  closeOpenClawAgentDatabasesForTest();
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const resolved = resolveSessionRowEntry({ entries: params.store, sessionKey: params.sessionKey });
  return { ...resolved, legacyKeys: [] };
}

export function resolveStorePath(
  store?: string,
  opts?: { agentId?: string; env?: NodeJS.ProcessEnv },
): string {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  const env = opts?.env ?? process.env;
  if (!store) {
    return path.join(resolveStateDir(env), "agents", agentId, "sessions", "sessions.json");
  }
  return path.resolve(resolveUserPath(store.replaceAll("{agentId}", agentId), env));
}

export function resolveSessionTranscriptPathInDir(
  sessionId: string,
  sessionsDir: string,
  topicId?: string | number,
): string {
  const trimmed = validateSessionId(sessionId);
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId === undefined ? `${trimmed}.jsonl` : `${trimmed}-topic-${safeTopicId}.jsonl`;
  return path.resolve(sessionsDir, fileName);
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  options?: { agentId?: string; env?: NodeJS.ProcessEnv; sessionsDir?: string },
): string {
  const sessionsDir = options?.sessionsDir ?? path.dirname(resolveStorePath(undefined, options));
  const persisted = entry?.sessionFile?.trim();
  return persisted
    ? path.resolve(sessionsDir, persisted)
    : resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}

export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  return loadSqliteSessionEntries(resolveSessionRowOptionsFromStorePath(storePath));
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  _opts?: SaveSessionStoreOptions,
): Promise<void> {
  normalizeSessionEntries(store);
  const options = resolveSessionRowOptionsFromStorePath(storePath);
  const deleteScope = new Set(Object.keys(loadSqliteSessionEntries(options)));
  await saveSessionStoreRows(options, store, deleteScope);
}

async function saveSessionStoreRows(
  options: SessionRowOptions,
  store: Record<string, SessionEntry>,
  deleteScope?: ReadonlySet<string>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(store)) {
    upsertSessionEntry({ ...options, sessionKey, entry });
  }
  if (deleteScope) {
    for (const sessionKey of deleteScope) {
      if (!Object.prototype.hasOwnProperty.call(store, sessionKey)) {
        deleteSessionEntry({ ...options, sessionKey });
      }
    }
  }
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  _opts?: SaveSessionStoreOptions,
): Promise<T> {
  const options = resolveSessionRowOptionsFromStorePath(storePath);
  const store = loadSqliteSessionEntries(options);
  const deleteScope = new Set(Object.keys(store));
  const result = await mutator(store);
  normalizeSessionEntries(store);
  await saveSessionStoreRows(options, store, deleteScope);
  return result;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const options = resolveSessionRowOptionsFromStorePath(params.storePath);
  return await patchSessionEntry({
    ...options,
    sessionKey: params.sessionKey,
    update: params.update,
  });
}

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, CompatSessionEntry>;
  storePath: string;
  sessionEntry?: CompatSessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
  maintenanceConfig?: unknown;
}): Promise<{ sessionFile: string; sessionEntry: CompatSessionEntry }> {
  const now = Date.now();
  const baseEntry = params.sessionEntry ??
    params.sessionStore[params.sessionKey] ?? {
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
  const persistedSessionFile =
    baseEntry.sessionId === params.sessionId ? baseEntry.sessionFile?.trim() : undefined;
  const sessionFile =
    persistedSessionFile ||
    params.fallbackSessionFile?.trim() ||
    resolveSessionTranscriptPathInDir(
      params.sessionId,
      params.sessionsDir ?? path.dirname(path.resolve(params.storePath)),
    );
  const sessionEntry: CompatSessionEntry = {
    ...baseEntry,
    sessionId: params.sessionId,
    sessionFile,
    updatedAt: now,
    sessionStartedAt:
      baseEntry.sessionId === params.sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
  };
  params.sessionStore[params.sessionKey] = sessionEntry;
  upsertSessionEntry({
    ...resolveSessionRowOptions({
      storePath: params.storePath,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
    sessionKey: params.sessionKey,
    entry: sessionEntry as SessionEntry,
  });
  return { sessionFile, sessionEntry };
}

export function readSessionUpdatedAt(params: {
  agentId?: string;
  storePath?: string;
  sessionKey: string;
}): number | undefined {
  return readSqliteSessionUpdatedAt({
    ...resolveSessionRowOptions(params),
    sessionKey: params.sessionKey,
  });
}

export async function recordSessionMetaFromInbound(params: {
  agentId?: string;
  storePath?: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("../config/sessions/types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  return await recordSessionMetaFromInboundSqlite({
    ...resolveSessionRowOptions(params),
    sessionKey: params.sessionKey,
    ctx: params.ctx,
    groupResolution: params.groupResolution,
    createIfMissing: params.createIfMissing,
  });
}

export async function updateLastRoute(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  channel?: SessionEntry["channel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: import("../utils/delivery-context.types.js").DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("../config/sessions/types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  return await updateLastRouteSqlite({
    ...resolveSessionRowOptions(params),
    sessionKey: params.sessionKey,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
    deliveryContext: params.deliveryContext,
    ctx: params.ctx,
    groupResolution: params.groupResolution,
    createIfMissing: params.createIfMissing,
  });
}
