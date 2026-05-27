import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import {
  loadCronStoreWithConfigJobs,
  saveCronStore,
  type PreservedCronConfigJob,
} from "../store.js";
import type { CronJob } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import type { CronServiceState } from "./state.js";

function invalidateStaleNextRunOnScheduleChange(params: {
  previousJobsById: ReadonlyMap<string, CronJob>;
  hydrated: CronJob;
}) {
  const previousJob = params.previousJobsById.get(params.hydrated.id);
  if (!previousJob || cronSchedulingInputsEqual(previousJob, params.hydrated)) {
    return;
  }
  params.hydrated.state ??= {};
  params.hydrated.state.nextRunAtMs = undefined;
}

function warnInvalidPersistedCronJob(params: {
  state: CronServiceState;
  raw: Record<string, unknown>;
  index: number;
  reason: string;
}) {
  const jobId = typeof params.raw.id === "string" ? params.raw.id : undefined;
  const dedupeKey = jobId ?? `index:${params.index}`;
  if (params.state.warnedInvalidPersistedJobKeys.has(dedupeKey)) {
    return;
  }
  params.state.warnedInvalidPersistedJobKeys.add(dedupeKey);
  params.state.deps.log.warn(
    {
      storeKey: params.state.deps.storeKey,
      jobId,
      jobIndex: params.index,
      reason: params.reason,
    },
    "cron: skipped invalid persisted job; run openclaw doctor --fix to repair",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnsupportedStringPayloadKind(candidate: Record<string, unknown>): boolean {
  const payload = candidate.payload;
  if (!isRecord(payload)) {
    return false;
  }
  const kind = payload.kind;
  return (
    typeof kind === "string" && kind.trim() !== "" && kind !== "systemEvent" && kind !== "agentTurn"
  );
}

function maybeDefaultMissingSessionTarget(params: {
  state: CronServiceState;
  hydrated: CronJob;
}): void {
  if (typeof params.hydrated.sessionTarget === "string") {
    return;
  }
  const payload = params.hydrated.payload as unknown;
  const payloadKind =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, "kind")
      ? (payload as { kind?: unknown }).kind
      : undefined;
  let defaulted: "main" | "isolated" | undefined;
  if (payloadKind === "systemEvent") {
    defaulted = "main";
  } else if (payloadKind === "agentTurn") {
    defaulted = "isolated";
  }
  if (!defaulted) {
    return;
  }
  params.hydrated.sessionTarget = defaulted;
  const jobId = typeof params.hydrated.id === "string" ? params.hydrated.id : undefined;
  const dedupeKey = jobId ?? "<unknown>";
  if (params.state.warnedMissingSessionTargetJobIds.has(dedupeKey)) {
    return;
  }
  params.state.warnedMissingSessionTargetJobIds.add(dedupeKey);
  params.state.deps.log.warn(
    { storeKey: params.state.deps.storeKey, jobId, defaulted },
    "cron: job missing sessionTarget; defaulted in memory (run openclaw doctor --fix to persist canonical shape)",
  );
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  const previousJobsById = new Map<string, CronJob>();
  for (const job of state.store?.jobs ?? []) {
    previousJobsById.set(job.id, job);
  }
  const loaded = await loadCronStoreWithConfigJobs(state.deps.storeKey);
  const loadedJobs = loaded.store.jobs ?? [];
  const jobs: CronJob[] = [];
  const preservedInvalidPersistedJobs: PreservedCronConfigJob[] = [];
  for (const [index, job] of loadedJobs.entries()) {
    const raw = job as unknown as Record<string, unknown>;
    const rawConfigJob = loaded.configJobs[index] ?? structuredClone(raw);
    const { legacyJobIdIssue } = normalizeCronJobIdentityFields(raw);
    let normalized: Record<string, unknown> | null;
    try {
      normalized = normalizeCronJobInput(raw);
    } catch (error) {
      if (!isInvalidCronSessionTargetIdError(error)) {
        throw error;
      }
      normalized = null;
      state.deps.log.warn(
        { storeKey: state.deps.storeKey, jobId: typeof raw.id === "string" ? raw.id : undefined },
        "cron: job has invalid persisted sessionTarget; run openclaw doctor --fix to repair",
      );
    }
    const hydrated =
      normalized && typeof normalized === "object" ? (normalized as unknown as CronJob) : job;
    const invalidReason = getInvalidPersistedCronJobReason(
      hydrated as unknown as Record<string, unknown>,
    );
    if (invalidReason) {
      if (invalidReason === "invalid-payload" && hasUnsupportedStringPayloadKind(rawConfigJob)) {
        preservedInvalidPersistedJobs.push({ index, job: rawConfigJob });
      }
      warnInvalidPersistedCronJob({ state, raw, index, reason: invalidReason });
      continue;
    }
    jobs.push(hydrated);
    if (legacyJobIdIssue) {
      const resolvedId = typeof hydrated.id === "string" ? hydrated.id : undefined;
      state.deps.log.warn(
        { storeKey: state.deps.storeKey, jobId: resolvedId },
        "cron: job used legacy jobId field; normalized id in memory (run openclaw doctor --fix to persist canonical shape)",
      );
    }
    if (typeof hydrated.enabled !== "boolean") {
      hydrated.enabled = true;
    }
    maybeDefaultMissingSessionTarget({ state, hydrated });
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.preservedInvalidPersistedJobs = preservedInvalidPersistedJobs;
  state.storeLoadedAtMs = state.deps.nowMs();

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storeKey: state.deps.storeKey },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(
  state: CronServiceState,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storeKey, state.store, {
    ...opts,
    preservedConfigJobs: state.preservedInvalidPersistedJobs,
  });
}
