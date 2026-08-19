import { makeEnvironment } from "./providers.mjs";
import { isSamePath, pathsFor, validateManagedProfileChain } from "./paths.mjs";
import { inspectCodexUsage } from "./codex-usage.mjs";
import { createClaudeUsageAdapter } from "./usage-claude.mjs";

export const USAGE_WINDOW_IDS = Object.freeze(["five_hour", "week"]);
export const usageAdapters = {
  claude: createClaudeUsageAdapter(),
  codex: async ({ canonicalProfileHome }) => {
    const result = await inspectCodexUsage({ profileHome: canonicalProfileHome });
    const hasAvailableWindow = result?.windows?.some((window) => window?.status === "available");
    return hasAvailableWindow
      ? { status: "available", windows: result.windows }
      : { status: "unavailable", windows: [] };
  },
};

// Adapters return { status, windows }, with reset values in epoch milliseconds.
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
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object" || !USAGE_WINDOW_IDS.includes(window.id)) return null;
  if (window.status === "unavailable") return { id: window.id, status: "unavailable" };
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
  if (result.status === "unavailable" && windows.length === 0) return { status: "unavailable", windows: [] };
  return { status: "available", windows };
}

async function collectProfileUsage(profile, managedRoot, timezone) {
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
    });
    return normalizeResult(result);
  } catch {
    return { status: "unavailable", windows: [] };
  }
}

export async function collectUsage(profiles, managedRoot, timezone = displayTimezone()) {
  const results = new Array(profiles.length);
  let next = 0;
  const workerCount = Math.min(4, profiles.length);
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= profiles.length) return;
      results[index] = await collectProfileUsage(profiles[index], managedRoot, timezone);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function formatResetTime(value, timezone) {
  const date = validDate(value);
  if (!date) return null;
  try {
    return `${new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date)} ${timezone}`;
  } catch {
    return null;
  }
}
