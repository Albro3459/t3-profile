import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { error } from "./errors.mjs";
import { instanceId, validateName, validateProvider } from "./names.mjs";

export function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function absolutePath(value, base = process.cwd()) {
  return path.resolve(base, expandHome(value));
}

export async function lstatOrNull(value) {
  try {
    return await fs.lstat(value);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
    throw cause;
  }
}

export async function requireDirectory(value, label) {
  const absolute = absolutePath(value);
  let stats;
  try {
    stats = await fs.stat(absolute);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      throw error(
        `${label} '${absolute}' does not exist.`,
        "Create it first or pass an existing directory with --home.",
      );
    }
    throw error(`Cannot inspect ${label.toLowerCase()} '${absolute}'.`, "Check its permissions.");
  }
  if (!stats.isDirectory()) {
    throw error(`${label} '${absolute}' is not a directory.`, "Pass a directory path.");
  }
  return fs.realpath(absolute);
}

export async function requireFile(value, label) {
  const absolute = absolutePath(value);
  let stats;
  try {
    stats = await fs.stat(absolute);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      throw error(
        `${label} '${absolute}' does not exist.`,
        "Initialize T3 Code before using t3-profile.",
      );
    }
    throw error(`Cannot inspect ${label.toLowerCase()} '${absolute}'.`, "Check its permissions.");
  }
  if (!stats.isFile()) {
    throw error(`${label} '${absolute}' is not a regular file.`, "Check the T3 installation.");
  }
  return fs.realpath(absolute);
}

export async function resolveManagedRoot() {
  const configured = process.env.T3_PROFILE_HOME?.trim();
  const candidate = absolutePath(configured || path.join(os.homedir(), ".t3-profile"));
  const existing = await fs.stat(candidate).catch((cause) => {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
    throw error(`Cannot inspect managed root '${candidate}'.`, "Check its permissions.");
  });
  if (existing) {
    if (!existing.isDirectory()) {
      throw error(
        `Managed root '${candidate}' is not a directory.`,
        "Move it aside or set T3_PROFILE_HOME to a directory.",
      );
    }
    return fs.realpath(candidate);
  }
  return canonicalizeMissingPath(candidate);
}

async function canonicalizeMissingPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    const stats = await fs.stat(current).catch((cause) => {
      if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
      throw error(`Cannot inspect managed root parent '${current}'.`, "Check its permissions.");
    });
    if (stats) {
      if (!stats.isDirectory()) {
        throw error(
          `Managed root parent '${current}' is not a directory.`,
          "Choose a different T3_PROFILE_HOME.",
        );
      }
      const realParent = await fs.realpath(current);
      return path.join(realParent, ...suffix);
    }
    const parent = path.dirname(current);
    suffix.unshift(path.basename(current));
    if (parent === current) return path.resolve(value);
    current = parent;
  }
}

export function t3HomePath() {
  const configured = process.env.T3CODE_HOME?.trim();
  return absolutePath(configured || path.join(os.homedir(), ".t3"));
}

export function pathsFor({ provider, name, sourceHome, managedRoot }) {
  validateProvider(provider);
  validateName(name);
  const profileHome = path.join(managedRoot, "profiles", provider, name);
  return {
    managedRoot,
    registryPath: path.join(managedRoot, "profiles.json"),
    backupsPath: path.join(managedRoot, "backups"),
    profileHome,
    sourceHome,
    settingsPath: path.join(t3HomePath(), "settings.json"),
    instanceId: instanceId(provider, name),
  };
}

export function isSamePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

export function isPathWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function pathsOverlap(left, right) {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

export function displayPath(value) {
  const absolute = path.resolve(value);
  const home = path.resolve(os.homedir());
  if (isSamePath(absolute, home)) return "~";
  if (isPathWithin(home, absolute)) return `~${path.sep}${path.relative(home, absolute)}`;
  return absolute;
}
