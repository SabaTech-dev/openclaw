import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/plugins/assertions.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeInstalledPluginIndex(stateDir: string, installRecords: unknown) {
  const sqlite = requireNodeSqlite();
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        host_contract_version TEXT NOT NULL,
        compat_registry_version TEXT NOT NULL,
        migration_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        generated_at_ms INTEGER NOT NULL,
        refresh_reason TEXT,
        install_records_json TEXT NOT NULL,
        plugins_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        warning TEXT,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO installed_plugin_index (
        index_key,
        version,
        host_contract_version,
        compat_registry_version,
        migration_version,
        policy_hash,
        generated_at_ms,
        refresh_reason,
        install_records_json,
        plugins_json,
        diagnostics_json,
        warning,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "current",
      1,
      "test",
      "test",
      1,
      "test",
      1,
      null,
      JSON.stringify(installRecords),
      "[]",
      "[]",
      null,
      1,
    );
  } finally {
    db.close();
  }
}

describe("plugins Docker assertions", () => {
  it("keeps sweep artifact paths aligned with the assertion scratch root", () => {
    const scripts = [
      "scripts/e2e/lib/plugins/sweep.sh",
      "scripts/e2e/lib/plugins/marketplace.sh",
      "scripts/e2e/lib/plugins/clawhub.sh",
    ];

    for (const scriptPath of scripts) {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain("OPENCLAW_PLUGINS_TMP_DIR");
      expect(script).not.toMatch(
        /\/tmp\/(?:plugins|marketplace|demo-plugin|is-number|openclaw-plugin|openclaw-clawhub)/,
      );
    }
  });

  it("uses the configured scratch root and resolves Windows home-relative install paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const installPath = path.join(home, "managed-plugin");
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins2.json"), {
        plugins: [{ id: "demo-plugin-tgz", status: "loaded" }],
      });
      writeJson(path.join(scratchRoot, "plugins2-inspect.json"), {
        gatewayMethods: ["demo.tgz"],
      });
      writeInstalledPluginIndex(path.join(home, ".openclaw"), {
        "demo-plugin-tgz": {
          source: "archive",
          installPath: String.raw`~\managed-plugin`,
        },
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("compares local plugin source paths by canonical path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const sourceParent = path.join(root, "source");
    const sourcePath = `${sourceParent}//plugin`;
    const normalizedSourcePath = path.join(sourceParent, "plugin");
    const installPath = path.join(home, ".openclaw", "extensions", "demo-plugin-dir");
    mkdirSync(sourcePath, { recursive: true });
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins3.json"), {
        plugins: [{ id: "demo-plugin-dir", status: "loaded" }],
      });
      writeJson(path.join(scratchRoot, "plugins3-inspect.json"), {
        gatewayMethods: ["demo.dir"],
      });
      writeInstalledPluginIndex(path.join(home, ".openclaw"), {
        "demo-plugin-dir": {
          source: "path",
          sourcePath: normalizedSourcePath,
          installPath,
        },
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-dir", sourcePath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("still requires archive managed install directories to be removed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const installPath = path.join(home, ".openclaw", "extensions", "demo-plugin-tgz");
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins2-uninstalled.json"), { plugins: [] });
      writeFileSync(path.join(scratchRoot, "plugins2-install-path.txt"), installPath, "utf8");
      writeInstalledPluginIndex(path.join(home, ".openclaw"), {});

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz-removed"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("managed install path still exists after uninstall");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
