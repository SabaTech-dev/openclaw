import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkShellCompletionStatus } from "../commands/doctor-completion.js";
import { installCompletion } from "./completion-runtime.js";

describe("completion runtime", () => {
  const originalHome = process.env.HOME;
  const originalShell = process.env.SHELL;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  let homeDir = "";
  let stateDir = "";

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    process.env.HOME = homeDir;
    process.env.SHELL = "/bin/zsh";
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }

    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("installs dynamic profile sourcing without writing completion cache files", async () => {
    const cachePath = path.join(stateDir, "completions", "openclaw.zsh");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "#compdef openclaw\n", "utf-8");

    await installCompletion("zsh", true, "openclaw");

    const profile = await fs.readFile(path.join(homeDir, ".zshrc"), "utf-8");
    expect(profile).toContain(`[ -f "${cachePath}" ] && source "${cachePath}"`);
  });

  it("rewrites a retired state-dir completion cache profile line", async () => {
    const retiredCachePath = path.join(stateDir, "completions", "openclaw.zsh");
    await fs.mkdir(path.dirname(retiredCachePath), { recursive: true });
    await fs.writeFile(retiredCachePath, "#compdef openclaw\n", "utf-8");
    await fs.writeFile(path.join(homeDir, ".zshrc"), `source ${retiredCachePath}\n`, "utf-8");

    const status = await checkShellCompletionStatus("openclaw");
    expect(status).toMatchObject({
      cacheExists: true,
      cachePath: retiredCachePath,
      profileInstalled: true,
      shell: "zsh",
      usesSlowPattern: false,
    });

    await installCompletion("zsh", true, "openclaw");

    const profile = await fs.readFile(path.join(homeDir, ".zshrc"), "utf-8");
    expect(profile).toContain(`[ -f "${retiredCachePath}" ] && source "${retiredCachePath}"`);
  });

  it("rejects install when the completion cache is missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));

    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
        "Completion cache not found",
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
