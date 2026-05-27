import { AsyncLocalStorage } from "node:async_hooks";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { withOpenClawStateLock } from "../../../state/openclaw-state-lock.js";

type ActiveWriteLockState = {
  active: boolean;
};

type HeldSessionLock = {
  release: () => Promise<void>;
};

type LockOptions = {
  sessionFile?: string;
  sessionKey?: string;
  sessionId?: string;
  path?: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionWriteLockRunOptions = {
  publishOwnedWrite?: boolean;
};

type WithSessionWriteLock = <T>(
  run: () => Promise<T> | T,
  options?: SessionWriteLockRunOptions,
) => Promise<T>;

type SessionEventProcessor = {
  _processAgentEvent?: (event: unknown) => Promise<void>;
  _extensionRunner?: {
    hasHandlers?: (eventType: string) => boolean;
  };
  __openclawSessionEventWriteLockInstalled?: boolean;
};

type SessionEventQueueOwner = {
  _agentEventQueue?: PromiseLike<unknown>;
};

type SessionEventQueueBridge = SessionEventQueueOwner & {
  _handleAgentEvent?: AwaitableSessionEventHandler;
  _disconnectFromAgent?: () => void;
  _reconnectToAgent?: () => void;
};

type AwaitableSessionEventHandler = ((event: unknown, signal?: unknown) => unknown) & {
  __openclawSessionEventQueueAwaitInstalled?: boolean;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type SessionWithExternalHooks = SessionEventProcessor & {
  compact?: LockableFunction;
  agent?: {
    beforeToolCall?: LockableFunction;
    afterToolCall?: LockableFunction;
    onPayload?: LockableFunction;
    onResponse?: LockableFunction;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type LockableFunction = ((...args: unknown[]) => unknown) & {
  __openclawSessionWriteLockInstalled?: boolean;
};

const activeSessionLockState = new AsyncLocalStorage<ActiveWriteLockState>();

function sessionHasExtensionHandlers(session: SessionEventProcessor, eventType: string): boolean {
  const extensionRunner = session["_extensionRunner"];
  const hasHandlers = extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(extensionRunner, eventType);
  } catch {
    return true;
  }
}

function eventMayReachTranscriptWriters(session: SessionEventProcessor, event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  if (type === "message_update" || type === "message_end" || type === "agent_end") {
    return true;
  }
  if (typeof type !== "string") {
    return false;
  }
  return sessionHasExtensionHandlers(session, type);
}

function installLockableFunction(params: {
  owner: Record<string, unknown>;
  key: string;
  shouldLock: () => boolean;
  waitBeforeLock?: () => Promise<void>;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const current = params.owner[params.key] as LockableFunction | undefined;
  if (typeof current !== "function" || current["__openclawSessionWriteLockInstalled"] === true) {
    return;
  }
  const wrapped: LockableFunction = async function lockedExternalHook(
    this: unknown,
    ...args: unknown[]
  ) {
    if (!params.shouldLock()) {
      return await current.apply(this, args);
    }
    await params.waitBeforeLock?.();
    return await params.withSessionWriteLock(async () => await current.apply(this, args));
  };
  wrapped["__openclawSessionWriteLockInstalled"] = true;
  params.owner[params.key] = wrapped;
}

async function waitForSessionEventQueue(session: unknown): Promise<void> {
  const owner = session as SessionEventQueueOwner | null | undefined;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queue = owner?._agentEventQueue;
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    await Promise.resolve(queue).catch(() => {});
    if (owner?._agentEventQueue === queue) {
      return;
    }
  }
  const queue = owner?._agentEventQueue;
  if (queue && typeof queue.then === "function") {
    await Promise.resolve(queue).catch(() => {});
  }
}

function installAwaitableSessionEventQueue(session: unknown): void {
  const owner = session as SessionEventQueueBridge;
  const original = owner["_handleAgentEvent"];
  if (
    typeof original !== "function" ||
    original["__openclawSessionEventQueueAwaitInstalled"] === true
  ) {
    return;
  }
  const canReconnect =
    typeof owner._disconnectFromAgent === "function" &&
    typeof owner._reconnectToAgent === "function";
  if (canReconnect) {
    owner._disconnectFromAgent?.();
  }
  const wrapped: AwaitableSessionEventHandler = function awaitableHandleAgentEvent(
    ...args: [event: unknown, signal?: unknown]
  ) {
    const result = original(...args);
    const queue = owner._agentEventQueue;
    return queue && typeof queue.then === "function" ? Promise.resolve(queue) : result;
  };
  wrapped["__openclawSessionEventQueueAwaitInstalled"] = true;
  owner["_handleAgentEvent"] = wrapped;
  if (canReconnect) {
    owner._reconnectToAgent?.();
  }
}

function resolveLockKey(options: LockOptions): string {
  const key =
    options.sessionKey?.trim() ||
    options.sessionId?.trim() ||
    options.sessionFile?.trim() ||
    "unknown-session";
  return key.replace(/\s+/g, " ").slice(0, 512);
}

function resolveRetryCount(timeoutMs: number): number {
  return Math.max(0, Math.ceil(Math.max(1, timeoutMs) / 100));
}

async function acquireSqliteSessionWriteLock(options: LockOptions): Promise<HeldSessionLock> {
  let releaseGate!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  let resolveAcquired!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const lockTask = withOpenClawStateLock(
    resolveLockKey(options),
    {
      ...(options.path ? { path: options.path } : {}),
      scope: "embedded-attempt-session-write",
      stale: Math.max(1, options.maxHoldMs || options.staleMs),
      retries: {
        retries: resolveRetryCount(options.timeoutMs),
        minTimeout: 10,
        maxTimeout: 100,
        factor: 1,
        randomize: false,
      },
    },
    async (signal) => {
      if (signal.aborted) {
        throw signal.reason;
      }
      resolveAcquired();
      await gate;
    },
  );
  void lockTask.catch(rejectAcquired);
  await acquired;
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      releaseGate();
      await lockTask;
    },
  };
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionRef: string) {
    super(`session changed while embedded prompt lock was released: ${sessionRef}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export function installSessionEventWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  installAwaitableSessionEventQueue(params.session);
  const session = params.session as SessionEventProcessor;
  if (
    typeof session._processAgentEvent !== "function" ||
    session.__openclawSessionEventWriteLockInstalled === true
  ) {
    return;
  }
  const original = session._processAgentEvent;
  session.__openclawSessionEventWriteLockInstalled = true;
  session._processAgentEvent = async function lockedProcessAgentEvent(
    this: unknown,
    event: unknown,
  ) {
    if (!eventMayReachTranscriptWriters(session, event)) {
      return await original.call(this, event);
    }
    return await params.withSessionWriteLock(async () => await original.call(this, event));
  };
}

export function installSessionExternalHookWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionWithExternalHooks;
  const agent = session.agent;
  if (agent) {
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "beforeToolCall",
      shouldLock: () => true,
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "afterToolCall",
      shouldLock: () => sessionHasExtensionHandlers(session, "tool_result"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onPayload",
      shouldLock: () => sessionHasExtensionHandlers(session, "before_provider_request"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onResponse",
      shouldLock: () => sessionHasExtensionHandlers(session, "after_provider_response"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
  }
  installLockableFunction({
    owner: session as Record<string, unknown>,
    key: "compact",
    shouldLock: () => true,
    waitBeforeLock: () => waitForSessionEventQueue(session),
    withSessionWriteLock: params.withSessionWriteLock,
  });
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<HeldSessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  lockOptions: LockOptions;
}): Promise<EmbeddedAttemptSessionLockController> {
  let lock: HeldSessionLock | null = await acquireSqliteSessionWriteLock(params.lockOptions);
  let lockHeldByCleanup = false;
  let takeoverDetected = false;

  const acquire = async (): Promise<HeldSessionLock> => {
    if (lock) {
      return lock;
    }
    lock = await acquireSqliteSessionWriteLock(params.lockOptions);
    return lock;
  };
  const release = async (): Promise<void> => {
    if (!lock) {
      return;
    }
    const lockToRelease = lock;
    lock = null;
    await lockToRelease.release();
  };

  return {
    async releaseForPrompt(): Promise<void> {
      lockHeldByCleanup = false;
      await release();
    },
    async releaseHeldLockForAbort(): Promise<void> {
      lockHeldByCleanup = false;
      await release();
    },
    refreshAfterOwnedSessionWrite(): void {
      takeoverDetected = false;
    },
    async reacquireAfterPrompt(): Promise<void> {
      await acquire();
    },
    waitForSessionEvents: waitForSessionEventQueue,
    async withSessionWriteLock<T>(
      run: () => Promise<T> | T,
      options?: SessionWriteLockRunOptions,
    ): Promise<T> {
      const active = activeSessionLockState.getStore();
      if (active?.active && !options?.publishOwnedWrite) {
        return await run();
      }
      const writeLock = lock ? null : await acquireSqliteSessionWriteLock(params.lockOptions);
      const state: ActiveWriteLockState = { active: true };
      try {
        return await activeSessionLockState.run(state, async () => await run());
      } catch (error) {
        throw error;
      } finally {
        state.active = false;
        await writeLock?.release();
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<HeldSessionLock> {
      await waitForSessionEventQueue(cleanupParams?.session);
      if (lock) {
        lockHeldByCleanup = true;
        const cleanupLock = lock;
        return {
          release: async () => {
            if (lock === cleanupLock) {
              lock = null;
            }
            await cleanupLock.release();
          },
        };
      }
      lock = await acquireSqliteSessionWriteLock(params.lockOptions);
      lockHeldByCleanup = true;
      const cleanupLock = lock;
      return {
        release: async () => {
          if (lock === cleanupLock) {
            lock = null;
          }
          await cleanupLock.release();
        },
      };
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
    async dispose(): Promise<void> {
      if (!lock || lockHeldByCleanup) {
        return;
      }
      await release();
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock?: WithSessionWriteLock;
}): void {
  const session = params.session as SessionWithAgentPrompt;
  const currentStreamFn = session.agent?.streamFn;
  if (
    typeof currentStreamFn !== "function" ||
    currentStreamFn.__openclawSessionLockPromptReleaseInstalled === true
  ) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(session.agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    try {
      if ((params.sessionFile || params.sessionKey) && params.withSessionWriteLock) {
        return await withOwnedSessionTranscriptWrites(
          {
            ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            withSessionWriteLock: params.withSessionWriteLock,
          },
          async () => await originalStreamFn(...args),
        );
      }
      return await originalStreamFn(...args);
    } finally {
      await params.reacquireAfterPrompt();
    }
  };
  wrappedStreamFn.__openclawSessionLockPromptReleaseInstalled = true;
  session.agent!.streamFn = wrappedStreamFn;
}
