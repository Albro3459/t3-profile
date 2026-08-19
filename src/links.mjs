import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { error } from "./errors.mjs";
import { isSamePath, pathsOverlap } from "./paths.mjs";

const CLAUDE_MANIFEST = [
  { name: "settings.json", type: "file" },
  { name: "skills/", sourceName: "skills", type: "directory" },
  { name: "agents/", sourceName: "agents", type: "directory" },
  { name: "CLAUDE.md", type: "file" },
];

function linkKind(type) {
  if (process.platform !== "win32") return type === "directory" ? "dir" : "file";
  return type === "directory" ? "junction" : "file";
}

function sourceNameFor(entry) {
  return entry.sourceName ?? entry.name.replace(/\/$/, "");
}

export async function inspectClaudeResources(sourceHome, profileHome) {
  const available = [];
  const skipped = [];
  for (const entry of CLAUDE_MANIFEST) {
    const source = path.join(sourceHome, sourceNameFor(entry));
    let stats;
    try {
      stats = await fs.stat(source);
    } catch (cause) {
      if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
        skipped.push(entry.name);
        continue;
      }
      throw error(`Cannot inspect shared Claude resource '${source}'.`, "Check its permissions.");
    }
    if (entry.type === "directory" && !stats.isDirectory()) {
      throw error(
        `Claude resource '${source}' is not a directory.`,
        "Fix the source home or use --isolated.",
      );
    }
    if (entry.type === "file" && !stats.isFile()) {
      throw error(
        `Claude resource '${source}' is not a regular file.`,
        "Fix the source home or use --isolated.",
      );
    }
    const realSource = await fs.realpath(source);
    available.push({
      name: entry.name,
      source: path.resolve(source),
      realSource,
      destination: path.join(profileHome, sourceNameFor(entry)),
      type: entry.type,
    });
  }
  return { available, skipped };
}

async function probeLink(type) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3-profile-link-"));
  const source = path.join(temporaryRoot, "source");
  const destination = path.join(temporaryRoot, "destination");
  try {
    if (type === "directory") await fs.mkdir(source);
    else await fs.writeFile(source, "");
    await fs.symlink(source, destination, linkKind(type));
    await fs.lstat(destination);
  } catch (cause) {
    const platformHint =
      process.platform === "win32"
        ? "Enable Windows Developer Mode or retry with --isolated."
        : "Check filesystem permissions and retry with --isolated.";
    throw error(
      `The platform cannot create required ${type} live links.`,
      platformHint,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function preflightLinks({ provider, sharing, sourceHome, profileHome, resources }) {
  if (sharing !== "standard") return;
  if (provider === "codex") {
    if (pathsOverlap(sourceHome, profileHome)) {
      throw error(
        "The source home and managed profile path overlap.",
        "Choose a managed root outside the provider source home.",
      );
    }
    // T3 materializes Codex's native shadow home after restart. Probe both
    // link kinds before t3-profile changes either the profile or settings.
    await probeLink("directory");
    await probeLink("file");
    return;
  }
  if (provider !== "claude") return;
  if (pathsOverlap(sourceHome, profileHome)) {
    throw error(
      "The source home and managed profile path overlap.",
      "Choose a managed root outside the provider source home.",
    );
  }
  for (const resource of resources.available) {
    if (resource.type === "directory" && pathsOverlap(resource.realSource, resource.destination)) {
      throw error(
        `The shared Claude directory '${resource.name}' overlaps its managed destination.`,
        "Choose a different managed root.",
      );
    }
    if (resource.type === "file" && isSamePath(resource.realSource, resource.destination)) {
      throw error(
        `The shared Claude resource '${resource.name}' would link to itself.`,
        "Choose a different managed root.",
      );
    }
  }
  const kinds = new Set(resources.available.map((resource) => resource.type));
  for (const type of kinds) await probeLink(type);
}

function resourceTypeMatches(stats, type) {
  return type === "directory" ? stats.isDirectory() : stats.isFile();
}

async function revalidateSource(resource) {
  let realSource;
  try {
    realSource = await fs.realpath(resource.source);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      throw error(
        `The shared Claude resource '${resource.name}' is no longer available.`,
        "Restore it and retry.",
      );
    }
    throw error(
      `Cannot resolve shared Claude resource '${resource.source}'.`,
      "Check its permissions and retry.",
    );
  }

  let stats;
  try {
    stats = await fs.stat(resource.source);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      throw error(
        `The shared Claude resource '${resource.name}' is no longer available.`,
        "Restore it and retry.",
      );
    }
    throw error(
      `Cannot inspect shared Claude resource '${resource.source}'.`,
      "Check its permissions and retry.",
    );
  }
  if (!resourceTypeMatches(stats, resource.type)) {
    throw error(
      `The shared Claude resource '${resource.name}' changed type while preparing the profile.`,
      "Restore the original resource and retry.",
    );
  }
  if (resource.realSource !== undefined && !isSamePath(realSource, resource.realSource)) {
    throw error(
      `The shared Claude resource '${resource.name}' changed while preparing the profile.`,
      "Rerun add to review the new source target.",
    );
  }
  return { ...resource, realSource };
}

function assertSafeClaudeResource(resource) {
  if (resource.type === "directory" && pathsOverlap(resource.realSource, resource.destination)) {
    throw error(
      `The shared Claude directory '${resource.name}' overlaps its managed destination.`,
      "Choose a different managed root.",
    );
  }
  if (resource.type === "file" && isSamePath(resource.realSource, resource.destination)) {
    throw error(
      `The shared Claude resource '${resource.name}' would link to itself.`,
      "Choose a different managed root.",
    );
  }
}

async function existingLinkTarget(destination) {
  try {
    return await fs.realpath(destination);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      throw error(
        `The managed Claude link '${destination}' is broken.`,
        "Move it aside or choose a new profile name.",
      );
    }
    throw error(
      `Cannot resolve managed Claude link '${destination}'.`,
      "Check its permissions and retry.",
    );
  }
}

async function verifyLink(resource) {
  const stats = await fs.lstat(resource.destination).catch((cause) => {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
    throw cause;
  });
  if (!stats?.isSymbolicLink()) {
    throw error(
      `The managed Claude link '${resource.destination}' is missing or is not a link.`,
      "Restore the link or retry with a new profile name.",
    );
  }
  const target = await existingLinkTarget(resource.destination);
  if (!isSamePath(target, resource.realSource)) {
    throw error(
      `The managed Claude link '${resource.destination}' points to an unexpected source.`,
      "Move it aside or choose a new profile name.",
    );
  }
  const targetStats = await fs.stat(resource.destination).catch((cause) => {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
    throw cause;
  });
  if (!targetStats || !resourceTypeMatches(targetStats, resource.type)) {
    throw error(
      `The managed Claude link '${resource.destination}' has an unexpected type.`,
      "Restore the source resource and retry.",
    );
  }
  return resource.destination;
}

export async function verifyClaudeLinks(resources) {
  const verified = [];
  for (const resource of resources) verified.push(await verifyLink(resource));
  return verified;
}

export async function createLinks(resources) {
  const created = [];
  try {
    const validatedResources = [];
    for (const resource of resources) {
      const validated = await revalidateSource(resource);
      assertSafeClaudeResource(validated);
      validatedResources.push(validated);
    }
    for (let index = 0; index < validatedResources.length; index += 1) {
      const resource = await revalidateSource(validatedResources[index]);
      assertSafeClaudeResource(resource);
      validatedResources[index] = resource;
      const existing = await fs.lstat(resource.destination).catch((cause) => {
        if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
        throw cause;
      });
      if (existing) {
        if (!existing.isSymbolicLink()) {
          throw error(
            `The managed Claude destination '${resource.destination}' already exists.`,
            "Move it aside or choose a new profile name.",
          );
        }
        const existingTarget = await existingLinkTarget(resource.destination);
        if (!isSamePath(existingTarget, resource.realSource)) {
          throw error(
            `The managed Claude link '${resource.destination}' points to an unexpected source.`,
            "Move it aside or choose a new profile name.",
          );
        }
        continue;
      }
      await fs.symlink(resource.source, resource.destination, linkKind(resource.type));
      const ownership = {
        destination: resource.destination,
        realSource: resource.realSource,
        identity: null,
      };
      created.push(ownership);
      const createdStats = await fs.lstat(resource.destination, { bigint: true });
      if (!createdStats.isSymbolicLink()) {
        throw new Error("created destination is no longer a symbolic link");
      }
      ownership.identity = linkIdentity(createdStats);
      const createdTarget = await existingLinkTarget(resource.destination);
      if (!isSamePath(createdTarget, resource.realSource)) {
        throw new Error("created link target changed before rollback ownership was recorded");
      }
    }
    await verifyClaudeLinks(validatedResources);
    return created;
  } catch (cause) {
    const rollbackFailures = await rollbackLinks(created);
    cause.createdLinks = [...created];
    if (rollbackFailures.length > 0) cause.linkRollbackFailures = rollbackFailures;
    throw cause;
  }
}

export async function rollbackLinks(created) {
  const failures = [];
  for (const entry of [...created].reverse()) {
    const ownership = typeof entry === "string"
      ? { destination: entry, realSource: undefined, identity: null }
      : entry;
    const destination = ownership.destination;
    try {
      const stats = await fs.lstat(destination, { bigint: true }).catch((cause) => {
        if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
        throw cause;
      });
      if (!stats) continue;
      if (!stats.isSymbolicLink()) {
        throw new Error("destination is no longer a symbolic link");
      }
      if (!ownership.identity || !sameLinkIdentity(stats, ownership.identity)) {
        throw new Error("link ownership cannot be established; destination was replaced");
      }
      if (ownership.realSource !== undefined) {
        const target = await existingLinkTarget(destination);
        if (!isSamePath(target, ownership.realSource)) {
          throw new Error("link target changed; destination ownership cannot be established");
        }
      }
      await fs.unlink(destination);
    } catch (cause) {
      failures.push({ path: destination, cause });
    }
  }
  return failures;
}

function linkIdentity(stats) {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  };
}

function sameLinkIdentity(stats, expected) {
  const actual = linkIdentity(stats);
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.ctimeNs === expected.ctimeNs
    && actual.birthtimeNs === expected.birthtimeNs;
}
