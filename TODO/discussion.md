# t3-profile discussion brief

Status: product discussion only. This is not an implementation plan.

## Product thesis

`t3-profile` is a human-facing Node CLI for managing named Claude and Codex subscription profiles and reconciling them with T3's native provider-instance model.

It should own:

- named profile creation and metadata;
- isolated provider homes;
- delegation to the provider's native authentication command;
- T3 provider-instance registration and reconciliation;
- profile inspection and diagnostics.

It should not own T3 process lifecycle, T3 Connect, tunnels, sleep management, or global account switching. It should use the real `claude` and `codex` binaries rather than act as a protocol wrapper.

## Working CLI language

```text
t3-profile add claude personal
t3-profile add codex work
t3-profile auth claude personal
t3-profile list
t3-profile show claude personal
t3-profile sync --dry-run
t3-profile sync
t3-profile doctor
t3-profile doctor codex work
```

Provider plus profile name is the explicit identity. Email can be displayed or accepted as a lookup alias later, but is not a stable key. T3 instance IDs can be derived predictably, such as `claude_personal` and `codex_work`, while display names remain human-friendly.

`auth` is intentionally separate from `add` because it also covers renewal. An interactive `add` may offer to authenticate and sync immediately, but the underlying operations should remain separately invocable.

If direct terminal use is part of v1, use an explicitly process-scoped verb rather than a global switch:

```text
t3-profile run claude personal
t3-profile run codex work -- --model gpt-5
```

`run` would set the target home only for the spawned native CLI process and allow concurrent profiles. T3 should still point directly at the real provider binaries and use its own provider-instance configuration.

`remove`, `rename`, `import`, `export`, and machine-readable output are later discussion items rather than v1 assumptions.

## Profile model

A managed profile needs only metadata:

- provider: `claude` or `codex`;
- stable slug/name;
- display name and optional accent color;
- absolute provider home path;
- T3 provider instance ID;
- Codex shared home when applicable;
- optional non-secret account metadata discovered during diagnostics.

The registry must not contain tokens, API keys, or copied `auth.json` data. Native provider storage remains the credential source of truth.

T3 already separates provider implementation (`ProviderDriverKind`) from the user-defined routing key (`ProviderInstanceId`). `t3-profile` should manage that model, not invent a parallel provider runtime.

## Provider behavior

### Claude

- Each profile uses a separate Claude config/home directory.
- Authentication is delegated to `claude auth login` with both `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the same absolute profile path.
- Login and runtime preserve the real `HOME` so the normal macOS login Keychain remains discoverable.
- Claude Code 2.1.234 derives a profile-specific macOS Keychain service named `Claude Code-credentials-<8-character SHA-256 suffix>` from the secure-storage/config path. Separate absolute paths therefore address separate OAuth entries.
- A defined-empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` means the default unsuffixed credential store; it is not equivalent to an unset variable and must not be used for managed profiles.
- Different Claude homes are different continuation groups, so an existing thread generally cannot switch between accounts.
- Do not depend on `claude-swap` or inject a wrapper into T3's stdio protocol.

T3 runtime currently sets only `CLAUDE_CONFIG_DIR`. `t3-profile sync` should also configure the matching non-secret `CLAUDE_SECURESTORAGE_CONFIG_DIR` on each managed Claude provider instance. This makes secure-store selection deterministic even if the parent process inherited that variable. T3's current documentation logs a second account in using a temporary `HOME`; that example is inconsistent with runtime behavior and should not be copied.

`claude-swap` confirms the same isolation mechanism in its concurrent `run` mode. Its global `switch` command snapshots and rewrites one active identity, which is not the desired model. Its `run` mode seeds separate Claude config directories and uses native Claude under them, but `t3-profile` can avoid credential copying entirely by performing native login directly in each final managed profile.

Default sharing policy should be conservative: credentials, settings, history, projects, plugins, and runtime state remain profile-local. Skills or instruction files may become explicit opt-in sharing features only after their semantics are defined. Do not symlink an entire Claude settings file by default.

### Codex

- Default to T3's documented shared-home plus shadow-home layout.
- The primary `CODEX_HOME` holds shared sessions, settings, skills, and related state.
- Each additional account gets a shadow home with its own real `auth.json`; T3 materializes the shared entries as links and keeps credential/model-cache entries private.
- This layout keeps accounts switchable in compatible existing T3 threads.
- A fully separate `CODEX_HOME` is an advanced isolation choice, not the common default.
- Do not treat official `codex --profile` as an account switcher and do not copy OAuth files between profiles.

Windows symlink permissions and behavior need validation because T3's current shadow-home implementation uses filesystem symlinks.

`codex-profiles` independently confirms that process-scoped `CODEX_HOME` plus native `codex login` is sufficient and requires no token handling. It defaults to completely separate homes and does not share sessions; T3's primary-home plus private-shadow-home model remains the better default when compatible existing-thread switching is desired.

## Reconciliation contract

`sync` should compare desired managed profiles with T3's `providerInstances` and show a deterministic change set before mutation. It must:

- preserve unmanaged provider instances and unknown settings;
- write absolute paths because T3 should not be expected to expand shell syntax;
- never place credentials in T3 settings or CLI output;
- detect ID collisions, missing homes, stale registrations, and incompatible existing entries;
- avoid silently taking over an unmanaged instance;
- preserve untouched sensitive environment entries, including their redacted metadata, exactly;
- use atomic writes and refuse unsafe concurrency if direct settings-file mutation is the available integration seam.

T3 has no provider-settings CLI today. A running server does expose authenticated WebSocket RPC methods `server.getSettings` and `server.updateSettings`. The update accepts a `ServerSettingsPatch`, but `providerInstances` is replaced as a whole map rather than patched by key. The online flow therefore needs to read the current redacted settings, clone the complete map, merge only the target instance, update, then verify the result.

T3 stores sensitive environment values outside `settings.json`. The RPC returns redacted placeholders, and removing or changing those placeholders can remove the associated secret. An external sync must never reconstruct the whole map from its own registry.

When no server is running, direct `settings.json` reconciliation is a possible fallback: preserve the raw document, merge only the managed target, and atomically replace the file. T3 watches the file, but its locking is process-local, so direct mutation while the server is running risks a lost update and should be refused. Explicit T3 base selection is needed when `--base-dir`, `T3CODE_HOME`, or dev storage makes the target ambiguous.

The RPC and settings schema are internal/version-coupled rather than a documented external API. Keep the T3 adapter narrow, probe compatibility, and fail with an actionable message on unknown layouts instead of guessing.

## Storage discussion

Use one overrideable, user-visible managed root:

```text
~/.t3-profile/
  profiles.json
  profiles/
    claude/
      personal/
      work/
    codex/
      personal/
      work/
```

`T3_PROFILE_HOME` overrides `~/.t3-profile`. Node resolves `~` through the current user's home on macOS, Linux, and Windows. The uniform location is intentionally easier for humans to inspect, back up, and understand than platform-specific application-data paths.

Existing primary homes such as `~/.claude` and `~/.codex` are adopted by reference rather than moved. Additional managed subscription profiles live under `profiles/<provider>/<name>`.

T3 itself resolves its base from `T3CODE_HOME`, defaulting to `~/.t3`; `T3_HOME` is not the correct variable.

## Sharing contract

Profile creation must never silently link or copy shared resources. Interactive `add` shows the exact profile home, canonical source, private resources, and links before making changes, then requires confirmation. Non-interactive creation requires an explicit sharing preset or `--isolated`.

Example confirmation:

```text
Create Claude profile "personal"

Profile home
  ~/.t3-profile/profiles/claude/personal

Private to this profile
  OAuth / Keychain credential
  .credentials.json
  .claude.json account metadata
  projects and history

Shared live from ~/.claude
  skills/          -> ~/.claude/skills
  settings.json    -> ~/.claude/settings.json
  CLAUDE.md        -> ~/.claude/CLAUDE.md

Edits to shared resources affect every linked profile.
Create this profile? [y/N]
```

Claude's `.claude.json` is not the same as `.claude/settings.json`: the former contains account/global state and remains private; the latter may be shared only after explicit disclosure. Skills and instruction files are also live shared state, not one-time copies.

For Codex, the normal T3-compatible preset uses `~/.codex` as the shared primary home and the managed profile directory as the shadow home. It shares `config.toml`, sessions, skills, plugins, and `AGENTS.md` while keeping `auth.json` and `models_cache.json` private. The confirmation must disclose that shared sessions enable account switching in existing T3 threads.

Suggested creation choices:

- `shared`: link the documented settings, skills, instructions, and provider-specific shared runtime state;
- `isolated`: create no shared links;
- `custom`: select each resource category explicitly.

On Windows, directory junctions and file links need a capability check and an explicit fallback policy. Copying is not equivalent to live sharing and must never be presented as though it were a link.

## Safety invariants

- Never print, log, index, copy, or pass credentials through argv.
- Run native authentication against the target home instead of switching global state.
- Keep profile directories private where the platform permits, while stating that they are not full security boundaries.
- Preserve protocol-clean stdio by configuring T3's native drivers instead of wrapping them.
- `doctor` should distinguish missing binaries, missing or invalid auth, permissions, incomplete homes, stale T3 registration, version mismatch, and unsupported platform behavior.
- Separate provider accounts do not isolate environment variables, repositories, Git/SSH credentials, system keychains, or external tools.

## Scaffold direction

Mirror the small direct-source structure from `t3-session`:

- ESM package with a thin shebang entrypoint;
- centralized command parsing and dispatch;
- separate CLI, output, error, config, and version concerns;
- predictable exit codes and stdout/stderr separation;
- native `node:path`, `node:os`, and `node:fs` portability;
- narrow published-file allowlist and no build output unless it becomes necessary.

Do not carry over skill installation, transcript storage, JSONL/schema envelopes, or SQLite machinery. Human-readable output is the default; machine contracts can be added only when a real consumer exists.

## Open product questions

1. Is `t3-profile` definitively the package and command name?
2. Should `add` be an interactive end-to-end flow by default, or only create metadata and leave `auth`/`sync` explicit?
3. What should happen on Windows when live-link capabilities are unavailable?
4. How should a local CLI obtain authenticated access to a running T3 RPC without making credential handling worse?
5. What minimum Claude Code version should be required for profile-hashed secure storage, and how should compatibility be probed?
6. Are any Claude resources shared in v1, or is complete profile isolation the first safe release?
7. Does v1 support only T3 registration, or also convenient terminal launching under a named profile?
8. What is the safe behavior when T3 is running and a provider instance changes?
9. Should the first/default Codex account be adopted from the existing `~/.codex`, with only additional accounts managed under the tool root?

## Sources examined

- T3 discussion thread `71350509-ff55-432e-b48c-3046936adc94`, complete 5-turn projection, idle, no warnings.
- `/Users/alexbrodsky/GitHub/t3code/docs/providers/claude.md`
- `/Users/alexbrodsky/GitHub/t3code/docs/providers/codex.md`
- `/Users/alexbrodsky/GitHub/t3code/packages/contracts/src/providerInstance.ts`
- `/Users/alexbrodsky/GitHub/t3code/packages/contracts/src/settings.ts`
- `/Users/alexbrodsky/GitHub/t3code/apps/server/src/provider/Drivers/ClaudeHome.ts`
- `/Users/alexbrodsky/GitHub/t3code/apps/server/src/provider/Drivers/CodexHomeLayout.ts`
- `/Users/alexbrodsky/GitHub/t3code/apps/server/src/serverSettings.ts`
- `/Users/alexbrodsky/GitHub/t3code/apps/server/src/ws.ts`
- `/Users/alexbrodsky/GitHub/t3code/packages/contracts/src/rpc.ts`
- `/Users/alexbrodsky/GitHub/t3-session`
- `/Users/alexbrodsky/GitHub/claude-swap`
- `/Users/alexbrodsky/GitHub/codex-profiles`
- Installed Claude Code 2.1.234 program binary, inspected for environment and Keychain service derivation without reading credentials.
