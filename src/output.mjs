import { VERSION } from "./version.mjs";

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
  t3-profile add <claude|codex> <name> [--home <path>] [--isolated] [--yes]
  t3-profile auth <claude|codex> <name>
  t3-profile run <claude|codex> <name> [-- provider arguments]
  t3-profile list

Names must be lowercase and match ^[a-z][a-z0-9_-]{0,47}$.

Options:
  --home <path>  Use an existing primary provider home as the sharing source.
  --isolated     Create an independent profile without shared resources.
  --yes          Select standard sharing, assume T3 is stopped, and skip prompts
                 other than validation.
  --help         Show this help.
  --version      Show the version.`);
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

export function printCreated({ providerTitle, name, profileHome, sharing }) {
  writeLine(`Created ${providerTitle} profile "${name}".`);
  writeLine("");
  writeLine(`Home:    ${profileHome}`);
  writeLine(`Sharing: ${sharing === "standard" ? "Standard" : "Isolated"}`);
  writeLine("");
  writeLine("Next:");
  writeLine(`  1. Run \`t3-profile auth ${providerTitle.toLowerCase()} ${name}\`.`);
  writeLine("  2. Restart T3 Code after authentication completes.");
}

export function printList(profiles) {
  if (profiles.length === 0) {
    writeLine("No profiles configured.");
    return;
  }
  const rows = profiles
    .slice()
    .sort((left, right) => `${left.provider}:${left.name}`.localeCompare(`${right.provider}:${right.name}`))
    .map((profile) => [profile.provider, profile.name, profile.sharing, profile.profileHome]);
  const headings = ["PROVIDER", "NAME", "SHARING", "HOME"];
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index].length)));
  writeLine(headings.map((heading, index) => paint("1", heading.padEnd(widths[index]))).join("  "));
  for (const row of rows) writeLine(row.map((value, index) => value.padEnd(widths[index])).join("  "));
}
