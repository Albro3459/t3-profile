import fs from "node:fs/promises";

import { backupFile, existingMode, readJsonFile, writeAtomic } from "./atomic.mjs";
import { error } from "./errors.mjs";
import { providerDriver } from "./names.mjs";

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error(`T3 settings field '${label}' must be an object.`, "Fix settings.json and retry.");
  }
  return value;
}

function validateSettingsDocument(value) {
  objectValue(value, "root");
  if (value.providerInstances !== undefined) objectValue(value.providerInstances, "providerInstances");
  if (value.providers !== undefined) objectValue(value.providers, "providers");
  if (value.providerInstances) {
    for (const [instanceId, instance] of Object.entries(value.providerInstances)) {
      objectValue(instance, `providerInstances.${instanceId}`);
      if (instance.driver !== undefined && typeof instance.driver !== "string") {
        throw error(
          `T3 provider instance '${instanceId}' has an invalid driver.`,
          "Fix settings.json and retry.",
        );
      }
      if (instance.environment !== undefined && !Array.isArray(instance.environment)) {
        throw error(
          `T3 provider instance '${instanceId}' has an invalid environment.`,
          "Fix settings.json and retry.",
        );
      }
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

export function primaryHomeValues(document, provider) {
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

export async function backupAndWriteSettings({ settingsPath, backupsPath, raw, next }) {
  const backup = await backupFile(settingsPath, backupsPath);
  const mode = await existingMode(settingsPath, 0o600);
  await writeAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`, mode);
  return backup;
}

export async function restoreSettings(settingsPath, raw, mode) {
  await writeAtomic(settingsPath, raw, mode);
}

export async function verifySettings(settingsPath, expectedInstanceId, expectedInstance, expectedPrimary) {
  const result = await readSettingsDocument(settingsPath);
  const actual = result.value.providerInstances?.[expectedInstanceId];
  if (JSON.stringify(actual) !== JSON.stringify(expectedInstance)) {
    throw error(
      `T3 settings verification failed for '${expectedInstanceId}'.`,
      "Restore the backup and retry.",
    );
  }
  for (const value of expectedPrimary) {
    if (value.expected === undefined) continue;
    const current = primaryHomeValues(result.value, value.provider).find((entry) => entry.label === value.label)?.value;
    if (current !== value.expected) {
      throw error(
        `T3 primary home verification failed for ${value.provider}.`,
        "Restore the backup and retry.",
      );
    }
  }
  return result;
}
