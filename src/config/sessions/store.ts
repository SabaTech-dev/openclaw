import type { MsgContext } from "../../auto-reply/templating.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import { conversationIdentityFromMsgContext } from "./conversation-identity.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  applySqliteSessionEntriesPatch,
  deleteSqliteSessionEntry,
  listSqliteSessionEntries,
  moveSqliteSessionEntryKey,
  readSqliteSessionEntry,
  replaceSqliteSessionEntry,
} from "./session-entries.sqlite.js";
import { normalizeSessionRowKey } from "./store-entry.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export { normalizeSessionRowKey, resolveSessionRowEntry } from "./store-entry.js";

const SESSION_ROW_PATCH_RETRY_LIMIT = 16;

type SessionEntryRowOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

type SessionEntryPatchResult =
  | Partial<SessionEntry>
  | {
      patch: Partial<SessionEntry>;
      mergePolicy?: "preserve-activity";
      conversationIdentities?: readonly ConversationIdentity[];
    }
  | null;

function resolveSessionRowOptionsFromSessionKey(params: {
  agentId?: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): SessionEntryRowOptions {
  const agentId =
    params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey) ?? DEFAULT_AGENT_ID;
  return {
    agentId: normalizeAgentId(agentId),
    ...(params.env ? { env: params.env } : {}),
  };
}

function uniqueSessionKeys(keys: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

function resolveLegacyRelativeSessionKey(params: {
  agentId: string;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.agentId)) {
    return undefined;
  }
  return normalizeSessionRowKey(parsed.rest);
}

function resolveSessionReadCandidateKeys(options: SessionEntryRowOptions & { sessionKey: string }) {
  const trimmedKey = options.sessionKey.trim();
  const normalizedKey = normalizeSessionRowKey(trimmedKey);
  return uniqueSessionKeys([
    trimmedKey,
    normalizedKey,
    resolveLegacyRelativeSessionKey({
      agentId: options.agentId,
      sessionKey: normalizedKey,
    }),
  ]);
}

function readSessionEntryCandidate(options: SessionEntryRowOptions & { sessionKey: string }): {
  entry?: SessionEntry;
  entryKey?: string;
} {
  for (const sessionKey of resolveSessionReadCandidateKeys(options)) {
    const entry = readSqliteSessionEntry({ ...options, sessionKey });
    if (entry) {
      return { entry, entryKey: sessionKey };
    }
  }
  return {};
}

export function getSessionEntry(
  options: SessionEntryRowOptions & { sessionKey: string },
): SessionEntry | undefined {
  return readSessionEntryCandidate(options).entry;
}

export function listSessionEntries(
  options: SessionEntryRowOptions,
): Array<{ sessionKey: string; entry: SessionEntry }> {
  return listSqliteSessionEntries(options);
}

export function loadSessionStore(
  _storePath?: string,
  _options?: { skipCache?: boolean },
): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ agentId: DEFAULT_AGENT_ID }).map(({ sessionKey, entry }) => [
      `agent:${DEFAULT_AGENT_ID}:${sessionKey}`,
      entry,
    ]),
  );
}

export function upsertSessionEntry(
  options: SessionEntryRowOptions & {
    sessionKey: string;
    entry: SessionEntry;
    conversationIdentities?: readonly ConversationIdentity[];
    allowDropAcpMeta?: boolean;
  },
): void {
  const existing = readSessionEntryCandidate(options).entry;
  const next = structuredClone(options.entry);
  if (!options.allowDropAcpMeta && existing?.acp && !next.acp) {
    next.acp = existing.acp;
  }
  replaceSqliteSessionEntry({
    ...options,
    entry: next,
  });
}

export function deleteSessionEntry(
  options: SessionEntryRowOptions & { sessionKey: string },
): boolean {
  for (const sessionKey of resolveSessionReadCandidateKeys(options)) {
    if (deleteSqliteSessionEntry({ ...options, sessionKey })) {
      return true;
    }
  }
  return false;
}

export function moveSessionEntryKey(
  options: SessionEntryRowOptions & {
    fromSessionKey: string;
    toSessionKey: string;
    entry?: SessionEntry;
  },
): boolean {
  return moveSqliteSessionEntryKey(options);
}

function resolvePatchSessionEntry(options: SessionEntryRowOptions & { sessionKey: string }): {
  entry?: SessionEntry;
  entryKey: string;
  normalizedKey: string;
} {
  const trimmedKey = options.sessionKey.trim();
  const normalizedKey = normalizeSessionRowKey(trimmedKey);
  for (const sessionKey of resolveSessionReadCandidateKeys(options)) {
    const entry = readSqliteSessionEntry({ ...options, sessionKey });
    if (entry) {
      return { entry, entryKey: sessionKey, normalizedKey };
    }
  }
  return { entryKey: normalizedKey, normalizedKey };
}

export async function patchSessionEntry(
  options: SessionEntryRowOptions & {
    sessionKey: string;
    fallbackEntry?: SessionEntry;
    update: (entry: SessionEntry) => Promise<SessionEntryPatchResult> | SessionEntryPatchResult;
  },
): Promise<SessionEntry | null> {
  for (let attempt = 0; attempt < SESSION_ROW_PATCH_RETRY_LIMIT; attempt += 1) {
    const resolved = resolvePatchSessionEntry(options);
    const expected = resolved.entry ? structuredClone(resolved.entry) : null;
    const existing = resolved.entry
      ? structuredClone(resolved.entry)
      : options.fallbackEntry
        ? structuredClone(options.fallbackEntry)
        : undefined;
    if (!existing) {
      return null;
    }
    const patchResult = await options.update(existing);
    if (!patchResult) {
      return resolved.entry ? existing : null;
    }
    const patch = "patch" in patchResult ? patchResult.patch : patchResult;
    const conversationIdentities =
      "patch" in patchResult ? patchResult.conversationIdentities : undefined;
    const next =
      "patch" in patchResult && patchResult.mergePolicy === "preserve-activity"
        ? mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
    const expectedEntries = new Map([[resolved.entryKey, expected]]);
    if (resolved.entryKey !== resolved.normalizedKey) {
      expectedEntries.set(resolved.normalizedKey, null);
    }
    const applied = applySqliteSessionEntriesPatch({
      agentId: options.agentId,
      env: options.env,
      path: options.path,
      upsertEntries: { [resolved.normalizedKey]: next },
      ...(conversationIdentities
        ? { conversationIdentities: { [resolved.normalizedKey]: conversationIdentities } }
        : {}),
      expectedEntries,
      deleteEntries: resolved.entryKey === resolved.normalizedKey ? undefined : [resolved.entryKey],
    });
    if (applied) {
      return next;
    }
  }
  throw new Error(
    `Session row update conflicted after ${SESSION_ROW_PATCH_RETRY_LIMIT} SQLite retries: ${options.sessionKey}`,
  );
}

export function readSessionUpdatedAt(params: {
  agentId?: string;
  sessionKey: string;
}): number | undefined {
  try {
    const options = resolveSessionRowOptionsFromSessionKey(params);
    return readSessionEntryCandidate({
      ...options,
      sessionKey: params.sessionKey,
    }).entry?.updatedAt;
  } catch {
    return undefined;
  }
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export async function recordSessionMetaFromInbound(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const rowOptions = resolveSessionRowOptionsFromSessionKey({
    agentId: params.agentId,
    env: params.env,
    sessionKey,
  });
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  return await patchSessionEntry({
    ...rowOptions,
    sessionKey,
    ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    update: (existing) => {
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey: normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        return null;
      }
      return {
        patch,
        mergePolicy: "preserve-activity",
        conversationIdentities: [
          conversationIdentityFromMsgContext({
            ctx,
            groupResolution: params.groupResolution,
          }),
        ].filter((entry) => entry !== null),
      };
    },
  });
}

export function clearSessionStoreCacheForTest(): void {
  // SQLite-backed session rows do not keep the legacy JSON store cache.
}

export async function updateLastRoute(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  channel?: SessionEntry["channel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: import("../../plugin-sdk/channel-route.js").ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { sessionKey, channel, to, accountId, threadId, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const rowOptions = resolveSessionRowOptionsFromSessionKey({
    agentId: params.agentId,
    sessionKey,
    env: params.env,
  });
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const routeContext = deliveryContextFromChannelRoute(params.route);
  const explicitContext = normalizeDeliveryContext(params.deliveryContext);
  const inlineContext = normalizeDeliveryContext({
    channel,
    to,
    accountId,
    threadId,
  });
  const mergedInput = mergeDeliveryContext(
    routeContext,
    mergeDeliveryContext(explicitContext, inlineContext),
  );
  const explicitDeliveryContext = params.deliveryContext;
  const explicitThreadFromDeliveryContext =
    explicitDeliveryContext != null &&
    Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
      ? explicitDeliveryContext.threadId
      : undefined;
  const explicitThreadValue =
    explicitThreadFromDeliveryContext ??
    (threadId != null && threadId !== "" ? threadId : undefined);
  const explicitRouteProvided = Boolean(
    routeContext?.channel ||
    routeContext?.to ||
    explicitContext?.channel ||
    explicitContext?.to ||
    inlineContext?.channel ||
    inlineContext?.to,
  );
  const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
  return await patchSessionEntry({
    ...rowOptions,
    sessionKey,
    ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    update: (existing) => {
      const fallbackContext = clearThreadFromFallback
        ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
        : deliveryContextFromSession(existing);
      const merged = mergeDeliveryContext(mergedInput, fallbackContext);
      const normalized = normalizeSessionDeliveryFields({
        route: params.route,
        deliveryContext: {
          channel: merged?.channel,
          to: merged?.to,
          accountId: merged?.accountId,
          threadId: merged?.threadId,
        },
      });
      const metaPatch = ctx
        ? deriveSessionMetaPatch({
            ctx,
            sessionKey: normalizedKey,
            existing,
            groupResolution: params.groupResolution,
          })
        : null;
      const basePatch: Partial<SessionEntry> = {
        route: normalized.route,
        channel: normalized.deliveryContext?.channel,
        deliveryContext: normalized.deliveryContext,
        lastChannel: normalized.lastChannel,
        lastTo: normalized.lastTo,
        lastAccountId: normalized.lastAccountId,
        lastThreadId: normalized.lastThreadId,
      };
      return {
        patch: metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
        mergePolicy: "preserve-activity",
        conversationIdentities: ctx
          ? [
              conversationIdentityFromMsgContext({
                ctx,
                deliveryContext: normalized.deliveryContext,
                groupResolution: params.groupResolution,
              }),
            ].filter((entry) => entry !== null)
          : undefined,
      };
    },
  });
}
