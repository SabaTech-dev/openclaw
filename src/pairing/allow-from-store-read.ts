import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { normalizeUniqueTrimmedStringList } from "../shared/string-normalization.js";
import {
  dedupePreserveOrder,
  resolveAllowFromAccountId,
  safeAccountKey,
  safeChannelKey,
} from "./pairing-store-keys.js";
import { readChannelAllowFromStoreSync } from "./pairing-store.js";
import type { PairingChannel } from "./pairing-store.types.js";

function legacyPairingCredentialsDir(env: NodeJS.ProcessEnv): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

function resolveLegacyAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const accountKey = accountId ? safeAccountKey(accountId) : "";
  return path.join(
    legacyPairingCredentialsDir(env),
    accountKey ? `${base}-${accountKey}-allowFrom.json` : `${base}-allowFrom.json`,
  );
}

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  return resolveLegacyAllowFromPath(channel, env, accountId);
}

function readLegacyAllowFromEntries(filePath: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { allowFrom?: unknown };
    return normalizeUniqueTrimmedStringList(parsed.allowFrom);
  } catch {
    return [];
  }
}

export function readChannelAllowFromStoreEntriesSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  const sqliteEntries = readChannelAllowFromStoreSync(channel, env, resolvedAccountId);
  const scopedLegacyEntries = readLegacyAllowFromEntries(
    resolveLegacyAllowFromPath(channel, env, resolvedAccountId),
  );
  const defaultLegacyEntries =
    resolvedAccountId === DEFAULT_ACCOUNT_ID
      ? readLegacyAllowFromEntries(resolveLegacyAllowFromPath(channel, env))
      : [];
  return dedupePreserveOrder([...sqliteEntries, ...scopedLegacyEntries, ...defaultLegacyEntries]);
}

export function clearAllowFromStoreReadCacheForTest(): void {
  // SQLite-backed and legacy fallback reads do not keep a process-local cache.
}
