# t3-profile v1 implementation review

Scope: `TODO/plan.md` against commits `6a62fa0`, `abf40a4`, `c061f07`, and
review-fix commit `432ab2a`.

## Follow-up findings

### Resolved: Preserve link ownership during rollback

`createLinks` immediately calls `rollbackLinks` when a later link operation
fails (`src/links.mjs:246-288`). `rollbackLinks` removes every recorded path
that is currently a symbolic link without checking that it is still the link
created by this invocation (`src/links.mjs:292-305`). If another process or the
user replaces an earlier created link before a later link fails, rollback can
delete that replacement. The safer outer cleanup in `removeCreatedArtifacts`
never sees the path because the inner rollback has already removed it.

Carry sufficient ownership information for each created link and verify it
before unlinking. If ownership cannot be established, retain the path and
report incomplete cleanup instead of deleting it.

`createLinks` now records the destination, expected real source, and BigInt
filesystem identity for each link it creates. Both immediate and outer
rollback use the same ownership-aware `rollbackLinks` path and retain/report a
destination whose identity or target no longer matches.

Resolving code: `src/links.mjs` (`createLinks`, `rollbackLinks`,
`linkIdentity`, `sameLinkIdentity`) and `src/commands.mjs`
(`removeCreatedArtifacts`, `mutateAdd`).

### Resolved: Make regex validation consume the complete input

The profile-name, instance-ID, provider-instance slug, and environment-name
patterns use JavaScript's `$` assertion (`src/names.mjs:4`,
`src/names.mjs:40-47`, and `src/settings.mjs:25-35`). `$` also matches before a
final line terminator, so values such as `personal\n` and `codex\n` pass these
checks even though they do not match the required whole-input formats. A
newline-suffixed profile name reaches derived paths, T3 instance IDs, and
terminal output, and it also bypasses the Windows reserved-name comparison.

Use a true end-of-input check or explicitly reject line terminators before
applying the patterns.

The name, instance-ID, open-slug, and environment-name patterns now combine
the existing `$` assertion with a true end-of-input negative assertion. Final
line terminators can no longer pass any of these validators.

Resolving code: `src/names.mjs` (`NAME_PATTERN`, `validateInstanceId`) and
`src/settings.mjs` (`OPEN_SLUG`, `ENVIRONMENT_NAME`).

### Resolved: Reject an existing managed-root symlink

`resolveManagedRoot` inspects an existing `T3_PROFILE_HOME` with `fs.stat` and
then canonicalizes it with `realpath` (`src/paths.mjs:69-85`). Consequently, a
managed root that is itself a symbolic link is accepted and all managed state
is written through it. The review-fix plan requires the managed root, profiles
directory, and provider parent to be real directories rather than links.

Inspect the configured root with `lstat` before canonicalization and reject a
symbolic link consistently with the descendant-directory checks.

`resolveManagedRoot` now uses `lstat` for an existing final component and
rejects symbolic links before canonicalizing a real directory. Missing roots
continue to canonicalize through their nearest existing real ancestor.

Resolving code: `src/paths.mjs` (`resolveManagedRoot`).

### Resolved: Retain partial directory-creation ownership on failure

`mutateAdd` records the directories returned by `ensureDirectoryChain` only
after that helper resolves (`src/commands.mjs:548-559`). If the helper creates
one or more missing ancestors and a later `mkdir` fails, it throws without
returning the partial `created` list (`src/commands.mjs:401-431`). Rollback then
has no record of those tool-created directories and leaves them behind.

Record each successful creation directly in mutation state, or attach the
partial list to the error so rollback can remove the empty directories it
owns.

`ensureDirectoryChain` now reports every successful `mkdir` immediately to
the mutation state. A later failure therefore leaves rollback with the full
partial ownership list.

Resolving code: `src/commands.mjs` (`ensureDirectoryChain`, `mutateAdd`).

### Resolved: Resolve custom-home handling for opaque default config

Settings validation intentionally accepts `config` without inspecting its
shape (`src/settings.mjs:63-86`), but a custom-home add later rejects an
existing default instance whose valid opaque `config` is a scalar or array
(`src/settings.mjs:141-169`). This means a settings document accepted under the
documented public envelope can still make `--home` fail after the stopped-T3
confirmation, despite the v1 completion criterion requiring custom primary
homes.

Define and preflight the supported custom-home transformation before the final
summary. The implementation must either preserve a valid opaque config while
updating the supported primary-home field or report the unsupported shape
before asking the user to stop T3.

Custom-home summary preparation now preflights the default instance config.
Opaque object configs and their unknown fields remain supported and preserved;
scalar, array, and null shapes fail before the summary and stopped-T3
confirmation instead of after it.

Resolving code: `src/settings.mjs` (`validateCustomPrimaryHome`,
`primaryHomeValues`).

### Validation: Partially complete

The validation record below contains the syntax build, help/version smoke
commands, and `git diff --check`, but it does not record the applicable macOS
drift, collision, rollback-failure, argument-fidelity, or success cases from
`TODO/review-fixes-plan.md`. That plan makes those manual checks part of the
completion criteria. Windows-only validation is correctly identified as
outstanding, but the implementation should not be marked fully reviewed until
the applicable macOS cases and their results are recorded here.

The final Luna validation pass added isolated macOS success, envelope, name,
registry, settings, and link coverage recorded below. Interactive drift and
forced rollback-failure cases, native provider argument checks, full
permissions/output inspection, and Windows-only checks remain outstanding.

## Findings and resolutions

### Resolved: Re-read and merge T3 settings after stopped-server confirmation

`prepareAdd` now records only the confirmed intent and summary snapshot.
`finalizeAdd` re-resolves the managed root and source, re-reads settings and
the registry, reruns collision and link checks, rejects summary-relevant drift,
and builds the final settings and registry documents from the post-confirmation
state. Unrelated settings and registry changes are preserved.

Resolving code: `src/commands.mjs` (`prepareAdd`, `finalizeAdd`,
`validateAddState`).

### Resolved: Use the provider-specific native authentication command

`providerAuthArguments` returns `auth login` for Claude and `login` for Codex,
and `authCommand` uses that provider-specific argument list.

Resolving code: `src/providers.mjs` (`providerAuthArguments`) and
`src/commands.mjs` (`authCommand`).

### Resolved: Make rollback complete and report cleanup failures

`rollbackAdd` attempts settings and registry restoration independently, then
jointly re-reads both control files before removing any profile artifacts. It
retains the profile when either file cannot be restored or verified and reports
each failed step plus the settings backup path. Claude link rollback returns
its created-link state and failures instead of swallowing unlink errors, so the
outer transaction can retry and report exact cleanup paths.

Resolving code: `src/commands.mjs` (`rollbackAdd`, `removeCreatedArtifacts`,
`mutateAdd`) and `src/links.mjs` (`createLinks`, `rollbackLinks`).

### Resolved: Create the profile leaf exclusively before treating it as owned

`ensureDirectoryChain` creates and tracks only missing parent directories.
`mutateAdd` creates the profile leaf with one non-recursive `mkdir` call and
records ownership only after that call succeeds. Rollback removes only recorded
links and empty directories; it never recursively removes profile content.

Resolving code: `src/commands.mjs` (`ensureDirectoryChain`,
`mutateAdd`, `removeCreatedArtifacts`).

### Resolved: Do not describe the Windows replacement fallback as atomic

Atomic writes now stage and fsync a same-directory temporary file, then use one
replacing rename. The move-aside fallback is gone. Windows rename contention
retries only the documented transient errors and leaves the original target in
place on persistent failure. Content-checked writes stage first and re-read the
target immediately before replacement; rollback restores use the same guard.

Resolving code: `src/atomic.mjs` (`stageFile`, `replaceTarget`,
`writeAtomicIfUnchanged`, `restoreAtomicIfUnchanged`).

### Resolved: Validate the known T3 provider-instance envelope

Settings validation now checks provider-instance IDs and drivers, optional
display fields, enabled flags, and environment entry names, values, and flags.
The driver-specific `config` object and unknown envelope properties remain
opaque and round-trip unchanged.

Resolving code: `src/settings.mjs` (`validateSettingsDocument`,
`validateEnvironment`, `validateSlug`).

### Resolved: Revalidate and verify the Claude link layout at mutation time

Claude resources are re-resolved and type-checked immediately before link
creation. Existing links are compared through `realpath`, directory source
overlaps are rejected, and every link is verified before control files are
written. Partial link creation carries its created destinations into the
transaction rollback path.

Resolving code: `src/links.mjs` (`revalidateSource`, `assertSafeClaudeResource`,
`createLinks`, `verifyClaudeLinks`) and `src/commands.mjs` (`mutateAdd`).

### Resolved: Support Windows command shims for provider execution

Provider execution now uses `cross-spawn@7.0.6` with an argument array,
`shell: false`, inherited stdio, and the existing actionable error/exit-code
mapping. This supports PATH and Windows `.cmd` shims without concatenating or
shell-interpolating provider arguments.

Resolving code: `src/process.mjs` (`runProvider`), `src/commands.mjs`
(`authCommand`, `runCommand`), `package.json`, and `package-lock.json`.

## Validation

- `npm run build` passes, including syntax checks for the new process module.
- `npm run start -- --help` and `npm run start -- --version` pass.
- `git diff --check` passes.
- Isolated fixtures pass for Claude standard/custom-home, Claude isolated,
  Codex standard/custom-home, and Codex isolated adds. `list` reports all four
  profiles.
- Final fixture inspection confirms the Claude live links, Codex direct and
  shadow-home settings, complete registry entries, and preservation of an
  unknown provider driver plus opaque configuration and root data.
- Malformed settings are rejected for a missing driver, invalid instance ID,
  non-string environment value, and blank display name. Uppercase and
  Windows-reserved profile names are rejected.
- The final focused review found and the implementation resolved the remaining
  link rollback-state, immediately-before-replacement, joint-rollback-
  verification, lockfile, and review-completion issues.
- No automated tests were added or run, matching the v1 plan's explicit test
  constraint.
- Outstanding macOS cases are interactive stopped-state drift/conflict/source
  drift/cycle checks, forced settings/registry/rollback failures, native auth
  and argument fidelity, and full permissions/stdout/stderr inspection.
  Windows atomic contention and command-shim checks require a Windows host.
