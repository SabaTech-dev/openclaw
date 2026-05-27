import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSessionManagerForRun } from "./session-manager-init.js";

const tempPaths: string[] = [];

async function makeTempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-init-"));
  tempPaths.push(dir);
  return path.join(dir, "session.jsonl");
}

describe("prepareSessionManagerForRun", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("rewrites pre-created no-assistant session headers to the runtime cwd", async () => {
    const sessionFile = await makeTempFile();
    await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf-8");
    const sessionManager = {
      sessionId: "old-session",
      cwd: "/srv/openclaw/main",
      flushed: true,
      fileEntries: [
        {
          type: "session",
          id: "old-session",
          cwd: "/srv/openclaw/main",
        },
        {
          type: "message",
          message: { role: "user" },
        },
      ],
      byId: new Map([["old", {}]]),
      labelsById: new Map([["old", {}]]),
      leafId: "old",
    };

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "new-session",
      cwd: "/tmp/task-repo",
    });

    expect(sessionManager.sessionId).toBe("new-session");
    expect(sessionManager.cwd).toBe("/tmp/task-repo");
    expect(sessionManager.fileEntries).toEqual([
      {
        type: "session",
        id: "new-session",
        cwd: "/tmp/task-repo",
      },
    ]);
    expect(sessionManager.byId.size).toBe(0);
    expect(sessionManager.labelsById.size).toBe(0);
    expect(sessionManager.leafId).toBeNull();
    expect(sessionManager.flushed).toBe(false);
    expect(await fs.readFile(sessionFile, "utf-8")).toBe("");
  });
});
