import { randomUUID } from "node:crypto";
import { sql, type Insertable } from "kysely";
import {
  executeCompiledSqliteQuerySync,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";

export type SqliteSessionTranscriptEvent = {
  seq: number;
  event: unknown;
  createdAt: number;
};

export type SqliteSessionTranscriptStoreOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  sessionId: string;
};

export type AppendSqliteSessionTranscriptEventOptions = SqliteSessionTranscriptStoreOptions & {
  event: unknown;
  now?: () => number;
  parentMode?: "database-tail";
};

export type AppendSqliteSessionTranscriptEventsOptions = SqliteSessionTranscriptStoreOptions & {
  events: unknown[];
  now?: () => number;
  supersededMessageIdempotencyEventIds?: string[];
};

export type AppendSqliteSessionTranscriptMessageOptions = SqliteSessionTranscriptStoreOptions & {
  cwd?: string;
  dedupeLatestAssistantText?: string;
  idempotencyLookup?: "scan" | "caller-checked";
  message: unknown;
  now?: () => number;
  sessionVersion: number;
};

export type ReplaceSqliteSessionTranscriptEventsOptions = SqliteSessionTranscriptStoreOptions & {
  events: unknown[];
  legacyReplayFingerprintDedupe?: boolean;
  now?: () => number;
};

export type LoadSqliteSessionTranscriptTailEventsOptions = SqliteSessionTranscriptStoreOptions & {
  maxBytes?: number;
  maxEvents: number;
};

export type LoadSqliteSessionTranscriptBoundedEventsOptions =
  SqliteSessionTranscriptStoreOptions & {
    maxBytes?: number;
    maxEvents: number;
  };

export type SqliteSessionTranscriptScope = {
  agentId: string;
  path?: string;
  sessionId: string;
};

export type SqliteSessionTranscript = SqliteSessionTranscriptScope & {
  updatedAt: number;
  eventCount: number;
};

export type SqliteSessionTranscriptStats = {
  sessionId: string;
  updatedAt: number;
  eventCount: number;
  jsonlBytes: number;
};

export type SqliteSessionTranscriptSnapshot = SqliteSessionTranscriptScope & {
  snapshotId: string;
  reason: string;
  eventCount: number;
  createdAt: number;
  metadata: unknown;
};

type TranscriptEventsTable = OpenClawAgentKyselyDatabase["transcript_events"];
type TranscriptEventIdentitiesTable = OpenClawAgentKyselyDatabase["transcript_event_identities"];
type SessionsTable = OpenClawAgentKyselyDatabase["sessions"];
type AgentTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_entries"
  | "session_routes"
  | "sessions"
  | "transcript_event_identities"
  | "transcript_events"
  | "transcript_snapshots"
>;

function normalizeSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId) {
    throw new Error("SQLite transcript store requires a session id.");
  }
  return sessionId;
}

function normalizeTranscriptScope(options: SqliteSessionTranscriptStoreOptions): {
  agentId: string;
  sessionId: string;
} {
  return {
    agentId: normalizeAgentId(options.agentId),
    sessionId: normalizeSessionId(options.sessionId),
  };
}

function parseTranscriptEventJson(value: unknown, seq: number): unknown {
  if (typeof value !== "string") {
    throw new Error(`SQLite transcript event ${seq} is not stored as JSON.`);
  }
  return JSON.parse(value);
}

function parseCreatedAt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function parseTranscriptTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readTranscriptEventTimestampMs(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  return (
    parseTranscriptTimestampMs(record.timestamp) ??
    (record.message && typeof record.message === "object"
      ? parseTranscriptTimestampMs((record.message as Record<string, unknown>).timestamp)
      : undefined)
  );
}

function parseTranscriptEventRow(row: {
  seq: number | bigint;
  event_json: unknown;
  created_at: unknown;
}): SqliteSessionTranscriptEvent {
  const seq = typeof row.seq === "bigint" ? Number(row.seq) : row.seq;
  return {
    seq,
    event: parseTranscriptEventJson(row.event_json, seq),
    createdAt: parseCreatedAt(row.created_at),
  };
}

function parseSqliteCount(value: unknown): number {
  const count = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function getAgentTranscriptKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<AgentTranscriptDatabase>(db);
}

function openTranscriptAgentDatabase(
  options: SqliteSessionTranscriptStoreOptions,
): OpenClawAgentDatabase {
  return openOpenClawAgentDatabase(options);
}

function listTranscriptAgentDatabaseTargets(
  options: OpenClawStateDatabaseOptions & { agentId?: string },
): Array<{ agentId: string; path?: string }> {
  if (!options.agentId) {
    return listOpenClawRegisteredAgentDatabases(options);
  }
  const agentId = normalizeAgentId(options.agentId);
  if (options.path) {
    return [{ agentId, path: options.path }];
  }
  const defaultPath = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const registered = listOpenClawRegisteredAgentDatabases(options).filter(
    (row) => row.agentId === agentId && row.path !== defaultPath,
  );
  return [{ agentId }, ...registered.map((row) => ({ agentId: row.agentId, path: row.path }))];
}

function readNextTranscriptSeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select((eb) =>
        eb(eb.fn.coalesce(eb.fn.max<number | bigint>("seq"), eb.lit(-1)), "+", eb.lit(1)).as(
          "next_seq",
        ),
      )
      .where("session_id", "=", sessionId),
  );
  return typeof row?.next_seq === "bigint" ? Number(row.next_seq) : (row?.next_seq ?? 0);
}

function readTranscriptSessionUpdatedAt(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("sessions")
      .select(["updated_at"])
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === undefined || row.updated_at === null) {
    return undefined;
  }
  const updatedAt = typeof row.updated_at === "bigint" ? Number(row.updated_at) : row.updated_at;
  return Number.isFinite(updatedAt) ? updatedAt : undefined;
}

function bindTranscriptSessionRoot(params: {
  sessionId: string;
  updatedAt: number;
}): Insertable<SessionsTable> {
  return {
    session_id: params.sessionId,
    session_key: params.sessionId,
    created_at: params.updatedAt,
    updated_at: params.updatedAt,
    started_at: null,
    ended_at: null,
    status: null,
    chat_type: null,
    channel: null,
    model_provider: null,
    model: null,
    agent_harness_id: null,
    parent_session_key: null,
    spawned_by: null,
    display_name: null,
  };
}

function ensureTranscriptSessionRoot(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  updatedAt: number;
}): void {
  executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .insertInto("sessions")
      .values(
        bindTranscriptSessionRoot({
          sessionId: params.sessionId,
          updatedAt: params.updatedAt,
        }),
      )
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      ),
  );
}

function deleteTranscriptSessionRootIfUnused(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
}): void {
  const db = getAgentTranscriptKysely(params.database.db);
  const countRows = (table: keyof AgentTranscriptDatabase): number => {
    const row = executeSqliteQueryTakeFirstSync(
      params.database.db,
      db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
        .where("session_id", "=", params.sessionId),
    );
    return parseSqliteCount(row?.count);
  };
  if (
    countRows("session_entries") > 0 ||
    countRows("session_routes") > 0 ||
    countRows("transcript_events") > 0 ||
    countRows("transcript_snapshots") > 0
  ) {
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    db.deleteFrom("sessions").where("session_id", "=", params.sessionId),
  );
}

function readLatestTranscriptTailEventId(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | null {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_event_identities")
      .select(["event_id"])
      .where("session_id", "=", sessionId)
      .where((eb) => eb.or([eb("event_type", "is", null), eb("event_type", "!=", "session")]))
      .where("has_parent", "=", 1)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return typeof row?.event_id === "string" ? row.event_id : null;
}

function withDatabaseTailParent(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  event: unknown;
}): unknown {
  if (!params.event || typeof params.event !== "object" || Array.isArray(params.event)) {
    return params.event;
  }
  if (!Object.hasOwn(params.event, "parentId")) {
    return params.event;
  }
  return {
    ...params.event,
    parentId: readLatestTranscriptTailEventId(params.database, params.sessionId),
  };
}

function bindTranscriptEvent(params: {
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): Insertable<TranscriptEventsTable> {
  return {
    session_id: params.sessionId,
    seq: params.seq,
    event_json: JSON.stringify(params.event),
    created_at: params.createdAt,
  };
}

function readMessageIdempotencyKey(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const key = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key.trim() ? key : null;
}

function extractAssistantMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .filter(
      (
        part,
      ): part is {
        type: string;
        text: string;
      } =>
        Boolean(
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string" &&
          (part as { text: string }).text.trim(),
        ),
    )
    .map((part) => part.text.trim());
  return parts.length > 0 ? parts.join("\n").trim() : null;
}

function extractAssistantTranscriptEventText(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  return extractAssistantMessageText((event as { message?: unknown }).message);
}

function readLatestEquivalentAssistantMessageId(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  expectedText: string;
}): string | undefined {
  const rows = executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", params.sessionId)
      .orderBy("seq", "desc"),
  ).rows;
  for (const row of rows) {
    const eventJson = row.event_json;
    if (typeof eventJson !== "string") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(eventJson);
    } catch {
      continue;
    }
    const candidateText = extractAssistantTranscriptEventText(event);
    if (candidateText === null) {
      return undefined;
    }
    if (candidateText !== params.expectedText) {
      return undefined;
    }
    const id = (event as { id?: unknown }).id;
    return typeof id === "string" && id ? id : undefined;
  }
  return undefined;
}

function readTranscriptEventIdentity(params: {
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): Insertable<TranscriptEventIdentitiesTable> | null {
  if (!params.event || typeof params.event !== "object" || Array.isArray(params.event)) {
    return null;
  }
  const record = params.event as {
    id?: unknown;
    type?: unknown;
    parentId?: unknown;
    message?: { idempotencyKey?: unknown };
  };
  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }
  return {
    session_id: params.sessionId,
    event_id: record.id,
    seq: params.seq,
    event_type: typeof record.type === "string" ? record.type : null,
    has_parent: Object.hasOwn(record, "parentId") ? 1 : 0,
    parent_id: typeof record.parentId === "string" ? record.parentId : null,
    message_idempotency_key: readMessageIdempotencyKey(record.message),
    created_at: params.createdAt,
  };
}

function upsertTranscriptEventIdentity(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): void {
  const identity = readTranscriptEventIdentity(params);
  if (!identity) {
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .insertInto("transcript_event_identities")
      .values(identity)
      .onConflict((conflict) =>
        conflict.columns(["session_id", "event_id"]).doUpdateSet({
          seq: (eb) => eb.ref("excluded.seq"),
          event_type: (eb) => eb.ref("excluded.event_type"),
          has_parent: (eb) => eb.ref("excluded.has_parent"),
          parent_id: (eb) => eb.ref("excluded.parent_id"),
          message_idempotency_key: (eb) => eb.ref("excluded.message_idempotency_key"),
          created_at: (eb) => eb.ref("excluded.created_at"),
        }),
      ),
  );
}

function insertTranscriptEvent(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  seq: number;
  event: unknown;
  createdAt: number;
}): void {
  executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .insertInto("transcript_events")
      .values(
        bindTranscriptEvent({
          sessionId: params.sessionId,
          seq: params.seq,
          event: params.event,
          createdAt: params.createdAt,
        }),
      ),
  );
  upsertTranscriptEventIdentity(params);
}

function clearSupersededMessageIdempotencyKeys(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  eventIds?: readonly string[];
}): void {
  const eventIds = [...new Set(params.eventIds?.filter((id) => id.trim()) ?? [])];
  if (eventIds.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    getAgentTranscriptKysely(params.database.db)
      .updateTable("transcript_event_identities")
      .set({ message_idempotency_key: null })
      .where("session_id", "=", params.sessionId)
      .where("event_id", "in", eventIds),
  );
}

export function resolveSqliteSessionTranscriptScope(
  options: OpenClawStateDatabaseOptions & {
    agentId?: string;
    sessionId: string;
  },
): SqliteSessionTranscriptScope | undefined {
  const sessionId = normalizeSessionId(options.sessionId);
  if (options.agentId?.trim()) {
    return {
      agentId: normalizeAgentId(options.agentId),
      path: options.path,
      sessionId,
    };
  }
  return undefined;
}

export function listSqliteSessionTranscripts(
  options: OpenClawStateDatabaseOptions & { agentId?: string; minUpdatedAt?: number } = {},
): SqliteSessionTranscript[] {
  const agentDatabases = listTranscriptAgentDatabaseTargets(options);
  const transcripts: SqliteSessionTranscript[] = [];
  const minUpdatedAt =
    typeof options.minUpdatedAt === "number" && Number.isFinite(options.minUpdatedAt)
      ? Math.floor(options.minUpdatedAt)
      : undefined;
  for (const agentDatabase of agentDatabases) {
    const database = openOpenClawAgentDatabase({
      ...options,
      agentId: agentDatabase.agentId,
      ...(agentDatabase.path ? { path: agentDatabase.path } : {}),
    });
    transcripts.push(
      ...executeSqliteQuerySync(
        database.db,
        getAgentTranscriptKysely(database.db)
          .selectFrom("sessions")
          .innerJoin("transcript_events as events", "events.session_id", "sessions.session_id")
          .select([
            "events.session_id",
            "sessions.updated_at",
            (eb) => eb.fn.countAll<number | bigint>().as("event_count"),
          ])
          .$if(minUpdatedAt !== undefined, (query) =>
            query.where("sessions.updated_at", ">=", minUpdatedAt!),
          )
          .groupBy(["events.session_id", "sessions.updated_at"])
          .orderBy("updated_at", "desc")
          .orderBy("events.session_id", "asc"),
      ).rows.flatMap((row) => {
        const record = row;
        if (typeof record.session_id !== "string") {
          return [];
        }
        const updatedAt =
          typeof record.updated_at === "bigint"
            ? Number(record.updated_at)
            : (record.updated_at ?? 0);
        const eventCount =
          typeof record.event_count === "bigint"
            ? Number(record.event_count)
            : (record.event_count ?? 0);
        return [
          {
            agentId: agentDatabase.agentId,
            ...(agentDatabase.path ? { path: agentDatabase.path } : {}),
            sessionId: normalizeSessionId(record.session_id),
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
            eventCount: Number.isFinite(eventCount) ? eventCount : 0,
          },
        ];
      }),
    );
  }
  return transcripts.toSorted(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      a.agentId.localeCompare(b.agentId) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

export function getSqliteSessionTranscriptStats(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptStats | null {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select([
        (eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"),
        (eb) => eb.fn.countAll<number | bigint>().as("event_count"),
        // kysely-allow-raw: SQLite length(CAST(text AS blob)) gives the stored
        // JSON byte count for the JSONL-size preflight; no identifiers are interpolated.
        sql<number | bigint | null>`coalesce(sum(length(CAST(event_json AS blob)) + 1), 0)`.as(
          "jsonl_bytes",
        ),
      ])
      .where("session_id", "=", sessionId),
  );
  const eventCount =
    typeof row?.event_count === "bigint" ? Number(row.event_count) : (row?.event_count ?? 0);
  if (!Number.isFinite(eventCount) || eventCount <= 0) {
    return null;
  }
  const updatedAt =
    typeof row?.updated_at === "bigint" ? Number(row.updated_at) : (row?.updated_at ?? 0);
  const rawBytes =
    typeof row?.jsonl_bytes === "bigint" ? Number(row.jsonl_bytes) : (row?.jsonl_bytes ?? 0);
  return {
    sessionId,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    eventCount,
    jsonlBytes: Number.isFinite(rawBytes) && rawBytes > 0 ? Math.floor(rawBytes) : 0,
  };
}

export function appendSqliteSessionTranscriptEvent(
  options: AppendSqliteSessionTranscriptEventOptions,
): { seq: number } {
  const { sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const seq = runOpenClawAgentWriteTransaction((database) => {
    ensureTranscriptSessionRoot({ database, sessionId, updatedAt: now });
    const nextSeq = readNextTranscriptSeq(database, sessionId);
    const event =
      options.parentMode === "database-tail"
        ? withDatabaseTailParent({ database, sessionId, event: options.event })
        : options.event;
    insertTranscriptEvent({
      database,
      sessionId,
      seq: nextSeq,
      event,
      createdAt: now,
    });
    return nextSeq;
  }, options);

  return { seq };
}

export function appendSqliteSessionTranscriptEvents(
  options: AppendSqliteSessionTranscriptEventsOptions,
): { appended: number } {
  const { sessionId } = normalizeTranscriptScope(options);
  if (options.events.length === 0) {
    return { appended: 0 };
  }
  const now = options.now?.() ?? Date.now();
  const appended = runOpenClawAgentWriteTransaction((database) => {
    ensureTranscriptSessionRoot({ database, sessionId, updatedAt: now });
    clearSupersededMessageIdempotencyKeys({
      database,
      sessionId,
      eventIds: options.supersededMessageIdempotencyEventIds,
    });
    let nextSeq = readNextTranscriptSeq(database, sessionId);
    for (const event of options.events) {
      insertTranscriptEvent({
        database,
        sessionId,
        seq: nextSeq,
        event,
        createdAt: now,
      });
      nextSeq += 1;
    }
    return options.events.length;
  }, options);

  return { appended };
}

export function appendSqliteSessionTranscriptMessage(
  options: AppendSqliteSessionTranscriptMessageOptions,
): { messageId: string; appended: boolean } {
  const { sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  const messageId = runOpenClawAgentWriteTransaction((database) => {
    const db = getAgentTranscriptKysely(database.db);
    ensureTranscriptSessionRoot({ database, sessionId, updatedAt: now });
    let nextSeq = readNextTranscriptSeq(database, sessionId);

    if (nextSeq === 0) {
      insertTranscriptEvent({
        database,
        sessionId,
        seq: nextSeq,
        event: {
          type: "session",
          version: options.sessionVersion,
          id: sessionId,
          timestamp: new Date(now).toISOString(),
          cwd: options.cwd ?? process.cwd(),
        },
        createdAt: now,
      });
      nextSeq += 1;
    }

    if (idempotencyKey && options.idempotencyLookup === "scan") {
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_event_identities")
          .select(["event_id"])
          .where("session_id", "=", sessionId)
          .where("message_idempotency_key", "=", idempotencyKey)
          .limit(1),
      );
      if (typeof existing?.event_id === "string") {
        return { messageId: existing.event_id, appended: false };
      }
    }

    const dedupeLatestAssistantText = options.dedupeLatestAssistantText?.trim();
    if (dedupeLatestAssistantText) {
      const existingMessageId = readLatestEquivalentAssistantMessageId({
        database,
        sessionId,
        expectedText: dedupeLatestAssistantText,
      });
      if (existingMessageId) {
        return { messageId: existingMessageId, appended: false };
      }
    }

    const tailEventId = readLatestTranscriptTailEventId(database, sessionId);
    const newMessageId = randomUUID();
    insertTranscriptEvent({
      database,
      sessionId,
      seq: nextSeq,
      event: {
        type: "message",
        id: newMessageId,
        parentId: tailEventId,
        timestamp: new Date(now).toISOString(),
        message: options.message,
      },
      createdAt: now,
    });
    return { messageId: newMessageId, appended: true };
  }, options);

  return messageId;
}

export function replaceSqliteSessionTranscriptEvents(
  options: ReplaceSqliteSessionTranscriptEventsOptions,
): { replaced: number } {
  const { sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const timestamps = options.events.map(readTranscriptEventTimestampMs);
  let fallbackCreatedAt = timestamps.find((timestamp) => timestamp !== undefined) ?? now;
  const entries = options.events.map((event, seq) => {
    const createdAt = timestamps[seq] ?? fallbackCreatedAt;
    fallbackCreatedAt = createdAt;
    return {
      event,
      seq,
      createdAt,
    };
  });
  const updatedAt = entries.length > 0 ? Math.max(...entries.map((entry) => entry.createdAt)) : now;
  runOpenClawAgentWriteTransaction((database) => {
    ensureTranscriptSessionRoot({ database, sessionId, updatedAt });
    executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_events")
        .where("session_id", "=", sessionId),
    );
    entries.forEach((entry) => {
      insertTranscriptEvent({
        database,
        sessionId,
        seq: entry.seq,
        event: entry.event,
        createdAt: entry.createdAt,
      });
    });
  }, options);

  return { replaced: options.events.length };
}

function readTranscriptEventId(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const eventId = (event as { id?: unknown }).id;
  return typeof eventId === "string" && eventId.trim() ? eventId : null;
}

function readTranscriptEventMessageIdempotencyKey(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  return readMessageIdempotencyKey((event as { message?: unknown }).message);
}

function normalizeTranscriptEventFingerprintValue(
  value: unknown,
  options: { stripTranscriptIdentity: boolean },
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeTranscriptEventFingerprintValue(entry, { stripTranscriptIdentity: false }),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    if (
      options.stripTranscriptIdentity &&
      (key === "id" || key === "parentId" || key === "firstKeptEntryId")
    ) {
      continue;
    }
    normalized[key] = normalizeTranscriptEventFingerprintValue(
      (value as Record<string, unknown>)[key],
      { stripTranscriptIdentity: false },
    );
  }
  return normalized;
}

function readTranscriptEventFingerprint(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  return JSON.stringify(
    normalizeTranscriptEventFingerprintValue(event, { stripTranscriptIdentity: true }),
  );
}

function remapTranscriptEventReferences(event: unknown, eventIds: Map<string, string>): unknown {
  if (!event || typeof event !== "object" || Array.isArray(event) || eventIds.size === 0) {
    return event;
  }
  const record = event as Record<string, unknown>;
  const parentId = typeof record.parentId === "string" ? eventIds.get(record.parentId) : undefined;
  const firstKeptEntryId =
    typeof record.firstKeptEntryId === "string" ? eventIds.get(record.firstKeptEntryId) : undefined;
  if (!parentId && !firstKeptEntryId) {
    return event;
  }
  return {
    ...record,
    ...(parentId ? { parentId } : {}),
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
  };
}

export function mergeSqliteSessionTranscriptEvents(
  options: ReplaceSqliteSessionTranscriptEventsOptions,
): { merged: number; skipped: number } {
  const { sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const timestamps = options.events.map(readTranscriptEventTimestampMs);
  let fallbackCreatedAt = timestamps.find((timestamp) => timestamp !== undefined) ?? now;
  const entries = options.events.map((event, index) => {
    const createdAt = timestamps[index] ?? fallbackCreatedAt;
    fallbackCreatedAt = createdAt;
    return { event, createdAt };
  });
  const updatedAt = entries.length > 0 ? Math.max(...entries.map((entry) => entry.createdAt)) : now;
  let merged = 0;
  let skipped = 0;

  runOpenClawAgentWriteTransaction((database) => {
    const sessionUpdatedAt = Math.max(
      updatedAt,
      readTranscriptSessionUpdatedAt(database, sessionId) ?? 0,
    );
    ensureTranscriptSessionRoot({ database, sessionId, updatedAt: sessionUpdatedAt });
    const existingIdentities = executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .selectFrom("transcript_event_identities")
        .select(["event_id", "message_idempotency_key"])
        .where("session_id", "=", sessionId),
    );
    const seenEventIds = new Set<string>();
    const seenMessageIdempotencyKeys = new Map<string, string | null>();
    for (const row of existingIdentities.rows) {
      if (typeof row.event_id === "string") {
        seenEventIds.add(row.event_id);
      }
      if (typeof row.message_idempotency_key === "string") {
        seenMessageIdempotencyKeys.set(
          row.message_idempotency_key,
          typeof row.event_id === "string" ? row.event_id : null,
        );
      }
    }

    const existingEvents = executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", "event_json", "created_at"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    );
    const legacyReplayFingerprints: Array<{ fingerprint: string; eventId: string | null }> = [];
    let existingMinSeq: number | undefined;
    let existingMaxCreatedAt: number | undefined;
    for (const row of existingEvents.rows) {
      const seq = typeof row.seq === "bigint" ? Number(row.seq) : row.seq;
      existingMinSeq = Math.min(existingMinSeq ?? seq, seq);
      const createdAt = parseCreatedAt(row.created_at);
      existingMaxCreatedAt = Math.max(existingMaxCreatedAt ?? createdAt, createdAt);
      const existingEvent = parseTranscriptEventJson(row.event_json, seq);
      const fingerprint = readTranscriptEventFingerprint(existingEvent);
      if (options.legacyReplayFingerprintDedupe && fingerprint) {
        legacyReplayFingerprints.push({
          fingerprint,
          eventId: readTranscriptEventId(existingEvent),
        });
      }
    }

    const remappedEventIds = new Map<string, string>();
    const shouldSkipNewStaleEvents =
      existingMinSeq !== undefined &&
      existingMaxCreatedAt !== undefined &&
      updatedAt < existingMaxCreatedAt;
    let nextSeq = readNextTranscriptSeq(database, sessionId);
    let legacyReplayFingerprintIndex = 0;
    const consumeExistingFingerprint = (fingerprint: string | null): string | null | undefined => {
      if (!options.legacyReplayFingerprintDedupe || !fingerprint) {
        return undefined;
      }
      const existing = legacyReplayFingerprints[legacyReplayFingerprintIndex];
      if (existing?.fingerprint !== fingerprint) {
        return undefined;
      }
      legacyReplayFingerprintIndex += 1;
      return existing.eventId;
    };
    for (const entry of entries) {
      const event = remapTranscriptEventReferences(entry.event, remappedEventIds);
      const eventId = readTranscriptEventId(event);
      const fingerprint = options.legacyReplayFingerprintDedupe
        ? readTranscriptEventFingerprint(event)
        : null;
      if (eventId && seenEventIds.has(eventId)) {
        remappedEventIds.set(eventId, eventId);
        consumeExistingFingerprint(fingerprint);
        skipped += 1;
        continue;
      }
      const idempotencyKey = readTranscriptEventMessageIdempotencyKey(event);
      const existingIdempotentEventId = idempotencyKey
        ? seenMessageIdempotencyKeys.get(idempotencyKey)
        : undefined;
      if (existingIdempotentEventId !== undefined) {
        if (eventId && existingIdempotentEventId) {
          remappedEventIds.set(eventId, existingIdempotentEventId);
        }
        consumeExistingFingerprint(fingerprint);
        skipped += 1;
        continue;
      }
      const existingEventId = consumeExistingFingerprint(fingerprint);
      if (existingEventId !== undefined) {
        if (eventId && existingEventId) {
          remappedEventIds.set(eventId, existingEventId);
        }
        skipped += 1;
        continue;
      }
      if (shouldSkipNewStaleEvents) {
        skipped += 1;
        continue;
      }
      insertTranscriptEvent({
        database,
        sessionId,
        seq: nextSeq,
        event,
        createdAt: entry.createdAt,
      });
      nextSeq += 1;
      merged += 1;
      if (eventId) {
        seenEventIds.add(eventId);
      }
      if (idempotencyKey) {
        seenMessageIdempotencyKeys.set(idempotencyKey, eventId);
      }
    }
  }, options);

  return { merged, skipped };
}

export function loadSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptEvent[] {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  return executeSqliteQuerySync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select(["seq", "event_json", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows.map(parseTranscriptEventRow);
}

export function readLatestSqliteSessionTranscriptLeafId(
  options: SqliteSessionTranscriptStoreOptions,
): string | null {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_event_identities")
      .select(["event_id"])
      .where("session_id", "=", sessionId)
      .where((eb) => eb.or([eb("event_type", "is", null), eb("event_type", "!=", "session")]))
      .orderBy("seq", "desc")
      .limit(1),
  );
  return typeof row?.event_id === "string" && row.event_id.trim() ? row.event_id.trim() : null;
}

export function loadSqliteSessionTranscriptTailEvents(
  options: LoadSqliteSessionTranscriptTailEventsOptions,
): SqliteSessionTranscriptEvent[] {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const maxEvents = normalizePositiveInteger(options.maxEvents, 1);
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? Math.max(1024, Math.floor(options.maxBytes))
      : undefined;
  const rows = executeSqliteQuerySync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select(["seq", "event_json", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(maxEvents),
  ).rows;
  const selected: typeof rows = [];
  let bytes = 0;
  for (const row of rows) {
    const eventBytes = Buffer.byteLength(row.event_json, "utf8") + 1;
    if (maxBytes !== undefined && selected.length > 0 && bytes + eventBytes > maxBytes) {
      break;
    }
    selected.push(row);
    bytes += eventBytes;
  }
  return selected.toReversed().map(parseTranscriptEventRow);
}

export function loadSqliteSessionTranscriptBoundedEvents(
  options: LoadSqliteSessionTranscriptBoundedEventsOptions,
): SqliteSessionTranscriptEvent[] {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const maxEvents = normalizePositiveInteger(options.maxEvents, 1);
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? Math.max(1, Math.floor(options.maxBytes))
      : undefined;
  const rows = executeSqliteQuerySync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select(["seq", "event_json", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc")
      .limit(maxEvents),
  ).rows;
  const selected: typeof rows = [];
  let bytes = 0;
  for (const row of rows) {
    const eventBytes = Buffer.byteLength(row.event_json, "utf8") + 1;
    if (maxBytes !== undefined && selected.length > 0 && bytes + eventBytes > maxBytes) {
      break;
    }
    if (maxBytes !== undefined && selected.length === 0 && eventBytes > maxBytes) {
      return [];
    }
    selected.push(row);
    bytes += eventBytes;
  }
  return selected.map(parseTranscriptEventRow);
}

export function countSqliteSessionTranscriptDisplayMessages(
  options: SqliteSessionTranscriptStoreOptions,
): number {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const row = executeCompiledSqliteQuerySync(
    database.db,
    // kysely-allow-raw: recursive CTE; inputs stay parameterized through Kysely.
    sql<{
      parent_link_count?: unknown;
      active_count?: unknown;
      fallback_count?: unknown;
    }>`
      WITH latest_leaf AS (
        SELECT event_id
        FROM transcript_event_identities
        WHERE session_id = ${sessionId} AND (event_type IS NULL OR event_type != 'session') AND has_parent = 1
        ORDER BY seq DESC
        LIMIT 1
      ),
      active_chain(event_id, parent_id, seq, event_type) AS (
        SELECT event_id, parent_id, seq, event_type
        FROM transcript_event_identities
        WHERE session_id = ${sessionId} AND event_id = (SELECT event_id FROM latest_leaf)
        UNION ALL
        SELECT parent.event_id, parent.parent_id, parent.seq, parent.event_type
        FROM transcript_event_identities AS parent
        JOIN active_chain AS child ON child.parent_id = parent.event_id
        WHERE parent.session_id = ${sessionId}
      )
      SELECT
        (SELECT COUNT(*) FROM transcript_event_identities WHERE session_id = ${sessionId} AND has_parent = 1) AS parent_link_count,
        (
          SELECT COUNT(*)
          FROM active_chain
          JOIN transcript_events ON transcript_events.session_id = ${sessionId}
            AND transcript_events.seq = active_chain.seq
          WHERE active_chain.event_type IN ('message', 'compaction')
            OR instr(transcript_events.event_json, '"message":') > 0
            OR instr(transcript_events.event_json, '"type":"compaction"') > 0
        ) AS active_count,
        (
          SELECT COUNT(*)
          FROM transcript_events
          WHERE session_id = ${sessionId}
            AND (instr(event_json, '"message":') > 0 OR instr(event_json, '"type":"compaction"') > 0)
        ) AS fallback_count
      `.compile(getAgentTranscriptKysely(database.db)),
  ).rows[0];
  const parentLinkCount = parseSqliteCount(row?.parent_link_count);
  const activeCount = parseSqliteCount(row?.active_count);
  return parentLinkCount > 0 && activeCount > 0
    ? activeCount
    : parseSqliteCount(row?.fallback_count);
}

export function hasSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_events")
      .select((eb) => eb.lit(1).as("found"))
      .where("session_id", "=", sessionId)
      .limit(1),
  );
  return row?.found !== undefined;
}

export function recordSqliteSessionTranscriptSnapshot(
  options: SqliteSessionTranscriptStoreOptions & {
    snapshotId: string;
    reason: string;
    eventCount: number;
    createdAt?: number;
    metadata?: unknown;
  },
): void {
  const { sessionId } = normalizeTranscriptScope(options);
  const snapshotId = normalizeSessionId(options.snapshotId);
  const reason = options.reason.trim() || "snapshot";
  const eventCount = Math.max(0, Math.floor(options.eventCount));
  const createdAt = options.createdAt ?? Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    ensureTranscriptSessionRoot({ database, sessionId, updatedAt: createdAt });
    executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .insertInto("transcript_snapshots")
        .values({
          session_id: sessionId,
          snapshot_id: snapshotId,
          reason,
          event_count: eventCount,
          created_at: createdAt,
          metadata_json: JSON.stringify(options.metadata ?? {}),
        })
        .onConflict((conflict) =>
          conflict.columns(["session_id", "snapshot_id"]).doUpdateSet({
            reason: (eb) => eb.ref("excluded.reason"),
            event_count: (eb) => eb.ref("excluded.event_count"),
            created_at: (eb) => eb.ref("excluded.created_at"),
            metadata_json: (eb) => eb.ref("excluded.metadata_json"),
          }),
        ),
    );
  }, options);
}

export function hasSqliteSessionTranscriptSnapshot(
  options: SqliteSessionTranscriptStoreOptions & { snapshotId: string },
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const snapshotId = normalizeSessionId(options.snapshotId);
  const database = openTranscriptAgentDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getAgentTranscriptKysely(database.db)
      .selectFrom("transcript_snapshots")
      .select((eb) => eb.lit(1).as("found"))
      .where("session_id", "=", sessionId)
      .where("snapshot_id", "=", snapshotId)
      .limit(1),
  );
  return row?.found !== undefined;
}

export function deleteSqliteSessionTranscriptSnapshot(
  options: SqliteSessionTranscriptStoreOptions & { snapshotId: string },
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const snapshotId = normalizeSessionId(options.snapshotId);
  return runOpenClawAgentWriteTransaction((database) => {
    const result = executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_snapshots")
        .where("session_id", "=", sessionId)
        .where("snapshot_id", "=", snapshotId),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, options);
}

export function deleteSqliteSessionTranscript(
  options: SqliteSessionTranscriptStoreOptions,
): boolean {
  const { sessionId } = normalizeTranscriptScope(options);
  const removed = runOpenClawAgentWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_snapshots")
        .where("session_id", "=", sessionId),
    );
    const events = executeSqliteQuerySync(
      database.db,
      getAgentTranscriptKysely(database.db)
        .deleteFrom("transcript_events")
        .where("session_id", "=", sessionId),
    );
    deleteTranscriptSessionRootIfUnused({ database, sessionId });
    return Number(events.numAffectedRows ?? 0) > 0;
  }, options);
  return removed;
}
