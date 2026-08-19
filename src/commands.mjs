import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { existingMode, removeCreatedPath, writeAtomic, writeJsonAtomic } from "./atomic.mjs";
import { CancelledError, error } from "./errors.mjs";
import { createLinks, inspectClaudeResources, preflightLinks, rollbackLinks } from "./links.mjs";
import {
  instanceId,
  providerDriver,
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
import { makeEnvironment, buildT3Instance, providerBinary, sharingSummary } from "./providers.mjs";
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
  restoreSettings,
  verifySettings,
} from "./settings.mjs";
import {
  printAddSummary,
  printCreated,
  printList,
  writeLine,
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

async function prepareAdd(options) {
  const provider = validateProvider(options.provider);
  const name = validateName(options.name);
  const managedRoot = await resolveManagedRoot();
  const sourceHome = await requireDirectory(options.home ?? defaultSource(provider), "Primary home");
  const paths = pathsFor({ provider, name, sourceHome, managedRoot });
  await requireFile(paths.settingsPath, "T3 settings");
  const registry = await readRegistry(paths.registryPath);
  const settings = await readSettingsDocument(paths.settingsPath);

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

  const instance = buildT3Instance({ provider, profileHome: paths.profileHome, sourceHome, sharing });
  const nextSettings = buildNextSettings({
    document: settings.value,
    provider,
    sourceHome,
    profileHome: paths.profileHome,
    instanceId: paths.instanceId,
    instance,
    customHome: options.home !== undefined,
  });
  return {
    ...options,
    provider,
    name,
    sharing,
    managedRoot,
    sourceHome,
    paths,
    registry,
    settings,
    nextSettings,
    instance,
    resources,
    primaryValues: options.home === undefined ? [] : settingsPrimarySummary(settings.value, provider),
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

async function mutateAdd(prepared) {
  const { paths, registry, settings } = prepared;
  const createdLinks = [];
  let profileCreated = false;
  let settingsChanged = false;
  let registryChanged = false;
  const registryMode = await existingMode(paths.registryPath, 0o600);
  try {
    await fs.mkdir(paths.profileHome, { recursive: true, mode: 0o700 });
    profileCreated = true;
    if (prepared.provider === "claude" && prepared.sharing === "standard") {
      createdLinks.push(...await createLinks(prepared.resources.available.map((resource) => ({
        ...resource,
        source: resource.source,
      }))));
    }
    const registryEntry = {
      provider: prepared.provider,
      name: prepared.name,
      sourceHome: prepared.sourceHome,
      profileHome: paths.profileHome,
      sharing: prepared.sharing,
      links: prepared.resources.available.map((resource) => ({
        source: resource.source,
        destination: resource.destination,
        type: resource.type,
      })),
      instanceId: paths.instanceId,
      createdAt: new Date().toISOString(),
    };
    await backupAndWriteSettings({
      settingsPath: paths.settingsPath,
      backupsPath: paths.backupsPath,
      raw: settings.raw,
      next: prepared.nextSettings,
    });
    settingsChanged = true;
    await writeJsonAtomic(
      paths.registryPath,
      serializeRegistry([...registry.profiles, registryEntry]),
      registryMode,
    );
    registryChanged = true;
    await verifySettings(
      paths.settingsPath,
      paths.instanceId,
      prepared.instance,
      prepared.home === undefined
        ? []
        : primaryHomeValues(prepared.nextSettings, prepared.provider).map((value) => ({
            ...value,
            provider: prepared.provider,
            expected: prepared.sourceHome,
          })),
    );
    const writtenRegistry = await readRegistry(paths.registryPath);
    if (!findProfile(writtenRegistry.profiles, prepared.provider, prepared.name)) {
      throw error("Profile registry verification failed.", "Restore the settings backup and retry.");
    }
    return registryEntry;
  } catch (cause) {
    if (registryChanged) {
      if (registry.exists && registry.raw !== null) await writeAtomic(paths.registryPath, registry.raw, registryMode);
      else await fs.unlink(paths.registryPath).catch(() => {});
    }
    if (settingsChanged) await restoreSettings(paths.settingsPath, settings.raw, settings.mode).catch(() => {});
    await rollbackLinks(createdLinks);
    if (profileCreated) await removeCreatedPath(paths.profileHome).catch(() => {});
    throw cause;
  }
}

async function addCommand(options) {
  const prepared = await prepareAdd(options);
  await confirmStopped(prepared);
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

async function runProvider(binary, argumentsToPass, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argumentsToPass, { env: environment, stdio: "inherit" });
    child.once("error", (cause) => {
      if (cause?.code === "ENOENT") {
        reject(error(`The '${binary}' command was not found.`, `Install ${binary} and ensure it is on PATH.`));
      } else {
        reject(error(`Could not start '${binary}'.`, "Check its permissions and retry."));
      }
    });
    child.once("close", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function authCommand(options) {
  const profile = await loadProfile(options.provider, options.name);
  if (!(await pathExistsAsDirectory(profile.profileHome))) {
    throw error(`Profile home '${profile.profileHome}' does not exist.`, "Recreate the profile before authenticating.");
  }
  return runProvider(
    providerBinary(profile.provider),
    ["auth", "login"],
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
