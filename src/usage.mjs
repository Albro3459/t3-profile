import { makeEnvironment } from "./providers.mjs";
import { isSamePath, pathsFor, validateManagedProfileChain } from "./paths.mjs";
import { inspectCodexUsage } from "./codex-usage.mjs";
import { readClaudeKeychainItem, resolveLoginKeychain } from "./keychain.mjs";
import { CLAUDE_RECOVERY_KEYCHAIN_LOCKED, createClaudeUsageAdapter } from "./usage-claude.mjs";

export const USAGE_WINDOW_IDS = Object.freeze(["five_hour", "week"]);
export const usageAdapters = {
  claude: createClaudeUsageAdapter(),
  codex: async ({ canonicalProfileHome, environment }) => {
    const result = await inspectCodexUsage({
      profileHome: canonicalProfileHome,
      environment,
    });
    const hasAvailableWindow = result?.windows?.some((window) => window?.status === "available");
    return hasAvailableWindow
      ? { status: "available", windows: result.windows }
      : { status: "unavailable", windows: [] };
  },
};

// Adapters return { status, windows }, with reset values in epoch milliseconds;
// inactive windows have a null reset and have not started yet.
// A provider failure uses status "unavailable" and no windows; partial results
// can include labeled windows with status "unavailable".
export function registerUsageAdapter(provider, adapter) {
  usageAdapters[provider] = adapter;
}

export function displayTimezone() {
  let timezone;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timezone !== "string" || timezone.length === 0) throw new Error("missing timezone");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

function validPercentage(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object" || !USAGE_WINDOW_IDS.includes(window.id)) return null;
  if (window.status === "unavailable") return { id: window.id, status: "unavailable" };
  if (window.status === "inactive") {
    return window.percent === 0 && window.resetsAt === null
      ? { id: window.id, status: "inactive", percent: 0, resetsAt: null }
      : { id: window.id, status: "unavailable" };
  }
  if (window.status !== "available") return { id: window.id, status: "unavailable" };
  const date = validDate(window.resetsAt);
  if (!validPercentage(window.percent) || !date) return { id: window.id, status: "unavailable" };
  return { id: window.id, status: "available", percent: Math.round(window.percent), resetsAt: date };
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { status: "unavailable", windows: [] };
  }
  if (result.status !== undefined && result.status !== "available" && result.status !== "unavailable") {
    return { status: "unavailable", windows: [] };
  }
  const windows = Array.isArray(result.windows)
    ? result.windows.map(normalizeWindow).filter(Boolean)
    : [];
  const ids = new Set();
  for (const window of windows) {
    if (ids.has(window.id)) return { status: "unavailable", windows: [] };
    ids.add(window.id);
  }
  if (result.status === "unavailable" && windows.length === 0) {
    return result.recovery?.kind === CLAUDE_RECOVERY_KEYCHAIN_LOCKED
      ? { status: "unavailable", windows: [], recovery: { kind: CLAUDE_RECOVERY_KEYCHAIN_LOCKED } }
      : { status: "unavailable", windows: [] };
  }
  return { status: "available", windows };
}

async function collectProfileUsage(profile, managedRoot, timezone, keychainPath = null) {
  try {
    const expected = pathsFor({
      provider: profile.provider,
      name: profile.name,
      sourceHome: profile.sourceHome,
      managedRoot,
    });
    if (!isSamePath(profile.profileHome, expected.profileHome) || profile.instanceId !== expected.instanceId) {
      return { status: "unavailable", windows: [] };
    }
    const chain = await validateManagedProfileChain({
      managedRoot,
      provider: profile.provider,
      name: profile.name,
      requireHome: true,
    });
    const canonicalProfileHome = chain.profileHome.canonical;
    const adapter = usageAdapters[profile.provider];
    if (typeof adapter !== "function") return { status: "unavailable", windows: [] };
    const result = await adapter({
      profile,
      canonicalProfileHome,
      environment: makeEnvironment(profile.provider, canonicalProfileHome),
      displayTimezone: timezone,
      keychainPath,
    });
    return normalizeResult(result);
  } catch {
    return { status: "unavailable", windows: [] };
  }
}

async function collectUsageResults(profiles, managedRoot, timezone, keychainPath = null) {
  const results = new Array(profiles.length);
  let next = 0;
  const workerCount = Math.min(4, profiles.length);
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= profiles.length) return;
      results[index] = await collectProfileUsage(profiles[index], managedRoot, timezone, keychainPath);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function collectUsage(profiles, managedRoot, timezone = displayTimezone(), keychainPath = null) {
  return collectUsageResults(profiles, managedRoot, timezone, keychainPath);
}

export async function collectUsageWithDiagnostics(profiles, managedRoot, timezone = displayTimezone()) {
  if (process.platform !== "darwin" || !profiles.some((profile) => profile.provider === "claude")) {
    return { results: await collectUsageResults(profiles, managedRoot, timezone), keychainPath: null, lockedProfiles: [] };
  }

  const keychainPath = await resolveLoginKeychain();
  const results = await collectUsageResults(profiles, managedRoot, timezone, keychainPath);
  const lockedProfiles = results
    .map((result, index) => result?.recovery?.kind === CLAUDE_RECOVERY_KEYCHAIN_LOCKED ? index : null)
    .filter((index) => index !== null);
  return { results, keychainPath, lockedProfiles };
}

export async function countLockedUsageProfiles(profiles, managedRoot, keychainPath) {
  if (process.platform !== "darwin" || typeof keychainPath !== "string") return 0;
  let count = 0;
  for (const profile of profiles) {
    if (profile.usage?.recovery?.kind !== CLAUDE_RECOVERY_KEYCHAIN_LOCKED || profile.provider !== "claude") continue;
    try {
      const expected = pathsFor({
        provider: profile.provider,
        name: profile.name,
        sourceHome: profile.sourceHome,
        managedRoot,
      });
      if (!isSamePath(profile.profileHome, expected.profileHome)) continue;
      const chain = await validateManagedProfileChain({
        managedRoot,
        provider: profile.provider,
        name: profile.name,
        requireHome: true,
      });
      const item = await readClaudeKeychainItem({
        profileHome: chain.profileHome.canonical,
        keychainPath,
        environment: makeEnvironment(profile.provider, chain.profileHome.canonical),
      });
      if (item.state === "locked") count += 1;
    } catch {
      // A failed recheck leaves the first-pass result unchanged and suppresses recovery.
    }
  }
  return count;
}

export function formatResetTime(value, timezone) {
  const date = validDate(value);
  if (!date) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.month}/${values.day} at ${values.hour}:${values.minute} ${values.dayPeriod}`;
  } catch {
    return null;
  }
}
