import fs from "node:fs/promises";
import path from "node:path";

import { readClaudeKeychainItem } from "./keychain.mjs";
import { inspectCommand } from "./process.mjs";
import { providerBinary } from "./providers.mjs";
import { VERSION } from "./version.mjs";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_BETA_HEADER = "oauth-2025-04-20";
export const CLAUDE_USAGE_OUTPUT_LIMIT_BYTES = 65_536;
export const CLAUDE_USAGE_TIMEOUT_MS = 5_000;
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;
export const CLAUDE_USAGE_REFRESH_ARGUMENTS = Object.freeze([
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--no-session-persistence",
]);

export const CLAUDE_RECOVERY_KEYCHAIN_LOCKED = "keychain-locked";

function unavailable(recovery) {
  const result = { status: "unavailable", windows: [] };
  if (recovery === CLAUDE_RECOVERY_KEYCHAIN_LOCKED) {
    result.recovery = { kind: CLAUDE_RECOVERY_KEYCHAIN_LOCKED };
  }
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validReset(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return Number.isFinite(new Date(value).getTime());
}

function parseWindow(id, value) {
  if (!isObject(value)) return { id, status: "unavailable" };
  if (typeof value.utilization !== "number" ||
      !Number.isFinite(value.utilization) ||
      value.utilization < 0 ||
      value.utilization > 100) {
    return { id, status: "unavailable" };
  }
  if (value.resets_at === null || value.resets_at === undefined) {
    return value.utilization === 0
      ? { id, status: "inactive", percent: 0, resetsAt: null }
      : { id, status: "unavailable" };
  }
  if (!validReset(value.resets_at)) return { id, status: "unavailable" };
  return {
    id,
    status: "available",
    percent: value.utilization,
    resetsAt: value.resets_at,
  };
}

/**
 * Normalize the typed Anthropic OAuth usage response. The endpoint is the
 * source used by Claude Code's usage UI; it is not the human-formatted result
 * returned by `claude -p "/usage"`.
 */
export function parseClaudeUsageResponse(response) {
  if (!isObject(response)) return unavailable();
  const hasWindow = Object.hasOwn(response, "five_hour") || Object.hasOwn(response, "seven_day");
  if (!hasWindow) return unavailable();
  return {
    status: "available",
    windows: [
      parseWindow("five_hour", response.five_hour),
      parseWindow("week", response.seven_day),
    ],
  };
}

function parseAccessToken(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > CLAUDE_USAGE_OUTPUT_LIMIT_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    const token = value?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function readFileAccessToken(profileHome) {
  const credentialsPath = path.join(profileHome, ".credentials.json");
  let stats;
  try {
    stats = await fs.lstat(credentialsPath);
  } catch {
    return { token: null, present: false };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return { token: null, present: false };
  let raw;
  try {
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    return { token: null, present: true };
  }
  return { token: parseAccessToken(raw), present: true };
}

async function readAccessToken(profileHome, {
  environment = process.env,
  inspect = inspectCommand,
  platform = process.platform,
  keychainPath = null,
} = {}) {
  let keychainState = "unsupported";
  if (platform === "darwin") {
    const keychain = await readClaudeKeychainItem({
      profileHome,
      keychainPath,
      environment,
      inspect,
      platform,
    });
    keychainState = keychain.state;
    const keychainToken = parseAccessToken(keychain.raw);
    if (keychainToken) return { token: keychainToken, source: "keychain", keychainState };
  }
  const file = await readFileAccessToken(profileHome);
  return {
    token: file.token,
    source: file.token ? "file" : null,
    filePresent: file.present,
    keychainState,
  };
}

async function fetchUsageResponse(accessToken, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return { kind: "unavailable" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_USAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_USAGE_BETA_HEADER,
        "User-Agent": `t3-profile/${VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response?.ok) {
      return { kind: response?.status === 401 ? "unauthorized" : "unavailable" };
    }
    if (typeof response.text !== "function") return { kind: "unavailable" };
    const raw = await response.text();
    if (Buffer.byteLength(raw) > CLAUDE_USAGE_OUTPUT_LIMIT_BYTES) return { kind: "unavailable" };
    return { kind: "available", response: JSON.parse(raw) };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshAccessToken(environment, inspect) {
  try {
    const result = await inspect(
      providerBinary("claude"),
      CLAUDE_USAGE_REFRESH_ARGUMENTS,
      environment,
      CLAUDE_USAGE_TIMEOUT_MS,
    );
    if (!result?.found || result.code !== 0 || result.timedOut) return false;
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") return false;
    return Buffer.byteLength(result.stdout) <= CLAUDE_USAGE_OUTPUT_LIMIT_BYTES &&
      Buffer.byteLength(result.stderr) <= CLAUDE_USAGE_OUTPUT_LIMIT_BYTES;
  } catch {
    return false;
  }
}

export async function claudeUsageAdapter({
  canonicalProfileHome,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  inspect = inspectCommand,
  platform = process.platform,
  keychainPath = null,
}) {
  try {
    const credentials = await readAccessToken(canonicalProfileHome, { environment, inspect, platform, keychainPath });
    if (!credentials.token) {
      return unavailable(keychainPath && credentials.keychainState === "locked"
        ? CLAUDE_RECOVERY_KEYCHAIN_LOCKED
        : undefined);
    }
    const firstAttempt = await fetchUsageResponse(credentials.token, fetchImpl);
    if (firstAttempt.kind === "available") return parseClaudeUsageResponse(firstAttempt.response);
    if (firstAttempt.kind !== "unauthorized") return unavailable();

    // Claude owns refresh-token rotation and storage locking; let it refresh
    // the selected profile, then retry the typed endpoint with the new token.
    if (!(await refreshAccessToken(environment, inspect))) {
      const keychain = await readClaudeKeychainItem({
        profileHome: canonicalProfileHome,
        keychainPath,
        environment,
        inspect,
        platform,
      });
      return unavailable(credentials.source === "file" && keychainPath && keychain.state === "locked"
        ? CLAUDE_RECOVERY_KEYCHAIN_LOCKED
        : undefined);
    }
    const refreshedCredentials = await readAccessToken(canonicalProfileHome, { environment, inspect, platform, keychainPath });
    const refreshedToken = refreshedCredentials.token;
    if (!refreshedToken || refreshedToken === credentials.token) {
      const keychain = await readClaudeKeychainItem({
        profileHome: canonicalProfileHome,
        keychainPath,
        environment,
        inspect,
        platform,
      });
      return unavailable(credentials.source === "file" && keychainPath && keychain.state === "locked"
        ? CLAUDE_RECOVERY_KEYCHAIN_LOCKED
        : undefined);
    }
    const secondAttempt = await fetchUsageResponse(refreshedToken, fetchImpl);
    return secondAttempt.kind === "available"
      ? parseClaudeUsageResponse(secondAttempt.response)
      : unavailable();
  } catch {
    return unavailable();
  }
}

export function createClaudeUsageAdapter() {
  return ({ canonicalProfileHome, environment, fetchImpl, inspect, platform, keychainPath }) => claudeUsageAdapter({
    canonicalProfileHome,
    environment,
    fetchImpl,
    inspect,
    platform,
    keychainPath,
  });
}
