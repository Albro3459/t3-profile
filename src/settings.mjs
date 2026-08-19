import fs from "node:fs/promises";

import {
  backupFile,
  existingMode,
  readCurrentFile,
  readJsonFile,
  writeAtomicIfUnchanged,
} from "./atomic.mjs";
import { error } from "./errors.mjs";
import { providerDriver } from "./names.mjs";

function objectValue(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error(`T3 settings field '${label}' must be an object.`, "Fix settings.json and retry.");
  }
  return value;
}

const OPEN_SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$(?![\s\S])/;
const ENVIRONMENT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$(?![\s\S])/;

function invalidEnvelope(label, detail) {
  throw error(`T3 ${label} is invalid${detail ? `: ${detail}` : "."}`, "Fix settings.json and retry.");
}

function validateSlug(value, label, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !OPEN_SLUG.test(value)) {
    invalidEnvelope(label, `use 1-${maxLength} letters, digits, '_' or '-' with a leading letter`);
  }
}

function validateEnvironment(instance, instanceId) {
  if (instance.environment === undefined) return;
  if (!Array.isArray(instance.environment)) invalidEnvelope(`provider instance '${instanceId}' environment`);
  for (const [index, entry] of instance.environment.entries()) {
    objectValue(entry, `providerInstances.${instanceId}.environment.${index}`);
    const prefix = `provider instance '${instanceId}' environment entry ${index}`;
    if (
      typeof entry.name !== "string" ||
      entry.name.length < 1 ||
      entry.name.length > 128 ||
      !ENVIRONMENT_NAME.test(entry.name)
    ) {
      invalidEnvelope(`${prefix} name`, "use 1-128 letters, digits, or '_' with a non-digit first character");
    }
    if (entry.value !== undefined && typeof entry.value !== "string") {
      invalidEnvelope(`${prefix} value`, "it must be a string");
    }
    for (const field of ["sensitive", "valueRedacted"]) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") {
        invalidEnvelope(`${prefix} ${field}`, "it must be a boolean");
      }
    }
  }
}

function validateSettingsDocument(value) {
  objectValue(value, "root");
  if (value.providerInstances !== undefined) objectValue(value.providerInstances, "providerInstances");
  if (value.providers !== undefined) objectValue(value.providers, "providers");
  if (value.providerInstances) {
    for (const [instanceId, instance] of Object.entries(value.providerInstances)) {
      validateSlug(instanceId, `provider instance ID '${instanceId}'`, 64);
      objectValue(instance, `providerInstances.${instanceId}`);
      validateSlug(instance.driver, `provider instance '${instanceId}' driver`, 64);
      for (const field of ["displayName", "accentColor"]) {
        if (
          instance[field] !== undefined &&
          (typeof instance[field] !== "string" || instance[field].trim().length === 0)
        ) {
          invalidEnvelope(`provider instance '${instanceId}' ${field}`, "it must be a nonempty string");
        }
      }
      if (instance.enabled !== undefined && typeof instance.enabled !== "boolean") {
        invalidEnvelope(`provider instance '${instanceId}' enabled`, "it must be a boolean");
      }
      validateEnvironment(instance, instanceId);
    }
  }
  return value;
}

export async function readSettingsDocument(settingsPath) {
  const stats = await fs.lstat(settingsPath).catch((cause) => {
    if (cause?.code === "ENOENT") {
      throw error(
        `T3 settings '${settingsPath}' does not exist.`,
        "Start T3 Code once so it creates settings.json, then retry.",
      );
    }
    throw error(`Cannot inspect T3 settings '${settingsPath}'.`, "Check its permissions.");
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw error(
      `T3 settings '${settingsPath}' is not a regular file.`,
      "Restore a regular settings.json file before retrying.",
    );
  }
  const document = await readJsonFile(settingsPath, "T3 settings");
  validateSettingsDocument(document.value);
  return { raw: document.raw, value: document.value, mode: stats.mode & 0o777 };
}

function existingHomeValue(instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) return undefined;
  const config = instance.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  return config.homePath;
}

function validateCustomPrimaryHome(document, provider) {
  const defaultInstanceId = providerDriver(provider);
  const defaultInstance = document.providerInstances?.[defaultInstanceId];
  if (defaultInstance === undefined) return;
  const config = defaultInstance.config;
  if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) {
    throw error(
      `T3 settings field 'providerInstances.${defaultInstanceId}.config' is invalid.`,
      "Fix settings.json and retry.",
    );
  }
}

export function primaryHomeValues(document, provider) {
  validateCustomPrimaryHome(document, provider);
  const legacyKey = provider === "claude" ? "claudeAgent" : "codex";
  const defaultInstanceId = providerDriver(provider);
  const legacy = document.providers?.[legacyKey]?.homePath;
  const instance = existingHomeValue(document.providerInstances?.[defaultInstanceId]);
  return [
    { label: `legacy providers.${legacyKey}.homePath`, value: legacy },
    { label: `providerInstances.${defaultInstanceId}.config.homePath`, value: instance },
  ].filter(({ value }) => value !== undefined);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildNextSettings({ document, provider, sourceHome, profileHome, instanceId, instance, customHome }) {
  const next = clone(document);
  next.providerInstances ??= {};
  if (next.providerInstances[instanceId] !== undefined) {
    throw error(
      `T3 provider instance '${instanceId}' already exists.`,
      "Choose a different profile name.",
    );
  }
  if (customHome) {
    const legacyKey = provider === "claude" ? "claudeAgent" : "codex";
    next.providers ??= {};
    const legacy = next.providers[legacyKey];
    if (legacy !== undefined && (!legacy || typeof legacy !== "object" || Array.isArray(legacy))) {
      throw error(`T3 settings field 'providers.${legacyKey}' is invalid.`, "Fix settings.json and retry.");
    }
    next.providers[legacyKey] = { ...(legacy ?? {}), homePath: sourceHome };

    const defaultInstanceId = providerDriver(provider);
    const defaultInstance = next.providerInstances[defaultInstanceId];
    if (defaultInstance !== undefined) {
      if (!defaultInstance || typeof defaultInstance !== "object" || Array.isArray(defaultInstance)) {
        throw error(
          `T3 settings field 'providerInstances.${defaultInstanceId}' is invalid.`,
          "Fix settings.json and retry.",
        );
      }
      const config = defaultInstance.config;
      if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) {
        throw error(
          `T3 settings field 'providerInstances.${defaultInstanceId}.config' is invalid.`,
          "Fix settings.json and retry.",
        );
      }
      next.providerInstances[defaultInstanceId] = {
        ...defaultInstance,
        config: { ...(config ?? {}), homePath: sourceHome },
      };
    }
  }
  next.providerInstances[instanceId] = instance;
  return next;
}

export function withoutProviderInstance(document, instanceId) {
  const next = clone(document);
  if (next.providerInstances) delete next.providerInstances[instanceId];
  return next;
}

export async function backupAndWriteSettings({ settingsPath, backupsPath, expectedRaw, raw, next }) {
  const expected = expectedRaw ?? raw;
  const current = await readCurrentFile(settingsPath, "T3 settings");
  if (!current.exists || current.raw !== expected) {
    throw error(
      `T3 settings '${settingsPath}' changed while waiting to be updated.`,
      "Rerun the operation to review the new state.",
    );
  }
  const backup = await backupFile(settingsPath, backupsPath, current.raw);
  const mode = await existingMode(settingsPath, 0o600);
  const writtenRaw = `${JSON.stringify(next, null, 2)}\n`;
  try {
    await writeAtomicIfUnchanged(settingsPath, expected, writtenRaw, mode, "T3 settings");
  } catch (cause) {
    cause.backupPath = backup;
    throw cause;
  }
  return { backupPath: backup, writtenRaw };
}
