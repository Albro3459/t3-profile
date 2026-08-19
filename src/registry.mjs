import path from "node:path";
import fs from "node:fs/promises";

import { readJsonFile } from "./atomic.mjs";
import { error } from "./errors.mjs";
import { validateInstanceId, validateName, validateProvider } from "./names.mjs";

function assertString(value, field, entryIndex) {
  if (typeof value !== "string" || value.length === 0) {
    throw error(`Registry entry ${entryIndex} has an invalid ${field}.`, "Fix profiles.json and retry.");
  }
}

function decodeLink(value, entryIndex, linkIndex) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error(`Registry entry ${entryIndex} has an invalid link ${linkIndex}.`, "Fix profiles.json and retry.");
  }
  assertString(value.source, "link source", entryIndex);
  assertString(value.destination, "link destination", entryIndex);
  if (!path.isAbsolute(value.source) || !path.isAbsolute(value.destination)) {
    throw error(`Registry entry ${entryIndex} has an invalid link path.`, "Fix profiles.json and retry.");
  }
  if (value.type !== "file" && value.type !== "directory") {
    throw error(`Registry entry ${entryIndex} has an invalid link type.`, "Fix profiles.json and retry.");
  }
  return {
    source: value.source,
    destination: value.destination,
    type: value.type,
  };
}

function decodeProfile(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error(`Registry entry ${index} is not an object.`, "Fix profiles.json and retry.");
  }
  validateProvider(value.provider);
  validateName(value.name);
  for (const field of ["sourceHome", "profileHome", "instanceId", "createdAt"]) {
    assertString(value[field], field, index);
  }
  if (!path.isAbsolute(value.sourceHome) || !path.isAbsolute(value.profileHome)) {
    throw error(`Registry entry ${index} has a relative home path.`, "Fix profiles.json and retry.");
  }
  validateInstanceId(value.instanceId);
  if (value.sharing !== "standard" && value.sharing !== "isolated") {
    throw error(`Registry entry ${index} has an invalid sharing mode.`, "Fix profiles.json and retry.");
  }
  if (!Array.isArray(value.links)) {
    throw error(`Registry entry ${index} has invalid links.`, "Fix profiles.json and retry.");
  }
  return {
    provider: value.provider,
    name: value.name,
    sourceHome: value.sourceHome,
    profileHome: value.profileHome,
    sharing: value.sharing,
    links: value.links.map((link, linkIndex) => decodeLink(link, index, linkIndex)),
    instanceId: value.instanceId,
    createdAt: value.createdAt,
  };
}

export async function readRegistry(registryPath) {
  const stats = await fs.lstat(registryPath).catch((cause) => {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return null;
    throw error(`Cannot inspect registry '${registryPath}'.`, "Check its permissions.");
  });
  if (!stats) return { profiles: [], exists: false, raw: null };
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw error(
      `Profile registry '${registryPath}' is not a regular file.`,
      "Move it aside or restore a regular profiles.json file.",
    );
  }
  const { raw, value } = await readJsonFile(registryPath, "profile registry");
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.profiles)) {
    throw error(`The profile registry '${registryPath}' has an invalid shape.`, "Fix profiles.json and retry.");
  }
  const profiles = value.profiles.map(decodeProfile);
  const seen = new Set();
  for (const profile of profiles) {
    const key = `${profile.provider}:${profile.name}`;
    if (seen.has(key)) throw error(`The profile registry contains duplicate '${key}'.`, "Fix profiles.json and retry.");
    seen.add(key);
  }
  return { profiles, exists: true, raw };
}

export function serializeRegistry(profiles) {
  return { profiles };
}

export function findProfile(profiles, provider, name) {
  return profiles.find((profile) => profile.provider === provider && profile.name === name);
}

export function findByInstanceId(profiles, instanceId) {
  return profiles.find((profile) => profile.instanceId === instanceId);
}
