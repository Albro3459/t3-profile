import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { error } from "./errors.mjs";
import { lstatOrNull } from "./paths.mjs";

async function temporaryPath(target) {
  const suffix = crypto.randomBytes(8).toString("hex");
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${suffix}.tmp`);
}

async function replaceTarget(temporary, target) {
  const delays = [0, 10, 25, 50, 100, 200];
  let lastCause;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await fs.rename(temporary, target);
      return;
    } catch (cause) {
      lastCause = cause;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(cause?.code)) {
        throw cause;
      }
    }
  }
  throw lastCause;
}

export async function writeAtomic(target, data, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = await stageFile(target, data, mode);
  await replaceStaged(temporary, target);
}

async function stageFile(target, data, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = await temporaryPath(target);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", mode === undefined ? 0o600 : mode);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (cause) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

async function replaceStaged(temporary, target) {
  try {
    await replaceTarget(temporary, target);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

export async function backupFile(source, backupsDirectory, data) {
  const existingDirectory = await lstatOrNull(backupsDirectory);
  if (existingDirectory && (existingDirectory.isSymbolicLink() || !existingDirectory.isDirectory())) {
    throw error(
      `Backup directory '${backupsDirectory}' is not a managed directory.`,
      "Move it aside or choose a different T3_PROFILE_HOME.",
    );
  }
  await fs.mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
  const raw = data ?? await fs.readFile(source);
  const backup = path.join(
    backupsDirectory,
    `settings.json.${new Date().toISOString().replaceAll(/[:.]/g, "-")}.${process.pid}.bak`,
  );
  await writeAtomic(backup, raw, 0o600);
  return backup;
}

export async function readCurrentFile(filePath, label = "file") {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      return { exists: false, raw: null, mode: undefined };
    }
    throw error(`Cannot inspect ${label} '${filePath}'.`, "Check its permissions.");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw error(`The ${label} '${filePath}' is not a regular file.`, "Restore a regular file and retry.");
  }
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw error(`Cannot read ${label} '${filePath}'.`, "Check its permissions.");
  }
  return { exists: true, raw, mode: stats.mode & 0o777 };
}

function sameFileContents(current, expectedRaw) {
  return expectedRaw === null
    ? !current.exists
    : current.exists && current.raw === expectedRaw;
}

export async function writeAtomicIfUnchanged(
  filePath,
  expectedRaw,
  nextRaw,
  mode,
  label = "file",
) {
  const modeToUse = mode ?? (await readCurrentFile(filePath, label)).mode ?? 0o600;
  const temporary = await stageFile(filePath, nextRaw, modeToUse);
  const current = await readCurrentFile(filePath, label);
  if (!sameFileContents(current, expectedRaw)) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error(
      `${label} '${filePath}' changed while waiting to be updated.`,
      "Rerun the operation to review the new state.",
    );
  }
  await replaceStaged(temporary, filePath);
}

export async function restoreAtomicIfUnchanged(
  filePath,
  writtenRaw,
  originalRaw,
  originalMode,
  label = "file",
) {
  const current = await readCurrentFile(filePath, label);
  if (!sameFileContents(current, writtenRaw)) {
    throw error(
      `${label} '${filePath}' changed before rollback.`,
      "Leave T3 stopped and restore the file manually before retrying.",
    );
  }
  if (originalRaw === null) {
    const beforeRemove = await readCurrentFile(filePath, label);
    if (!sameFileContents(beforeRemove, writtenRaw)) {
      throw error(
        `${label} '${filePath}' changed before rollback.`,
        "Leave T3 stopped and restore the file manually before retrying.",
      );
    }
    if (beforeRemove.exists) {
      const stats = await fs.lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw error(`The ${label} '${filePath}' is not a regular file.`, "Restore a regular file and retry.");
      }
      await fs.unlink(filePath);
    }
    return;
  }
  const temporary = await stageFile(filePath, originalRaw, originalMode ?? current.mode ?? 0o600);
  const beforeReplace = await readCurrentFile(filePath, label);
  if (!sameFileContents(beforeReplace, writtenRaw)) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error(
      `${label} '${filePath}' changed before rollback.`,
      "Leave T3 stopped and restore the file manually before retrying.",
    );
  }
  await replaceStaged(temporary, filePath);
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
