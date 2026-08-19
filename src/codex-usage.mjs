import { makeEnvironment } from "./providers.mjs";
import { runBidirectionalJsonRpc } from "./jsonrpc.mjs";
import { VERSION } from "./version.mjs";

export const CODEX_WEEKLY_WINDOW_MINUTES = 10_080;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unavailableCodexUsage() {
  return {
    windows: [{ id: "week", status: "unavailable" }],
  };
}

export function selectCodexRateLimits(result) {
  if (!isObject(result)) return null;
  const byLimitId = result.rateLimitsByLimitId;
  if (isObject(byLimitId) && isObject(byLimitId.codex)) return byLimitId.codex;

  const legacy = result.rateLimits;
  if (!isObject(legacy)) return null;
  if (!Object.hasOwn(legacy, "limitId") || legacy.limitId === "codex") return legacy;
  return null;
}

function validDateFromEpochSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeCodexWindow(window) {
  if (!isObject(window) || window.windowDurationMins !== CODEX_WEEKLY_WINDOW_MINUTES) return null;
  if (typeof window.usedPercent !== "number" ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100) {
    return { invalid: true };
  }
  const resetsAt = validDateFromEpochSeconds(window.resetsAt);
  if (!resetsAt) return { invalid: true };
  return {
    id: "week",
    status: "available",
    percent: Math.round(window.usedPercent),
    resetsAt: resetsAt.getTime(),
  };
}

export function parseCodexUsageResult(result) {
  const bucket = selectCodexRateLimits(result);
  if (!bucket) return unavailableCodexUsage();

  const candidates = [bucket.primary, bucket.secondary]
    .filter((window) => window !== null && window !== undefined)
    .filter((window) => isObject(window) && window.windowDurationMins === CODEX_WEEKLY_WINDOW_MINUTES);
  if (candidates.length !== 1) return unavailableCodexUsage();

  const normalized = normalizeCodexWindow(candidates[0]);
  if (!normalized || normalized.invalid) return unavailableCodexUsage();
  return { windows: [normalized] };
}

export async function inspectCodexUsage({
  profileHome,
  environment = makeEnvironment("codex", profileHome),
  timeoutMs = 5_000,
}) {
  try {
    const responses = await runBidirectionalJsonRpc({
      binary: "codex",
      argumentsToPass: ["app-server"],
      environment,
      timeoutMs,
      steps: [
        {
          type: "request",
          id: 0,
          method: "initialize",
          params: {
            clientInfo: {
              name: "t3-profile",
              title: "t3-profile",
              version: VERSION,
            },
            capabilities: {},
          },
        },
        { type: "notification", method: "initialized" },
        { type: "request", id: 1, method: "account/rateLimits/read" },
      ],
    });
    return parseCodexUsageResult(responses.get(1));
  } catch {
    return unavailableCodexUsage();
  }
}
