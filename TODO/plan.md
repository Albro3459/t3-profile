# t3-profile v1 implementation plan

Status: ready for implementation review. This is the v1 source of truth. `discussion.md` remains exploratory history.

## Goal

Build a small cross-platform Node CLI that creates isolated Claude and Codex subscription profiles, optionally shares one opinionated set of configuration from an existing primary home, delegates authentication to the native CLI, and registers the profile with T3.

Keep v1 narrow. It does not detect running T3 processes, support custom sharing, reconcile arbitrary drift, inspect health, copy credentials, switch global accounts, or manage T3 processes.

## Commands

```text
t3-profile add <claude|codex> <name> [--home <path>] [--isolated] [--yes]
t3-profile auth <claude|codex> <name>
t3-profile run <claude|codex> <name> [-- provider arguments]
t3-profile list
```

No other commands are required for v1.

## Names

The profile name is required. It is never inferred or prompted.

Valid names match:

```regex
^[a-z][a-z0-9_-]{0,47}$
```

This keeps profile directories and derived T3 instance IDs portable and unambiguous on case-insensitive macOS/Windows filesystems and case-sensitive Linux filesystems.

Also reject Windows reserved path names such as `con`, `prn`, `aux`, `nul`, `com1` through `com9`, and `lpt1` through `lpt9`.

Derived paths and IDs:

```text
Profile home:   ~/.t3-profile/profiles/<provider>/<name>
T3 instance ID: claude_<name> or codex_<name>
```

## Homes

`--home` selects the existing primary/default provider home and sharing source.

Defaults:

```text
Claude: ~/.claude
Codex:  ~/.codex
```

The selected home must already exist and be a directory. Fail before creating anything when it does not.

The managed root is:

```text
${T3_PROFILE_HOME:-~/.t3-profile}
```

The source home is never moved. The new subscription profile always lives under the managed root.

For a custom `--home`, the stopped-server T3 settings update also points the primary/default provider instance at that absolute source path. Any conflicting existing value appears in the confirmation before it is changed.

## Sharing model

There are exactly two modes:

- `standard`: the provider-specific opinionated sharing layout;
- `isolated`: no shared links.

`standard` is recommended, but it is not silently selected in an interactive session. Without `--isolated`, ask one question:

```text
Share the standard Claude configuration from ~/.claude?

  settings.json
  skills/
  agents/
  CLAUDE.md

Share these resources? [Y/n]
```

Answering no selects isolated mode. `--isolated` skips the question. `--yes` selects standard sharing and skips prompts other than validation; its help text must say that explicitly.

Only existing source resources are linked. Missing optional resources are shown as skipped and are never created or copied in the source home.

### Claude standard

Create live links from the managed Claude home to existing resources in the source home:

- `settings.json`;
- `skills/`;
- `agents/`;
- `CLAUDE.md`.

Keep private:

- OAuth and macOS Keychain credentials;
- `.credentials.json`;
- `.claude.json` account/global state;
- projects and history;
- plugins and other runtime state.

Configure the managed path as T3's Claude `homePath`. Native login and runtime set both variables to the same normalized absolute managed path while preserving the real `HOME`:

```text
CLAUDE_CONFIG_DIR
CLAUDE_SECURESTORAGE_CONFIG_DIR
```

Never set `CLAUDE_SECURESTORAGE_CONFIG_DIR` to an empty string.

### Claude isolated

Create the managed home with no shared links. Authentication, settings, instructions, skills, agents, projects, and history are independent.

### Codex standard

Use T3's native shared-home plus shadow-home layout:

```text
homePath       = primary/source home
shadowHomePath = managed profile home
```

This intentionally shares Codex configuration, `AGENTS.md`, skills, plugins, sessions, archived sessions, SQLite state, shell snapshots, worktrees, cache, logs, MCP lock state, and other non-private primary-home entries.

Keep `auth.json` and `models_cache.json` private. Keep `log`, `memories`, and `tmp` shadow-local.

Shared sessions are desired: they allow compatible Codex accounts to switch inside existing T3 threads.

The confirmation summarizes these categories explicitly. Do not describe Codex standard sharing as only config and skills.

### Codex isolated

Use the managed directory as a direct independent Codex home:

```text
homePath       = managed profile home
shadowHomePath = empty
```

It shares nothing and cannot switch into T3 threads bound to the primary Codex home.

## Live-link policy

Never copy a resource as a fallback for a link.

macOS and Linux:

- symbolic links for files and directories.

Windows:

- directory junctions for shared directories;
- file symbolic links for shared files;
- preflight every required link type before any profile or settings mutation;
- if live links are unavailable, fail with instructions to enable Windows Developer Mode or retry with `--isolated`.

Do not silently create a partially shared profile. Standard sharing is all available resources from the declared manifest or no mutation.

Link safety:

- resolve source and destination to absolute paths;
- reject source/target identity and cycles;
- refuse existing unmanaged destination content;
- create only links recorded in the profile manifest;
- accept an existing link only when it resolves to the expected source;
- keep repeated operations idempotent;
- never delete or replace pre-existing user files during rollback.

## `add` flow

Complete preflight before writing:

1. Validate provider and required lowercase name.
2. Resolve the source home, managed root, target home, and T3 settings path.
3. Require the source home and T3 settings file to exist.
4. Reject profile, path, registry, and T3 instance collisions.
5. Inspect the standard sharing manifest and link capabilities.
6. Prompt for standard or isolated sharing unless a flag decides it.
7. Show one compact final summary.
8. Ask the user to confirm T3 is fully stopped.
9. Create the managed home and links.
10. Update the profile registry and stopped-server T3 settings atomically.
11. Verify the written profile and settings.
12. Print the two next actions: authenticate, then restart T3.

Do not inspect the process table or attempt to prove that T3 is stopped in v1. Trust the user's confirmation. Never stop a process automatically.

Final confirmation:

```text
Create Claude profile "personal"?

Primary home: ~/.claude
Profile home: ~/.t3-profile/profiles/claude/personal
Sharing:      Standard

Live shared
  settings.json
  skills/
  agents/
  CLAUDE.md

Private
  credentials
  account metadata
  projects and history

Shared resources are live links. Changes affect every linked profile.
Shared settings can include hooks, permissions, MCP configuration, and
environment values. Credentials are never copied by t3-profile.

Quit T3 Code and stop every `t3 serve` and `t3 connect` process.
T3 is fully stopped and ready to update? [y/N]
```

Cancellation:

```text
Cancelled. No changes were made.
```

Success:

```text
Created Claude profile "personal".

Home:    ~/.t3-profile/profiles/claude/personal
Sharing: Standard

Next:
  1. Run `t3-profile auth claude personal`.
  2. Restart T3 Code after authentication completes.
```

## T3 settings

V1 modifies settings only while the user confirms T3 is stopped.

Resolution order:

```text
T3CODE_HOME
~/.t3
```

The settings document is `${T3CODE_HOME:-~/.t3}/userdata/settings.json`.

Update behavior:

- read and validate the raw settings document;
- preserve unmanaged provider instances and opaque driver configuration;
- preserve sensitive redaction metadata exactly;
- update a custom primary/default provider home when requested;
- add only the derived managed provider instance;
- save a recoverable settings backup under `~/.t3-profile/backups/`;
- atomically replace `settings.json`;
- never touch T3's secrets directory;
- verify the resulting instance entries before success.

No WebSocket RPC, cross-process locking, process detection, or online reconciliation in v1.

## Registry

`~/.t3-profile/profiles.json` stores only:

- provider and lowercase name;
- normalized source and managed home paths;
- `standard` or `isolated` sharing mode;
- exact links owned by the tool;
- T3 instance ID;
- creation timestamp.

It never stores credentials, tokens, API keys, or provider auth payloads.

## `auth`

Delegate authentication to the native provider CLI:

```text
Claude: claude auth login
Codex:  codex login
```

Launch under the selected profile environment. Do not inspect, capture, parse, copy, or log credentials.

Scrub inherited provider authentication override variables that could bypass the selected profile. Pass through unrelated environment values.

## `run`

Launch the real provider binary under the same process-scoped profile environment used by `auth`.

```text
t3-profile run claude personal
t3-profile run codex work -- --model gpt-5
```

Pass provider arguments after `--` unchanged. Do not modify the caller's shell environment and do not configure T3 to use the wrapper.

## `list`

Read the local registry and print a compact table without probing authentication or T3 health:

```text
PROVIDER  NAME      SHARING   HOME
claude    personal  standard  ~/.t3-profile/profiles/claude/personal
codex     work      isolated  ~/.t3-profile/profiles/codex/work
```

An empty registry prints:

```text
No profiles configured.
```

## Output rules

- Human-readable output only in v1.
- Short headings, aligned labels, and whitespace; no decorative boxes.
- Color only on a TTY and honor `NO_COLOR`.
- Normal output to stdout; warnings and errors to stderr.
- Errors begin with `Error:` and include one actionable correction.
- Never print secrets or sensitive environment values.
- User cancellation exits successfully.
- Validation and mutation failures exit nonzero.

## Implementation sequence

1. Scaffold the small ESM Node package using the relevant `t3-session` conventions: thin executable, direct source execution, separated CLI/output/errors/config/version modules, and no skill assets.
2. Implement path/name validation, managed storage, registry decoding, backups, and atomic file utilities.
3. Implement the minimal TTY prompt/output layer and non-interactive `--yes` behavior.
4. Implement Claude standard/isolated link and environment definitions.
5. Implement Codex standard shadow-home and isolated-home definitions.
6. Implement cross-platform link capability preflight and transactional link creation.
7. Implement stopped-T3 settings merge and verification.
8. Implement transactional `add` with final confirmation and rollback of newly created managed artifacts.
9. Implement native `auth`, process-scoped `run`, and registry-only `list`.
10. Write the concise README with exact sharing, shutdown/restart, Windows link, and security disclosures.
11. Validate with syntax/build commands and manual filesystem/settings review. Do not add or run tests unless separately requested.

## Completion criteria

- `add` supports Claude and Codex with default or custom primary homes.
- Names are required, lowercase, path-safe, and T3-ID-safe.
- Users make one explicit standard-versus-isolated choice.
- Standard sharing uses live links only and lists exactly what is shared.
- Codex standard profiles share sessions and remain continuation-compatible.
- Windows either creates real live links or fails before mutation.
- The user confirms T3 is stopped and is told when to restart.
- Native login owns all credential operations.
- `list` reports managed profiles without health probing.
- No v2 behavior leaks into the v1 implementation.
