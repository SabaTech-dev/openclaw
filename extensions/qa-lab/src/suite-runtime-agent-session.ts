import { setTimeout as sleep } from "node:timers/promises";
import {
  CURRENT_SESSION_VERSION,
  loadCommitmentStore,
  replaceSqliteSessionTranscriptEvents,
  saveCommitmentStore,
  type CommitmentStoreSnapshot,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionEntry,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
} from "./suite-runtime-types.js";

type QaGatewayCallEnv = Pick<
  QaSuiteRuntimeEnv,
  "gateway" | "primaryModel" | "alternateModel" | "providerMode"
>;

const SESSION_STORE_LOCK_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;

function isSessionStoreLockTimeout(error: unknown) {
  const text = formatErrorMessage(error);
  return (
    text.includes("OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT") ||
    text.includes("SessionWriteLockTimeoutError") ||
    text.includes("session file locked")
  );
}

async function callGatewayWithSessionStoreLockRetry<T>(
  env: QaGatewayCallEnv,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number },
) {
  for (let attempt = 0; attempt <= SESSION_STORE_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return (await env.gateway.call(method, params, options)) as T;
    } catch (error) {
      if (
        !isSessionStoreLockTimeout(error) ||
        attempt === SESSION_STORE_LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(SESSION_STORE_LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(`${method} failed after session store lock retries`);
}

type ActiveMemorySessionToggleEntry = {
  version: 1;
  disabled: true;
  updatedAt: number;
};

type QaCrestodianAuditEntry = {
  timestamp?: string;
  operation?: string;
  summary?: string;
  [key: string]: unknown;
};

function createActiveMemorySessionToggleStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  return createPluginStateKeyedStore<ActiveMemorySessionToggleEntry>("active-memory", {
    namespace: "session-toggles",
    maxEntries: 50_000,
    env: env.gateway.runtimeEnv,
  });
}

function createCrestodianAuditStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  return createPluginStateKeyedStore<QaCrestodianAuditEntry>("crestodian", {
    namespace: "audit",
    maxEntries: 50_000,
    env: env.gateway.runtimeEnv,
  });
}

async function createSession(env: QaGatewayCallEnv, label: string, key?: string) {
  const created = await callGatewayWithSessionStoreLockRetry<{ key?: string }>(
    env,
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  );
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaGatewayCallEnv, sessionKey: string) {
  const payload = await callGatewayWithSessionStoreLockRetry<{
    groups?: Array<{ tools?: Array<{ id?: string }> }>;
  }>(
    env,
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  );
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function seedQaSessionTranscript(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    messages?: Array<{ role: string; content: unknown; timestamp?: number | string }>;
    now?: number;
    deliveryContext?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    };
    spawnedBy?: string;
    parentSessionKey?: string;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    endedAt?: number;
  },
) {
  const agentId = params.agentId?.trim() || "qa";
  const now = params.now ?? Date.now();
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    throw new Error("seedQaSessionTranscript requires sessionId");
  }
  const sessionKey = params.sessionKey?.trim() || `agent:${agentId}:seed-${sessionId}`;
  const messages = params.messages ?? [];
  let parentId: string | null = null;
  const messageEvents = messages.map((message, index) => {
    const id = `qa-seed-${index + 1}`;
    const timestampMs = now - Math.max(1, messages.length - index) * 30_000;
    const event = {
      type: "message" as const,
      id,
      parentId,
      timestamp: new Date(timestampMs).toISOString(),
      message: {
        ...message,
        timestamp:
          typeof message.timestamp === "number" || typeof message.timestamp === "string"
            ? message.timestamp
            : timestampMs,
      },
    };
    parentId = id;
    return event;
  });
  replaceSqliteSessionTranscriptEvents({
    agentId,
    sessionId,
    env: env.gateway.runtimeEnv,
    events: [
      {
        type: "session",
        id: sessionId,
        version: CURRENT_SESSION_VERSION,
        timestamp: new Date(now - 120_000).toISOString(),
        cwd: env.gateway.workspaceDir,
      },
      ...messageEvents,
    ],
    now: () => now,
  });
  upsertSessionEntry({
    agentId,
    env: env.gateway.runtimeEnv,
    sessionKey,
    entry: {
      sessionId,
      updatedAt: now,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.spawnedBy ? { spawnedBy: params.spawnedBy } : {}),
      ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(typeof params.endedAt === "number" ? { endedAt: params.endedAt } : {}),
    },
  });
  return { agentId, sessionId, sessionKey, transcriptScope: { agentId, sessionId } };
}

async function setQaActiveMemorySessionDisabled(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: { sessionKey: string; disabled: boolean; now?: number },
) {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("setQaActiveMemorySessionDisabled requires sessionKey");
  }
  const toggleStore = createActiveMemorySessionToggleStore(env);
  if (params.disabled) {
    await toggleStore.register(sessionKey, {
      version: 1,
      disabled: true,
      updatedAt: params.now ?? Date.now(),
    });
    return { sessionKey, disabled: true };
  }
  await toggleStore.delete(sessionKey);
  return { sessionKey, disabled: false };
}

async function readQaCrestodianAuditEntries(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const auditStore = createCrestodianAuditStore(env);
  return (await auditStore.entries()).map(
    (entry: { value: QaCrestodianAuditEntry }) => entry.value,
  );
}

async function seedQaCommitmentStore(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  store: CommitmentStoreSnapshot,
) {
  await saveCommitmentStore(store, { env: env.gateway.runtimeEnv });
  return { count: store.commitments.length };
}

async function readQaCommitmentStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  return await loadCommitmentStore({ env: env.gateway.runtimeEnv });
}

async function readSkillStatus(env: QaGatewayCallEnv, agentId = "qa") {
  const payload = await callGatewayWithSessionStoreLockRetry<{
    skills?: QaSkillStatusEntry[];
  }>(
    env,
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  );
  return payload.skills ?? [];
}

async function readRawQaSessionEntries(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const payload = (await env.gateway.call(
    "sessions.list",
    {
      agentId: "qa",
      includeGlobal: true,
      includeUnknown: true,
      limit: 1000,
    },
    {
      timeoutMs: 45_000,
    },
  )) as {
    sessions?: Array<
      QaRawSessionEntry & {
        key?: string;
      }
    >;
  };
  return Object.fromEntries(
    (payload.sessions ?? []).flatMap((session) => {
      const key = session.key?.trim();
      if (!key) {
        return [];
      }
      return [
        [
          key,
          {
            ...(session.sessionId ? { sessionId: session.sessionId } : {}),
            ...(session.status ? { status: session.status } : {}),
            ...(session.spawnedBy ? { spawnedBy: session.spawnedBy } : {}),
            ...(session.label ? { label: session.label } : {}),
            ...(typeof session.abortedLastRun === "boolean"
              ? { abortedLastRun: session.abortedLastRun }
              : {}),
            ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
          } satisfies QaRawSessionEntry,
        ],
      ];
    }),
  );
}

export {
  createSession,
  readEffectiveTools,
  readQaCommitmentStore,
  readQaCrestodianAuditEntries,
  readRawQaSessionEntries,
  readSkillStatus,
  setQaActiveMemorySessionDisabled,
  seedQaCommitmentStore,
  seedQaSessionTranscript,
};
