import fsSync from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  onSessionTranscriptUpdate,
  resolveAgentDir,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionTranscriptEntry,
  listSessionTranscriptScopesForAgent,
  readSessionTranscriptDeltaStats,
  type SessionTranscriptEntry,
  type SessionTranscriptScope,
} from "openclaw/plugin-sdk/memory-core-host-engine-session-transcripts";
import {
  buildFileEntry,
  ensureMemoryIndexSchema,
  listMemoryFiles,
  loadSqliteVecExtension,
  MEMORY_INDEX_TABLE_NAMES,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
  type MemoryFileEntry,
  type MemorySource,
  type MemorySessionTranscriptScope,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import { openMemoryDatabaseAtPath } from "./manager-db.js";
import { isMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  applyMemoryFallbackProviderState,
  resolveFallbackCurrentProviderId,
  resolveMemoryFallbackProviderRequest,
  type MemoryProviderLifecycleState,
} from "./manager-provider-state.js";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  shouldRunFullMemoryReindex,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";
import {
  resolveMemorySessionStartupDirtyTranscripts,
  resolveMemorySessionSyncPlan,
  type MemorySessionStartupTranscriptState,
} from "./manager-session-sync-state.js";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";
import { runMemoryTargetedSessionSync } from "./manager-targeted-sync.js";
import {
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchEventStats,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

type MemoryIndexEntry = MemoryFileEntry | SessionTranscriptEntry;

function memoryEntrySourceKey(entry: MemoryIndexEntry, source: MemorySource): string {
  if (source === "sessions" && "scope" in entry) {
    return `session:${entry.scope.sessionId}`;
  }
  return entry.path;
}

function sessionTranscriptSourceKeyForScope(scope: Pick<SessionTranscriptScope, "sessionId">) {
  return `session:${scope.sessionId}`;
}

function sessionTranscriptScopeKey(scope: Pick<SessionTranscriptScope, "agentId" | "sessionId">) {
  return `${scope.agentId}\0${scope.sessionId}`;
}

function sessionTranscriptScopeFromKey(key: string): SessionTranscriptScope | null {
  const [agentId, sessionId, ...rest] = key.split("\0");
  if (!agentId || !sessionId || rest.length > 0) {
    return null;
  }
  return { agentId, sessionId };
}

const META_KEY = "current";
const META_TABLE = MEMORY_INDEX_TABLE_NAMES.meta;
const SOURCES_TABLE = MEMORY_INDEX_TABLE_NAMES.sources;
const CHUNKS_TABLE = MEMORY_INDEX_TABLE_NAMES.chunks;
const VECTOR_TABLE = MEMORY_INDEX_TABLE_NAMES.vector;
const FTS_TABLE = MEMORY_INDEX_TABLE_NAMES.fts;
const EMBEDDING_CACHE_TABLE = MEMORY_INDEX_TABLE_NAMES.embeddingCache;
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_SYNC_YIELD_EVERY = 10;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

type NativeMemoryWatchPair = {
  dir: string;
  main: fsSync.FSWatcher;
  parent: fsSync.FSWatcher | null;
};

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { present?: number } | undefined;
  return row?.present === 1;
}

function resolveMemoryWatchFactory(): typeof chokidar.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[TEST_MEMORY_WATCH_FACTORY_KEY];
    if (typeof override === "function") {
      return override as typeof chokidar.watch;
    }
  }
  return chokidar.watch.bind(chokidar);
}

function resolveMemoryNativeWatchFactory(): typeof fsSync.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[
      TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY
    ];
    if (typeof override === "function") {
      return override as typeof fsSync.watch;
    }
  }
  return fsSync.watch.bind(fsSync);
}

function shouldIgnoreMemoryWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
  multimodalSettings?: ResolvedMemorySearchConfig["multimodal"],
): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  if (parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const extension = normalizeLowercaseStringOrEmpty(path.extname(normalized));
  if (extension.length === 0 || extension === ".md") {
    return false;
  }
  if (!multimodalSettings) {
    return true;
  }
  return classifyMemoryMultimodalPath(normalized, multimodalSettings) === null;
}

export function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

function createSessionSyncYield(total: number): () => Promise<void> {
  let completed = 0;
  return async () => {
    completed += 1;
    if (completed < total && completed % SESSION_SYNC_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  };
}

export abstract class MemoryManagerSyncOps {
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: EmbeddingProviderId;
  protected abstract providerUnavailableReason?: string;
  protected abstract providerLifecycle: MemoryProviderLifecycleState;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource> = new Set();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  private nativeMemoryWatchPairs: NativeMemoryWatchPair[] = [];
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected fallbackReason?: string;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected pendingWatchPaths: MemoryWatchSettleQueue = new Map();
  protected sessionsDirty = false;
  protected dirtySessionTranscripts = new Set<string>();
  protected pendingSessionTranscripts = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; lastMessages: number; pendingBytes: number; pendingMessages: number }
  >();
  protected vectorDegradedWriteWarningShown = false;
  private lastMetaSerialized: string | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    forceSessions?: boolean;
    sessionTranscript?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract resetProviderInitializationForRetry(): void;
  protected abstract indexFile(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;

  protected resetVectorState(): void {
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.semanticAvailable = undefined;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.vectorDegradedWriteWarningShown = false;
  }

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) {
      return;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  protected buildSourceFilter(
    alias?: string,
    sourcesOverride?: MemorySource[],
  ): { sql: string; params: MemorySource[] } {
    const sources = sourcesOverride ?? Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source_kind` : "source_kind";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.databasePath);
    return openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled, this.agentId);
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      skipCoreTables: true,
      cacheEnabled: this.cache.enabled,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
      ftsTokenizer: this.settings.store.fts.tokenizer,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watcher || this.nativeMemoryWatchPairs.length > 0) {
      // Already initialized — preserve idempotence.
      return;
    }
    // Core paths preserve original symlink-follow behavior (chokidar/fs.watch
    // resolve through symlinks by default); extraPaths preserves the original
    // explicit symlink-skip policy.
    const fileWatchPaths = new Set<string>([path.join(this.workspaceDir, "MEMORY.md")]);
    const dirWatchPaths = new Set<string>([path.join(this.workspaceDir, "memory")]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          dirWatchPaths.add(entry);
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)
        ) {
          fileWatchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
      this.dirty = true;
      this.scheduleWatchSync();
    };
    // Native recursive fs.watch for directory paths — one watcher per
    // directory on macOS (FSEvents) and Windows (ReadDirectoryChangesW).
    // Avoids chokidar's per-file fs.watch fan-out that opened ~12k REG FDs
    // on multi-thousand-`.md` memory trees (issue #86613).
    //
    // Linux is intentionally NOT in the native set: Node's
    // `fs.watch(dir, { recursive: true })` on non-macOS/non-Windows routes
    // through `internal/fs/recursive_watch`, which walks the tree and
    // attaches one watcher per entry under the hood. That defeats the
    // constant-watcher-profile goal of this fix without throwing (so the
    // creation-failure fallback below would not catch it). Linux paths
    // therefore go straight to chokidar, matching pre-PR behavior on that
    // platform.
    //
    // On any other native creation failure (e.g. unsupported filesystem,
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM) the directory also falls back to
    // chokidar so freshness is preserved on the degraded path.
    const nativeRecursiveSupported = process.platform === "darwin" || process.platform === "win32";
    for (const dir of dirWatchPaths) {
      if (!nativeRecursiveSupported) {
        fileWatchPaths.add(dir);
        continue;
      }
      if (!this.attachNativeMemoryWatchForDir(dir, markDirty)) {
        // Native creation failed (dir missing, unsupported FS, throw) —
        // fall back to chokidar so directory coverage isn't dropped.
        fileWatchPaths.add(dir);
      }
    }
    if (fileWatchPaths.size > 0) {
      this.watcher = resolveMemoryWatchFactory()(Array.from(fileWatchPaths), {
        ignoreInitial: true,
        ignored: (watchPath, stats) =>
          shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
      });
      this.watcher.on("add", markDirty);
      this.watcher.on("change", markDirty);
      this.watcher.on("unlink", markDirty);
      this.watcher.on("unlinkDir", markDirty);
      this.watcher.on("error", (err) => {
        // File watcher errors (e.g., ENOSPC) should not crash the gateway.
        // Log the error and continue - memory search still works without auto-sync.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory watcher error: ${message}`);
      });
    }
  }

  // Attach a native recursive `fs.watch` to `dir` plus a non-recursive
  // parent-directory watch that detects root-replacement
  // (`rm -rf memory && mkdir memory`) by inode comparison. Returns true if
  // the main native watcher attached. Called from ensureWatcher(); also
  // re-entered from the parent-watch handler on detected replacement.
  protected attachNativeMemoryWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): boolean {
    if (this.closed) {
      return false;
    }
    let recordedInode: number | null;
    try {
      recordedInode = fsSync.statSync(dir).ino;
    } catch {
      // Dir doesn't exist; caller will fall back to chokidar.
      return false;
    }
    let mainWatcher: fsSync.FSWatcher;
    try {
      mainWatcher = resolveMemoryNativeWatchFactory()(
        dir,
        { recursive: true },
        (_eventType, filename) => {
          if (filename == null) {
            // Node docs: filename may be null on some platforms even when
            // recursive watching is otherwise supported. Be conservative
            // and mark broadly dirty rather than dropping the event.
            markDirty();
            return;
          }
          const full = path.join(dir, filename);
          let stats: fsSync.Stats | undefined;
          try {
            const s = fsSync.lstatSync(full, { throwIfNoEntry: false });
            stats = s ?? undefined;
          } catch {
            stats = undefined;
          }
          if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
            return;
          }
          // Pass stats so the watch-settle queue can debounce rapid
          // writes; without a snapshot the queue cannot detect stability.
          markDirty(full, stats);
        },
      );
    } catch (err) {
      log.warn(
        `failed to start native recursive watcher on ${dir}: ${String(err)}; falling back to chokidar`,
      );
      return false;
    }
    const pair: NativeMemoryWatchPair = { dir, main: mainWatcher, parent: null };
    mainWatcher.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory native watcher error on ${dir}: ${message}`);
      // Per Node docs the FSWatcher is no longer usable after an error.
      this.closeNativeMemoryWatchPair(pair);
      if (this.closed) {
        return;
      }
      // Force a broad re-sync to cover the gap, then restore directory
      // coverage by reattaching to chokidar so subsequent file changes
      // still drive watch sync (intervalMinutes defaults to 0; without
      // a watcher the directory would stop being indexed).
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
    });
    this.nativeMemoryWatchPairs.push(pair);
    // Non-recursive parent watcher: catches root-directory replacement so
    // we can reattach the main watcher on the new inode. Without this,
    // `rm -rf memory && mkdir memory` would leave the main watcher bound
    // to the dead inode and silently miss subsequent file changes.
    try {
      const parentDir = path.dirname(dir);
      const baseName = path.basename(dir);
      const parentWatcher = resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          // Per Node docs `filename` can be null on some platforms even
          // when the parent watcher is otherwise supported. Treat null
          // as an unknown event and re-check the watched directory's
          // inode (clawsweeper review [P2] 5df68c…); otherwise filter
          // by basename so sibling events don't trigger reattach.
          if (filename !== null && filename !== baseName) {
            return;
          }
          let currentInode: number | null;
          try {
            currentInode = fsSync.statSync(dir).ino;
          } catch {
            currentInode = null;
          }
          if (currentInode === recordedInode) {
            return;
          }
          // Root was replaced (or removed). Tear down the existing pair
          // and either reattach (if dir still exists) or fall back to
          // chokidar (if dir is gone).
          this.closeNativeMemoryWatchPair(pair);
          if (this.closed) {
            return;
          }
          markDirty();
          if (currentInode !== null) {
            // Re-attach on the new inode (this also installs a fresh
            // parent watcher closed over the new recordedInode). If the
            // helper's own statSync races with the dir disappearing
            // between our inode check and its own check, it returns
            // false — fall back to chokidar so coverage isn't lost.
            if (!this.attachNativeMemoryWatchForDir(dir, markDirty)) {
              this.attachMemoryChokidarFallback(dir, markDirty);
            }
          } else {
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        },
      );
      parentWatcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory native parent watcher error on ${path.dirname(dir)}: ${message}`);
        try {
          parentWatcher.close();
        } catch {
          // ignore
        }
        this.removeNativeMemoryParentWatch(parentWatcher);
        if (pair.parent === parentWatcher) {
          pair.parent = null;
        }
        // Main watcher still alive — root-replacement detection is lost
        // but normal events still flow. No fallback needed.
      });
      pair.parent = parentWatcher;
    } catch (err) {
      // Parent watcher couldn't start (e.g. parentDir not accessible).
      // The main watcher still works for non-replacement events; just
      // log and continue.
      log.warn(
        `memory native parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
    return true;
  }

  private closeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    try {
      pair.main.close();
    } catch {
      // ignore close failures
    }
    if (pair.parent) {
      try {
        pair.parent.close();
      } catch {
        // ignore close failures
      }
      pair.parent = null;
    }
    this.removeNativeMemoryWatchPair(pair);
  }

  protected closeNativeMemoryWatchPairs(): void {
    while (this.nativeMemoryWatchPairs.length > 0) {
      const pair = this.nativeMemoryWatchPairs[0];
      if (!pair) {
        return;
      }
      this.closeNativeMemoryWatchPair(pair);
    }
  }

  private removeNativeMemoryParentWatch(w: fsSync.FSWatcher): void {
    for (const pair of this.nativeMemoryWatchPairs) {
      if (pair.parent === w) {
        pair.parent = null;
        return;
      }
    }
  }

  private removeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    const idx = this.nativeMemoryWatchPairs.indexOf(pair);
    if (idx >= 0) {
      this.nativeMemoryWatchPairs.splice(idx, 1);
    }
  }

  // Reattach `dir` to chokidar after a native recursive watcher dies, so
  // subsequent memory changes under `dir` continue to drive watch sync.
  // Called from the native watcher `error` handler in ensureWatcher();
  // factored out so the fallback shape can be unit-tested in isolation.
  protected attachMemoryChokidarFallback(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    if (this.closed) {
      // Manager teardown started — don't create new watcher resources.
      return;
    }
    try {
      if (this.watcher) {
        // Existing chokidar watcher (handling MEMORY.md and/or other file
        // paths) — extend it to cover this directory too.
        this.watcher.add(dir);
        return;
      }
      // No chokidar watcher exists yet. Spin one up just for this directory
      // so the periodic-sync gap is closed.
      this.watcher = resolveMemoryWatchFactory()([dir], {
        ignoreInitial: true,
        ignored: (watchPath, stats) =>
          shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
      });
      this.watcher.on("add", markDirty);
      this.watcher.on("change", markDirty);
      this.watcher.on("unlink", markDirty);
      this.watcher.on("unlinkDir", markDirty);
      this.watcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory watcher error: ${message}`);
      });
    } catch (err) {
      log.warn(`failed to attach chokidar fallback for ${dir}: ${String(err)}`);
    }
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      const updateAgentId = update.agentId?.trim();
      if (updateAgentId && updateAgentId !== this.agentId) {
        return;
      }
      const sessionId = update.sessionId?.trim();
      if (!sessionId) {
        return;
      }
      const sessionTranscript = sessionTranscriptScopeKey({
        agentId: updateAgentId || this.agentId,
        sessionId,
      });
      this.scheduleSessionDirty(sessionTranscript);
    });
  }

  protected ensureSessionStartupCatchup(): void {
    if (!this.sources.has("sessions")) {
      return;
    }
    void this.runSessionStartupCatchup().catch((err) => {
      log.warn("memory session startup catch-up failed: " + String(err));
    });
  }

  protected async markSessionStartupCatchupDirtyTranscripts(): Promise<string[]> {
    if (!this.sources.has("sessions") || this.closed) {
      return [];
    }
    const scopes = await listSessionTranscriptScopesForAgent(this.agentId);
    if (scopes.length === 0 || this.closed) {
      return [];
    }
    const existingRows = loadMemorySourceFileState({
      db: this.db,
      source: "sessions",
    }).rows;
    const transcripts: MemorySessionStartupTranscriptState[] = [];
    for (const scope of scopes) {
      const stats = readSessionTranscriptDeltaStats(scope);
      if (!stats) {
        continue;
      }
      transcripts.push({
        scopeKey: sessionTranscriptScopeKey(scope),
        sourceKey: sessionTranscriptSourceKeyForScope(scope),
        updatedAt: stats.updatedAt,
        size: stats.size,
      });
    }
    const dirtyTranscripts = resolveMemorySessionStartupDirtyTranscripts({
      transcripts,
      existingRows,
    });
    if (dirtyTranscripts.length === 0 || this.closed) {
      return dirtyTranscripts;
    }
    for (const transcript of dirtyTranscripts) {
      this.dirtySessionTranscripts.add(transcript);
    }
    this.sessionsDirty = true;
    return dirtyTranscripts;
  }

  protected async runSessionStartupCatchup(): Promise<string[]> {
    const dirtyTranscripts = await this.markSessionStartupCatchupDirtyTranscripts();
    if (dirtyTranscripts.length === 0 || this.closed) {
      return dirtyTranscripts;
    }
    void this.sync({ reason: "session-startup-catchup" }).catch((err) => {
      log.warn("memory sync failed (session-startup-catchup): " + String(err));
    });
    return dirtyTranscripts;
  }

  private scheduleSessionDirty(sessionTranscript: string) {
    this.pendingSessionTranscripts.add(sessionTranscript);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.pendingSessionTranscripts.size === 0) {
      return;
    }
    const pending = Array.from(this.pendingSessionTranscripts);
    this.pendingSessionTranscripts.clear();
    let shouldSync = false;
    for (const sessionTranscript of pending) {
      const delta = await this.updateSessionDelta(sessionTranscript);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.dirtySessionTranscripts.add(sessionTranscript);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionTranscript: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    const scope = sessionTranscriptScopeFromKey(sessionTranscript);
    if (!scope) {
      return null;
    }
    const stats = readSessionTranscriptDeltaStats(scope);
    if (!stats) {
      return null;
    }
    const size = stats.size;
    const messageCount = stats.messageCount;
    let state = this.sessionDeltas.get(sessionTranscript);
    if (!state) {
      state = { lastSize: 0, lastMessages: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionTranscript, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    const deltaMessages = Math.max(0, messageCount - state.lastMessages);
    if (deltaBytes === 0 && deltaMessages === 0) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize || messageCount < state.lastMessages) {
      state.pendingBytes += size;
      state.pendingMessages += messageCount;
    } else {
      state.pendingBytes += deltaBytes;
      state.pendingMessages += deltaMessages;
    }
    state.lastSize = size;
    state.lastMessages = messageCount;
    this.sessionDeltas.set(sessionTranscript, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private resetSessionDelta(absPath: string, size: number, messageCount: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.lastMessages = messageCount;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private normalizeTargetSessionTranscripts(params?: {
    sessionTranscriptScopes?: MemorySessionTranscriptScope[];
  }): Set<string> | null {
    if (!params?.sessionTranscriptScopes || params.sessionTranscriptScopes.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    for (const scope of params?.sessionTranscriptScopes ?? []) {
      const agentId = scope.agentId.trim();
      const sessionId = scope.sessionId.trim();
      if (agentId === this.agentId && sessionId) {
        normalized.add(sessionTranscriptScopeKey({ agentId, sessionId }));
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      runDetachedMemorySync(async () => {
        if (this.closed) {
          return;
        }
        if (!(await settleMemoryWatchEventPaths(this.pendingWatchPaths))) {
          if (!this.closed) {
            this.scheduleWatchSync();
          }
          return;
        }
        if (this.closed) {
          return;
        }
        await this.sync({ reason: "watch" });
      }, "watch");
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(
    params?: {
      reason?: string;
      force?: boolean;
      sessionTranscriptScopes?: MemorySessionTranscriptScope[];
    },
    needsFullReindex = false,
  ) {
    return shouldSyncSessionsForReindex({
      hasSessionSource: this.sources.has("sessions"),
      sessionsDirty: this.sessionsDirty,
      dirtySessionTranscriptCount: this.dirtySessionTranscripts.size,
      sync: params,
      needsFullReindex,
    });
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const deleteSourceByKeyAndKind = this.db.prepare(
      `DELETE FROM ${SOURCES_TABLE} WHERE source_key = ? AND source_kind = ?`,
    );
    const deleteChunksByKeyAndKind = this.db.prepare(
      `DELETE FROM ${CHUNKS_TABLE} WHERE source_key = ? AND source_kind = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available && sqliteTableExists(this.db, VECTOR_TABLE)
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM ${CHUNKS_TABLE} WHERE source_key = ? AND source_kind = ?)`,
          )
        : null;
    const deleteFtsRowsByPathAndSource =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE source_key = ? AND source = ?`)
        : null;

    const files = await listMemoryFiles(
      this.workspaceDir,
      this.settings.extraPaths,
      this.settings.multimodal,
    );
    const fileEntries = (
      await runWithConcurrency(
        files.map(
          (file) => async () =>
            await buildFileEntry(file, this.workspaceDir, this.settings.multimodal),
        ),
        this.getIndexConcurrency(),
      )
    ).filter((entry): entry is MemoryFileEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const existingState = loadMemorySourceFileState({
      db: this.db,
      source: "memory",
    });
    const existingRows = existingState.rows;
    const existingHashes = existingState.hashes;
    const activeSourceKeys = new Set(
      fileEntries.map((entry) => memoryEntrySourceKey(entry, "memory")),
    );
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const tasks = fileEntries.map((entry) => async () => {
      const sourceKey = memoryEntrySourceKey(entry, "memory");
      if (!params.needsFullReindex && existingHashes.get(sourceKey) === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    for (const stale of existingRows) {
      if (activeSourceKeys.has(stale.sourceKey)) {
        continue;
      }
      deleteSourceByKeyAndKind.run(stale.sourceKey, "memory");
      if (deleteVectorRowsByPathAndSource) {
        try {
          deleteVectorRowsByPathAndSource.run(stale.sourceKey, "memory");
        } catch {}
      }
      deleteChunksByKeyAndKind.run(stale.sourceKey, "memory");
      if (deleteFtsRowsByPathAndSource) {
        try {
          deleteFtsRowsByPathAndSource.run(stale.sourceKey, "memory");
        } catch {}
      }
    }
  }

  private async syncSessionTranscripts(params: {
    needsFullReindex: boolean;
    targetSessionTranscriptKeys?: string[];
    progress?: MemorySyncProgressState;
  }) {
    const deleteSourceByKeyAndKind = this.db.prepare(
      `DELETE FROM ${SOURCES_TABLE} WHERE source_key = ? AND source_kind = ?`,
    );
    const deleteChunksByKeyAndKind = this.db.prepare(
      `DELETE FROM ${CHUNKS_TABLE} WHERE source_key = ? AND source_kind = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available && sqliteTableExists(this.db, VECTOR_TABLE)
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM ${CHUNKS_TABLE} WHERE source_key = ? AND source_kind = ?)`,
          )
        : null;
    const deleteFtsRowsByPathSourceAndModel =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(
            `DELETE FROM ${FTS_TABLE} WHERE source_key = ? AND source = ? AND model = ?`,
          )
        : null;

    const targetSessionTranscriptKeys =
      params.needsFullReindex || !params.targetSessionTranscriptKeys
        ? null
        : new Set(params.targetSessionTranscriptKeys);
    const transcripts = targetSessionTranscriptKeys
      ? Array.from(targetSessionTranscriptKeys)
          .map(sessionTranscriptScopeFromKey)
          .filter((scope): scope is SessionTranscriptScope => scope !== null)
      : await listSessionTranscriptScopesForAgent(this.agentId);
    const sessionPlan = resolveMemorySessionSyncPlan({
      needsFullReindex: params.needsFullReindex,
      transcripts,
      targetSessionTranscriptKeys,
      dirtySessionTranscripts: this.dirtySessionTranscripts,
      existingRows: targetSessionTranscriptKeys
        ? null
        : loadMemorySourceFileState({
            db: this.db,
            source: "sessions",
          }).rows,
      sessionTranscriptSourceKeyForScope,
    });
    const { activeSourceKeys, existingRows, existingHashes, indexAll } = sessionPlan;
    log.debug("memory sync: indexing session transcripts", {
      transcripts: transcripts.length,
      indexAll,
      dirtyTranscripts: this.dirtySessionTranscripts.size,
      targetedTranscripts: targetSessionTranscriptKeys?.size ?? 0,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += transcripts.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled
          ? "Indexing session transcripts (batch)..."
          : "Indexing session transcripts…",
      });
    }

    const yieldAfterSessionTranscript = createSessionSyncYield(transcripts.length);
    const tasks = transcripts.map((scope) => async () => {
      const scopeKey = sessionTranscriptScopeKey(scope);
      try {
        if (!indexAll && !this.dirtySessionTranscripts.has(scopeKey)) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          return;
        }
        const entry = await buildSessionTranscriptEntry(scope);
        if (!entry) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          return;
        }
        const existingHash = resolveMemorySourceExistingHash({
          db: this.db,
          source: "sessions",
          sourceKey: memoryEntrySourceKey(entry, "sessions"),
          existingHashes,
        });
        if (!params.needsFullReindex && existingHash === entry.hash) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          this.resetSessionDelta(scopeKey, entry.size, entry.messageCount);
          return;
        }
        await this.indexFile(entry, { source: "sessions", content: entry.content });
        this.resetSessionDelta(scopeKey, entry.size, entry.messageCount);
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
      } finally {
        await yieldAfterSessionTranscript();
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    if (activeSourceKeys === null) {
      // Targeted syncs only refresh the requested transcripts and should not
      // prune unrelated session rows without a full directory enumeration.
      return;
    }

    const staleRows = existingRows ?? [];
    const yieldAfterStaleSessionRow = createSessionSyncYield(staleRows.length);
    for (const stale of staleRows) {
      try {
        if (activeSourceKeys.has(stale.sourceKey)) {
          continue;
        }
        deleteSourceByKeyAndKind.run(stale.sourceKey, "sessions");
        if (deleteVectorRowsByPathAndSource) {
          try {
            deleteVectorRowsByPathAndSource.run(stale.sourceKey, "sessions");
          } catch {}
        }
        deleteChunksByKeyAndKind.run(stale.sourceKey, "sessions");
        if (deleteFtsRowsByPathSourceAndModel) {
          try {
            deleteFtsRowsByPathSourceAndModel.run(
              stale.sourceKey,
              "sessions",
              this.provider?.model ?? "fts-only",
            );
          } catch {}
        }
      } finally {
        await yieldAfterStaleSessionRow();
      }
    }
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  private assertFtsOnlySyncAllowed(): void {
    if (this.provider) {
      return;
    }
    const existingMeta = this.readMeta();
    if (
      !existingMeta ||
      existingMeta.model === "fts-only" ||
      !this.settings.provider ||
      this.settings.provider === "none"
    ) {
      return;
    }
    this.resetProviderInitializationForRetry();
    throw new Error(
      `Memory sync aborted: embedding provider "${this.settings.provider}" is configured but unavailable. ` +
        `Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: ${existingMeta.model}).`,
    );
  }

  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    sessionTranscriptScopes?: MemorySessionTranscriptScope[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    this.assertFtsOnlySyncAllowed();

    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const configuredSources = resolveConfiguredSourcesForMeta(this.sources);
    const configuredScopeHash = resolveConfiguredScopeHash({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      multimodal: {
        enabled: this.settings.multimodal.enabled,
        modalities: this.settings.multimodal.modalities,
        maxFileBytes: this.settings.multimodal.maxFileBytes,
      },
    });
    const targetSessionTranscriptKeys = this.normalizeTargetSessionTranscripts(params);
    const hasTargetSessionTranscripts = targetSessionTranscriptKeys !== null;
    if (params?.reason === "cli" && !params.force && !hasTargetSessionTranscripts) {
      await this.markSessionStartupCatchupDirtyTranscripts();
    }
    const targetedSessionSync = await runMemoryTargetedSessionSync({
      hasSessionSource: this.sources.has("sessions"),
      targetSessionTranscriptKeys,
      reason: params?.reason,
      progress: progress ?? undefined,
      dirtySessionTranscripts: this.dirtySessionTranscripts,
      syncSessionTranscripts: async (targetedParams) => {
        await this.syncSessionTranscripts(targetedParams);
      },
      shouldFallbackOnError: (err) => this.shouldFallbackOnError(err),
      activateFallbackProvider: async (reason) => await this.activateFallbackProvider(reason),
      runFullReindex: async (reindexParams) => {
        await this.runSafeReindex(reindexParams);
      },
    });
    if (targetedSessionSync.handled) {
      this.sessionsDirty = targetedSessionSync.sessionsDirty;
      return;
    }
    const needsFullReindex =
      (params?.force && !hasTargetSessionTranscripts) ||
      shouldRunFullMemoryReindex({
        meta,
        // Also detects provider→FTS-only transitions so orphaned old-model FTS rows are cleaned up.
        provider: this.provider ? { id: this.provider.id, model: this.provider.model } : null,
        providerKey: this.providerKey ?? undefined,
        configuredSources,
        configuredScopeHash,
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        vectorReady,
        ftsTokenizer: this.settings.store.fts.tokenizer,
      });
    try {
      if (needsFullReindex) {
        await this.runSafeReindex({
          reason: params?.reason,
          force: params?.force,
          progress: progress ?? undefined,
        });
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") &&
        ((!hasTargetSessionTranscripts && params?.force) || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }

      if (shouldSyncSessions) {
        await this.syncSessionTranscripts({
          needsFullReindex,
          targetSessionTranscriptKeys: targetSessionTranscriptKeys
            ? Array.from(targetSessionTranscriptKeys)
            : undefined,
          progress: progress ?? undefined,
        });
        this.sessionsDirty = false;
        this.dirtySessionTranscripts.clear();
      } else if (this.dirtySessionTranscripts.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }
    } catch (err) {
      const reason = formatErrorMessage(err);
      const activated =
        this.shouldFallbackOnError(err) && (await this.activateFallbackProvider(reason));
      if (activated) {
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      if (!this.provider && this.fts.enabled && this.shouldFallbackOnError(err)) {
        log.warn(`memory embeddings unavailable; rebuilding lexical memory index only: ${reason}`);
        await this.runSafeReindex({
          reason: params?.reason ?? "embedding-degraded",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      throw err;
    }
  }

  protected shouldFallbackOnError(err: unknown): boolean {
    return isMemoryEmbeddingOperationError(err);
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(batch?.enabled && this.provider && this.providerRuntime?.batchEmbed);
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  protected async activateFallbackProvider(reason: string): Promise<boolean> {
    const currentProviderId = resolveFallbackCurrentProviderId({
      provider: this.provider,
      lifecycle: this.providerLifecycle,
    });
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      settings: this.settings,
      currentProviderId,
    });
    if (!fallbackRequest || !currentProviderId) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }

    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      ...fallbackRequest,
    });

    const fallbackState = applyMemoryFallbackProviderState({
      current: {
        provider: this.provider,
        fallbackFrom: this.fallbackFrom,
        fallbackReason: this.fallbackReason,
        providerUnavailableReason: undefined,
        providerRuntime: this.providerRuntime,
        lifecycle: this.providerLifecycle,
      },
      fallbackFrom: currentProviderId,
      reason,
      result: fallbackResult,
    });
    this.fallbackFrom = fallbackState.fallbackFrom;
    this.fallbackReason = fallbackState.fallbackReason;
    this.provider = fallbackState.provider;
    this.providerRuntime = fallbackState.providerRuntime;
    this.providerUnavailableReason = fallbackState.providerUnavailableReason;
    this.providerLifecycle = fallbackState.lifecycle;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, {
      reason,
    });
    return true;
  }

  protected async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    this.assertFtsOnlySyncAllowed();

    // The builtin memory index lives inside the per-agent database. A full
    // reindex must reset only memory-owned tables, never swap the database file.
    this.resetIndex();

    const shouldSyncMemory = this.sources.has("memory");
    const shouldSyncSessions = this.shouldSyncSessions(
      { reason: params.reason, force: params.force },
      true,
    );

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionTranscripts({ needsFullReindex: true, progress: params.progress });
      this.sessionsDirty = false;
      this.dirtySessionTranscripts.clear();
    } else if (this.dirtySessionTranscripts.size > 0) {
      this.sessionsDirty = true;
    } else {
      this.sessionsDirty = false;
    }

    const nextMeta: MemoryIndexMeta = {
      model: this.provider?.model ?? "fts-only",
      provider: this.provider?.id ?? "none",
      providerKey: this.providerKey!,
      sources: resolveConfiguredSourcesForMeta(this.sources),
      scopeHash: resolveConfiguredScopeHash({
        workspaceDir: this.workspaceDir,
        extraPaths: this.settings.extraPaths,
        multimodal: {
          enabled: this.settings.multimodal.enabled,
          modalities: this.settings.multimodal.modalities,
          maxFileBytes: this.settings.multimodal.maxFileBytes,
        },
      }),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      ftsTokenizer: this.settings.store.fts.tokenizer,
    };
    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }

    this.writeMeta(nextMeta);
    this.pruneEmbeddingCacheIfNeeded?.();
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM ${SOURCES_TABLE}`);
    this.db.exec(`DELETE FROM ${CHUNKS_TABLE}`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
      } catch {}
    }
    this.ensureSchema();
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.dirtySessionTranscripts.clear();
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db
      .prepare(
        `SELECT schema_version, provider, model, provider_key, sources_json, scope_hash, chunk_tokens, chunk_overlap, vector_dims, fts_tokenizer, config_hash, updated_at FROM ${META_TABLE} WHERE meta_key = ?`,
      )
      .get(META_KEY) as
      | {
          schema_version: number;
          provider: string;
          model: string;
          provider_key: string | null;
          sources_json: string;
          scope_hash: string;
          chunk_tokens: number;
          chunk_overlap: number;
          vector_dims: number | null;
          fts_tokenizer: string;
          config_hash: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed: MemoryIndexMeta = {
        provider: row.provider,
        model: row.model,
        providerKey: row.provider_key ?? undefined,
        sources: JSON.parse(row.sources_json) as MemoryIndexMeta["sources"],
        scopeHash: row.scope_hash,
        chunkTokens: row.chunk_tokens,
        chunkOverlap: row.chunk_overlap,
        ftsTokenizer: row.fts_tokenizer,
      };
      if (typeof row.vector_dims === "number") {
        parsed.vectorDims = row.vector_dims;
      }
      this.lastMetaSerialized = JSON.stringify(parsed);
      return parsed;
    } catch {
      this.lastMetaSerialized = null;
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ${META_TABLE} (meta_key, schema_version, provider, model, provider_key, sources_json, scope_hash, chunk_tokens, chunk_overlap, vector_dims, fts_tokenizer, config_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET
           schema_version=excluded.schema_version,
           provider=excluded.provider,
           model=excluded.model,
           provider_key=excluded.provider_key,
           sources_json=excluded.sources_json,
           scope_hash=excluded.scope_hash,
           chunk_tokens=excluded.chunk_tokens,
           chunk_overlap=excluded.chunk_overlap,
           vector_dims=excluded.vector_dims,
           fts_tokenizer=excluded.fts_tokenizer,
           config_hash=excluded.config_hash,
           updated_at=excluded.updated_at`,
      )
      .run(
        META_KEY,
        1,
        meta.provider,
        meta.model,
        meta.providerKey ?? null,
        JSON.stringify(meta.sources ?? []),
        meta.scopeHash ?? "",
        meta.chunkTokens,
        meta.chunkOverlap,
        meta.vectorDims ?? null,
        meta.ftsTokenizer ?? "unicode61",
        value,
        Date.now(),
      );
    this.lastMetaSerialized = value;
  }
}
