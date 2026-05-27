import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { withTempDir } from "../../../test-helpers/temp-dir.js";
import { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

const FAST_LOCK_OPTIONS = {
  sessionKey: "agent:test:session",
  sessionId: "test-session",
  sessionFile: "test-session.jsonl",
  timeoutMs: 20,
  staleMs: 1_000,
  maxHoldMs: 1_000,
} as const;

describe("SQLite embedded attempt session lock", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("serializes controllers for the same session key", async () => {
    await withTempDir({ prefix: "openclaw-attempt-session-lock-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const first = await createEmbeddedAttemptSessionLockController({
        lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
      });
      try {
        await expect(
          createEmbeddedAttemptSessionLockController({
            lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
          }),
        ).rejects.toThrow("Timed out acquiring SQLite state lock");
      } finally {
        await first.dispose();
      }
    });
  });

  it("temporarily releases the eager lock for prompt submission", async () => {
    await withTempDir({ prefix: "openclaw-attempt-session-prompt-lock-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const first = await createEmbeddedAttemptSessionLockController({
        lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
      });
      await first.releaseForPrompt();

      const second = await createEmbeddedAttemptSessionLockController({
        lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
      });
      await second.dispose();
      await first.reacquireAfterPrompt();
      await first.dispose();
    });
  });

  it("releases the eager lock for abort cleanup", async () => {
    await withTempDir({ prefix: "openclaw-attempt-session-abort-lock-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const first = await createEmbeddedAttemptSessionLockController({
        lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
      });
      await first.releaseHeldLockForAbort();

      const second = await createEmbeddedAttemptSessionLockController({
        lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
      });
      await second.dispose();
      await first.dispose();
    });
  });

  it("does not reacquire the same SQLite lease for nested owned writes", async () => {
    await withTempDir({ prefix: "openclaw-attempt-session-owned-write-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const controller = await createEmbeddedAttemptSessionLockController({
        lockOptions: { ...FAST_LOCK_OPTIONS, path: dbPath },
      });
      let ran = false;

      await controller.withSessionWriteLock(
        () => {
          ran = true;
        },
        { publishOwnedWrite: true },
      );

      expect(ran).toBe(true);
      await controller.dispose();
    });
  });
});
