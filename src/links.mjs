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
    if (isSamePath(resource.realSource, resource.destination)) {
      throw error(
        `The shared Claude resource '${resource.name}' would link to itself.`,
        "Choose a different managed root.",
      );
    }
  }
  const kinds = new Set(resources.available.map((resource) => resource.type));
  for (const type of kinds) await probeLink(type);
}

async function resolveExistingLink(destination) {
  const target = await fs.readlink(destination);
  return path.resolve(path.dirname(destination), target);
}

export async function createLinks(resources) {
  const created = [];
  try {
    for (const resource of resources) {
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
        const existingTarget = await resolveExistingLink(resource.destination);
        if (!isSamePath(existingTarget, resource.realSource)) {
          throw error(
            `The managed Claude link '${resource.destination}' points to an unexpected source.`,
            "Move it aside or choose a new profile name.",
          );
        }
        continue;
      }
      await fs.symlink(resource.source, resource.destination, linkKind(resource.type));
      created.push(resource.destination);
    }
    return created;
  } catch (cause) {
    await rollbackLinks(created);
    throw cause;
  }
}

export async function rollbackLinks(created) {
  for (const destination of [...created].reverse()) {
    const stats = await fs.lstat(destination).catch(() => null);
    if (stats?.isSymbolicLink()) await fs.unlink(destination).catch(() => {});
  }
}
