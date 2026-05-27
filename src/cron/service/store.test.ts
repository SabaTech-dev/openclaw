import { describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStoreKey } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storeKey: string, job: Record<string, unknown>) {
  await saveCronStore(storeKey, { version: 1, jobs: [job as unknown as CronJob] });
}

function updateCronJobRowForTest(
  storeKey: string,
  jobId: string,
  updates: Partial<OpenClawStateKyselyDatabase["cron_jobs"]>,
): void {
  const stateDatabase = openOpenClawStateDatabase();
  const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "cron_jobs">>(stateDatabase.db);
  executeSqliteQuerySync(
    stateDatabase.db,
    db
      .updateTable("cron_jobs")
      .set(updates)
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  );
}

function createStoreTestState(storeKey: string) {
  return createCronServiceState({
    storeKey: storeKey,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function createReloadCronJob(params?: Partial<CronJob>): CronJob {
  return {
    id: "reload-cron-expr-job",
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: STORE_TEST_NOW - 60_000,
    updatedAtMs: STORE_TEST_NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...params,
  };
}

describe("cron service store seam coverage", () => {
  it("loads stored jobs, recomputes next runs, and keeps JSON files out of the load path", async () => {
    const { storeKey } = await makeStoreKey();

    await writeSingleJobStore(storeKey, {
      id: "modern-job",
      name: "modern job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    });

    const state = createStoreTestState(storeKey);

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    if (!job) {
      throw new Error("expected loaded cron job");
    }
    expect(job.sessionTarget).toBe("isolated");
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("ping");
    }
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.channel).toBe("telegram");
    expect(job.delivery?.to).toBe("123");
    expect(job?.state.nextRunAtMs).toBe(STORE_TEST_NOW);

    await persist(state);
    const persisted = await loadCronStore(storeKey);
    expect(persisted.jobs[0]?.payload.kind).toBe("agentTurn");
  });

  it("loads persisted custom session ids without rewriting them", async () => {
    const { storeKey } = await makeStoreKey();

    await writeSingleJobStore(storeKey, {
      id: "unsafe-session-target-job",
      name: "unsafe session target job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:../../outside",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      state: {},
    });

    const state = createStoreTestState(storeKey);

    await ensureLoaded(state, { skipRecompute: true });

    const job = findJobOrThrow(state, "unsafe-session-target-job");
    expect(job.sessionTarget).toBe("session:../../outside");
  });

  it("preserves unsupported payload rows across full persistence without loading them", async () => {
    const { storeKey } = await makeStoreKey();
    const legacyJob = createReloadCronJob({
      id: "legacy-command",
      name: "legacy command",
      state: { lastRunAtMs: STORE_TEST_NOW - 3_600_000 },
    });

    await saveCronStore(storeKey, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: "valid-job",
          name: "valid job",
          payload: { kind: "systemEvent", text: "tick" },
        }),
        legacyJob,
      ],
    });
    updateCronJobRowForTest(storeKey, "legacy-command", {
      payload_kind: "command",
      payload_message: "echo daily",
      job_json: JSON.stringify({
        ...legacyJob,
        payload: { kind: "command", command: "echo daily" },
        state: { lastRunAtMs: STORE_TEST_NOW - 3_600_000 },
      }),
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });

    expect(state.store?.jobs.map((job) => job.id)).toEqual(["valid-job"]);
    expect(() => findJobOrThrow(state, "legacy-command")).toThrow(/unknown cron job id/);

    const valid = findJobOrThrow(state, "valid-job");
    valid.name = "valid job renamed";
    await persist(state);

    const persisted = await loadCronStore(storeKey);
    expect(persisted.jobs.map((job) => job.id)).toEqual(["valid-job"]);

    const stateDatabase = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "cron_jobs">>(
      stateDatabase.db,
    );
    const rows = executeSqliteQuerySync(
      stateDatabase.db,
      db
        .selectFrom("cron_jobs")
        .select(["job_id", "payload_kind", "job_json"])
        .where("store_key", "=", storeKey)
        .orderBy("sort_order", "asc")
        .orderBy("job_id", "asc"),
    ).rows;
    expect(rows.map((row) => row.job_id)).toEqual(["valid-job", "legacy-command"]);
    expect(rows[1]).toMatchObject({ job_id: "legacy-command", payload_kind: "command" });
    expect(JSON.parse(rows[1]?.job_json ?? "{}")).toMatchObject({
      id: "legacy-command",
      payload: { kind: "command", command: "echo daily" },
    });
  });

  it("clears stale nextRunAtMs after force reload when cron schedule expression changes", async () => {
    const { storeKey } = await makeStoreKey();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storeKey, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });
    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(staleNextRunAtMs);

    await writeSingleJobStore(storeKey, {
      id: "reload-cron-expr-job",
      name: "reload cron expr job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 30_000,
      schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
  });

  it("preserves nextRunAtMs after force reload when cron schedule key order changes only", async () => {
    const { storeKey } = await makeStoreKey();
    const dueNextRunAtMs = STORE_TEST_NOW - 1_000;

    await saveCronStore(storeKey, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });

    await writeSingleJobStore(storeKey, {
      id: "reload-cron-expr-job",
      name: "reload cron expr job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 30_000,
      schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: dueNextRunAtMs },
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("rejects a force-reloaded legacy string schedule before persistence", async () => {
    const { storeKey } = await makeStoreKey();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });

    await expect(
      writeSingleJobStore(storeKey, {
        ...createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW,
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
        schedule: "0 17 * * *",
      }),
    ).rejects.toThrow(/schedule_kind/);

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const job = findJobOrThrow(state, "reload-cron-expr-job");
    expect(job.schedule).toEqual({ kind: "cron", expr: "0 6 * * *", tz: "UTC" });
    expect(job.state.nextRunAtMs).toBe(staleNextRunAtMs);
  });

  it("preserves nextRunAtMs after force reload when scheduling inputs are unchanged", async () => {
    const { storeKey } = await makeStoreKey();
    const originalNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        state: { nextRunAtMs: originalNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: originalNextRunAtMs + 60_000 },
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(
      originalNextRunAtMs + 60_000,
    );
  });

  it("clears stale nextRunAtMs after force reload when enabled state changes", async () => {
    const { storeKey } = await makeStoreKey();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        enabled: true,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        enabled: false,
        updatedAtMs: STORE_TEST_NOW,
        state: {},
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when every schedule anchor changes", async () => {
    const { storeKey } = await makeStoreKey();
    const jobId = "reload-every-anchor-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        id: jobId,
        updatedAtMs: STORE_TEST_NOW,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW },
        state: {},
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when at schedule target changes", async () => {
    const { storeKey } = await makeStoreKey();
    const jobId = "reload-at-target-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storeKey);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storeKey, {
      ...createReloadCronJob({
        id: jobId,
        updatedAtMs: STORE_TEST_NOW,
        schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" },
        state: {},
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });
});
