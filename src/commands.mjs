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
  inspectClaudeLink,
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
  filesystemIdentity,
  isSamePath,
  isPathWithin,
  isRedirectedStats,
  lstatOrNull,
  pathsFor,
  pathsOverlap,
  requireDirectory,
  requireFile,
  resolveManagedRoot,
  sameFilesystemIdentity,
  t3SettingsPath,
  validateManagedProfileChain,
} from "./paths.mjs";
import {
  makeEnvironment,
  buildT3Instance,
  providerAuthArguments,
  providerAuthStatusArguments,
  providerBinary,
  providerVersionArguments,
  reconcileT3Instance,
  sharingSummary,
} from "./providers.mjs";
import { inspectCommand, runProvider } from "./process.mjs";
import {
  findByInstanceId,
  findProfile,
  readRegistry,
  serializeRegistry,
  withoutProfile,
} from "./registry.mjs";
import {
  backupAndWriteSettings,
  buildNextSettings,
  primaryHomeValues,
  readSettingsDocument,
  withoutProviderInstance,
} from "./settings.mjs";
import {
  printAddSummary,
  printAuthenticated,
  printAuthenticationIncomplete,
  printCreated,
  printDoctor,
  printList,
  printRemoved,
  printRemoveSummary,
  printSynced,
  printSyncSummary,
} from "./output.mjs";
import { collectUsage, displayTimezone } from "./usage.mjs";

function requirePositional(command, values, expected) {
  if (values.length !== expected) {
    throw error(`Invalid arguments for '${command}'.`, `Use 't3-profile help' for usage.`);
  }
}

export function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help" };
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    return { command: "version" };
  }
  const [command, ...rest] = argv;
  if (command === "list") {
    requirePositional(command, rest, 0);
    return { command };
  }
  if (command === "doctor") {
    if (rest.length !== 0 && rest.length !== 2) {
      throw error("Invalid arguments for 'doctor'.", "Pass no profile or one provider and profile name.");
    }
    return { command, provider: rest[0], name: rest[1] };
  }
  if (command === "sync") {
    let dryRun = false;
    let yes = false;
    for (const value of rest) {
      if (value === "--dry-run") dryRun = true;
      else if (value === "--yes") yes = true;
      else throw error(`Unknown option '${value}'.`, "Use 't3-profile help' for usage.");
    }
    return { command, dryRun, yes };
  }
  if (command === "remove") {
    const positional = [];
    let yes = false;
    for (const value of rest) {
      if (value === "--yes") yes = true;
      else if (value.startsWith("-")) throw error(`Unknown option '${value}'.`, "Use 't3-profile help' for usage.");
      else positional.push(value);
    }
    requirePositional(command, positional, 2);
    return { command, provider: positional[0], name: positional[1], yes };
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
  if (command !== "add") throw error(`Unknown command '${command}'.`, "Use 't3-profile help' for usage.");

  const positional = [];
  let home;
  let isolated = false;
  let skipAuth = false;
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
    if (value === "--skip-auth") {
      skipAuth = true;
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
    if (value.startsWith("-")) throw error(`Unknown option '${value}'.`, "Use 't3-profile help' for usage.");
    positional.push(value);
  }
  requirePositional(command, positional, 2);
  if (isolated && yes) throw error("--isolated and --yes cannot be combined.", "Choose one sharing mode.");
  return { command, provider: positional[0], name: positional[1], home, isolated, skipAuth, yes };
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
      "Run it in an interactive terminal or pass --yes when that option is supported.",
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

const STOPPED_T3_PROMPT = "T3 is fully stopped and ready to update? [y/N] ";

async function confirmStoppedT3(yes) {
  if (yes) return;
  const confirmed = await prompt(STOPPED_T3_PROMPT, false);
  if (!confirmed) throw new CancelledError();
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
  await confirmStoppedT3(prepared.yes);
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
    skipAuth: prepared.skipAuth,
  });
  if (prepared.skipAuth) return;
  try {
    const exitCode = await authCommand(prepared);
    if (exitCode === 0) printAuthenticated();
    else printAuthenticationIncomplete(prepared.provider, prepared.name);
    return exitCode;
  } catch (cause) {
    printAuthenticationIncomplete(prepared.provider, prepared.name);
    throw cause;
  }
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
  if (registry.profiles.length === 0) {
    printList([]);
    return;
  }
  const timezone = displayTimezone();
  const usage = await collectUsage(registry.profiles, managedRoot, timezone);
  printList(registry.profiles.map((profile, index) => ({
    ...profile,
    profileHome: displayPath(profile.profileHome),
    usage: usage[index],
    displayTimezone: timezone,
  })));
}

function desiredInstance(profile) {
  return buildT3Instance({
    provider: profile.provider,
    profileHome: profile.profileHome,
    sourceHome: profile.sourceHome,
    sharing: profile.sharing,
  });
}

function buildSyncPlan(document, profiles) {
  const next = JSON.parse(JSON.stringify(document));
  next.providerInstances ??= {};
  const changes = [];
  const seen = new Set();
  for (const profile of [...profiles].sort((left, right) => left.instanceId.localeCompare(right.instanceId))) {
    if (seen.has(profile.instanceId)) {
      throw error(`Registry instance ID '${profile.instanceId}' is duplicated.`, "Fix profiles.json and retry.");
    }
    seen.add(profile.instanceId);
    const existing = next.providerInstances[profile.instanceId];
    let reconciled;
    try {
      reconciled = reconcileT3Instance(existing, desiredInstance(profile), profile.instanceId);
    } catch (cause) {
      throw error(cause.message, "Resolve the collision in T3 settings before syncing.");
    }
    if (!isDeepStrictEqual(existing, reconciled)) {
      changes.push({ action: existing === undefined ? "add" : "update", instanceId: profile.instanceId });
      next.providerInstances[profile.instanceId] = reconciled;
    }
  }
  return { next, changes };
}

async function validateSyncFilesystem(managedRoot, profiles) {
  const rootIdentities = [];
  const profileIdentities = new Map();
  for (const profile of profiles) {
    const expectedPaths = pathsFor({
      provider: profile.provider,
      name: profile.name,
      sourceHome: profile.sourceHome,
      managedRoot,
    });
    if (!isSamePath(profile.profileHome, expectedPaths.profileHome) || profile.instanceId !== expectedPaths.instanceId) {
      throw error(
        `Profile '${profile.provider} ${profile.name}' has unexpected managed identity fields.`,
        "Fix profiles.json before syncing.",
      );
    }
    const chain = await validateManagedProfileChain({
      managedRoot,
      provider: profile.provider,
      name: profile.name,
      requireHome: true,
    });
    const rootIdentity = filesystemIdentity(chain.managedRoot.stats);
    if (!rootIdentities.some((identity) => sameFilesystemIdentity(identity, rootIdentity))) {
      rootIdentities.push(rootIdentity);
    }
    profileIdentities.set(profile.instanceId, {
      managedRoot: rootIdentity,
      profiles: filesystemIdentity(chain.profiles.stats),
      providerParent: filesystemIdentity(chain.providerParent.stats),
      profileHome: filesystemIdentity(chain.profileHome.stats),
    });
  }
  return { rootIdentities, profileIdentities };
}

function sameSyncFilesystemState(initial, current) {
  if (initial.rootIdentities.length !== current.rootIdentities.length) return false;
  if (!initial.rootIdentities.every((identity) => current.rootIdentities.some((candidate) => sameFilesystemIdentity(identity, candidate)))) {
    return false;
  }
  if (initial.profileIdentities.size !== current.profileIdentities.size) return false;
  for (const [instanceId, identity] of initial.profileIdentities) {
    const currentIdentity = current.profileIdentities.get(instanceId);
    if (!currentIdentity ||
      !sameFilesystemIdentity(identity.managedRoot, currentIdentity.managedRoot) ||
      !sameFilesystemIdentity(identity.profiles, currentIdentity.profiles) ||
      !sameFilesystemIdentity(identity.providerParent, currentIdentity.providerParent) ||
      !sameFilesystemIdentity(identity.profileHome, currentIdentity.profileHome)) {
      return false;
    }
  }
  return true;
}

async function syncCommand(options) {
  const managedRoot = await resolveManagedRoot();
  const registryPath = path.join(managedRoot, "profiles.json");
  const registry = await readRegistry(registryPath);
  const settingsPath = t3SettingsPath();
  const settings = await readSettingsDocument(settingsPath);
  const initialFilesystem = await validateSyncFilesystem(managedRoot, registry.profiles);
  const plan = buildSyncPlan(settings.value, registry.profiles);
  printSyncSummary(plan.changes, options.dryRun);
  if (plan.changes.length === 0 || options.dryRun) return;
  await confirmStoppedT3(options.yes);

  const finalManagedRoot = await resolveManagedRoot();
  if (!isSamePath(finalManagedRoot, managedRoot)) {
    throw error("The managed root changed while waiting for T3 to stop.", "Rerun sync to review the new state.");
  }
  const finalRegistryPath = path.join(finalManagedRoot, "profiles.json");
  const current = await readSettingsDocument(settingsPath);
  if (current.raw !== settings.raw) {
    throw error("T3 settings changed while waiting for sync.", "Rerun sync to review the new state.");
  }
  const currentRegistry = await readRegistry(finalRegistryPath);
  if (currentRegistry.raw !== registry.raw) {
    throw error("The profile registry changed while waiting for sync.", "Rerun sync to review the new state.");
  }
  const finalFilesystem = await validateSyncFilesystem(finalManagedRoot, currentRegistry.profiles);
  if (!sameSyncFilesystemState(initialFilesystem, finalFilesystem)) {
    throw error(
      "A managed profile home or parent changed while waiting for sync.",
      "Rerun sync to review the new state.",
    );
  }
  const finalPlan = buildSyncPlan(current.value, currentRegistry.profiles);
  const result = await backupAndWriteSettings({
    settingsPath,
    backupsPath: path.join(finalManagedRoot, "backups"),
    expectedRaw: current.raw,
    next: finalPlan.next,
  });
  const written = await readSettingsDocument(settingsPath);
  if (!isDeepStrictEqual(written.value, finalPlan.next)) {
    throw error("T3 settings verification failed after sync.", `Restore '${result.backupPath}' and retry.`);
  }
  printSynced(finalPlan.changes.length, displayPath(result.backupPath));
}

async function writeRemovedControlFiles({ managedRoot, settings, registry, nextSettings, nextProfiles }) {
  const settingsPath = t3SettingsPath();
  const registryPath = path.join(managedRoot, "profiles.json");
  const registryRaw = `${JSON.stringify(serializeRegistry(nextProfiles), null, 2)}\n`;
  const registryMode = await existingMode(registryPath, 0o600);
  const mutation = { settings: null, registry: null, backupPath: undefined };
  try {
    const settingsResult = await backupAndWriteSettings({
      settingsPath,
      backupsPath: path.join(managedRoot, "backups"),
      expectedRaw: settings.raw,
      next: nextSettings,
    });
    mutation.backupPath = settingsResult.backupPath;
    mutation.settings = {
      originalRaw: settings.raw,
      originalMode: settings.mode,
      writtenRaw: settingsResult.writtenRaw,
    };
    await writeAtomicIfUnchanged(
      registryPath,
      registry.raw,
      registryRaw,
      registryMode,
      "profile registry",
    );
    mutation.registry = {
      originalRaw: registry.raw,
      originalMode: registryMode,
      writtenRaw: registryRaw,
    };
    const writtenSettings = await readSettingsDocument(settingsPath);
    const writtenRegistry = await readRegistry(registryPath);
    if (!isDeepStrictEqual(writtenSettings.value, nextSettings) || !isDeepStrictEqual(writtenRegistry.profiles, nextProfiles)) {
      throw error("Remove verification failed.", "Leave T3 stopped and restore the control files.");
    }
    return mutation.backupPath;
  } catch (cause) {
    const failures = [];
    if (mutation.registry) {
      try {
        await restoreAtomicIfUnchanged(
          registryPath,
          mutation.registry.writtenRaw,
          mutation.registry.originalRaw,
          mutation.registry.originalMode,
          "profile registry",
        );
      } catch (restoreCause) {
        failures.push(`registry: ${restoreCause.message}`);
      }
    }
    if (mutation.settings) {
      try {
        await restoreAtomicIfUnchanged(
          settingsPath,
          mutation.settings.writtenRaw,
          mutation.settings.originalRaw,
          mutation.settings.originalMode,
          "T3 settings",
        );
      } catch (restoreCause) {
        failures.push(`settings: ${restoreCause.message}`);
      }
    }
    if (failures.length > 0) {
      throw error(
        `Remove failed and rollback was incomplete: ${failures.join("; ")}.`,
        `Leave T3 stopped and restore '${mutation.backupPath ?? settingsPath}'.`,
      );
    }
    throw cause;
  }
}

function removalParentIdentity(chain) {
  return {
    managedRoot: filesystemIdentity(chain.managedRoot.stats),
    profiles: filesystemIdentity(chain.profiles.stats),
    providerParent: filesystemIdentity(chain.providerParent.stats),
  };
}

function sameRemovalParentIdentity(left, right) {
  return sameFilesystemIdentity(left.managedRoot, right.managedRoot) &&
    sameFilesystemIdentity(left.profiles, right.profiles) &&
    sameFilesystemIdentity(left.providerParent, right.providerParent);
}

async function validateRemovalHolding({ holdingPath, chain, expectedIdentity }) {
  const stats = await lstatOrNull(holdingPath);
  if (!stats || isRedirectedStats(stats) || !stats.isDirectory()) {
    throw error(
      `Removal holding path '${holdingPath}' is missing or invalid.`,
      `Leave T3 stopped and inspect '${holdingPath}' manually.`,
    );
  }
  if (!sameFilesystemIdentity(filesystemIdentity(stats), expectedIdentity)) {
    throw error(
      `Removal holding path '${holdingPath}' changed unexpectedly.`,
      `Leave T3 stopped and inspect '${holdingPath}' manually.`,
    );
  }
  let canonical;
  try {
    canonical = await fs.realpath(holdingPath);
  } catch {
    throw error(
      `Cannot resolve removal holding path '${holdingPath}'.`,
      `Leave T3 stopped and inspect '${holdingPath}' manually.`,
    );
  }
  if (!isSamePath(path.dirname(canonical), chain.providerParent.canonical) ||
      !isPathWithin(chain.managedRoot.canonical, canonical)) {
    throw error(
      `Removal holding path '${holdingPath}' resolves outside the managed profile.`,
      `Leave T3 stopped and inspect '${holdingPath}' manually.`,
    );
  }
  return stats;
}

async function restoreRemovedHome({ profileHome, holdingPath, chain, expectedIdentity }) {
  const currentChain = await validateManagedProfileChain({
    managedRoot: chain.managedRoot.canonical,
    provider: path.basename(chain.providerParent.canonical),
    name: path.basename(profileHome),
  });
  if (!sameRemovalParentIdentity(removalParentIdentity(chain), removalParentIdentity(currentChain))) {
    throw error(
      `The managed profile parent changed; the profile home remains at '${holdingPath}'.`,
      "Leave T3 stopped and restore the retained directory manually.",
    );
  }
  if (currentChain.profileHome.stats) {
    throw error(
      `The original profile path '${profileHome}' is no longer empty; the profile home remains at '${holdingPath}'.`,
      "Leave T3 stopped and restore the retained directory manually.",
    );
  }
  await validateRemovalHolding({ holdingPath, chain: currentChain, expectedIdentity });
  await fs.rename(holdingPath, profileHome);
}

async function removeCommand(options) {
  const provider = validateProvider(options.provider);
  const name = validateName(options.name);
  const managedRoot = await resolveManagedRoot();
  const registryPath = path.join(managedRoot, "profiles.json");
  const registry = await readRegistry(registryPath);
  const profile = findProfile(registry.profiles, provider, name);
  if (!profile) throw error(`Profile '${provider} ${name}' is not configured.`, "Run t3-profile list.");
  const expectedHome = path.join(managedRoot, "profiles", provider, name);
  const expectedInstanceId = pathsFor({ provider, name, sourceHome: profile.sourceHome, managedRoot }).instanceId;
  if (!isSamePath(profile.profileHome, expectedHome) || profile.instanceId !== expectedInstanceId) {
    throw error(`Profile '${provider} ${name}' has unexpected managed identity fields.`, "Fix profiles.json before removing it.");
  }
  const initialChain = await validateManagedProfileChain({
    managedRoot,
    provider,
    name,
  });
  const initialParentIdentity = removalParentIdentity(initialChain);
  const initialHomeIdentity = filesystemIdentity(initialChain.profileHome.stats);
  const settings = await readSettingsDocument(t3SettingsPath());
  const existingInstance = settings.value.providerInstances?.[profile.instanceId];
  if (existingInstance && existingInstance.driver !== desiredInstance(profile).driver) {
    throw error(
      `T3 provider instance '${profile.instanceId}' uses an unexpected driver.`,
      "Resolve the collision before removing the profile.",
    );
  }
  printRemoveSummary({
    providerTitle: providerTitle(provider),
    name,
    profileHome: displayPath(profile.profileHome),
    instanceId: profile.instanceId,
  });
  if (!options.yes) {
    const confirmed = await prompt("Permanently remove this profile? [y/N] ", false);
    if (!confirmed) throw new CancelledError();
  }
  await confirmStoppedT3(options.yes);

  const finalRegistry = await readRegistry(registryPath);
  const finalProfile = findProfile(finalRegistry.profiles, provider, name);
  if (!finalProfile || !isDeepStrictEqual(finalProfile, profile)) {
    throw error("The profile registry changed while waiting for removal.", "Rerun remove to review the new state.");
  }
  const finalSettings = await readSettingsDocument(t3SettingsPath());
  const finalInstance = finalSettings.value.providerInstances?.[profile.instanceId];
  if (finalInstance && finalInstance.driver !== desiredInstance(profile).driver) {
    throw error(
      `T3 provider instance '${profile.instanceId}' changed while waiting for removal.`,
      "Rerun remove to review the new state.",
    );
  }
  const finalChain = await validateManagedProfileChain({
    managedRoot,
    provider,
    name,
  });
  if (!sameRemovalParentIdentity(initialParentIdentity, removalParentIdentity(finalChain)) ||
      !sameFilesystemIdentity(initialHomeIdentity, filesystemIdentity(finalChain.profileHome.stats))) {
    throw error("The profile home changed while waiting for removal.", "Rerun remove to review the new state.");
  }
  const nextProfiles = withoutProfile(finalRegistry.profiles, provider, name);
  const nextSettings = withoutProviderInstance(finalSettings.value, profile.instanceId);
  const removingHome = `${profile.profileHome}.removing`;
  if (finalChain.profileHome.stats) {
    if (await lstatOrNull(removingHome)) {
      throw error(`Removal holding path '${removingHome}' already exists.`, "Move it aside and retry.");
    }
    const beforeMoveChain = await validateManagedProfileChain({
      managedRoot,
      provider,
      name,
      requireHome: true,
    });
    if (!sameRemovalParentIdentity(initialParentIdentity, removalParentIdentity(beforeMoveChain)) ||
        !sameFilesystemIdentity(initialHomeIdentity, filesystemIdentity(beforeMoveChain.profileHome.stats))) {
      throw error("The managed profile changed while waiting for removal.", "Rerun remove to review the new state.");
    }
    try {
      await fs.rename(profile.profileHome, removingHome);
    } catch {
      throw error(
        `The profile home '${profile.profileHome}' could not be secured for removal.`,
        "Check its permissions and retry.",
      );
    }
    const afterMoveChain = await validateManagedProfileChain({ managedRoot, provider, name });
    if (!sameRemovalParentIdentity(initialParentIdentity, removalParentIdentity(afterMoveChain)) ||
        afterMoveChain.profileHome.stats) {
      throw error(
        `The profile home changed while moving it to '${removingHome}'.`,
        `Leave T3 stopped and retain '${removingHome}' for manual recovery.`,
      );
    }
    await validateRemovalHolding({
      holdingPath: removingHome,
      chain: afterMoveChain,
      expectedIdentity: initialHomeIdentity,
    });
  }
  try {
    await writeRemovedControlFiles({
      managedRoot,
      settings: finalSettings,
      registry: finalRegistry,
      nextSettings,
      nextProfiles,
    });
  } catch (cause) {
    if (finalChain.profileHome.stats) {
      try {
        await restoreRemovedHome({
          profileHome: profile.profileHome,
          holdingPath: removingHome,
          chain: finalChain,
          expectedIdentity: initialHomeIdentity,
        });
      } catch (restoreCause) {
        throw error(
          `${cause.message} The profile home remains at '${removingHome}': ${restoreCause.message}`,
          "Leave T3 stopped and restore the listed paths manually.",
        );
      }
    }
    throw cause;
  }
  if (finalChain.profileHome.stats) {
    const beforeDeleteChain = await validateManagedProfileChain({ managedRoot, provider, name });
    if (!sameRemovalParentIdentity(initialParentIdentity, removalParentIdentity(beforeDeleteChain)) ||
        beforeDeleteChain.profileHome.stats) {
      throw error(
        `The profile was unregistered, but removal path '${removingHome}' could not be verified.`,
        `Retain '${removingHome}' and restore or remove it manually after checking the managed chain.`,
      );
    }
    await validateRemovalHolding({
      holdingPath: removingHome,
      chain: beforeDeleteChain,
      expectedIdentity: initialHomeIdentity,
    });
    try {
      await fs.rm(removingHome, { recursive: true });
    } catch {
      throw error(
        `The profile was unregistered, but '${removingHome}' could not be deleted.`,
        `Retain '${removingHome}' and delete it manually after checking the managed chain.`,
      );
    }
  }
  printRemoved({ providerTitle: providerTitle(provider), name });
}

function diagnostic(results, level, label, message) {
  results.push({ level, label, message });
}

async function diagnosePlatform(results) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    diagnostic(results, "warn", "platform", `${process.platform} ${process.arch} is untested; only macOS 26.5 on ARM is tested.`);
    return;
  }
  const version = await inspectCommand("sw_vers", ["-productVersion"]);
  if (version.timedOut) {
    diagnostic(results, "error", "platform version", "macOS version probe timed out.");
    return;
  }
  if (!version.found) {
    diagnostic(results, "error", "platform version", "macOS version command was not found.");
    return;
  }
  const productVersion = version.found && version.code === 0 ? version.stdout.trim() : "unknown macOS version";
  diagnostic(
    results,
    productVersion === "26.5" ? "pass" : "warn",
    "platform",
    productVersion === "26.5" ? "macOS 26.5 on ARM is tested." : `${productVersion} on ARM is untested; macOS 26.5 is tested.`,
  );
}

async function diagnoseProvider(results, profile) {
  const label = `${profile.provider} ${profile.name}`;
  const environment = makeEnvironment(profile.provider, profile.profileHome);
  const version = await inspectCommand(
    providerBinary(profile.provider),
    providerVersionArguments(profile.provider),
    environment,
  );
  if (!version.found) {
    diagnostic(results, "error", `${label} binary`, `${profile.provider} was not found on PATH.`);
    return;
  }
  if (version.timedOut) {
    diagnostic(results, "error", `${label} version`, "provider version probe timed out.");
  }
  if (!version.timedOut) {
    const versionText = `${version.stdout}\n${version.stderr}`.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
    if (profile.provider === "claude" && versionText === "2.1.235") {
      diagnostic(results, "pass", `${label} version`, "Claude Code 2.1.235 is tested.");
    } else if (profile.provider === "claude") {
      diagnostic(results, "warn", `${label} version`, `Claude Code ${versionText} is untested; 2.1.235 is tested.`);
    } else {
      diagnostic(results, "warn", `${label} version`, `Codex ${versionText} is untested.`);
    }
  }
  const auth = await inspectCommand(
    providerBinary(profile.provider),
    providerAuthStatusArguments(profile.provider),
    environment,
  );
  if (auth.timedOut) {
    diagnostic(results, "error", `${label} auth`, "authentication-status probe timed out.");
  } else if (!auth.found) {
    diagnostic(results, "error", `${label} auth`, `${profile.provider} was not found on PATH.`);
  } else {
    diagnostic(
      results,
      auth.code === 0 ? "pass" : "error",
      `${label} auth`,
      auth.code === 0 ? "native CLI reports authenticated." : "native CLI reports missing or invalid authentication; run t3-profile auth.",
    );
  }
}

async function diagnoseProfile(results, profile, settings, managedRoot) {
  const label = `${profile.provider} ${profile.name}`;
  const expectedHome = path.join(managedRoot, "profiles", profile.provider, profile.name);
  const expectedInstanceId = pathsFor({
    provider: profile.provider,
    name: profile.name,
    sourceHome: profile.sourceHome,
    managedRoot,
  }).instanceId;
  const identityValid = isSamePath(profile.profileHome, expectedHome) && profile.instanceId === expectedInstanceId;
  let managedChain;
  try {
    managedChain = await validateManagedProfileChain({
      managedRoot,
      provider: profile.provider,
      name: profile.name,
      requireHome: true,
    });
  } catch (cause) {
    diagnostic(results, "error", `${label} home`, cause.message);
  }
  if (!identityValid) {
    diagnostic(results, "error", `${label} identity`, "registry identity does not match its expected managed path and instance ID.");
  } else if (managedChain) {
    try {
      await fs.access(managedChain.profileHome.canonical, 6);
      diagnostic(results, "pass", `${label} home`, "managed profile directory is readable and writable.");
    } catch {
      diagnostic(results, "error", `${label} home`, "managed profile directory is not readable and writable.");
    }
  }

  if (!(await pathExistsAsDirectory(profile.sourceHome))) {
    diagnostic(results, "error", `${label} source`, "primary source home is missing.");
  } else {
    diagnostic(results, "pass", `${label} source`, "primary source home exists.");
  }
  const existing = settings?.value.providerInstances?.[profile.instanceId];
  if (!existing) {
    diagnostic(results, "error", `${label} T3`, `instance '${profile.instanceId}' is missing; run t3-profile sync.`);
  } else {
    try {
      const reconciled = reconcileT3Instance(existing, desiredInstance(profile), profile.instanceId);
      diagnostic(
        results,
        isDeepStrictEqual(existing, reconciled) ? "pass" : "warn",
        `${label} T3`,
        isDeepStrictEqual(existing, reconciled) ? "provider instance is in sync." : "provider instance has drift; run t3-profile sync.",
      );
    } catch (cause) {
      diagnostic(results, "error", `${label} T3`, cause.message);
    }
  }

  if (profile.provider === "claude" && profile.sharing === "standard") {
    for (const link of profile.links) {
      const linkName = path.basename(link.destination);
      if (!identityValid || !managedChain) {
        diagnostic(results, "error", `${label} share ${linkName}`, "live link is invalid: managed profile home is not validated.");
        continue;
      }
      const inspection = await inspectClaudeLink(link, managedChain.profileHome.canonical);
      if (inspection.ok) {
        diagnostic(results, "pass", `${label} share ${linkName}`, "live link is healthy.");
      } else {
        diagnostic(results, "error", `${label} share ${linkName}`, `live link is invalid: ${inspection.message}.`);
      }
    }
  }
  if (identityValid && managedChain) {
    await diagnoseProvider(results, { ...profile, profileHome: managedChain.profileHome.canonical });
  }
}

async function doctorCommand(options) {
  const results = [];
  await diagnosePlatform(results);
  const managedRoot = await resolveManagedRoot();
  let registry;
  try {
    registry = await readRegistry(path.join(managedRoot, "profiles.json"));
    diagnostic(results, "pass", "registry", `${registry.profiles.length} managed profile${registry.profiles.length === 1 ? "" : "s"} loaded.`);
  } catch (cause) {
    diagnostic(results, "error", "registry", cause.message);
    printDoctor(results);
    return 1;
  }
  let settings;
  try {
    settings = await readSettingsDocument(t3SettingsPath());
    diagnostic(results, "pass", "T3 settings", "settings file is valid.");
  } catch (cause) {
    diagnostic(results, "error", "T3 settings", cause.message);
  }
  let profiles = registry.profiles;
  if (options.provider !== undefined) {
    const provider = validateProvider(options.provider);
    const name = validateName(options.name);
    const profile = findProfile(profiles, provider, name);
    if (!profile) {
      diagnostic(results, "error", `${provider} ${name}`, "profile is not configured.");
      printDoctor(results);
      return 1;
    }
    profiles = [profile];
  }
  for (const profile of profiles) await diagnoseProfile(results, profile, settings, managedRoot);
  printDoctor(results);
  return results.some((result) => result.level === "error") ? 1 : 0;
}

export async function dispatch(options) {
  if (options.command === "add") return addCommand(options);
  if (options.command === "auth") return authCommand(options);
  if (options.command === "run") return runCommand(options);
  if (options.command === "list") return listCommand();
  if (options.command === "sync") return syncCommand(options);
  if (options.command === "doctor") return doctorCommand(options);
  if (options.command === "remove") return removeCommand(options);
  throw error(`Unknown command '${options.command}'.`, "Use 't3-profile help' for usage.");
}
