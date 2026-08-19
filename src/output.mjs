import { VERSION } from "./version.mjs";
import { formatResetTime } from "./usage.mjs";

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

function paint(code, value) {
  return useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export function writeLine(value = "") {
  process.stdout.write(`${value}\n`);
}

export function writeError(value) {
  process.stderr.write(`${value}\n`);
}

export function printHelp() {
  writeLine(`t3-profile ${VERSION}

Usage:
  t3-profile help
  t3-profile version
  t3-profile add <claude|codex> <name> [--home <path>] [--isolated] [--skip-auth] [--yes]
  t3-profile auth <claude|codex> <name>
  t3-profile run <claude|codex> <name> [-- provider arguments]
  t3-profile list
  t3-profile sync [--dry-run] [--yes]
  t3-profile doctor [<claude|codex> <name>]
  t3-profile remove <claude|codex> <name> [--yes]

Names must be lowercase and match ^[a-z][a-z0-9_-]{0,47}$.

Options:
  --home <path>  Use an existing primary provider home as the sharing source.
  --isolated     Create an independent profile without shared resources.
  --skip-auth    Create the profile without starting provider authentication.
  --dry-run      Show the changes sync would make without writing them.
  --yes          For add, select standard sharing. For add, sync, or remove,
                 assert that T3 is stopped and accept the command's other
                 confirmations. Validation and drift checks still run.
  help, --help, -h
                 Show this help.
  version, --version, -v
                 Show the version.

Confirmation behavior:
  add prompts after the creation/sharing summary and before mutation.
  mutating sync prompts after its deterministic plan and before mutation.
  remove first asks for destructive consent, then immediately asks whether
  T3 is stopped before mutation. The stopped-T3 prompt is:
  T3 is fully stopped and ready to update? [y/N]
  sync --dry-run and synchronized sync no-ops, read-only list and doctor, and
  provider-only auth and run do not show the stopped-T3 prompt or require T3
  to be stopped. Declining any shown confirmation prevents mutation. Declining
  remove's destructive consent does not continue to the stopped-T3 prompt.
  Native provider CLIs may still prompt natively.`);
}

export function printCancelled() {
  writeLine("Cancelled. No changes were made.");
}

function valueOrUnset(value) {
  return value === undefined || value === "" ? "<unset>" : value;
}

export function printAddSummary({
  providerTitle,
  name,
  sourceHome,
  profileHome,
  sharing,
  summary,
  customHome,
  primaryValues,
  t3SettingsPath,
}) {
  writeLine(`Create ${providerTitle} profile "${name}"?`);
  writeLine("");
  writeLine(`Primary home: ${sourceHome}`);
  writeLine(`Profile home: ${profileHome}`);
  writeLine(`Sharing:      ${sharing === "standard" ? "Standard" : "Isolated"}`);
  if (customHome) {
    writeLine("");
    writeLine("Primary/default T3 home update");
    if (primaryValues.length === 0) {
      writeLine(`  <unset> -> ${sourceHome}`);
    } else {
      for (const primary of primaryValues) {
        writeLine(`  ${primary.label}: ${valueOrUnset(primary.value)} -> ${sourceHome}`);
      }
    }
    writeLine(`  Settings: ${t3SettingsPath}`);
  }
  writeLine("");
  writeLine("Live shared");
  if (summary.live.length === 0) writeLine("  (none)");
  else for (const item of summary.live) writeLine(`  ${item}`);
  if (summary.skipped.length > 0) {
    writeLine("");
    writeLine("Skipped because missing");
    for (const item of summary.skipped) writeLine(`  ${item}`);
  }
  writeLine("");
  writeLine("Private");
  for (const item of summary.private) writeLine(`  ${item}`);
  writeLine("");
  writeLine(summary.note);
  if (sharing === "standard") {
    writeLine("Shared resources are live links. Changes affect every linked profile.");
    writeLine("Credentials are never copied by t3-profile.");
  }
  writeLine("");
  writeLine("Quit T3 Code and stop every `t3 serve` and `t3 connect` process.");
}

export function printCreated({ providerTitle, name, profileHome, sharing, skipAuth }) {
  writeLine(`Created ${providerTitle} profile "${name}".`);
  writeLine("");
  writeLine(`Home:    ${profileHome}`);
  writeLine(`Sharing: ${sharing === "standard" ? "Standard" : "Isolated"}`);
  writeLine("");
  if (skipAuth) {
    writeLine("Next:");
    writeLine(`  1. Run \`t3-profile auth ${providerTitle.toLowerCase()} ${name}\`.`);
    writeLine("  2. Restart T3 Code after authentication completes.");
  } else {
    writeLine("Starting provider authentication...");
  }
}

export function printAuthenticated() {
  writeLine("");
  writeLine("Authentication completed. Restart T3 Code.");
}

export function printAuthenticationIncomplete(provider, name) {
  writeError("");
  writeError(`Profile creation succeeded, but authentication did not. Rerun: t3-profile auth ${provider} ${name}`);
}

export function printSyncSummary(changes, dryRun) {
  if (changes.length === 0) {
    writeLine("T3 provider instances are already in sync.");
    return;
  }
  writeLine(dryRun ? "Sync dry run:" : "Sync T3 provider instances?");
  writeLine("");
  for (const change of changes) writeLine(`  ${change.action.padEnd(6)} ${change.instanceId}`);
}

export function printSynced(count, backupPath) {
  writeLine(`Synced ${count} T3 provider instance${count === 1 ? "" : "s"}.`);
  writeLine(`Settings backup: ${backupPath}`);
  writeLine("Restart T3 Code.");
}

export function printRemoveSummary({ providerTitle, name, profileHome, instanceId }) {
  writeLine(`Remove ${providerTitle} profile "${name}"?`);
  writeLine("");
  writeLine(`Profile home: ${profileHome}`);
  writeLine(`T3 instance:  ${instanceId}`);
  writeLine("");
  writeLine("The managed profile home, including private files and local history stored there, will be permanently deleted.");
  writeLine("Removal does not perform native logout or token revocation.");
  writeLine("Credentials may remain in macOS Keychain or another provider credential store until you revoke them or log out separately.");
  writeLine("Quit T3 Code and stop every `t3 serve` and `t3 connect` process.");
}

export function printRemoved({ providerTitle, name }) {
  writeLine(`Removed ${providerTitle} profile "${name}".`);
  writeLine("Restart T3 Code.");
}

export function printDoctor(results) {
  for (const result of results) {
    writeLine(`${result.level.toUpperCase().padEnd(5)} ${result.label}: ${result.message}`);
  }
  const errors = results.filter((result) => result.level === "error").length;
  const warnings = results.filter((result) => result.level === "warn").length;
  const passes = results.filter((result) => result.level === "pass").length;
  writeLine("");
  writeLine(`${passes} passed, ${warnings} warning${warnings === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}.`);
}

export function printList(profiles) {
  if (profiles.length === 0) {
    writeLine("No profiles configured.");
    return;
  }
  const rows = profiles
    .slice()
    .sort((left, right) => `${left.provider}:${left.name}`.localeCompare(`${right.provider}:${right.name}`))
    .map((profile) => ({
      values: [profile.provider, profile.name, profile.sharing, profile.profileHome],
      usage: renderUsage(profile.usage, profile.displayTimezone),
    }));
  const headings = ["PROVIDER", "NAME", "SHARING", "HOME", "USAGE"];
  const widths = headings.slice(0, 4).map((heading, index) => Math.max(heading.length, ...rows.map((row) => row.values[index].length)));
  const usageStart = widths.reduce((total, width) => total + width, 0) + 2 * 4;
  writeLine([
    ...headings.slice(0, 4).map((heading, index) => paint("1", heading.padEnd(widths[index]))),
    paint("1", "USAGE"),
  ].join("  "));
  for (const row of rows) {
    const prefix = row.values.map((value, index) => value.padEnd(widths[index])).join("  ");
    writeLine(`${prefix}  ${row.usage[0]}`);
    for (const line of row.usage.slice(1)) writeLine(`${" ".repeat(usageStart)}${line}`);
  }
}

function renderUsage(usage, timezone = "UTC") {
  if (!usage || usage.status !== "available" || !Array.isArray(usage.windows) || usage.windows.length === 0) {
    return ["unavailable"];
  }
  const byId = new Map(usage.windows.map((window) => [window.id, window]));
  const lines = [];
  for (const id of ["five_hour", "week"]) {
    const window = byId.get(id);
    if (!window) continue;
    const label = id === "five_hour" ? "5h" : "week";
    if (window.status !== "available") {
      lines.push(`${label} unavailable`);
      continue;
    }
    if (typeof window.percent !== "number" || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) {
      lines.push(`${label} unavailable`);
      continue;
    }
    const reset = formatResetTime(window.resetsAt, timezone);
    lines.push(reset === null ? `${label} unavailable` : `${label} ${Math.round(window.percent)}% · resets ${reset}`);
  }
  return lines.length > 0 ? lines : ["unavailable"];
}
