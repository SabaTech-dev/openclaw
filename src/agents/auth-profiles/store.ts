import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import {
  listRuntimeExternalAuthProfiles,
  overlayExternalAuthProfiles,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import {
  isSafeToAdoptMainStoreOAuthIdentity,
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import { resolveAuthProfileStoreKey } from "./paths.js";
import {
  buildPersistedAuthProfileSecretsStore,
  isRuntimeLegacyOAuthSidecarCredential,
  loadLegacyAuthProfileStoreEntry,
  loadPersistedAuthProfileStoreEntry,
  loadPersistedAuthProfileStoreEntryFromDatabase,
  loadPersistedAuthProfileStoreEntryReadOnly,
  loadPersistedAuthProfileStore,
  matchesRuntimeLegacyOAuthSidecarMaterial,
  mergeAuthProfileStores,
  savePersistedAuthProfileSecretsStoreInTransaction,
} from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots as clearRuntimeAuthProfileStoreSnapshotsImpl,
  getRuntimeAuthProfileStoreSnapshot,
  hasRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { readAuthProfileStorePayloadResultFromDatabase } from "./sqlite-storage.js";
import { savePersistedAuthProfileStateInTransaction } from "./state.js";
import {
  clearLoadedAuthStoreCache,
  readCachedAuthProfileStore,
  writeCachedAuthProfileStore,
} from "./store-cache.js";
import type { AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  resolveLegacyOAuthSidecars?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SaveAuthProfileStoreOptions = {
  env?: NodeJS.ProcessEnv;
  filterExternalAuthProfiles?: boolean;
  forceLocalProfileIds?: Iterable<string>;
  syncExternalCli?: boolean;
};

type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type ExternalCliSyncResult = {
  store: AuthProfileStore;
  cacheable: boolean;
};

function resolveLoadedAuthStoreCacheKey(
  agentDir?: string,
  options?: Pick<
    LoadAuthProfileStoreOptions,
    "allowKeychainPrompt" | "env" | "resolveLegacyOAuthSidecars"
  >,
): string {
  const storeKey = resolveAuthProfileStoreKey(agentDir, options?.env);
  const sidecarMode =
    options?.resolveLegacyOAuthSidecars === false ? "sidecar:false" : "sidecar:true";
  const keychainMode = options?.allowKeychainPrompt === false ? "keychain:false" : "keychain:true";
  return `${storeKey}\0${sidecarMode}\0${keychainMode}`;
}

function resolvePersistedAuthProfileLoadOptions(
  options?: LoadAuthProfileStoreOptions,
): LoadAuthProfileStoreOptions {
  return {
    ...options,
    resolveLegacyOAuthSidecars: options?.resolveLegacyOAuthSidecars ?? true,
  };
}

function isInheritedMainOAuthCredential(params: {
  agentDir?: string;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
}): boolean {
  if (!params.agentDir || params.credential.type !== "oauth") {
    return false;
  }
  const storeKey = resolveAuthProfileStoreKey(params.agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (storeKey === mainStoreKey) {
    return false;
  }

  const localStore = loadPersistedAuthProfileStore(params.agentDir);
  if (localStore?.profiles[params.profileId]) {
    return false;
  }

  const mainCredential = loadPersistedAuthProfileStore()?.profiles[params.profileId];
  return (
    mainCredential?.type === "oauth" &&
    (isDeepStrictEqual(mainCredential, params.credential) ||
      shouldUseMainOwnerForLocalOAuthCredential({
        local: params.credential,
        main: mainCredential,
      }))
  );
}

function shouldUseMainOwnerForLocalOAuthCredential(params: {
  local: AuthProfileStore["profiles"][string];
  main: AuthProfileStore["profiles"][string] | undefined;
}): boolean {
  if (params.local.type !== "oauth" || params.main?.type !== "oauth") {
    return false;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(params.local, params.main)) {
    return false;
  }
  if (isDeepStrictEqual(params.local, params.main)) {
    return true;
  }
  return (
    Number.isFinite(params.main.expires) &&
    (!Number.isFinite(params.local.expires) || params.main.expires >= params.local.expires)
  );
}

function resolveRuntimeAuthProfileStore(
  agentDir?: string,
  options?: Pick<
    LoadAuthProfileStoreOptions,
    "allowKeychainPrompt" | "env" | "resolveLegacyOAuthSidecars"
  >,
): AuthProfileStore | null {
  const mainKey = resolveAuthProfileStoreKey(undefined);
  const requestedKey = resolveAuthProfileStoreKey(agentDir);
  const mainStore = getRuntimeAuthProfileStoreSnapshot(undefined);
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return mainStore;
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (requestedStore) {
    const persistedMainStore = loadAuthProfileStoreForAgent(undefined, {
      readOnly: true,
      syncExternalCli: false,
      ...resolvePersistedAuthProfileLoadOptions(options),
    });
    return mergeAuthProfileStores(persistedMainStore, requestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (mainStore) {
    return mainStore;
  }

  return null;
}

function resolveExternalCliOverlayOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): ResolvedExternalCliOverlayOptions {
  const discovery = options?.externalCli;
  if (!discovery) {
    return {
      ...(options?.allowKeychainPrompt !== undefined
        ? { allowKeychainPrompt: options.allowKeychainPrompt }
        : {}),
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.externalCliProviderIds
        ? { externalCliProviderIds: options.externalCliProviderIds }
        : {}),
      ...(options?.externalCliProfileIds
        ? { externalCliProfileIds: options.externalCliProfileIds }
        : {}),
    };
  }
  if (discovery.mode === "none") {
    const config = discovery.config ?? options?.config;
    return {
      allowKeychainPrompt: false,
      ...(config ? { config } : {}),
      externalCliProviderIds: [],
      externalCliProfileIds: [],
    };
  }
  if (discovery.mode === "existing") {
    const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
    const config = discovery.config ?? options?.config;
    return {
      ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
      ...(config ? { config } : {}),
    };
  }
  const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
  const config = discovery.config ?? options?.config;
  return {
    ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
    ...(config ? { config } : {}),
    ...(discovery.providerIds ? { externalCliProviderIds: discovery.providerIds } : {}),
    ...(discovery.profileIds ? { externalCliProfileIds: discovery.profileIds } : {}),
  };
}

function hasScopedExternalCliOverlay(options: ResolvedExternalCliOverlayOptions): boolean {
  return (
    options.externalCliProviderIds !== undefined || options.externalCliProfileIds !== undefined
  );
}

function maybeSyncPersistedExternalCliAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: LoadAuthProfileStoreOptions;
}): ExternalCliSyncResult {
  if (
    params.options?.readOnly === true ||
    params.options?.syncExternalCli === false ||
    process.env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return { store: params.store, cacheable: true };
  }
  const synced = syncPersistedExternalCliAuthProfiles(params.store, {
    agentDir: params.agentDir,
    env: params.options?.env,
    ...resolveExternalCliOverlayOptions(params.options),
  });
  if (synced === params.store) {
    return { store: params.store, cacheable: true };
  }
  const changedProfiles = Object.entries(synced.profiles).filter(([profileId, credential]) => {
    const previous = params.store.profiles[profileId];
    return !isDeepStrictEqual(previous, credential);
  });
  if (changedProfiles.length === 0) {
    return { store: synced, cacheable: true };
  }

  let savedStore = params.store;
  let changed = false;
  runOpenClawStateWriteTransaction(
    (database) => {
      const latestStore = loadPersistedAuthProfileStoreEntryFromDatabase(
        database,
        params.agentDir,
        { env: params.options?.env },
      )?.store ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      for (const [profileId, credential] of changedProfiles) {
        const previous = params.store.profiles[profileId];
        const latest = latestStore.profiles[profileId];
        if (!isDeepStrictEqual(latest, previous)) {
          log.debug("skipped persisted external cli auth sync for concurrently changed profile", {
            profileId,
          });
          continue;
        }
        latestStore.profiles[profileId] = credential;
        changed = true;
      }
      if (changed) {
        savedStore = saveAuthProfileStoreInTransaction(
          database,
          latestStore,
          params.agentDir,
          Date.now(),
          {
            env: params.options?.env,
            filterExternalAuthProfiles: false,
          },
        );
        return;
      }
      savedStore = latestStore;
    },
    { env: params.options?.env },
  );
  return { store: savedStore, cacheable: true };
}

function shouldKeepProfileInLocalStore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
  externalProfiles: () => RuntimeExternalOAuthProfile[];
}): boolean {
  if (params.credential.type !== "oauth") {
    return true;
  }
  if (
    isInheritedMainOAuthCredential({
      agentDir: params.agentDir,
      profileId: params.profileId,
      credential: params.credential,
    })
  ) {
    return false;
  }
  if (params.options?.filterExternalAuthProfiles === false) {
    return true;
  }
  if (params.store.runtimeExternalProfileIds?.includes(params.profileId)) {
    const persistedCredential = loadPersistedAuthProfileStore(params.agentDir)?.profiles[
      params.profileId
    ];
    if (persistedCredential) {
      return shouldPersistRuntimeExternalOAuthProfile({
        profileId: params.profileId,
        credential: params.credential,
        profiles: params.externalProfiles(),
      });
    }
    const runtimeCredential = getRuntimeAuthProfileStoreSnapshot(params.agentDir)?.profiles[
      params.profileId
    ];
    if (!runtimeCredential || isDeepStrictEqual(runtimeCredential, params.credential)) {
      return false;
    }
  }
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles: params.externalProfiles(),
  });
}

function buildLocalAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  const localStore = cloneAuthProfileStore(params.store);
  const forceLocalProfileIds = params.options?.forceLocalProfileIds
    ? new Set(params.options.forceLocalProfileIds)
    : undefined;
  let externalProfiles: RuntimeExternalOAuthProfile[] | undefined;
  const getExternalProfiles = (): RuntimeExternalOAuthProfile[] =>
    (externalProfiles ??= listRuntimeExternalAuthProfiles({
      store: params.store,
      agentDir: params.agentDir,
      env: params.options?.env,
    }));
  localStore.profiles = Object.fromEntries(
    Object.entries(localStore.profiles).filter(([profileId, credential]) =>
      forceLocalProfileIds?.has(profileId)
        ? true
        : shouldKeepProfileInLocalStore({
            store: params.store,
            profileId,
            credential,
            agentDir: params.agentDir,
            options: params.options,
            externalProfiles: getExternalProfiles,
          }),
    ),
  );
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  pruneAuthProfileStoreReferences(localStore, keptProfileIds);
  if (params.options?.filterExternalAuthProfiles !== false) {
    localStore.runtimeExternalProfileIds = undefined;
    localStore.runtimeExternalProfileIdsAuthoritative = undefined;
  }
  return localStore;
}

function pruneAuthProfileStoreReferences(
  store: AuthProfileStore,
  keptProfileIds: Set<string>,
): void {
  store.order = store.order
    ? Object.fromEntries(
        Object.entries(store.order)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter((profileId) => keptProfileIds.has(profileId)),
          ])
          .filter(([, profileIds]) => profileIds.length > 0),
      )
    : undefined;
  store.lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).filter(([, profileId]) => keptProfileIds.has(profileId)),
      )
    : undefined;
  store.usageStats = store.usageStats
    ? Object.fromEntries(
        Object.entries(store.usageStats).filter(([profileId]) => keptProfileIds.has(profileId)),
      )
    : undefined;
  store.runtimeExternalProfileIds = store.runtimeExternalProfileIds
    ?.filter((profileId) => keptProfileIds.has(profileId))
    .toSorted();
  if (
    store.runtimeExternalProfileIds?.length === 0 &&
    store.runtimeExternalProfileIdsAuthoritative !== true
  ) {
    store.runtimeExternalProfileIds = undefined;
  }
  if (store.runtimeExternalProfileIdsAuthoritative === true) {
    store.runtimeExternalProfileIds ??= [];
  }
}

function buildAuthProfileStoreWithoutExternalProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: Pick<
    LoadAuthProfileStoreOptions,
    "allowKeychainPrompt" | "env" | "resolveLegacyOAuthSidecars"
  >;
}): AuthProfileStore {
  const runtimeExternalProfileIds = new Set(params.store.runtimeExternalProfileIds ?? []);
  const localStore = cloneAuthProfileStore(params.store);
  if (runtimeExternalProfileIds.size === 0) {
    localStore.runtimeExternalProfileIds = undefined;
    localStore.runtimeExternalProfileIdsAuthoritative = undefined;
    return localStore;
  }
  for (const profileId of runtimeExternalProfileIds) {
    delete localStore.profiles[profileId];
  }
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  pruneAuthProfileStoreReferences(localStore, keptProfileIds);
  localStore.runtimeExternalProfileIds = undefined;
  localStore.runtimeExternalProfileIdsAuthoritative = undefined;
  const persistedStore = loadAuthProfileStoreWithoutExternalProfiles(
    params.agentDir,
    params.options,
  );
  return mergeAuthProfileStores(persistedStore, localStore);
}

function buildRuntimeAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  return buildLocalAuthProfileStoreForSave({
    ...params,
    options: {
      ...params.options,
      filterExternalAuthProfiles: false,
    },
  });
}

function setRuntimeExternalProfileMetadata(params: {
  store: AuthProfileStore;
  profileIds: ReadonlySet<string>;
  authoritative: boolean;
}): void {
  const profileIds = [...params.profileIds].toSorted();
  params.store.runtimeExternalProfileIds =
    profileIds.length > 0 || params.authoritative ? profileIds : undefined;
  params.store.runtimeExternalProfileIdsAuthoritative = params.authoritative ? true : undefined;
}

function mergeRuntimeExternalProfileReferences(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const runtimeExternalProfileIds = new Set(params.existing.runtimeExternalProfileIds ?? []);
  if (params.next.runtimeExternalProfileIdsAuthoritative === true) {
    return params.next;
  }
  if (runtimeExternalProfileIds.size === 0) {
    return params.next;
  }
  const merged = cloneAuthProfileStore(params.next);
  const mergedRuntimeExternalProfileIds = new Set(merged.runtimeExternalProfileIds ?? []);
  const backfilledRuntimeExternalProfileIds = new Set<string>();
  for (const profileId of runtimeExternalProfileIds) {
    const existingCredential = params.existing.profiles[profileId];
    const nextCredential = merged.profiles[profileId];
    if (nextCredential) {
      if (
        mergedRuntimeExternalProfileIds.has(profileId) ||
        (existingCredential && isDeepStrictEqual(nextCredential, existingCredential))
      ) {
        mergedRuntimeExternalProfileIds.add(profileId);
      }
      continue;
    }
    if (!existingCredential) {
      continue;
    }
    merged.profiles[profileId] = existingCredential;
    mergedRuntimeExternalProfileIds.add(profileId);
    backfilledRuntimeExternalProfileIds.add(profileId);
    if (params.existing.usageStats?.[profileId]) {
      merged.usageStats = {
        ...merged.usageStats,
        [profileId]: params.existing.usageStats[profileId],
      };
    }
  }
  for (const [provider, profileIds] of Object.entries(params.existing.order ?? {})) {
    const externalProfileIds = profileIds.filter((profileId) =>
      backfilledRuntimeExternalProfileIds.has(profileId),
    );
    if (externalProfileIds.length === 0 || merged.order?.[provider]) {
      continue;
    }
    const existingOrder = merged.order?.[provider] ?? [];
    merged.order = {
      ...merged.order,
      [provider]: [
        ...externalProfileIds,
        ...existingOrder.filter((profileId) => !externalProfileIds.includes(profileId)),
      ],
    };
  }
  for (const [provider, profileId] of Object.entries(params.existing.lastGood ?? {})) {
    if (!backfilledRuntimeExternalProfileIds.has(profileId) || merged.lastGood?.[provider]) {
      continue;
    }
    merged.lastGood = {
      ...merged.lastGood,
      [provider]: profileId,
    };
  }
  setRuntimeExternalProfileMetadata({
    store: merged,
    profileIds: mergedRuntimeExternalProfileIds,
    authoritative: params.existing.runtimeExternalProfileIdsAuthoritative === true,
  });
  return merged;
}

function mergeRuntimeExternalProfileState(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const existingRuntimeProfileIds = new Set(params.existing.runtimeExternalProfileIds ?? []);
  if (existingRuntimeProfileIds.size === 0) {
    return params.next;
  }
  const merged = cloneAuthProfileStore(params.next);
  const mergedRuntimeProfileIds = new Set(merged.runtimeExternalProfileIds ?? []);
  const activeRuntimeProfileIds = new Set<string>();
  const nextRuntimeProfileIdsAuthoritative =
    params.next.runtimeExternalProfileIdsAuthoritative === true;
  for (const profileId of existingRuntimeProfileIds) {
    if (nextRuntimeProfileIdsAuthoritative && !mergedRuntimeProfileIds.has(profileId)) {
      continue;
    }
    const existingCredential = params.existing.profiles[profileId];
    if (!existingCredential) {
      continue;
    }
    const nextCredential = merged.profiles[profileId];
    if (nextCredential) {
      if (
        mergedRuntimeProfileIds.has(profileId) ||
        isDeepStrictEqual(nextCredential, existingCredential)
      ) {
        mergedRuntimeProfileIds.add(profileId);
        activeRuntimeProfileIds.add(profileId);
      }
      continue;
    }
    merged.profiles[profileId] = existingCredential;
    mergedRuntimeProfileIds.add(profileId);
    activeRuntimeProfileIds.add(profileId);
  }
  if (activeRuntimeProfileIds.size === 0) {
    return params.next;
  }
  for (const profileId of activeRuntimeProfileIds) {
    if (params.existing.usageStats?.[profileId]) {
      merged.usageStats = {
        ...merged.usageStats,
        [profileId]: params.existing.usageStats[profileId],
      };
    }
  }
  for (const [provider, profileIds] of Object.entries(params.existing.order ?? {})) {
    const externalProfileIds = profileIds.filter((profileId) =>
      activeRuntimeProfileIds.has(profileId),
    );
    if (externalProfileIds.length === 0 || merged.order?.[provider]) {
      continue;
    }
    merged.order = {
      ...merged.order,
      [provider]: externalProfileIds,
    };
  }
  for (const [provider, profileId] of Object.entries(params.existing.lastGood ?? {})) {
    if (!activeRuntimeProfileIds.has(profileId) || merged.lastGood?.[provider]) {
      continue;
    }
    merged.lastGood = {
      ...merged.lastGood,
      [provider]: profileId,
    };
  }
  setRuntimeExternalProfileMetadata({
    store: merged,
    profileIds: mergedRuntimeProfileIds,
    authoritative: params.existing.runtimeExternalProfileIdsAuthoritative === true,
  });
  return merged;
}

function saveAuthProfileStoreInTransaction(
  database: OpenClawStateDatabase,
  store: AuthProfileStore,
  agentDir?: string,
  updatedAt: number = Date.now(),
  options?: SaveAuthProfileStoreOptions,
): AuthProfileStore {
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  const storeKey = resolveAuthProfileStoreKey(agentDir, options?.env);
  const previousRaw = readAuthProfileStorePayloadResultFromDatabase(database, storeKey);
  const runtimeLegacyOAuthSidecarProfileIds = new Set(
    Object.entries(store.profiles)
      .filter(
        ([profileId, credential]) =>
          isRuntimeLegacyOAuthSidecarCredential(credential) ||
          matchesRuntimeLegacyOAuthSidecarMaterial({
            authPath: storeKey,
            profileId,
            credential,
          }),
      )
      .map(([profileId]) => profileId),
  );
  const payload = buildPersistedAuthProfileSecretsStore(localStore, undefined, {
    agentDir,
    env: options?.env,
    existingRaw: previousRaw.exists ? previousRaw.value : undefined,
    runtimeLegacyOAuthSidecarProfileIds,
  });
  savePersistedAuthProfileSecretsStoreInTransaction(database, payload, agentDir, updatedAt, {
    env: options?.env,
  });
  savePersistedAuthProfileStateInTransaction(database, localStore, agentDir, updatedAt, {
    env: options?.env,
  });
  return localStore;
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  saveOptions?: SaveAuthProfileStoreOptions;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  try {
    let savedStore: AuthProfileStore | null = null;
    let savedUpdatedAt: number | null = null;
    runOpenClawStateWriteTransaction(
      (database) => {
        // SQLite serializes these updates; always reload inside the write
        // transaction so usage/cooldown/auth refresh updates cannot overwrite
        // fresher state from another process.
        const persisted = loadPersistedAuthProfileStoreEntryFromDatabase(
          database,
          params.agentDir,
          { env: params.env },
        );
        const legacy = persisted
          ? null
          : loadLegacyAuthProfileStoreEntry(params.agentDir, { env: params.env });
        const store =
          persisted?.store ??
          legacy?.store ??
          ({
            version: AUTH_STORE_VERSION,
            profiles: {},
          } satisfies AuthProfileStore);
        savedUpdatedAt = persisted?.updatedAt ?? legacy?.updatedAt ?? null;
        const shouldSave = params.updater(store);
        savedStore = store;
        if (shouldSave) {
          const saveOptions = params.env
            ? { ...params.saveOptions, env: params.saveOptions?.env ?? params.env }
            : params.saveOptions;
          const updatedAt = Date.now();
          savedUpdatedAt = updatedAt;
          savedStore = saveAuthProfileStoreInTransaction(
            database,
            store,
            params.agentDir,
            updatedAt,
            saveOptions,
          );
        }
      },
      { env: params.env },
    );
    if (savedStore) {
      writeCachedAuthProfileStore({
        storeKey: resolveAuthProfileStoreKey(params.agentDir, params.env),
        authMtimeMs: savedUpdatedAt,
        store: savedStore,
      });
    }
    return savedStore;
  } catch {
    return null;
  }
}

export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    return overlayExternalAuthProfiles(asStore);
  }
  const legacyStore = loadLegacyAuthProfileStoreEntry();
  if (legacyStore) {
    saveAuthProfileStore(legacyStore.store);
    return overlayExternalAuthProfiles(legacyStore.store);
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  return overlayExternalAuthProfiles(store);
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const persistedOptions = resolvePersistedAuthProfileLoadOptions(options);
  const storeKey = resolveLoadedAuthStoreCacheKey(agentDir, persistedOptions);
  let persisted = readOnly
    ? loadPersistedAuthProfileStoreEntryReadOnly(agentDir, {
        allowKeychainPrompt: persistedOptions.allowKeychainPrompt,
        env: persistedOptions.env,
        legacyFallback: false,
        resolveLegacyOAuthSidecars: persistedOptions.resolveLegacyOAuthSidecars,
      })
    : loadPersistedAuthProfileStoreEntry(agentDir, {
        allowKeychainPrompt: persistedOptions.allowKeychainPrompt,
        env: persistedOptions.env,
        legacyFallback: false,
        resolveLegacyOAuthSidecars: persistedOptions.resolveLegacyOAuthSidecars,
      });
  let authMtimeMs = persisted?.updatedAt ?? null;
  if (!persisted) {
    const legacy = loadLegacyAuthProfileStoreEntry(agentDir, {
      allowKeychainPrompt: persistedOptions.allowKeychainPrompt,
      env: persistedOptions.env,
      resolveLegacyOAuthSidecars: persistedOptions.resolveLegacyOAuthSidecars,
    });
    if (legacy) {
      persisted = legacy;
      authMtimeMs = legacy.updatedAt;
      if (!readOnly) {
        saveAuthProfileStore(legacy.store, agentDir, {
          env: persistedOptions.env,
          syncExternalCli: false,
        });
      }
    }
  }
  if (!readOnly) {
    const cached = readCachedAuthProfileStore({
      storeKey,
      authMtimeMs,
    });
    if (cached) {
      return cached;
    }
  }
  if (persisted) {
    const synced = maybeSyncPersistedExternalCliAuthProfiles({
      store: persisted.store,
      agentDir,
      options,
    });
    if (!readOnly) {
      writeCachedAuthProfileStore({
        storeKey,
        authMtimeMs: synced.store === persisted.store ? authMtimeMs : Date.now(),
        store: synced.store,
      });
    }
    return synced.store;
  }

  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  const synced = maybeSyncPersistedExternalCliAuthProfiles({
    store,
    agentDir,
    options,
  });

  if (!readOnly) {
    writeCachedAuthProfileStore({
      storeKey,
      authMtimeMs,
      store: synced.store,
    });
  }
  return synced.store;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const storeKey = resolveAuthProfileStoreKey(agentDir, options?.env);
  const mainStoreKey = resolveAuthProfileStoreKey(undefined, options?.env);
  const externalCli = resolveExternalCliOverlayOptions(options);
  if (!agentDir || storeKey === mainStoreKey) {
    return overlayExternalAuthProfiles(store, {
      agentDir,
      ...externalCli,
    });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return overlayExternalAuthProfiles(
    mergeAuthProfileStores(mainStore, store, {
      preserveBaseRuntimeExternalProfiles: true,
    }),
    {
      agentDir,
      ...externalCli,
    },
  );
}

export function loadAuthProfileStoreForSecretsRuntime(
  agentDir?: string,
  options?: Pick<
    LoadAuthProfileStoreOptions,
    "config" | "externalCli" | "externalCliProviderIds" | "externalCliProfileIds"
  >,
): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, {
    ...options,
    readOnly: true,
    allowKeychainPrompt: false,
    resolveLegacyOAuthSidecars: true,
  });
}

export function loadAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: Pick<LoadAuthProfileStoreOptions, "env" | "resolveLegacyOAuthSidecars">,
): AuthProfileStore {
  const loadOptions: LoadAuthProfileStoreOptions = {
    readOnly: true,
    allowKeychainPrompt: false,
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.resolveLegacyOAuthSidecars !== undefined
      ? { resolveLegacyOAuthSidecars: options.resolveLegacyOAuthSidecars }
      : {}),
  };
  const store = loadAuthProfileStoreForAgent(agentDir, loadOptions);
  const storeKey = resolveAuthProfileStoreKey(agentDir, options?.env);
  const mainStoreKey = resolveAuthProfileStoreKey(undefined, options?.env);
  if (!agentDir || storeKey === mainStoreKey) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, loadOptions);
  return mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCli?: ExternalCliAuthDiscovery;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
  },
): AuthProfileStore {
  const externalCli = resolveExternalCliOverlayOptions(options);
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir, options);
  const store = overlayExternalAuthProfiles(
    ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options),
    {
      agentDir,
      ...externalCli,
    },
  );
  if (!runtimeStore || hasScopedExternalCliOverlay(externalCli)) {
    return store;
  }
  return mergeRuntimeExternalProfileState({
    next: store,
    existing: runtimeStore,
  });
}

export function ensureAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: {
    allowKeychainPrompt?: boolean;
    env?: NodeJS.ProcessEnv;
    resolveLegacyOAuthSidecars?: boolean;
  },
): AuthProfileStore {
  const effectiveOptions: LoadAuthProfileStoreOptions = {
    ...options,
    resolveLegacyOAuthSidecars: options?.resolveLegacyOAuthSidecars ?? true,
  };
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir, effectiveOptions);
  if (runtimeStore) {
    return buildAuthProfileStoreWithoutExternalProfiles({
      store: runtimeStore,
      agentDir,
      options: effectiveOptions,
    });
  }
  const store = loadAuthProfileStoreForAgent(agentDir, effectiveOptions);
  const storeKey = resolveAuthProfileStoreKey(agentDir, effectiveOptions.env);
  const mainStoreKey = resolveAuthProfileStoreKey(undefined, effectiveOptions.env);
  if (!agentDir || storeKey === mainStoreKey) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, effectiveOptions);
  return mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
}

export function findPersistedAuthProfileCredential(params: {
  agentDir?: string;
  profileId: string;
}): AuthProfileStore["profiles"][string] | undefined {
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile || !params.agentDir) {
    return requestedProfile;
  }

  const requestedKey = resolveAuthProfileStoreKey(params.agentDir);
  const mainKey = resolveAuthProfileStoreKey();
  if (requestedKey === mainKey) {
    return requestedProfile;
  }

  return loadPersistedAuthProfileStore()?.profiles[params.profileId];
}

export function resolvePersistedAuthProfileOwnerAgentDir(params: {
  agentDir?: string;
  profileId: string;
}): string | undefined {
  if (!params.agentDir) {
    return undefined;
  }
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedKey = resolveAuthProfileStoreKey(params.agentDir);
  const mainKey = resolveAuthProfileStoreKey();
  if (requestedKey === mainKey) {
    return undefined;
  }

  const mainStore = loadPersistedAuthProfileStore();
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile) {
    return shouldUseMainOwnerForLocalOAuthCredential({
      local: requestedProfile,
      main: mainStore?.profiles[params.profileId],
    })
      ? undefined
      : params.agentDir;
  }

  return mainStore?.profiles[params.profileId] ? undefined : params.agentDir;
}

export function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = { syncExternalCli: false };
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (!agentDir || storeKey === mainStoreKey) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, {
    readOnly: true,
    syncExternalCli: false,
  });
  return mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
}

export { hasAnyAuthProfileStoreSource } from "./source-check.js";

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  replaceRuntimeAuthProfileStoreSnapshotsImpl(entries);
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  clearRuntimeAuthProfileStoreSnapshotsImpl();
  clearLoadedAuthStoreCache();
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
): void {
  const storeKey = resolveAuthProfileStoreKey(agentDir, options?.env);
  const updatedAt = Date.now();
  let savedStore = store;
  runOpenClawStateWriteTransaction(
    (database) => {
      savedStore = saveAuthProfileStoreInTransaction(database, store, agentDir, updatedAt, options);
    },
    { env: options?.env },
  );
  writeCachedAuthProfileStore({
    storeKey,
    authMtimeMs: updatedAt,
    store: savedStore,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    const existingRuntimeStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    const nextRuntimeStore = buildRuntimeAuthProfileStoreForSave({ store, agentDir, options });
    setRuntimeAuthProfileStoreSnapshot(
      existingRuntimeStore
        ? mergeRuntimeExternalProfileReferences({
            next: nextRuntimeStore,
            existing: existingRuntimeStore,
          })
        : nextRuntimeStore,
      agentDir,
    );
  }
}
