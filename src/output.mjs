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
  t3-profile usage
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
  sync --dry-run and synchronized sync no-ops, read-only list, usage, and
  doctor, and provider-only auth and run do not show the stopped-T3 prompt or
  require T3 to be stopped. Declining any shown confirmation prevents mutation.
  Declining remove's destructive consent does not continue to the stopped-T3
  prompt. Native provider CLIs may still prompt natively.`);
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
    }));
  const headings = ["PROVIDER", "NAME", "SHARING", "HOME"];
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row.values[index].length)));
  const wideWidth = widths.reduce((total, width) => total + width, 0) + 2 * 3;
  if (wideWidth <= terminalWidth()) {
    writeLine(headings.map((heading, index) => paint(
      "1",
      index === headings.length - 1 ? heading : heading.padEnd(widths[index]),
    )).join("  "));
    for (const row of rows) {
      writeLine(row.values.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd());
    }
    return;
  }
  printNarrowList(rows);
}

function terminalWidth() {
  return Number.isInteger(process.stdout.columns) && process.stdout.columns > 0
    ? process.stdout.columns
    : Number.POSITIVE_INFINITY;
}

function usageRows(usage, timezone = "UTC") {
  if (!usage || usage.status !== "available" || !Array.isArray(usage.windows) || usage.windows.length === 0) {
    return [{ interval: "", percent: null, reset: "unavailable" }];
  }
  const byId = new Map(usage.windows.map((window) => [window.id, window]));
  const rows = [];
  for (const id of ["five_hour", "week"]) {
    const window = byId.get(id);
    if (!window) continue;
    const interval = id === "five_hour" ? "5h" : "7d";
    if (window.status === "inactive") {
      rows.push({ interval, percent: 0, reset: "not started" });
      continue;
    }
    if (window.status !== "available" || typeof window.percent !== "number" || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) {
      rows.push({ interval, percent: null, reset: "unavailable" });
      continue;
    }
    const reset = formatResetTime(window.resetsAt, timezone);
    rows.push(reset === null
      ? { interval, percent: null, reset: "unavailable" }
      : { interval, percent: Math.round(window.percent), reset });
  }
  return rows.length > 0 ? rows : [{ interval: "", percent: null, reset: "unavailable" }];
}

export function printUsage(profiles) {
  if (profiles.length === 0) {
    writeLine("No profiles configured.");
    return;
  }
  const rows = profiles
    .slice()
    .sort((left, right) => `${left.provider}:${left.name}`.localeCompare(`${right.provider}:${right.name}`))
    .map((profile) => ({
      values: [profile.provider, profile.name],
      usage: usageRows(profile.usage, profile.displayTimezone),
    }));
  const headings = ["PROVIDER", "NAME", "WINDOW", "%", "RESETS"];
  const identityWidths = headings.slice(0, 2).map((heading, index) => Math.max(heading.length, ...rows.map((row) => row.values[index].length)));
  const intervalWidth = Math.max("WINDOW".length, ...rows.flatMap((row) => row.usage.map((entry) => entry.interval.length)));
  const percentWidth = Math.max("%".length, ...rows.flatMap((row) => row.usage.map((entry) => entry.percent === null ? 0 : String(entry.percent).length)));
  const resetWidth = Math.max("RESETS".length, ...rows.flatMap((row) => row.usage.map((entry) => entry.reset.length)));
  const wideWidth = identityWidths[0] + identityWidths[1] + intervalWidth + percentWidth + resetWidth + 2 * 4;
  if (wideWidth <= terminalWidth()) {
    writeLine([
      paint("1", headings[0].padEnd(identityWidths[0])),
      paint("1", headings[1].padEnd(identityWidths[1])),
      paint("1", headings[2].padEnd(intervalWidth)),
      paint("1", headings[3].padStart(percentWidth)),
      paint("1", headings[4]),
    ].join("  "));
    for (let profileIndex = 0; profileIndex < rows.length; profileIndex += 1) {
      if (profileIndex > 0) writeLine("");
      const row = rows[profileIndex];
      for (let index = 0; index < row.usage.length; index += 1) {
        const entry = row.usage[index];
        const prefix = index === 0
          ? `${centerValue(row.values[0], identityWidths[0])}  ${centerValue(row.values[1], identityWidths[1])}`
          : `${" ".repeat(identityWidths[0])}  ${" ".repeat(identityWidths[1])}`;
        writeLine([
          prefix,
          centerValue(entry.interval, intervalWidth),
          paintPercent(entry.percent, percentWidth),
          centerValue(entry.reset, resetWidth),
        ].join("  ").trimEnd());
      }
    }
    return;
  }
  printNarrowUsage(rows, intervalWidth, percentWidth, resetWidth);
}

function centerValue(value, width) {
  const padding = Math.max(0, width - value.length);
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(padding - left)}`;
}

function paintPercent(percent, width) {
  if (percent === null) return " ".repeat(width);
  const code = percent <= 33 ? "32" : percent <= 66 ? "33" : "31";
  return paint(code, centerValue(String(percent), width));
}

function printNarrowUsage(rows, intervalWidth, percentWidth, resetWidth) {
  const providerWidth = Math.max("PROVIDER".length, ...rows.map((row) => row.values[0].length));
  const nameWidth = Math.max("NAME".length, ...rows.map((row) => row.values[1].length));
  writeLine(`${paint("1", "PROVIDER".padEnd(providerWidth))}  ${paint("1", "NAME")}`);
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) writeLine("");
    const row = rows[index];
    writeLine(`${centerValue(row.values[0], providerWidth)}  ${centerValue(row.values[1], nameWidth)}`.trimEnd());
    writeLine(`  ${paint("1", "WINDOW".padEnd(intervalWidth))}  ${paint("1", "%".padStart(percentWidth))}  ${paint("1", "RESETS")}`);
    for (const entry of row.usage) {
      writeLine([
        "",
        centerValue(entry.interval, intervalWidth),
        paintPercent(entry.percent, percentWidth),
        centerValue(entry.reset, resetWidth),
      ].join("  ").trimEnd());
    }
  }
}

function printNarrowList(rows) {
  const providerWidth = Math.max("PROVIDER".length, ...rows.map((row) => row.values[0].length));
  writeLine(`${paint("1", "PROVIDER".padEnd(providerWidth))}  ${paint("1", "NAME")}`);
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) writeLine("");
    const row = rows[index];
    writeLine(`${row.values[0].padEnd(providerWidth)}  ${row.values[1]}`);
    writeLine(`  ${paint("1", "SHARING")}  ${row.values[2]}`);
    writeLine(`  ${paint("1", "HOME")}     ${row.values[3]}`);
  }
}
