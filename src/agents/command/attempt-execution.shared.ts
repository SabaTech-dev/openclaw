import { patchSessionEntry } from "../../config/sessions/store.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
} from "../internal-events.js";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../internal-runtime-context.js";
import type { AgentCommandOpts } from "./types.js";

export type PersistSessionEntryParams = {
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  entry: SessionEntry;
  clearedFields?: string[];
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

export async function persistSessionEntry(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve session agent for ${params.sessionKey}`);
  }
  const persisted = await patchSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    fallbackEntry: params.sessionStore?.[params.sessionKey] ?? params.entry,
    update: (existing) => {
      if (params.shouldPersist && !params.shouldPersist(existing)) {
        return null;
      }
      const merged = mergeSessionEntry(existing, params.entry);
      for (const field of params.clearedFields ?? []) {
        if (!Object.hasOwn(params.entry, field)) {
          Reflect.deleteProperty(merged, field);
        }
      }
      return merged;
    },
  });
  const nextEntry = persisted ?? undefined;
  if (nextEntry && params.sessionStore) {
    params.sessionStore[params.sessionKey] = nextEntry;
  } else if (params.sessionStore) {
    delete params.sessionStore[params.sessionKey];
  }
  return nextEntry;
}

export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

function resolvePlainInternalEventBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  const renderedEvents = formatAgentInternalEventsForPlainPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  const visibleBody = stripInternalRuntimeContext(body).trim();
  return [renderedEvents, visibleBody].filter(Boolean).join("\n\n") || body;
}

export function resolveAcpPromptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  return events?.length ? resolvePlainInternalEventBody(body, events) : body;
}

export function resolveInternalEventTranscriptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (!hasInternalRuntimeContext(body)) {
    return body;
  }
  return resolvePlainInternalEventBody(body, events);
}
