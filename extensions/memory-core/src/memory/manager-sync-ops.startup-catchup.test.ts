import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySource,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

const { listSessionTranscriptScopesForAgentMock, readSessionTranscriptDeltaStatsMock } = vi.hoisted(
  () => ({
    listSessionTranscriptScopesForAgentMock: vi.fn(),
    readSessionTranscriptDeltaStatsMock: vi.fn(),
  }),
);

vi.mock(
  "openclaw/plugin-sdk/memory-core-host-engine-session-transcripts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("openclaw/plugin-sdk/memory-core-host-engine-session-transcripts")
      >();
    return {
      ...actual,
      listSessionTranscriptScopesForAgent: listSessionTranscriptScopesForAgentMock,
      readSessionTranscriptDeltaStats: readSessionTranscriptDeltaStatsMock,
    };
  },
);

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

type SyncParams = {
  reason?: string;
  force?: boolean;
  sessionTranscriptScopes?: Array<{ agentId: string; sessionId: string }>;
  progress?: (update: MemorySyncProgressUpdate) => void;
};

type SourceStateRow = {
  sourceKey: string;
  path: string | null;
  hash: string;
  mtime?: number;
  size?: number;
};

class SessionStartupCatchupHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    sync: {
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    },
  } as ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected db: DatabaseSync;

  readonly syncCalls: SyncParams[] = [];

  constructor(sourceRows: SourceStateRow[]) {
    super();
    this.sources.add("sessions");
    this.db = {
      prepare: () => ({
        all: () => sourceRows,
        get: () => undefined,
        run: () => undefined,
      }),
    } as unknown as DatabaseSync;
  }

  async catchUp(): Promise<string[]> {
    return await this.runSessionStartupCatchup();
  }

  async markStartupDirtyTranscripts(): Promise<string[]> {
    return await this.markSessionStartupCatchupDirtyTranscripts();
  }

  getDirtySessionTranscripts(): string[] {
    return Array.from(this.dirtySessionTranscripts);
  }

  isSessionsDirty(): boolean {
    return this.sessionsDirty;
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected async sync(params?: SyncParams): Promise<void> {
    this.syncCalls.push(params ?? {});
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    _timeoutMs: number,
    _message: string,
  ): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected resetProviderInitializationForRetry(): void {}

  protected async indexFile(
    _entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {}
}

describe("session startup catch-up", () => {
  beforeEach(() => {
    listSessionTranscriptScopesForAgentMock.mockResolvedValue([
      { agentId: "main", sessionId: "thread" },
    ]);
    readSessionTranscriptDeltaStatsMock.mockReturnValue({
      size: 128,
      messageCount: 3,
      updatedAt: 200,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("marks stale indexed session transcripts dirty and schedules catch-up sync", async () => {
    const harness = new SessionStartupCatchupHarness([
      {
        sourceKey: "session:thread",
        path: "transcript:main:thread",
        hash: "old-hash",
        mtime: 100,
        size: 128,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual(["main\0thread"]);
    expect(harness.getDirtySessionTranscripts()).toEqual(["main\0thread"]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
  });

  it("can mark startup catch-up transcripts without scheduling background sync", async () => {
    const harness = new SessionStartupCatchupHarness([
      {
        sourceKey: "session:thread",
        path: "transcript:main:thread",
        hash: "old-hash",
        mtime: 100,
        size: 128,
      },
    ]);

    await expect(harness.markStartupDirtyTranscripts()).resolves.toEqual(["main\0thread"]);
    expect(harness.getDirtySessionTranscripts()).toEqual(["main\0thread"]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([]);
  });

  it("leaves unchanged indexed session transcripts clean", async () => {
    const harness = new SessionStartupCatchupHarness([
      {
        sourceKey: "session:thread",
        path: "transcript:main:thread",
        hash: "current-hash",
        mtime: 200,
        size: 128,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.getDirtySessionTranscripts()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });
});
