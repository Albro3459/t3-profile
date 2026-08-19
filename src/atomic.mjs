import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { error } from "./errors.mjs";
import { lstatOrNull } from "./paths.mjs";

async function temporaryPath(target) {
  const suffix = crypto.randomBytes(8).toString("hex");
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${suffix}.tmp`);
}

export async function writeAtomic(target, data, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = await temporaryPath(target);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", mode === undefined ? 0o600 : mode);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
  } catch (cause) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

export async function writeJsonAtomic(target, value, mode) {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function backupFile(source, backupsDirectory) {
  await fs.mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
  const raw = await fs.readFile(source);
  const backup = path.join(
    backupsDirectory,
    `settings.json.${new Date().toISOString().replaceAll(/[:.]/g, "-")}.${process.pid}.bak`,
  );
  await writeAtomic(backup, raw, 0o600);
  return backup;
}

export async function removeCreatedPath(value) {
  await fs.rm(value, { recursive: true, force: true });
}

export async function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    throw error(`Cannot read ${label} '${filePath}'.`, "Check its permissions.");
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    throw error(`The ${label} '${filePath}' is not valid JSON.`, "Fix the file and retry.");
  }
}

export async function existingMode(filePath, fallback = 0o600) {
  const stats = await lstatOrNull(filePath);
  return stats?.mode === undefined ? fallback : stats.mode & 0o777;
}
