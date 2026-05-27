import nodePath from "node:path";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import type { PersistableSessionMessage } from "../../agents/transcript/session-transcript-types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAndPersistSessionTranscriptScope } from "./session-scope.js";
import { getSessionEntry, normalizeSessionRowKey } from "./store.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import {
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

export type SessionTranscriptAppendResult =
  | { ok: true; messageId: string; sessionFile?: string }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "signal-only" | "none";

export type SessionTranscriptAssistantMessage = PersistableSessionMessage & {
  role: "assistant";
};

type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type LatestAssistantTranscriptText = AssistantTranscriptText;
export type TailAssistantTranscriptText = AssistantTranscriptText;

type TranscriptQueryScope = {
  agentId?: string;
  sessionId?: string;
};

type TranscriptSessionStoreTarget = {
  agentId: string;
  path?: string;
};

function parseCanonicalSessionStorePath(
  storePath: string,
): { agentId: string; stateDir: string } | undefined {
  const resolved = nodePath.resolve(storePath);
  if (nodePath.basename(resolved) !== "sessions.json") {
    return undefined;
  }
  const sessionsDir = nodePath.dirname(resolved);
  if (nodePath.basename(sessionsDir) !== "sessions") {
    return undefined;
  }
  const agentDir = nodePath.dirname(sessionsDir);
  const agentsDir = nodePath.dirname(agentDir);
  if (nodePath.basename(agentsDir) !== "agents") {
    return undefined;
  }
  const agentId = nodePath.basename(agentDir);
  if (!agentId) {
    return undefined;
  }
  return {
    agentId: normalizeAgentId(agentId),
    stateDir: nodePath.dirname(agentsDir),
  };
}

function resolveTranscriptSessionStoreTarget(params: {
  agentId: string;
  storePath?: string;
}): TranscriptSessionStoreTarget {
  const agentId = normalizeAgentId(params.agentId);
  const storePath = params.storePath?.trim();
  if (!storePath || storePath === "(sqlite)") {
    return { agentId };
  }
  const parsed = parseCanonicalSessionStorePath(storePath);
  if (parsed) {
    return {
      agentId: parsed.agentId,
      path: resolveOpenClawAgentSqlitePath({
        agentId: parsed.agentId,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: parsed.stateDir,
        },
      }),
    };
  }
  if (nodePath.extname(storePath) === ".json") {
    return { agentId };
  }
  return {
    agentId,
    path: storePath,
  };
}

function hasTranscriptQueryScope(scope?: TranscriptQueryScope | string): scope is {
  agentId: string;
  sessionId: string;
} {
  return typeof scope !== "string" && Boolean(scope?.agentId?.trim() && scope.sessionId?.trim());
}

function loadScopedSqliteTranscriptEvents(
  scope?: TranscriptQueryScope | string,
): unknown[] | undefined {
  if (!hasTranscriptQueryScope(scope)) {
    return undefined;
  }
  try {
    if (!hasSqliteSessionTranscriptEvents(scope)) {
      return undefined;
    }
    return loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  } catch {
    return undefined;
  }
}

function parseAssistantTranscriptEventText(
  event: unknown,
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): AssistantTranscriptText | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const parsed = event as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as
    | { role?: unknown; timestamp?: unknown; provider?: unknown; model?: unknown }
    | undefined;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    options?.excludeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantMessage(message)
  ) {
    return undefined;
  }
  const text = extractAssistantVisibleText(message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function isTranscriptOnlyOpenClawAssistantMessage(message: {
  provider?: unknown;
  model?: unknown;
}): boolean {
  return (
    message.provider === "openclaw" &&
    (message.model === "delivery-mirror" || message.model === "gateway-injected")
  );
}

function isTranscriptMessageEvent(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const parsed = event as { message?: unknown; type?: unknown };
  return parsed.type === "message" && Boolean(parsed.message) && typeof parsed.message === "object";
}

export async function resolveSessionTranscriptTarget(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  agentId: string;
  threadId?: string | number;
}): Promise<{ agentId: string; sessionId: string; sessionEntry: SessionEntry | undefined }> {
  let sessionEntry = params.sessionEntry;

  const resolvedTranscript = await resolveAndPersistSessionTranscriptScope({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry,
    agentId: params.agentId,
  });
  sessionEntry = resolvedTranscript.sessionEntry;

  return {
    agentId: resolvedTranscript.agentId,
    sessionId: resolvedTranscript.sessionId,
    sessionEntry,
  };
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  agentId: string;
  threadId?: string | number;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
}): Promise<{ agentId: string; sessionId: string; sessionEntry: SessionEntry | undefined }> {
  return await resolveSessionTranscriptTarget(params);
}

export async function readLatestAssistantTextFromSessionTranscript(
  scope: TranscriptQueryScope | string,
): Promise<LatestAssistantTranscriptText | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope);
  if (scopedEvents) {
    for (const event of scopedEvents.toReversed()) {
      const assistantText = parseAssistantTranscriptEventText(event, {
        excludeTranscriptOnlyOpenClawAssistant: true,
      });
      if (assistantText) {
        return assistantText;
      }
    }
    return undefined;
  }

  return undefined;
}

export async function readTailAssistantTextFromSessionTranscript(
  scope: TranscriptQueryScope | string,
): Promise<TailAssistantTranscriptText | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope);
  if (scopedEvents) {
    for (const event of scopedEvents.toReversed()) {
      const assistantText = parseAssistantTranscriptEventText(event);
      if (assistantText) {
        return assistantText;
      }
      if (isTranscriptMessageEvent(event)) {
        return undefined;
      }
    }
    return undefined;
  }

  return undefined;
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    idempotencyKey: params.idempotencyKey,
    updateMode: params.updateMode,
    config: params.config,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const agentId = normalizeAgentId(
    params.agentId ?? resolveAgentIdFromSessionKey(sessionKey) ?? DEFAULT_AGENT_ID,
  );
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const target = resolveTranscriptSessionStoreTarget({ agentId, storePath: params.storePath });
  const entry = getSessionEntry({
    agentId: target.agentId,
    ...(target.path ? { path: target.path } : {}),
    sessionKey: normalizedKey,
  });
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  try {
    await resolveAndPersistSessionTranscriptScope({
      sessionId: entry.sessionId,
      sessionKey: normalizedKey,
      sessionEntry: entry,
      agentId: target.agentId,
      ...(target.path ? { path: target.path } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      reason: formatErrorMessage(err),
    };
  }

  const explicitIdempotencyKey =
    params.idempotencyKey ??
    ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
  const message = {
    ...params.message,
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
  };
  const dedupeLatestAssistantText = isRedundantDeliveryMirror(params.message)
    ? extractAssistantMessageText(
        redactTranscriptMessage(
          message,
          params.config,
        ) as unknown as SessionTranscriptAssistantMessage,
      )
    : null;
  const appended = await appendSessionTranscriptMessage({
    agentId: target.agentId,
    ...(target.path ? { path: target.path } : {}),
    ...(dedupeLatestAssistantText ? { dedupeLatestAssistantText } : {}),
    ...(explicitIdempotencyKey ? { idempotencyLookup: "scan" } : {}),
    message,
    sessionId: entry.sessionId,
    config: params.config,
  });
  if (!appended) {
    return { ok: false, reason: "message skipped" };
  }
  const { messageId, message: appendedMessage } = appended;
  if (!appended.appended) {
    return { ok: true, messageId };
  }

  switch (params.updateMode ?? "inline") {
    case "inline":
      emitSessionTranscriptUpdate({
        agentId: target.agentId,
        sessionId: entry.sessionId,
        sessionKey,
        message: appendedMessage,
        messageId,
      });
      break;
    case "signal-only":
      emitSessionTranscriptUpdate({
        agentId: target.agentId,
        sessionId: entry.sessionId,
        sessionKey,
      });
      break;
    case "none":
      break;
  }
  return { ok: true, messageId };
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function extractAssistantMessageText(message: SessionTranscriptAssistantMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());

  return parts.length > 0 ? parts.join("\n").trim() : null;
}
