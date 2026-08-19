import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  existingMode,
  readCurrentFile,
  restoreAtomicIfUnchanged,
  writeAtomicIfUnchanged,
} from "./atomic.mjs";
import { CancelledError, error } from "./errors.mjs";
import {
  createLinks,
  inspectClaudeResources,
  preflightLinks,
  rollbackLinks,
  verifyClaudeLinks,
} from "./links.mjs";
import {
  providerTitle,
  validateName,
  validateProvider,
} from "./names.mjs";
import {
  displayPath,
  isSamePath,
  lstatOrNull,
  pathsFor,
  pathsOverlap,
  requireDirectory,
  requireFile,
  resolveManagedRoot,
} from "./paths.mjs";
import {
  makeEnvironment,
  buildT3Instance,
  providerAuthArguments,
  providerBinary,
  sharingSummary,
} from "./providers.mjs";
import { runProvider } from "./process.mjs";
import {
  findByInstanceId,
  findProfile,
  readRegistry,
  serializeRegistry,
} from "./registry.mjs";
import {
  backupAndWriteSettings,
  buildNextSettings,
  primaryHomeValues,
  readSettingsDocument,
} from "./settings.mjs";
import {
  printAddSummary,
  printCreated,
  printList,
} from "./output.mjs";

function requirePositional(command, values, expected) {
  if (values.length !== expected) {
    throw error(`Invalid arguments for '${command}'.`, `Use 't3-profile --help' for usage.`);
  }
}

export function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { command: "help" };
  if (argv[0] === "--version" || argv[0] === "-v") return { command: "version" };
  const [command, ...rest] = argv;
  if (command === "list") {
    requirePositional(command, rest, 0);
    return { command };
  }
  if (command === "auth") {
    requirePositional(command, rest, 2);
    return { command, provider: rest[0], name: rest[1] };
  }
  if (command === "run") {
    const separator = rest.indexOf("--");
    const before = separator === -1 ? rest : rest.slice(0, separator);
    const providerArguments = separator === -1 ? [] : rest.slice(separator + 1);
    requirePositional(command, before, 2);
    return { command, provider: before[0], name: before[1], providerArguments };
  }
  if (command !== "add") throw error(`Unknown command '${command}'.`, "Use 't3-profile --help' for usage.");

  const positional = [];
  let home;
  let isolated = false;
  let yes = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--isolated") {
      isolated = true;
      continue;
    }
    if (value === "--yes") {
      yes = true;
      continue;
    }
    if (value === "--home") {
      if (home !== undefined || rest[index + 1] === undefined) {
        throw error("The --home option requires one path.", "Pass an existing provider home.");
      }
      home = rest[++index];
      continue;
    }
    if (value.startsWith("--home=")) {
      if (home !== undefined || value.slice("--home=".length).length === 0) {
        throw error("The --home option requires one path.", "Pass an existing provider home.");
      }
      home = value.slice("--home=".length);
      continue;
    }
    if (value.startsWith("-")) throw error(`Unknown option '${value}'.`, "Use 't3-profile --help' for usage.");
    positional.push(value);
  }
  requirePositional(command, positional, 2);
  if (isolated && yes) throw error("--isolated and --yes cannot be combined.", "Choose one sharing mode.");
  return { command, provider: positional[0], name: positional[1], home, isolated, yes };
}

function defaultSource(provider) {
  return path.join(os.homedir(), provider === "claude" ? ".claude" : ".codex");
}

async function pathExistsAsDirectory(value) {
  const stats = await lstatOrNull(value);
  return stats?.isDirectory() ?? false;
}

async function prompt(question, defaultValue = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw error(
      "This command needs interactive confirmation.",
      "Use --yes for standard sharing or --isolated for an explicit non-shared profile.",
    );
  }
  const readline = await import("node:readline/promises");
  const interfaceInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await interfaceInstance.question(question)).trim().toLowerCase();
    if (answer === "") return defaultValue;
    return answer === "y" || answer === "yes";
  } finally {
    interfaceInstance.close();
  }
}

function sharingQuestion({ provider, sourceHome, resources }) {
  const title = providerTitle(provider);
  if (provider === "claude") {
    const lines = [
      `Share the standard ${title} configuration from ${displayPath(sourceHome)}?`,
      "",
      ...resources.available.map((resource) => `  ${resource.name}`),
      ...resources.skipped.map((resource) => `  ${resource} (missing, skipped)`),
      "",
      "Share these resources? [Y/n] ",
    ];
    return lines.join("\n");
  }
  return [
    `Share the standard ${title} home from ${displayPath(sourceHome)}?`,
    "",
    "  configuration, AGENTS.md, skills, plugins, sessions, and runtime state",
    "  auth.json and models_cache.json remain private",
    "  log, memories, and tmp remain shadow-local",
    "",
    "Share these resources? [Y/n] ",
  ].join("\n");
}

function settingsPrimarySummary(document, provider) {
  return primaryHomeValues(document, provider).map((entry) => ({ ...entry, provider }));
}

async function validateAddState({ provider, name, managedRoot, sourceHome, paths, registry, settings }) {
  if (findProfile(registry.profiles, provider, name)) {
    throw error(`Profile '${provider} ${name}' already exists.`, "Choose a different profile name.");
  }
  if (findByInstanceId(registry.profiles, paths.instanceId)) {
    throw error(`T3 instance ID '${paths.instanceId}' is already registered.`, "Choose a different profile name.");
  }
  if (settings.value.providerInstances?.[paths.instanceId] !== undefined) {
    throw error(`T3 provider instance '${paths.instanceId}' already exists.`, "Choose a different profile name.");
  }
  if (pathsOverlap(sourceHome, managedRoot)) {
    throw error(
      "The source home and managed root overlap.",
      "Set T3_PROFILE_HOME to a directory outside the primary provider home.",
    );
  }
  for (const parent of [
    path.join(managedRoot, "profiles"),
    path.join(managedRoot, "profiles", provider),
  ]) {
    const parentStats = await lstatOrNull(parent);
    if (parentStats && (parentStats.isSymbolicLink() || !parentStats.isDirectory())) {
      throw error(
        `Managed profile parent '${parent}' is not a regular directory.`,
        "Move it aside or choose a different T3_PROFILE_HOME.",
      );
    }
  }
  if (pathsOverlap(paths.profileHome, paths.settingsPath) || pathsOverlap(paths.profileHome, paths.registryPath)) {
    throw error(
      "The managed profile path overlaps a control file.",
      "Set T3_PROFILE_HOME to a separate directory.",
    );
  }
  if (await lstatOrNull(paths.profileHome)) {
    throw error(
      `Profile home '${paths.profileHome}' already exists.`,
      "Move it aside or choose a different profile name.",
    );
  }
  if (isSamePath(sourceHome, paths.profileHome)) {
    throw error("The source home and profile home are the same path.", "Choose a different managed root.");
  }
}

function resourceSnapshot(resources) {
  return {
    available: resources.available.map((resource) => ({
      name: resource.name,
      source: resource.source,
      realSource: resource.realSource,
      destination: resource.destination,
      type: resource.type,
    })),
    skipped: [...resources.skipped],
  };
}

async function prepareAdd(options) {
  const provider = validateProvider(options.provider);
  const name = validateName(options.name);
  const sourceInput = options.home ?? defaultSource(provider);
  const managedRoot = await resolveManagedRoot();
  const sourceHome = await requireDirectory(sourceInput, "Primary home");
  const paths = pathsFor({ provider, name, sourceHome, managedRoot });
  await requireFile(paths.settingsPath, "T3 settings");
  const registry = await readRegistry(paths.registryPath);
  const settings = await readSettingsDocument(paths.settingsPath);
  await validateAddState({ provider, name, managedRoot, sourceHome, paths, registry, settings });

  let sharing = options.isolated ? "isolated" : "standard";
  let resources = { available: [], skipped: [] };
  if (provider === "claude" && sharing === "standard") {
    resources = await inspectClaudeResources(sourceHome, paths.profileHome);
  }
  if (!options.yes && !options.isolated) {
    const share = await prompt(sharingQuestion({ provider, sourceHome, resources }), true);
    sharing = share ? "standard" : "isolated";
    if (sharing === "isolated") resources = { available: [], skipped: [] };
    if (sharing === "standard" && provider === "claude" && resources.available.length === 0 && resources.skipped.length === 0) {
      resources = await inspectClaudeResources(sourceHome, paths.profileHome);
    }
  }
  await preflightLinks({
    provider,
    sharing,
    sourceHome,
    profileHome: paths.profileHome,
    resources,
  });

  const primaryValues = options.home === undefined ? [] : settingsPrimarySummary(settings.value, provider);
  return {
    ...options,
    provider,
    name,
    sourceInput,
    sharing,
    managedRoot,
    sourceHome,
    paths,
    registry,
    settings,
    resources,
    primaryValues,
    summarySnapshot: {
      sourceHome,
      managedRoot,
      sharing,
      resources: resourceSnapshot(resources),
      primaryValues,
    },
    summary: sharingSummary({
      provider,
      sharing,
      sourceHome: displayPath(sourceHome),
      links: Object.assign(resources.available.map((resource) => ({ name: resource.name })), {
        skipped: resources.skipped,
      }),
    }),
  };
}

async function finalizeAdd(intent) {
  const managedRoot = await resolveManagedRoot();
  if (!isSamePath(managedRoot, intent.managedRoot)) {
    throw error(
      "The managed root changed while waiting for T3 to stop.",
      "Rerun add to review the new state.",
    );
  }
  const sourceHome = await requireDirectory(intent.sourceInput, "Primary home");
  if (!isSamePath(sourceHome, intent.sourceHome)) {
    throw error(
      "The primary home changed while waiting for T3 to stop.",
      "Rerun add to review the new state.",
    );
  }
  const paths = pathsFor({
    provider: intent.provider,
    name: intent.name,
    sourceHome,
    managedRoot,
  });
  await requireFile(paths.settingsPath, "T3 settings");
  const registry = await readRegistry(paths.registryPath);
  const settings = await readSettingsDocument(paths.settingsPath);
  await validateAddState({
    provider: intent.provider,
    name: intent.name,
    managedRoot,
    sourceHome,
    paths,
    registry,
    settings,
  });

  const resources = intent.provider === "claude" && intent.sharing === "standard"
    ? await inspectClaudeResources(sourceHome, paths.profileHome)
    : { available: [], skipped: [] };
  await preflightLinks({
    provider: intent.provider,
    sharing: intent.sharing,
    sourceHome,
    profileHome: paths.profileHome,
    resources,
  });
  const primaryValues = intent.home === undefined ? [] : settingsPrimarySummary(settings.value, intent.provider);
  const currentSnapshot = {
    sourceHome,
    managedRoot,
    sharing: intent.sharing,
    resources: resourceSnapshot(resources),
    primaryValues,
  };
  if (!isDeepStrictEqual(currentSnapshot, intent.summarySnapshot)) {
    throw error(
      "Inputs changed while waiting for T3 to stop.",
      "Rerun add to review the new state.",
    );
  }

  const instance = buildT3Instance({
    provider: intent.provider,
    profileHome: paths.profileHome,
    sourceHome,
    sharing: intent.sharing,
  });
  const nextSettings = buildNextSettings({
    document: settings.value,
    provider: intent.provider,
    sourceHome,
    profileHome: paths.profileHome,
    instanceId: paths.instanceId,
    instance,
    customHome: intent.home !== undefined,
  });
  return {
    ...intent,
    managedRoot,
    sourceHome,
    paths,
    registry,
    settings,
    resources,
    primaryValues,
    instance,
    nextSettings,
  };
}

async function confirmStopped(prepared) {
  printAddSummary({
    providerTitle: providerTitle(prepared.provider),
    name: prepared.name,
    sourceHome: displayPath(prepared.sourceHome),
    profileHome: displayPath(prepared.paths.profileHome),
    sharing: prepared.sharing,
    summary: prepared.summary,
    customHome: prepared.home !== undefined,
    primaryValues: prepared.primaryValues,
    t3SettingsPath: displayPath(prepared.paths.settingsPath),
  });
  if (prepared.yes) return;
  const confirmed = await prompt("T3 is fully stopped and ready to update? [y/N] ", false);
  if (!confirmed) throw new CancelledError();
}

async function ensureDirectoryChain(target, onCreate) {
  const missing = [];
  let current = path.resolve(target);
  while (true) {
    const stats = await lstatOrNull(current);
    if (stats) {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw error(
          `Managed profile parent '${current}' is not a regular directory.`,
          "Move it aside or choose a different T3_PROFILE_HOME.",
        );
      }
      break;
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const created = [];
  for (const directory of missing.reverse()) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created.push(directory);
      onCreate?.(directory);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const stats = await lstatOrNull(directory);
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) throw cause;
    }
  }
  return created;
}

function sameRaw(current, expectedRaw) {
  return expectedRaw === null ? !current.exists : current.exists && current.raw === expectedRaw;
}

async function removeCreatedArtifacts(prepared, mutation, failures) {
  const linkRollbackFailures = await rollbackLinks(mutation.createdLinks);
  for (const { path: destination, cause } of linkRollbackFailures) {
    failures.push({ step: "remove link", path: destination, cause });
  }
  for (const directory of [...mutation.createdDirectories].reverse()) {
    try {
      await fs.rmdir(directory);
    } catch (cause) {
      if (cause?.code === "ENOENT") continue;
      if (cause?.code === "ENOTEMPTY" || cause?.code === "EEXIST") {
        if (directory === prepared.paths.profileHome) {
          failures.push({ step: "remove profile directory", path: directory, cause });
        }
        continue;
      }
      failures.push({ step: "remove directory", path: directory, cause });
    }
  }
}

function rollbackError(cause, failures, backupPath) {
  const details = failures.map(({ step, path: target, cause: failure }) =>
    `${step} '${target}': ${failure instanceof Error ? failure.message : String(failure)}`,
  );
  if (backupPath) details.push(`settings backup: '${backupPath}'`);
  return error(
    `Add failed: ${cause instanceof Error ? cause.message : String(cause)} Rollback incomplete: ${details.join("; ")}.`,
    "Leave T3 stopped, restore the listed files, then retry.",
  );
}

async function rollbackAdd(prepared, mutation, cause) {
  const failures = [];
  if (mutation.settings) {
    try {
      await restoreAtomicIfUnchanged(
        prepared.paths.settingsPath,
        mutation.settings.writtenRaw,
        mutation.settings.originalRaw,
        mutation.settings.originalMode,
        "T3 settings",
      );
    } catch (restoreCause) {
      failures.push({ step: "restore settings", path: prepared.paths.settingsPath, cause: restoreCause });
    }
  }
  if (mutation.registry) {
    try {
      await restoreAtomicIfUnchanged(
        prepared.paths.registryPath,
        mutation.registry.writtenRaw,
        mutation.registry.originalRaw,
        mutation.registry.originalMode,
        "profile registry",
      );
    } catch (restoreCause) {
      failures.push({ step: "restore registry", path: prepared.paths.registryPath, cause: restoreCause });
    }
  }

  const settingsOriginalRaw = mutation.settings?.originalRaw ?? prepared.settings.raw;
  const registryOriginalRaw = mutation.registry?.originalRaw ?? prepared.registry.raw;
  let settingsRestored = false;
  let registryRestored = false;
  try {
    settingsRestored = sameRaw(
      await readCurrentFile(prepared.paths.settingsPath, "T3 settings"),
      settingsOriginalRaw,
    );
    if (!settingsRestored) throw new Error("contents do not match the original");
  } catch (verifyCause) {
    failures.push({ step: "verify settings rollback", path: prepared.paths.settingsPath, cause: verifyCause });
  }
  try {
    registryRestored = sameRaw(
      await readCurrentFile(prepared.paths.registryPath, "profile registry"),
      registryOriginalRaw,
    );
    if (!registryRestored) throw new Error("contents do not match the original");
  } catch (verifyCause) {
    failures.push({ step: "verify registry rollback", path: prepared.paths.registryPath, cause: verifyCause });
  }
  if (settingsRestored && registryRestored) {
    await removeCreatedArtifacts(prepared, mutation, failures);
  }
  if (failures.length > 0) throw rollbackError(cause, failures, mutation.backupPath);
  throw cause;
}

async function mutateAdd(prepared) {
  const mutation = {
    createdDirectories: [],
    createdLinks: [],
    settings: null,
    registry: null,
    backupPath: undefined,
  };
  try {
    await ensureDirectoryChain(
      path.join(prepared.managedRoot, "profiles", prepared.provider),
      (directory) => mutation.createdDirectories.push(directory),
    );
    try {
      await fs.mkdir(prepared.paths.profileHome, { mode: 0o700 });
      mutation.createdDirectories.push(prepared.paths.profileHome);
    } catch (cause) {
      if (cause?.code === "EEXIST") {
        throw error(
          `Profile home '${prepared.paths.profileHome}' already exists.`,
          "Move it aside or choose a different profile name.",
        );
      }
      throw cause;
    }

    if (prepared.provider === "claude" && prepared.sharing === "standard") {
      try {
        mutation.createdLinks.push(...await createLinks(prepared.resources.available));
      } catch (linkCause) {
        for (const createdLink of linkCause?.createdLinks ?? []) {
          if (!mutation.createdLinks.some(
            (link) => link.destination === createdLink.destination,
          )) {
            mutation.createdLinks.push(createdLink);
          }
        }
        throw linkCause;
      }
      await verifyClaudeLinks(prepared.resources.available);
    }
    const registryEntry = {
      provider: prepared.provider,
      name: prepared.name,
      sourceHome: prepared.sourceHome,
      profileHome: prepared.paths.profileHome,
      sharing: prepared.sharing,
      links: prepared.resources.available.map((resource) => ({
        source: resource.source,
        destination: resource.destination,
        type: resource.type,
      })),
      instanceId: prepared.paths.instanceId,
      createdAt: new Date().toISOString(),
    };
    const nextProfiles = [...prepared.registry.profiles, registryEntry];
    const registryRaw = `${JSON.stringify(serializeRegistry(nextProfiles), null, 2)}\n`;
    const registryMode = await existingMode(prepared.paths.registryPath, 0o600);

    let settingsResult;
    try {
      settingsResult = await backupAndWriteSettings({
        settingsPath: prepared.paths.settingsPath,
        backupsPath: prepared.paths.backupsPath,
        expectedRaw: prepared.settings.raw,
        next: prepared.nextSettings,
      });
    } catch (settingsCause) {
      if (settingsCause?.backupPath) mutation.backupPath = settingsCause.backupPath;
      throw settingsCause;
    }
    mutation.backupPath = settingsResult.backupPath;
    mutation.settings = {
      originalRaw: prepared.settings.raw,
      originalMode: prepared.settings.mode,
      writtenRaw: settingsResult.writtenRaw,
    };
    await writeAtomicIfUnchanged(
      prepared.paths.registryPath,
      prepared.registry.raw,
      registryRaw,
      registryMode,
      "profile registry",
    );
    mutation.registry = {
      originalRaw: prepared.registry.raw,
      originalMode: registryMode,
      writtenRaw: registryRaw,
    };

    const writtenSettings = await readSettingsDocument(prepared.paths.settingsPath);
    if (!isDeepStrictEqual(writtenSettings.value, prepared.nextSettings)) {
      throw error("T3 settings verification failed.", "Restore the settings backup and retry.");
    }
    const writtenRegistry = await readRegistry(prepared.paths.registryPath);
    if (!isDeepStrictEqual(writtenRegistry.profiles, nextProfiles)) {
      throw error("Profile registry verification failed.", "Restore the settings backup and retry.");
    }
    if (prepared.provider === "claude" && prepared.sharing === "standard") {
      await verifyClaudeLinks(prepared.resources.available);
    }
    return registryEntry;
  } catch (cause) {
    return rollbackAdd(prepared, mutation, cause);
  }
}

async function addCommand(options) {
  const intent = await prepareAdd(options);
  await confirmStopped(intent);
  const prepared = await finalizeAdd(intent);
  await mutateAdd(prepared);
  printCreated({
    providerTitle: providerTitle(prepared.provider),
    name: prepared.name,
    profileHome: displayPath(prepared.paths.profileHome),
    sharing: prepared.sharing,
  });
}

async function loadProfile(providerValue, nameValue) {
  const provider = validateProvider(providerValue);
  const name = validateName(nameValue);
  const managedRoot = await resolveManagedRoot();
  const registryPath = path.join(managedRoot, "profiles.json");
  const registry = await readRegistry(registryPath);
  const profile = findProfile(registry.profiles, provider, name);
  if (!profile) {
    throw error(`Profile '${provider} ${name}' is not configured.`, "Run t3-profile add first.");
  }
  return profile;
}

async function authCommand(options) {
  const profile = await loadProfile(options.provider, options.name);
  if (!(await pathExistsAsDirectory(profile.profileHome))) {
    throw error(`Profile home '${profile.profileHome}' does not exist.`, "Recreate the profile before authenticating.");
  }
  return runProvider(
    providerBinary(profile.provider),
    providerAuthArguments(profile.provider),
    makeEnvironment(profile.provider, profile.profileHome),
  );
}

async function runCommand(options) {
  const profile = await loadProfile(options.provider, options.name);
  if (!(await pathExistsAsDirectory(profile.profileHome))) {
    throw error(`Profile home '${profile.profileHome}' does not exist.`, "Recreate the profile before running it.");
  }
  return runProvider(
    providerBinary(profile.provider),
    options.providerArguments,
    makeEnvironment(profile.provider, profile.profileHome),
  );
}

async function listCommand() {
  const managedRoot = await resolveManagedRoot();
  const registry = await readRegistry(path.join(managedRoot, "profiles.json"));
  printList(registry.profiles.map((profile) => ({ ...profile, profileHome: displayPath(profile.profileHome) })));
}

export async function dispatch(options) {
  if (options.command === "add") return addCommand(options);
  if (options.command === "auth") return authCommand(options);
  if (options.command === "run") return runCommand(options);
  if (options.command === "list") return listCommand();
  throw error(`Unknown command '${options.command}'.`, "Use 't3-profile --help' for usage.");
}
