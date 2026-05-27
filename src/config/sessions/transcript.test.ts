import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { repairToolUseResultPairing } from "../../agents/session-transcript-repair.js";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  readTailAssistantTextFromSessionTranscript,
} from "./transcript.js";
import type { SessionEntry } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("appendAssistantMessageToSessionTranscript", () => {
  beforeAll(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-warm-"));
    try {
      const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({ warm: { sessionId: "warm-session", chatType: "direct" } }),
        "utf-8",
      );
      await appendAssistantMessageToSessionTranscript({
        sessionKey: "warm",
        text: "warm",
        storePath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";
  type ExactAssistantMessage = Parameters<
    typeof appendExactAssistantMessageToSessionTranscript
  >[0]["message"];
  type TranscriptRepairMessage = Parameters<typeof repairToolUseResultPairing>[0][number];
  type TranscriptUpdateEmitterSpy = {
    mock: {
      calls: [string | SessionTranscriptUpdate][];
    };
  };

  async function writeTranscriptStore(
    store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
        updatedAt: 1,
      },
    },
  ) {
    for (const [key, entry] of Object.entries(store)) {
      upsertSessionEntry({ agentId: "main", sessionKey: key, entry });
    }
  }

  function readEvents(targetSessionId = sessionId) {
    return loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: targetSessionId,
    }).map(
      (entry) =>
        entry.event as {
          type?: string;
          id?: string;
          parentId?: string | null;
          message?: {
            role?: string;
            provider?: string;
            model?: string;
            content?: Array<{ type?: string; text?: string }> | string;
            idempotencyKey?: string;
          };
        },
    );
  }

  function createExactAssistantMessage(params: {
    text?: string;
    content?: ExactAssistantMessage["content"];
    provider?: string;
    model?: string;
  }): ExactAssistantMessage {
    return {
      role: "assistant",
      content: params.content ?? [{ type: "text", text: params.text ?? "" }],
      api: "openai-responses",
      provider: params.provider ?? "codex",
      model: params.model ?? "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  it("appends SQLite transcript message for valid session", async () => {
    await writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const events = readEvents();
      expect(events.length).toBe(2);

      const header = events[0];
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = events[1];
      expect(messageLine.type).toBe("message");
      expect(messageLine.message?.role).toBe("assistant");
      const content = messageLine.message?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(Array.isArray(content) ? content[0]?.type : undefined).toBe("text");
      expect(Array.isArray(content) ? content[0]?.text : undefined).toBe(
        "Hello from delivery mirror!",
      );
    }
  });

  it("appends exact assistant messages to an explicit SQLite session database path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-relocated-"));
    const databasePath = path.join(root, "relocated", "openclaw-agent.sqlite");
    const relocatedSessionId = "relocated-session-id";
    try {
      upsertSessionEntry({
        agentId: "ops",
        path: databasePath,
        sessionKey: "main",
        entry: {
          sessionId: relocatedSessionId,
          updatedAt: 1,
        },
      });

      const result = await appendExactAssistantMessageToSessionTranscript({
        agentId: "ops",
        sessionKey: "main",
        storePath: databasePath,
        updateMode: "none",
        message: createExactAssistantMessage({ text: "Relocated transcript append" }),
      });

      expect(result.ok).toBe(true);
      const events = loadSqliteSessionTranscriptEvents({
        agentId: "ops",
        path: databasePath,
        sessionId: relocatedSessionId,
      }).map((entry) => entry.event as { message?: { role?: string; content?: unknown } });
      expect(events).toHaveLength(2);
      expect(events[1]?.message?.role).toBe("assistant");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
    });

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [event] = emitSpy.mock.calls[0] as [SessionTranscriptUpdate];
    const message = event.message as
      | {
          role?: string;
          provider?: string;
          model?: string;
          content?: unknown;
        }
      | undefined;
    expect(event.agentId).toBe("main");
    expect(event.sessionId).toBe(sessionId);
    expect(event.sessionKey).toBe(sessionKey);
    expect(event.messageId).toBeTypeOf("string");
    expect(message?.role).toBe("assistant");
    expect(message?.provider).toBe("openclaw");
    expect(message?.model).toBe("delivery-mirror");
    expect(message?.content).toEqual([{ type: "text", text: "Hello from delivery mirror!" }]);
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    await writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
    });

    const events = readEvents();
    expect(events.length).toBe(2);
    const messageLine = events[1];
    expect(messageLine?.message?.idempotencyKey).toBe("mirror:test-source-message");
    const content = messageLine?.message?.content;
    expect(Array.isArray(content) ? content[0]?.text : undefined).toBe(
      "Hello from delivery mirror!",
    );
  });

  it("uses scoped SQLite transcript events for delivery mirror idempotency", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await writeTranscriptStore();
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId,
      event: {
        type: "message",
        id: "sqlite-mirror-message",
        message: {
          role: "assistant",
          idempotencyKey: "mirror:sqlite-source-message",
          content: [{ type: "text", text: "Hello from SQLite mirror!" }],
        },
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Hello from SQLite mirror!",
      idempotencyKey: "mirror:sqlite-source-message",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "sqlite-mirror-message",
    });
    expect(readEvents()).toHaveLength(1);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not append a duplicate delivery mirror when the latest assistant message already matches", async () => {
    await writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({ text: "Hello from Codex!" }),
    });

    expect(exactResult.ok).toBe(true);

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from Codex!",
    });

    expect(mirrorResult.ok).toBe(true);
    if (exactResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      const events = readEvents();
      expect(events.length).toBe(2);

      const messageLine = events[1];
      expect(messageLine?.message?.provider).toBe("codex");
      expect(messageLine?.message?.model).toBe("gpt-5.4");
      const content = messageLine?.message?.content;
      expect(Array.isArray(content) ? content[0]?.text : undefined).toBe("Hello from Codex!");
    }
  });

  it("uses scoped SQLite transcript events for delivery mirror latest-match dedupe", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await writeTranscriptStore();
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId,
      event: {
        type: "message",
        id: "sqlite-latest-assistant",
        message: createExactAssistantMessage({ text: "Already delivered" }),
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Already delivered",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "sqlite-latest-assistant",
    });
    expect(readEvents()).toHaveLength(1);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("skips transcript-only OpenClaw assistant entries when reading latest assistant text", async () => {
    await writeTranscriptStore();

    const finalResult = await appendExactAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      message: createExactAssistantMessage({ text: "Complete final answer" }),
    });
    expect(finalResult.ok).toBe(true);
    if (!finalResult.ok) {
      return;
    }

    await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Earlier retained preview",
    });
    await appendExactAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      message: createExactAssistantMessage({
        text: "Injected transcript text",
        provider: "openclaw",
        model: "gateway-injected",
      }),
    });

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript({
      agentId: "main",
      sessionId,
    });
    expect(latestAssistantText?.id).toBe(finalResult.messageId);
    expect(latestAssistantText?.text).toBe("Complete final answer");
  });

  it("does not report transcript-only OpenClaw assistant entries as latest assistant text", async () => {
    await writeTranscriptStore();

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Only delivery mirror",
    });
    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript({
      agentId: "main",
      sessionId,
    });
    expect(latestAssistantText).toBeUndefined();
  });

  it("keeps transcript-only OpenClaw assistant entries available to the tail reader", async () => {
    await writeTranscriptStore();

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Tail delivery mirror",
    });
    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }

    const tailAssistantText = await readTailAssistantTextFromSessionTranscript({
      agentId: "main",
      sessionId,
    });
    expect(tailAssistantText?.id).toBe(mirrorResult.messageId);
    expect(tailAssistantText?.text).toBe("Tail delivery mirror");
  });

  it("scans past trailing non-assistant entries (e.g. openclaw.cache-ttl) to find the latest assistant text", async () => {
    // Regression for openclaw/openclaw#83427: the cache-ttl custom entry was
    // emitted after the canonical assistant turn, and the tail reader returned
    // undefined on the first non-assistant line, so the gap-fill check in
    // persistTextTurnTranscript wrote a duplicate `api: "cli"` assistant
    // message — poisoning the model's own context with verbatim duplicates.
    await writeTranscriptStore();

    const assistantResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({
        text: "Canonical answer",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
      }),
    });
    expect(assistantResult.ok).toBe(true);
    if (!assistantResult.ok) {
      return;
    }

    const cacheTtlEntry = `${JSON.stringify({
      type: "custom",
      customType: "openclaw.cache-ttl",
      timestamp: new Date().toISOString(),
      data: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    })}\n`;
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId,
      event: JSON.parse(cacheTtlEntry) as Record<string, unknown>,
    });

    const tailAssistantText = await readTailAssistantTextFromSessionTranscript({
      agentId: "main",
      sessionId,
    });
    expect(tailAssistantText?.id).toBe(assistantResult.messageId);
    expect(tailAssistantText?.text).toBe("Canonical answer");
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    await writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const events = readEvents();
      expect(events.length).toBe(4);

      const messageLine = events[3];
      expect(messageLine?.message?.provider).toBe("openclaw");
      expect(messageLine?.message?.model).toBe("delivery-mirror");
      const content = messageLine?.message?.content;
      expect(Array.isArray(content) ? content[0]?.text : undefined).toBe("Repeated answer");
    }
  });

  it("keeps delivery mirrors in transcripts while repair preserves real tool results", async () => {
    await writeTranscriptStore();
    const toolCallId = "call_maniple_list";

    const toolCallResult = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "maniple__list_workers",
            arguments: {},
          },
        ],
        stopReason: "toolUse",
      },
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Maniple List Workers",
    });

    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }
    expect(mirrorResult.messageId).not.toBe(toolCallResult.messageId);
    const eventsAfterMirror = readEvents();
    expect(eventsAfterMirror).toHaveLength(3);
    expect(eventsAfterMirror[2]?.message?.model).toBe("delivery-mirror");

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "maniple__list_workers",
        content: [{ type: "text", text: "workers listed" }],
        isError: false,
      },
    });

    const messages = readEvents()
      .map((event) => event as { message?: TranscriptRepairMessage })
      .flatMap((entry) => (entry.message ? [entry.message] : []));
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
    ]);
    const repair = repairToolUseResultPairing(messages, {
      missingToolResultText: "aborted",
    });

    expect(repair.added).toHaveLength(0);
    expect(repair.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect((repair.messages[2] as { model?: string }).model).toBe("delivery-mirror");
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:imessage:direct:+15551234567";
    const store: Record<string, SessionEntry> = {
      [storeKey]: {
        sessionId: "test-session-normalized",
        chatType: "direct",
        channel: "imessage",
        updatedAt: 1,
      },
    };
    await writeTranscriptStore(store);

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:iMessage:direct:+15551234567",
      text: "Hello normalized!",
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store: Record<string, SessionEntry> = {
      [storeKey]: {
        sessionId: "test-slack-session",
        chatType: "direct",
        channel: "slack",
        updatedAt: 1,
      },
    };
    await writeTranscriptStore(store);

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
    });

    expect(result.ok).toBe(true);
  });

  it("uses SQLite transcript rows when checking mirror idempotency", async () => {
    await writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
    });

    expect(result.ok).toBe(true);
    expect(readEvents()).toHaveLength(2);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    await writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({
        content: [
          {
            type: "text",
            text: "internal reasoning",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          },
        ],
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const messageLine = readEvents()[1];
      expect(messageLine?.message?.content).toEqual([
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ]);
    }
  });

  it("can emit signal-only transcript refresh events for exact assistant appends", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      updateMode: "signal-only",
      message: createExactAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey,
          agentId: "main",
          sessionId: "test-session-id",
        }),
      );
    }
    emitSpy.mockRestore();
  });

  it("serializes concurrent parent-linked transcript appends", async () => {
    const targetSessionId = "concurrent-tree-session";
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: { type: "session", id: targetSessionId },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: {
        type: "message",
        id: "root-message",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "root" },
      },
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendSessionTranscriptMessage({
          agentId: "main",
          sessionId: targetSessionId,
          message: { role: "assistant", content: `reply ${index}` },
        }),
      ),
    );

    const records = readEvents(targetSessionId).filter((record) => record.type === "message");

    expect(records).toHaveLength(9);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]?.parentId).toBe(records[index - 1]?.id);
    }
  });

  it("redacts structured message content before SQLite transcript persistence", async () => {
    const targetSessionId = "redacted-transcript-session";
    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: targetSessionId,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "standalone app password abcd-efgh-ijkl-mnop",
          },
          {
            type: "text",
            text: "tokens ya29.fake-access-token-with-enough-length",
          },
        ],
        toolInput: {
          apiKey: "AIzaSyD-very-real-looking-google-api-key-123",
          refresh: "1//0fake-refresh-token-with-enough-length",
        },
      },
    });

    const raw = JSON.stringify(readEvents(targetSessionId));
    expect(raw).not.toContain("ya29.fake-access-token");
    expect(raw).not.toContain("abcd-efgh-ijkl-mnop");
    expect(raw).not.toContain("AIzaSyD-very-real-looking");
    expect(raw).not.toContain("1//0fake-refresh-token");
  });

  it("appends to existing SQLite transcript chains", async () => {
    const targetSessionId = "small-linear-session";
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: { type: "session", version: 1, id: targetSessionId },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: {
        type: "message",
        id: "legacy-first",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "legacy first" },
      },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: {
        type: "message",
        id: "legacy-second",
        parentId: "legacy-first",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "legacy second" },
      },
    });

    const appended = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: targetSessionId,
      message: { role: "assistant", content: "new reply" },
    });

    const records = readEvents(targetSessionId);
    const messages = records.filter((record) => record.type === "message");

    expect(messages.map((record) => record.message?.content)).toEqual([
      "legacy first",
      "legacy second",
      "new reply",
    ]);
    expect(messages[0]?.id).toBe("legacy-first");
    expect(messages[0]?.parentId).toBeNull();
    expect(messages[1]?.id).toBe("legacy-second");
    expect(messages[1]?.parentId).toBe("legacy-first");
    expect(messages[2]?.id).toBe(appended.messageId);
    expect(messages[2]?.parentId).toBe("legacy-second");
  });

  it("appends scoped SQLite transcript entries without runtime legacy import", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-import-session",
      event: { type: "session", version: 1, id: "sqlite-import-session" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-import-session",
      event: {
        type: "message",
        id: "legacy-first",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "legacy first" },
      },
      now: () => 101,
    });

    const appended = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: "sqlite-import-session",
      message: { role: "assistant", content: "new reply" },
      now: 123,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "sqlite-import-session",
    }).map((entry) => entry.event as { type?: string; id?: string; parentId?: string | null });

    expect(events.map((event) => event.type)).toEqual(["session", "message", "message"]);
    expect(events[1]).toMatchObject({ id: "legacy-first", parentId: null });
    expect(events[2]).toMatchObject({ id: appended.messageId, parentId: "legacy-first" });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("mirrors a newly created scoped transcript header into SQLite", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const appended = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: "sqlite-new-session",
      cwd: "/workspace",
      message: { role: "assistant", content: "new reply" },
      now: 456,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "sqlite-new-session",
    }).map((entry) => entry.event as { type?: string; id?: string; message?: unknown });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "session",
      id: "sqlite-new-session",
      cwd: "/workspace",
    });
    expect(events[1]).toMatchObject({
      type: "message",
      id: appended.messageId,
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("appends scoped SQLite transcript entries without registering fake file paths", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionId = "sqlite-scope-session";

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      cwd: "/workspace",
      message: { role: "assistant", content: "scope reply" },
      now: 789,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId,
    }).map((entry) => entry.event as { type?: string; message?: unknown });
    expect(events.map((event) => event.type)).toEqual(["session", "message"]);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("reads latest and tail assistant text from scoped SQLite transcripts", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-read-session",
      event: { type: "session", id: "sqlite-read-session" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-read-session",
      event: {
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          timestamp: 200,
          content: [{ type: "text", text: "first reply" }],
        },
      },
      now: () => 200,
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-read-session",
      event: {
        type: "message",
        id: "assistant-2",
        message: {
          role: "assistant",
          timestamp: 300,
          content: [{ type: "text", text: "latest reply" }],
        },
      },
      now: () => 300,
    });

    await expect(
      readLatestAssistantTextFromSessionTranscript({
        agentId: "main",
        sessionId: "sqlite-read-session",
      }),
    ).resolves.toEqual({
      id: "assistant-2",
      text: "latest reply",
      timestamp: 300,
    });
    await expect(
      readTailAssistantTextFromSessionTranscript({
        agentId: "main",
        sessionId: "sqlite-read-session",
      }),
    ).resolves.toEqual({
      id: "assistant-2",
      text: "latest reply",
      timestamp: 300,
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
