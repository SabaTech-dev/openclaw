import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearGatewayModelPricingCacheState } from "../gateway/model-pricing-cache-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as usageFormat from "../utils/usage-format.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummary,
  loadSessionCostSummaryFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  refreshCostUsageCache,
  requestCostUsageCacheRefresh,
} from "./session-cost-usage.js";

describe("session cost usage", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-session-cost-" });

  const closeDatabases = () => {
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
  };

  const withStateDir = async <T>(stateDir: string, fn: () => Promise<T>): Promise<T> =>
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      closeDatabases();
      try {
        return await fn();
      } finally {
        closeDatabases();
      }
    });

  const makeRoot = async (prefix: string): Promise<string> => await suiteRootTracker.make(prefix);

  const writeTranscript = (params: {
    agentId?: string;
    databasePath?: string;
    sessionId: string;
    events: unknown[];
  }) => {
    const eventTimestamp = params.events
      .map((event) =>
        event &&
        typeof event === "object" &&
        typeof (event as { timestamp?: unknown }).timestamp === "string"
          ? Date.parse((event as { timestamp: string }).timestamp)
          : Number.NaN,
      )
      .find((value) => Number.isFinite(value));
    replaceSqliteSessionTranscriptEvents({
      agentId: params.agentId ?? "main",
      ...(params.databasePath ? { path: params.databasePath } : {}),
      sessionId: params.sessionId,
      events: [{ type: "session", version: 1, id: params.sessionId }, ...params.events],
      ...(eventTimestamp !== undefined ? { now: () => eventTimestamp } : {}),
    });
  };

  const assistantUsage = (params: {
    timestamp: string;
    input: number;
    output: number;
    totalTokens?: number;
    cost?: number;
    provider?: string;
    model?: string;
    durationMs?: number;
  }) => ({
    type: "message",
    timestamp: params.timestamp,
    provider: params.provider ?? "openai",
    model: params.model ?? "gpt-5.4",
    usage: {
      input: params.input,
      output: params.output,
      totalTokens: params.totalTokens ?? params.input + params.output,
      ...(params.cost === undefined ? {} : { cost: { total: params.cost } }),
    },
    message: {
      role: "assistant",
      provider: params.provider ?? "openai",
      model: params.model ?? "gpt-5.4",
      durationMs: params.durationMs,
      usage: {
        input: params.input,
        output: params.output,
        totalTokens: params.totalTokens ?? params.input + params.output,
        ...(params.cost === undefined ? {} : { cost: { total: params.cost } }),
      },
    },
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    closeDatabases();
    await suiteRootTracker.cleanup();
  });

  it("discovers sessions by durable SQLite scope", async () => {
    const root = await makeRoot("discover");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-discover",
        events: [
          {
            type: "message",
            timestamp: "2026-02-05T12:00:00.000Z",
            message: { role: "user", content: "Summarize the last build" },
          },
        ],
      });

      const sessions = await discoverAllSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        agentId: "main",
        sessionId: "sess-discover",
        firstUserMessage: "Summarize the last build",
      });
    });
  });

  it("discovers sessions that continued after the requested end", async () => {
    const root = await makeRoot("discover-continued");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-continued",
        events: [
          {
            type: "message",
            timestamp: "2026-02-05T12:00:00.000Z",
            message: { role: "user", content: "Summarize this range" },
          },
          {
            type: "message",
            timestamp: "2026-02-07T12:00:00.000Z",
            message: { role: "assistant", content: "continued" },
          },
        ],
      });

      const sessions = await discoverAllSessions({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        agentId: "main",
        sessionId: "sess-continued",
        firstUserMessage: "Summarize this range",
      });
    });
  });

  it("loads aggregate usage directly from SQLite transcript events", async () => {
    const root = await makeRoot("aggregate");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-aggregate",
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 10,
            output: 20,
            cost: 0.03,
          }),
        ],
      });

      const summary = await loadCostUsageSummary({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
      });
      expect(summary.daily).toHaveLength(1);
      expect(summary.totals.totalTokens).toBe(30);
      expect(summary.totals.totalCost).toBeCloseTo(0.03, 5);

      const cached = await loadCostUsageSummaryFromCache({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
        requestRefresh: false,
      });
      expect(cached.cacheStatus).toMatchObject({
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      });
      expect(await refreshCostUsageCache()).toBe("refreshed");
      requestCostUsageCacheRefresh();
    });
  });

  it("reuses resolved model costs while scanning repeated SQLite usage entries", async () => {
    const root = await makeRoot("resolver-cache");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-repeated",
        events: Array.from({ length: 12 }, () =>
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 10,
            output: 20,
          }),
        ),
      });

      const config = {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.4",
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const costSpy = vi.spyOn(usageFormat, "resolveModelCostConfig");
      try {
        const summary = await loadCostUsageSummary({
          startMs: Date.parse("2026-02-05T00:00:00.000Z"),
          endMs: Date.parse("2026-02-06T00:00:00.000Z"),
          config,
        });
        expect(summary.totals.totalTokens).toBe(360);
        expect(summary.totals.totalCost).toBeCloseTo(0.0006, 8);
        expect(costSpy.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        costSpy.mockRestore();
      }
    });
  });

  it("counts token usage for an unpriced zero-cost model as missing", async () => {
    const root = await makeRoot("unknown-zero");
    await withStateDir(root, async () => {
      clearGatewayModelPricingCacheState();
      writeTranscript({
        sessionId: "sess-unknown-zero",
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 881,
            output: 6,
            totalTokens: 23287,
            cost: 0,
            model: "gpt-5.5",
          }),
        ],
      });

      const summary = await loadCostUsageSummary({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
      });
      expect(summary.totals.totalTokens).toBe(23287);
      expect(summary.totals.totalCost).toBe(0);
      expect(summary.totals.missingCostEntries).toBe(1);
    });
  });

  it("counts token usage for a configured all-zero model as missing", async () => {
    const root = await makeRoot("configured-zero");
    await withStateDir(root, async () => {
      clearGatewayModelPricingCacheState();
      writeTranscript({
        sessionId: "sess-configured-zero",
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 881,
            output: 6,
            totalTokens: 23287,
            cost: 0,
            model: "gpt-5.5",
          }),
        ],
      });

      const config = {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.5",
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const summary = await loadCostUsageSummary({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
        config,
      });
      expect(summary.totals.totalTokens).toBe(23287);
      expect(summary.totals.totalCost).toBe(0);
      expect(summary.totals.missingCostEntries).toBe(1);
    });
  });

  it("loads session summary, time series, and logs by agent/session id", async () => {
    const root = await makeRoot("session");
    await withStateDir(root, async () => {
      writeTranscript({
        agentId: "worker",
        sessionId: "sess-summary",
        events: [
          {
            type: "message",
            timestamp: "2026-02-05T12:00:00.000Z",
            message: { role: "user", content: "[OpenClaw inbound]\nhello" },
          },
          {
            ...assistantUsage({
              timestamp: "2026-02-05T12:00:02.000Z",
              input: 10,
              output: 20,
              cost: 0.03,
              durationMs: 2000,
            }),
            message: {
              role: "assistant",
              provider: "openai",
              model: "gpt-5.4",
              durationMs: 2000,
              content: [
                { type: "tool_use", name: "shell" },
                { type: "text", text: "done" },
              ],
              usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.03 } },
            },
          },
        ],
      });

      expect(await loadSessionCostSummary({ sessionId: "sess-summary" })).toBeNull();

      const summary = await loadSessionCostSummary({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(summary).toMatchObject({
        agentId: "worker",
        sessionId: "sess-summary",
        totalTokens: 30,
        totalCost: 0.03,
        messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 1 },
      });
      expect(summary?.latency?.avgMs).toBe(2000);
      expect(summary?.modelUsage?.[0]).toMatchObject({ provider: "openai", model: "gpt-5.4" });

      const cached = await loadSessionCostSummaryFromCache({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(cached.cacheStatus.status).toBe("fresh");
      expect(cached.summary?.totalTokens).toBe(30);

      const timeseries = await loadSessionUsageTimeSeries({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(timeseries).toMatchObject({ sessionId: "sess-summary" });
      expect(timeseries?.points).toHaveLength(1);
      expect(timeseries?.points[0]).toMatchObject({ totalTokens: 30, cumulativeTokens: 30 });

      const logs = await loadSessionLogs({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(logs?.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(logs?.[0]?.content).toContain("hello");
      expect(logs?.[1]?.content).toContain("[Tool: shell]");
    });
  });

  it("computes time-series cumulative usage after timestamp sorting", async () => {
    const root = await makeRoot("timeseries-skewed");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-skewed",
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:10.000Z",
            input: 10,
            output: 5,
            cost: 0.015,
          }),
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 2,
            output: 3,
            cost: 0.005,
          }),
        ],
      });

      const timeseries = await loadSessionUsageTimeSeries({
        sessionId: "sess-skewed",
      });

      expect(timeseries?.points.map((point) => point.timestamp)).toEqual([
        Date.parse("2026-02-05T12:00:00.000Z"),
        Date.parse("2026-02-05T12:00:10.000Z"),
      ]);
      expect(timeseries?.points.map((point) => point.cumulativeTokens)).toEqual([5, 20]);
      expect(timeseries?.points[0]?.cumulativeCost).toBeCloseTo(0.005, 6);
      expect(timeseries?.points[1]?.cumulativeCost).toBeCloseTo(0.02, 6);
    });
  });

  it("loads per-session usage from a selected relocated SQLite database", async () => {
    const root = await makeRoot("session-relocated");
    await withStateDir(root, async () => {
      const databasePath = path.join(root, "relocated", "worker.sqlite");
      writeTranscript({
        agentId: "worker",
        databasePath,
        sessionId: "sess-relocated",
        events: [
          {
            type: "message",
            timestamp: "2026-02-05T12:00:00.000Z",
            message: { role: "user", content: "hello from relocated" },
          },
          {
            ...assistantUsage({
              timestamp: "2026-02-05T12:00:02.000Z",
              input: 4,
              output: 6,
              cost: 0.01,
            }),
            message: {
              role: "assistant",
              content: "hello back",
              usage: { input: 4, output: 6, totalTokens: 10, cost: { total: 0.01 } },
            },
          },
        ],
      });

      expect(
        await loadSessionCostSummary({ agentId: "worker", sessionId: "sess-relocated" }),
      ).toBeNull();

      const summary = await loadSessionCostSummary({
        agentId: "worker",
        databasePath,
        sessionId: "sess-relocated",
      });
      expect(summary).toMatchObject({
        agentId: "worker",
        sessionId: "sess-relocated",
        totalTokens: 10,
        totalCost: 0.01,
      });

      await expect(
        loadSessionUsageTimeSeries({
          agentId: "worker",
          databasePath,
          sessionId: "sess-relocated",
        }),
      ).resolves.toMatchObject({
        sessionId: "sess-relocated",
        points: [{ totalTokens: 10 }],
      });

      const logs = await loadSessionLogs({
        agentId: "worker",
        databasePath,
        sessionId: "sess-relocated",
      });
      expect(logs?.map((entry) => entry.role)).toEqual(["user", "assistant"]);

      await expect(discoverAllSessions({ agentId: "worker", databasePath })).resolves.toEqual([
        expect.objectContaining({
          agentId: "worker",
          databasePath,
          sessionId: "sess-relocated",
        }),
      ]);
    });
  });

  it("reports stale session cache status for missing SQLite transcripts", async () => {
    const root = await makeRoot("missing");
    await withStateDir(root, async () => {
      expect(await loadSessionCostSummary({ agentId: "main", sessionId: "missing" })).toBeNull();

      const cached = await loadSessionCostSummaryFromCache({
        agentId: "main",
        sessionId: "missing",
      });
      expect(cached.summary).toBeNull();
      expect(cached.cacheStatus).toMatchObject({
        status: "stale",
        cachedFiles: 0,
        pendingFiles: 0,
        staleFiles: 1,
      });
    });
  });

  it("returns empty points for zero, negative, and non-finite maxPoints", async () => {
    const root = await makeRoot("timeseries-invalid-max-points");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-invalid-max-points",
        events: [
          {
            type: "message",
            timestamp: new Date(Date.UTC(2026, 1, 12, 10, 1, 0)).toISOString(),
            message: {
              role: "assistant",
              provider: "openai",
              model: "gpt-5.4",
              usage: {
                input: 1,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 3,
                cost: { total: 0.001 },
              },
            },
          },
          {
            type: "message",
            timestamp: new Date(Date.UTC(2026, 1, 12, 10, 2, 0)).toISOString(),
            message: {
              role: "assistant",
              provider: "openai",
              model: "gpt-5.4",
              usage: {
                input: 2,
                output: 4,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 6,
                cost: { total: 0.002 },
              },
            },
          },
        ],
      });

      const base = { sessionId: "sess-invalid-max-points", points: [] };
      await expect(
        loadSessionUsageTimeSeries({ sessionId: "sess-invalid-max-points", maxPoints: 0 }),
      ).resolves.toEqual(base);
      await expect(
        loadSessionUsageTimeSeries({ sessionId: "sess-invalid-max-points", maxPoints: -1 }),
      ).resolves.toEqual(base);
      await expect(
        loadSessionUsageTimeSeries({
          sessionId: "sess-invalid-max-points",
          maxPoints: Number.NaN,
        }),
      ).resolves.toEqual(base);
      await expect(
        loadSessionUsageTimeSeries({
          sessionId: "sess-invalid-max-points",
          maxPoints: Number.POSITIVE_INFINITY,
        }),
      ).resolves.toEqual(base);
    });
  });

  it("returns empty logs for zero, negative, and non-finite limits", async () => {
    const root = await makeRoot("session-logs-invalid-limit");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-invalid-limit",
        events: [
          {
            type: "message",
            timestamp: new Date(Date.UTC(2026, 1, 12, 10, 0, 0)).toISOString(),
            message: { role: "user", content: "hello" },
          },
          {
            type: "message",
            timestamp: new Date(Date.UTC(2026, 1, 12, 10, 1, 0)).toISOString(),
            message: { role: "user", content: "world" },
          },
        ],
      });

      await expect(loadSessionLogs({ sessionId: "sess-invalid-limit", limit: 0 })).resolves.toEqual(
        [],
      );
      await expect(
        loadSessionLogs({ sessionId: "sess-invalid-limit", limit: -1 }),
      ).resolves.toEqual([]);
      await expect(
        loadSessionLogs({ sessionId: "sess-invalid-limit", limit: Number.NaN }),
      ).resolves.toEqual([]);
      await expect(
        loadSessionLogs({ sessionId: "sess-invalid-limit", limit: Number.POSITIVE_INFINITY }),
      ).resolves.toEqual([]);
    });
  });
});
