import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  createTaskRecord,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import * as taskRegistryMaintenance from "../tasks/task-registry.maintenance.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tasksAuditCommand, tasksMaintenanceCommand } from "./tasks.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

function readFirstJsonLog(runtime: RuntimeEnv): unknown {
  const calls = vi.mocked(runtime.log).mock.calls;
  const [message] = calls[0] ?? [];
  return JSON.parse(String(message));
}

const zeroTaskAuditCounts = {
  delivery_failed: 0,
  inconsistent_timestamps: 0,
  lost: 0,
  missing_cleanup: 0,
  stale_queued: 0,
  stale_running: 0,
};

function seedMainSessionRow(sessionKey: string, entry: SessionEntry): void {
  upsertSessionEntry({
    agentId: "main",
    sessionKey,
    entry,
  });
}

async function withTaskCommandStateDir(
  run: (state: OpenClawTestState) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-command-" },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("tasks commands", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("keeps audit JSON stable and sorts combined findings before limiting", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-queued",
        status: "running",
        task: "Inspect issue backlog",
      });
      vi.setSystemTime(now);
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Inspect issue backlog",
        status: "waiting",
        createdAt: now - 40 * 60_000,
        updatedAt: now - 40 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditCommand({ json: true }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        summary: {
          total: number;
          errors: number;
          warnings: number;
          byCode: Record<string, number>;
          taskFlows: { total: number; byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
      };

      expect(payload.summary.byCode.lost).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(1);
      expect(payload.summary.combined.total).toBe(3);

      const runningFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Running flow",
        status: "running",
        createdAt: now - 45 * 60_000,
        updatedAt: now - 45 * 60_000,
      });

      const limitedRuntime = createRuntime();
      await tasksAuditCommand({ json: true, limit: 1 }, limitedRuntime);

      const limitedPayload = readFirstJsonLog(limitedRuntime) as { findings: unknown[] };

      expect(limitedPayload.findings).toStrictEqual([
        {
          kind: "task_flow",
          severity: "error",
          code: "stale_running",
          detail: "running TaskFlow has not advanced recently",
          ageMs: 45 * 60_000,
          status: "running",
          token: runningFlow.flowId,
          flow: JSON.parse(JSON.stringify(runningFlow)),
        },
      ]);
    });
  });

  it("explains stale running tasks retained by backing sessions in maintenance JSON", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 45 * 60_000);
      const childSessionKey = "agent:main:subagent:child-retained";
      const task = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId: "run-retained-child",
        status: "running",
        task: "Review retained child session",
      });
      vi.setSystemTime(now);

      seedMainSessionRow(childSessionKey, {
        sessionId: "child-retained",
        updatedAt: now,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: false }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        diagnostics: {
          staleRunningTasks: Array<{
            taskId: string;
            decision: string;
            reason: string;
            childSessionKey?: string;
          }>;
        };
      };

      expect(payload.diagnostics.staleRunningTasks).toContainEqual(
        expect.objectContaining({
          taskId: task.taskId,
          decision: "retained",
          reason: "backing_session_present",
          childSessionKey,
        }),
      );
    });
  });

  it("explains task maintenance decisions before any later session registry pruning", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 45 * 60_000);
      const childSessionKey = "agent:main:cron:done-job:run:old-run";
      const task = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId: "run-backed-before-session-sweep",
        status: "running",
        task: "Review old cron child session",
      });
      vi.setSystemTime(now);

      seedMainSessionRow(childSessionKey, {
        sessionId: "old-run",
        updatedAt: now - 8 * 24 * 60 * 60_000,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: true }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        maintenance: {
          tasks: { reconciled: number };
        };
        diagnostics: {
          staleRunningTasks: Array<{
            taskId: string;
            decision: string;
            reason: string;
            childSessionKey?: string;
          }>;
        };
      };

      expect(payload.maintenance.tasks.reconciled).toBe(0);
      expect(payload.diagnostics.staleRunningTasks).toContainEqual(
        expect.objectContaining({
          taskId: task.taskId,
          decision: "retained",
          reason: "backing_session_present",
          childSessionKey,
        }),
      );
    });
  });

  it("does not build JSON-only diagnostics for text maintenance output", async () => {
    await withTaskCommandStateDir(async () => {
      const diagnosticsSpy = vi.spyOn(
        taskRegistryMaintenance,
        "getTaskRegistryMaintenanceDiagnostics",
      );
      const runtime = createRuntime();

      await tasksMaintenanceCommand({ json: false, apply: false }, runtime);

      expect(diagnosticsSpy).not.toHaveBeenCalled();
    });
  });

  it("explains retained lost task cleanup timing in maintenance text output", async () => {
    await withTaskCommandStateDir(async () => {
      const cleanupAfter = Date.now() + 60_000;
      createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-retained-lost",
        status: "lost",
        task: "Retained lost task",
        cleanupAfter,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: false, apply: true }, runtime);

      const joined = vi
        .mocked(runtime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(joined).toContain(
        `Retained lost tasks: 1 retained until ${new Date(cleanupAfter).toISOString()}; maintenance will prune after cleanupAfter.`,
      );
    });
  });

  it("keeps tasks maintenance JSON additive for TaskFlow state", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Old terminal flow",
        status: "succeeded",
        createdAt: now - 8 * 24 * 60 * 60_000,
        updatedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: false }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        mode: string;
        maintenance: { taskFlows: { pruned: number } };
        auditBefore: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
        auditAfter: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
      };

      expect(payload.mode).toBe("preview");
      expect(payload.maintenance.taskFlows.pruned).toBe(1);
      expect(payload.auditBefore.byCode).toStrictEqual(zeroTaskAuditCounts);
      expect(payload.auditBefore.taskFlows.byCode.stale_running).toBe(0);
      expect(payload.auditAfter.byCode).toStrictEqual(zeroTaskAuditCounts);
      expect(payload.auditAfter.taskFlows.byCode.stale_running).toBe(0);
    });
  });
});
