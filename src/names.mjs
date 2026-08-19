import { error } from "./errors.mjs";

export const PROVIDERS = ["claude", "codex"];
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function validateProvider(value) {
  if (!PROVIDERS.includes(value)) {
    throw error(
      `Unknown provider '${value ?? ""}'.`,
      "Use 'claude' or 'codex'.",
    );
  }
  return value;
}

export function validateName(value) {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw error(
      `Invalid profile name '${value ?? ""}'.`,
      "Names must match ^[a-z][a-z0-9_-]{0,47}$ and be lowercase.",
    );
  }
  if (RESERVED_WINDOWS_NAMES.has(value)) {
    throw error(
      `Invalid profile name '${value}'.`,
      "That name is reserved by Windows; choose another name.",
    );
  }
  return value;
}

export function validateInstanceId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value) ||
    RESERVED_WINDOWS_NAMES.has(value.toLowerCase())
  ) {
    throw error(`Invalid T3 instance ID '${value}'.`, "Use a different profile name.");
  }
  return value;
}

export function instanceId(provider, name) {
  validateProvider(provider);
  validateName(name);
  return validateInstanceId(`${provider}_${name}`);
}

export function providerDriver(provider) {
  validateProvider(provider);
  return provider === "claude" ? "claudeAgent" : "codex";
}

export function providerTitle(provider) {
  validateProvider(provider);
  return provider[0].toUpperCase() + provider.slice(1);
}
