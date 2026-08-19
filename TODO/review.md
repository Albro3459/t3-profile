# t3-profile v1 implementation review

Scope: `TODO/plan.md` against commits `6a62fa0`, `abf40a4`, and `c061f07`.

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
- The final focused review found and the implementation resolved the remaining
  link rollback-state, immediately-before-replacement, joint-rollback-
  verification, lockfile, and review-completion issues.
- No automated tests were added or run, matching the v1 plan's explicit test
  constraint. Windows-only contention and shim checks require a Windows host.
