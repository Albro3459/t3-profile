# t3-profile v1

`t3-profile` creates separate Claude and Codex subscription profiles while
registering them with T3. Authentication remains owned by each provider's
native CLI.

## Commands

```text
t3-profile add <claude|codex> <name> [--home <path>] [--isolated] [--yes]
t3-profile auth <claude|codex> <name>
t3-profile run <claude|codex> <name> [-- provider arguments]
t3-profile list
```

Names are required and must match `^[a-z][a-z0-9_-]{0,47}$`. Windows reserved
names such as `con`, `aux`, `com1`, and `lpt1` are rejected.

Examples:

```sh
t3-profile add claude personal
t3-profile add codex work --home /path/to/primary-codex
t3-profile add claude private --isolated
t3-profile add codex shared --yes

t3-profile auth claude personal
t3-profile auth codex work
t3-profile run claude personal
t3-profile run codex work -- --model gpt-5
t3-profile list
```

`--home` selects the existing primary provider home used as the sharing
source. Defaults are `~/.claude` and `~/.codex`. The source is never moved.
The target is always created below the managed root:

```text
${T3_PROFILE_HOME:-~/.t3-profile}/profiles/<provider>/<name>
```

The registry is `${T3_PROFILE_HOME:-~/.t3-profile}/profiles.json` and settings
backups are stored under `${T3_PROFILE_HOME:-~/.t3-profile}/backups/`.

With a custom `--home`, the stopped-server T3 settings update also points the
primary/default provider instance to that absolute source path; any conflicting
value is shown before it is changed.

`--yes` selects standard sharing and skips prompts other than validation.
Without `--yes` or `--isolated`, `add` asks whether to use standard sharing.
Answering no selects isolated mode. Missing optional source resources are
reported as skipped; they are not created or copied.

## Sharing

Standard sharing uses live links only. It never copies a resource as a
fallback. Changes to shared resources affect every profile linked to them.

### Claude

Standard Claude profiles link these existing resources from the source home:

```text
settings.json
skills/
agents/
CLAUDE.md
```

Credentials, account/global state, projects, history, plugins, and other
runtime state remain private. The profile's T3 Claude `homePath` is the
managed home. Provider processes receive both `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` set to that normalized absolute path;
`CLAUDE_SECURESTORAGE_CONFIG_DIR` is never set to an empty value. The real
`HOME` is preserved.

An isolated Claude profile has no shared links: authentication, settings,
instructions, skills, agents, projects, and history are independent.

### Codex

Standard Codex profiles use T3's shared-home/shadow-home layout:

```text
homePath       = primary/source home
shadowHomePath = managed profile home
```

This shares the primary home’s configuration, `AGENTS.md`, skills, plugins,
sessions, archived sessions, SQLite state, shell snapshots, worktrees, cache,
logs, MCP lock state, and other non-private entries. `auth.json` and
`models_cache.json` remain private. `log`, `memories`, and `tmp` remain
shadow-local. Shared sessions allow compatible Codex accounts to switch inside
existing T3 threads.

An isolated Codex profile uses the managed directory directly:

```text
homePath       = managed profile home
shadowHomePath = empty
```

It shares nothing and cannot switch into T3 threads bound to the primary Codex
home.

## Links and Windows

On macOS and Linux, shared files and directories are symbolic links. On
Windows, shared directories require directory junctions and shared files
require file symbolic links.

`add` checks every required link capability before changing the profile or T3
settings. If Windows cannot create the required links, enable Windows
Developer Mode and retry, or use `--isolated`. Standard sharing never leaves a
partially shared profile.

## T3 settings and shutdown

The T3 settings file is resolved from:

```text
${T3CODE_HOME:-~/.t3}/settings.json
```

Before mutation, `add` validates the source home and settings file, checks
collisions and link capabilities, shows the final sharing summary, and asks
you to confirm that T3 is fully stopped. Quit T3 Code and stop every
`t3 serve` and `t3 connect` process before answering yes. v1 trusts this
confirmation; it does not inspect or stop processes. The confirmation is:

```text
T3 is fully stopped and ready to update? [y/N]
```

Cancelling prints `Cancelled. No changes were made.`

T3 settings are backed up under `${T3_PROFILE_HOME:-~/.t3-profile}/backups/`
and replaced atomically. The tool preserves unmanaged provider instances,
opaque driver configuration, and sensitive redaction metadata, and never
touches T3's secrets directory. After authentication, restart T3 Code:

```text
1. t3-profile auth <claude|codex> <name>
2. Restart T3 Code.
```

## Authentication and running

Authentication delegates directly to the native CLI under the selected
profile environment:

```text
Claude: claude auth login
Codex:  codex login
```

`t3-profile` does not inspect, capture, parse, copy, or log credentials. It
scrubs inherited provider authentication override variables that could bypass
the selected profile, while passing through unrelated environment values.

`run` uses the same process-scoped environment and passes arguments after `--`
unchanged. It does not modify the caller's shell environment or configure T3
to use the wrapper.

## Security disclosures

Standard shared settings may contain hooks, permissions, MCP configuration,
and environment values. Review the source home before sharing it. Credentials
are never copied, and the local registry stores only provider/name, normalized
paths, sharing mode, owned links, T3 instance ID, and creation time—not tokens,
API keys, or auth payloads. Secrets and sensitive environment values are not
printed.

## v1 limitations

v1 supports only standard or isolated sharing. It does not provide custom
sharing, running-process detection or management, WebSocket RPC,
cross-process locking, online reconciliation, drift or health inspection,
credential copying, global account switching, or arbitrary T3 process
management. `list` reads the local registry only; it does not probe
authentication or T3 health. These capabilities are deferred to a future
version.
