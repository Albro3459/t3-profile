import fs from "node:fs/promises";
import path from "node:path";

import { VERSION } from "./version.mjs";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_BETA_HEADER = "oauth-2025-04-20";
export const CLAUDE_USAGE_OUTPUT_LIMIT_BYTES = 65_536;
export const CLAUDE_USAGE_TIMEOUT_MS = 5_000;

function unavailable() {
  return { status: "unavailable", windows: [] };
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
      value.utilization > 100 ||
      !validReset(value.resets_at)) {
    return { id, status: "unavailable" };
  }
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

async function readAccessToken(profileHome) {
  const credentialsPath = path.join(profileHome, ".credentials.json");
  let stats;
  try {
    stats = await fs.lstat(credentialsPath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  let raw;
  try {
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw) > CLAUDE_USAGE_OUTPUT_LIMIT_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    const token = value?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function fetchUsageResponse(accessToken, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_USAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_USAGE_BETA_HEADER,
        "User-Agent": `claude-code/${VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response?.ok || typeof response.text !== "function") return null;
    const raw = await response.text();
    if (Buffer.byteLength(raw) > CLAUDE_USAGE_OUTPUT_LIMIT_BYTES) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function claudeUsageAdapter({ canonicalProfileHome, fetchImpl = globalThis.fetch }) {
  try {
    const accessToken = await readAccessToken(canonicalProfileHome);
    if (!accessToken) return unavailable();
    const response = await fetchUsageResponse(accessToken, fetchImpl);
    return response === null ? unavailable() : parseClaudeUsageResponse(response);
  } catch {
    return unavailable();
  }
}

export function createClaudeUsageAdapter() {
  return ({ canonicalProfileHome, fetchImpl }) => claudeUsageAdapter({ canonicalProfileHome, fetchImpl });
}
