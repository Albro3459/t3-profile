import { createHash } from "node:crypto";
import os from "node:os";

import { inspectCommand, runInteractiveCommand } from "./process.mjs";

export const KEYCHAIN_COMMAND = "/usr/bin/security";
export const KEYCHAIN_TIMEOUT_MS = 2_000;
export const KEYCHAIN_OUTPUT_LIMIT_BYTES = 65_536;

const LOCKED_SECURITY_CODES = Object.freeze(new Set([-25308, -25315]));
// macOS 26 returns this process status with no diagnostic when a confirmed
// item's secret is requested from a locked Keychain.
const LOCKED_SECURITY_EXIT_CODES = Object.freeze(new Set([24]));
const LOCKED_DIAGNOSTICS = Object.freeze([
  "interaction is not allowed",
  "user interaction is not allowed",
  "interaction required",
]);

function keychainAccount(environment) {
  let account = environment?.USER;
  if (!account) {
    try {
      account = os.userInfo().username;
    } catch {
      account = "claude-code-user";
    }
  }
  return typeof account === "string" && /^[a-zA-Z0-9._-]+$/.test(account)
    ? account
    : "claude-code-user";
}

export function claudeKeychainAccount(environment) {
  return keychainAccount(environment);
}

export function claudeKeychainService(profileHome) {
  const normalizedHome = profileHome.normalize("NFC");
  const suffix = createHash("sha256").update(normalizedHome).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

function keychainArguments({ profileHome, environment, keychainPath, withSecret = false }) {
  return [
    "find-generic-password",
    "-a",
    keychainAccount(environment),
    "-s",
    claudeKeychainService(profileHome),
    ...(withSecret ? ["-w"] : []),
    ...(keychainPath ? [keychainPath] : []),
  ];
}

function boundedText(value) {
  return typeof value === "string" && Buffer.byteLength(value) <= KEYCHAIN_OUTPUT_LIMIT_BYTES ? value : "";
}

function securityStatusCodes(result) {
  const text = `${boundedText(result?.stderr)}\n${boundedText(result?.stdout)}`;
  return [...text.matchAll(/(?:^|[^\d])-([0-9]{5})(?:[^\d]|$)/g)].map((match) => -Number(match[1]));
}

function isLockedSecurityResult(result) {
  if (LOCKED_SECURITY_EXIT_CODES.has(result?.code)) return true;
  const codes = securityStatusCodes(result);
  if (codes.some((code) => LOCKED_SECURITY_CODES.has(code))) return true;
  const diagnostic = `${boundedText(result?.stderr)}\n${boundedText(result?.stdout)}`.toLowerCase();
  return LOCKED_DIAGNOSTICS.some((phrase) => diagnostic.includes(phrase));
}

async function inspectSecurity(argumentsToPass, environment, inspect) {
  try {
    return await inspect(KEYCHAIN_COMMAND, argumentsToPass, environment, KEYCHAIN_TIMEOUT_MS);
  } catch {
    return { found: false, code: 1, stdout: "", stderr: "", timedOut: false };
  }
}

function parseSingleKeychainPath(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > KEYCHAIN_OUTPUT_LIMIT_BYTES) return null;
  const quoted = [...output.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  if (quoted.length === 1) return quoted[0];
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length === 1 && !lines[0].startsWith("(") ? lines[0] : null;
}

export async function resolveLoginKeychain({
  environment = process.env,
  inspect = inspectCommand,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") return null;
  const result = await inspectSecurity(["login-keychain"], environment, inspect);
  if (!result?.found || result.code !== 0 || result.timedOut) return null;
  return parseSingleKeychainPath(result.stdout);
}

export async function readClaudeKeychainItem({
  profileHome,
  keychainPath = null,
  environment = process.env,
  inspect = inspectCommand,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") return { state: "unsupported", raw: null };
  const metadata = await inspectSecurity(
    keychainArguments({ profileHome, environment, keychainPath }),
    environment,
    inspect,
  );
  if (!metadata?.found || metadata.code !== 0 || metadata.timedOut) {
    return { state: "absent", raw: null };
  }
  const secret = await inspectSecurity(
    keychainArguments({ profileHome, environment, keychainPath, withSecret: true }),
    environment,
    inspect,
  );
  if (secret?.found && secret.code === 0 && !secret.timedOut) {
    return { state: "readable", raw: boundedText(secret.stdout) };
  }
  return { state: isLockedSecurityResult(secret) ? "locked" : "unavailable", raw: null };
}

export async function unlockKeychain({
  keychainPath,
  environment = process.env,
  run = runInteractiveCommand,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin" || typeof keychainPath !== "string" || keychainPath.length === 0) return false;
  try {
    return await run(KEYCHAIN_COMMAND, ["unlock-keychain", keychainPath], environment) === 0;
  } catch {
    return false;
  }
}

export async function lockKeychain({
  keychainPath,
  environment = process.env,
  inspect = inspectCommand,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin" || typeof keychainPath !== "string" || keychainPath.length === 0) return false;
  const result = await inspectSecurity(["lock-keychain", keychainPath], environment, inspect);
  return result?.code === 0 && !result?.timedOut;
}
