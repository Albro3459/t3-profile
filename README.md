# t3-profile v2

`t3-profile` creates separate Claude and Codex subscription profiles,
registers them with T3, and delegates authentication to each provider's native
CLI. `add` now completes creation, sharing, registration, and authentication in
one flow by default.

## Commands

```text
t3-profile add <claude|codex> <name> [--home <path>] [--isolated] [--skip-auth] [--yes]
t3-profile auth <claude|codex> <name>
t3-profile run <claude|codex> <name> [-- provider arguments]
t3-profile list
t3-profile sync [--dry-run] [--yes]
t3-profile doctor [<claude|codex> <name>]
t3-profile remove <claude|codex> <name> [--yes]
```

Names are required and must match `^[a-z][a-z0-9_-]{0,47}$`. Windows reserved
names such as `con`, `aux`, `com1`, and `lpt1` are rejected.

Examples:

```sh
t3-profile add claude personal
t3-profile add codex work --home /path/to/primary-codex
t3-profile add claude private --isolated
t3-profile add codex shared --yes
t3-profile add claude later --skip-auth

t3-profile auth claude personal
t3-profile auth codex work
t3-profile run claude personal
t3-profile run codex work -- --model gpt-5
t3-profile list
t3-profile sync --dry-run
t3-profile sync
t3-profile doctor
t3-profile doctor claude personal
t3-profile remove claude personal
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

`--yes` selects standard sharing and skips prompts other than provider
authentication. On `sync` and `remove`, it confirms that T3 is stopped and
skips the command's confirmation. `--skip-auth` is the explicit way to create a
profile without immediately starting native authentication.
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

Every item above is optional. If it does not exist in the source home,
`t3-profile` skips it and does not create an empty replacement.

Claude Code does not use a standard user-level `mcp/` directory. User- and
local-scoped MCP definitions live in `~/.claude.json`, which also contains
OAuth/session and application state, so `t3-profile` deliberately keeps that
whole file private. Project-scoped MCP definitions live in each repository's
`.mcp.json` and are outside profile-home sharing. MCP-related policy inside the
shared `settings.json` is shared.

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

This shares the primary home’s configuration (including MCP server
configuration), `AGENTS.md`, skills, plugins,
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
${T3CODE_HOME:-~/.t3}/userdata/settings.json
```

Before mutation, `add` validates the source home and settings file, checks
collisions and link capabilities, shows the final sharing summary, and asks
you to confirm that T3 is fully stopped. Quit T3 Code and stop every
`t3 serve` and `t3 connect` process before answering yes. v1 trusts this
confirmation; it does not inspect or stop processes. The confirmation is:

```text
T3 is fully stopped and ready to update? [y/N]
```

`sync` and `remove` use the same stopped-T3 boundary before changing settings.
Cancelling prints `Cancelled. No changes were made.`

T3 settings are backed up under `${T3_PROFILE_HOME:-~/.t3-profile}/backups/`
and replaced atomically. The tool preserves unmanaged provider instances,
opaque driver configuration, and sensitive redaction metadata, and never
touches T3's secrets directory. Restart T3 Code after `add`, `sync`, or
`remove` completes.

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

By default, `add` invokes this same authentication operation after the profile
and its T3 registration have been created. If native authentication exits
nonzero or is cancelled, the profile remains created and `t3-profile auth` can
be rerun later. `auth` remains available for renewal and repair.

## Sync, doctor, and remove

`sync` compares every registry-owned profile with T3's `providerInstances`.
It adds missing managed instances and repairs drift in fields owned by
`t3-profile`. It preserves unmanaged instances, unknown instance/config fields,
and unrelated environment entries. It never adopts or deletes an unregistered
T3 instance. `--dry-run` prints the deterministic change list without writing.

`doctor` is read-only. It checks the platform, registry and settings shape,
managed/source homes, T3 registration drift, Claude live links, native CLI
availability and version, and native authentication status. With no profile it
checks all registered profiles; pass a provider and name to narrow it. Errors
produce a nonzero exit status. Warnings identify untested combinations without
failing the command.

`remove` unregisters exactly one registry-owned T3 instance, removes its local
registry entry, and permanently deletes its managed profile home. This includes
private authentication and local history stored in that home. It never removes
the primary source home or unmanaged T3 instances.

## Security disclosures

Standard shared settings may contain hooks, permissions, MCP configuration,
and environment values. Review the source home before sharing it. Credentials
are never copied, and the local registry stores only provider/name, normalized
paths, sharing mode, owned links, T3 instance ID, and creation time—not tokens,
API keys, or auth payloads. Secrets and sensitive environment values are not
printed.

## Tested and untested support

The following combination has been tested:

- macOS 26.5 on ARM
- Claude Code 2.1.235

The following combinations are explicitly untested and may require platform or
provider-specific adjustments:

- Codex CLI and Codex profiles on every operating system
- Windows, including link permissions, junction behavior, command shims, and
  atomic replacement under file contention
- Linux
- Intel macOS, macOS versions other than 26.5, and Claude Code versions other
  than 2.1.235

The goal is to support Claude and Codex across macOS, Windows, and Linux. The
current implementation includes portability paths for those targets, but they
must not be described as verified until they have been exercised on those
platforms and versions.

## v2 limitations

v2 intentionally keeps standard or isolated sharing; there is no custom
sharing preset. It does not provide running-process detection or management,
WebSocket RPC, cross-process locking, credential copying, global account
switching, or arbitrary T3 process management. Offline settings mutations rely
on the user's confirmation that T3 is fully stopped. `sync` reconciles T3
registration only; it does not rewrite a profile's sharing layout.
