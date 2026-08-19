# t3-profile

> [!IMPORTANT]
> Fully quit T3 Code before adding, removing, or syncing profiles. Also stop any
> `t3 serve` and `t3 connect` processes. T3 writes `settings.json` when it quits
> and can overwrite changes made while it is running.

`t3-profile` lets you use multiple Claude and Codex subscriptions in T3 Code at
the same time. Each profile has its own authentication while optionally sharing
your existing configuration.

## Install

```sh
npm install --global @albro3459/t3-profile
```

Node.js 20 or newer is required.

## Quick start

```sh
# Check your setup and find problems
t3-profile doctor

# Add a profile and authenticate it
t3-profile add claude personal
t3-profile add codex work

# Show profiles and usage
t3-profile list

# Re-authenticate an existing profile
t3-profile auth claude personal
t3-profile auth codex work

# Restore all registered profiles to T3 settings
t3-profile sync

# Remove a profile, its private auth files, and local history
t3-profile remove claude personal

# Show every command and option
t3-profile --help
```

Profile names must start with a lowercase letter. They may contain lowercase
letters, numbers, underscores, and hyphens.

## Sharing

Profiles use standard sharing unless you choose an isolated profile during
`add`.

Claude profiles use live symbolic links for these resources when present:

```text
CLAUDE.md
settings.json
skills/
agents/
```

Authentication, projects, history, plugins, and other runtime state stay
private to the profile.

Codex profiles use T3's shared home and shadow home support. T3 shares
configuration, `AGENTS.md`, skills, plugins, sessions, and other non-private
state from your primary Codex home. Authentication and selected runtime files
stay in the profile's managed shadow home.

Use `--isolated` to share nothing:

```sh
t3-profile add claude private --isolated
t3-profile add codex private --isolated
```

## Custom provider homes

Use `--home` when your primary Claude or Codex home is in a custom location:

```sh
t3-profile add claude work --home /path/to/claude-home
t3-profile add codex work --home /path/to/codex-home
```

Defaults are `~/.claude` for Claude and `~/.codex` for Codex. The source home
stays in place.

## Common options

```text
--home <path>  Share from a custom primary provider home
--isolated     Create a profile without shared resources
--skip-auth    Add the profile without starting authentication
--dry-run      Preview what sync would change
--yes          Accept confirmations and assert that T3 is stopped
```

`sync` checks every registered profile. Use `t3-profile sync --dry-run` to
preview settings changes.

`doctor` is read-only. Pass a provider and name to check one profile:

```sh
t3-profile doctor codex work
```

`list` shows each profile's home, sharing mode, and usage. Claude
shows five-hour and weekly usage. Codex shows weekly usage. A failed usage check
appears as `unavailable` without hiding the profile.

For command details, sharing behavior, storage paths, and removal behavior, see
[the reference guide](docs/reference.md).
