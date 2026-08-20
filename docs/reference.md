# t3-profile reference

## Commands

```text
t3-profile add <claude|codex> <name> [--home <path>] [--isolated] [--skip-auth] [--yes]
t3-profile auth <claude|codex> <name>
t3-profile run <claude|codex> <name> [-- provider arguments]
t3-profile list
t3-profile usage [--no-keychain-prompt]
t3-profile sync [--dry-run] [--yes]
t3-profile doctor [<claude|codex> <name>]
t3-profile remove <claude|codex> <name> [--yes]
```

Run `t3-profile help` for built-in help. `--help` and `-h` are aliases.
Run `t3-profile version` to print the installed version. `--version` and `-v`
are aliases.

Names must match `^[a-z][a-z0-9_-]{0,47}$`. Windows reserved names such as
`con`, `aux`, `com1`, and `lpt1` are rejected.

## T3 shutdown requirement

Fully quit T3 Code before `add`, a mutating `sync`, or `remove`. Stop every
`t3 serve` and `t3 connect` process too. T3 writes its settings when it quits
and can overwrite changes made while it is running.

These operations ask you to confirm that T3 is stopped. Passing `--yes` makes
that assertion non-interactively. It also accepts the command's other
confirmations. Validation and drift checks still run.

`sync --dry-run`, a sync with no changes, `list`, `usage`, `doctor`, `auth`, and
`run` do not require T3 to be stopped.

T3 settings are backed up before changes. Restart T3 Code after `add`, `sync`,
or `remove` completes.

## Add

`add` creates a managed profile, configures sharing, registers it with T3, and
starts the provider's authentication flow.

```sh
t3-profile add claude personal
t3-profile add codex work
```

Use `--skip-auth` to authenticate later:

```sh
t3-profile add claude personal --skip-auth
t3-profile auth claude personal
```

Use `--home` to share from an existing custom provider home. The defaults are
`~/.claude` and `~/.codex`.

```sh
t3-profile add claude work --home /path/to/claude-home
t3-profile add codex work --home /path/to/codex-home
```

A custom home also updates T3's primary provider home setting. The source home
stays in place.

Without `--yes` or `--isolated`, `add` asks whether to use standard sharing.
Choose no for an isolated profile. `--yes` selects standard sharing.

## Authentication and provider commands

`auth` runs the provider's native login command inside the selected profile:

```text
Claude  claude auth login
Codex   codex login --device-auth
```

If authentication during `add` is cancelled or fails, the profile remains
available. Run `auth` again later.

`run` starts a provider command in the selected profile. Arguments after `--`
are passed through unchanged.

```sh
t3-profile run claude personal
t3-profile run codex work -- --model gpt-5
```

## Sharing

### Claude

Standard Claude profiles create live links from the managed profile to these
resources in the source home:

```text
settings.json
skills/
agents/
CLAUDE.md
```

Missing resources are skipped. Credentials, `.claude.json`, projects, history,
plugins, and other runtime state remain private. Settings may include hooks,
permissions, MCP configuration, and environment values, so review them before
sharing.

An isolated Claude profile has independent settings, instructions, skills,
agents, projects, authentication, and history.

### Codex

Standard Codex profiles use T3's shared home and shadow home layout:

```text
homePath       = primary Codex home
shadowHomePath = managed profile home
```

T3 shares configuration, `AGENTS.md`, skills, plugins, sessions, archived
sessions, SQLite state, shell snapshots, worktrees, cache, logs, MCP lock state,
and other non-private entries from the primary home. `auth.json` and
`models_cache.json` remain private. `log`, `memories`, and `tmp` remain local to
the managed shadow home.

Shared sessions let compatible Codex accounts switch within existing T3
threads. An isolated Codex profile shares nothing and cannot switch into T3
threads tied to the primary Codex home.

On macOS and Linux, Claude shared resources use symbolic links. Windows uses
directory junctions and file symbolic links. Enable Windows Developer Mode if
file link creation is unavailable, or use `--isolated`.

## List and usage

`list` shows every registered profile, its sharing mode, and managed home.
`usage` shows provider, profile name, usage, and reset times in a compact table.
The first usage pass is noninteractive. If unavailable profiles have matching
Claude credentials in a locked macOS Keychain, an interactive terminal asks
whether to temporarily unlock it, retries all providers and profiles, and
locks that Keychain again afterward on a best-effort basis. Declining,
cancelling, piping, CI, and `usage --no-keychain-prompt` preserve the
unavailable results. Codex Keychain recovery is not implemented or tested;
its credential backend is configurable, so the orchestration remains provider-neutral.

Claude authentication writes to the macOS Keychain whenever the login Keychain
is unlocked, including over SSH. When it is locked, Claude falls back to
`.credentials.json`; SSH itself does not select the storage backend.

Claude reports five-hour and seven-day usage. Codex reports seven-day usage.
Reset times use the local timezone and are shown as `8/19 at 11:10 PM`.
Percentages from 0–33 are green, 34–66 are yellow, and 67–100 are red when
color output is enabled. Provider, credential, network, or response errors
appear as `unavailable` for the affected profile. An inactive Claude session
shows `0` under `%` and `not started` under `RESETS` because its reset timestamp
is null until the first message starts the session.

Claude usage comes from Anthropic's OAuth usage endpoint. See
[Claude usage response schema](claude-usage-schema.md) for the supported fields.

See the [tested support matrix](support.md) for verified versions and platforms.

## Sync

`sync` compares every registered profile with T3's provider instances. It adds
missing managed instances and repairs fields owned by `t3-profile`.

```sh
t3-profile sync --dry-run
t3-profile sync
```

It preserves unmanaged provider instances and unknown fields. It does not
adopt or delete unregistered instances. It also does not change a profile's
sharing layout.

## Doctor

`doctor` checks the platform, registry, T3 settings, profile homes, sharing
links, provider CLI, and authentication status.

```sh
t3-profile doctor
t3-profile doctor claude personal
```

It is read-only. Errors produce a nonzero exit status.

## Remove

`remove` unregisters one profile from T3, removes its registry entry, and
deletes its managed profile home. This includes private files and local history
stored in that home.

```sh
t3-profile remove codex work
```

Removal does not run the provider's logout flow or revoke tokens. Credentials
may remain in macOS Keychain or another provider credential store. The primary
source home and unmanaged T3 instances are never removed.

## Storage

Managed profiles and registry:

```text
${T3_PROFILE_HOME:-~/.t3-profile}/profiles/<provider>/<name>
${T3_PROFILE_HOME:-~/.t3-profile}/profiles.json
```

T3 settings:

```text
${T3CODE_HOME:-~/.t3}/userdata/settings.json
```

Settings backups are stored in
`${T3_PROFILE_HOME:-~/.t3-profile}/backups/`.

The registry contains profile identity, paths, sharing mode, owned links, T3
instance ID, and creation time. It does not store tokens, API keys, or auth
payloads.
