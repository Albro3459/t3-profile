# t3-profile v1 implementation review

Scope: `TODO/plan.md` against commits `6a62fa0`, `abf40a4`, and `c061f07`.

## High priority

### TODO: Re-read and merge T3 settings after stopped-server confirmation

`prepareAdd` reads `settings.json` and builds `nextSettings` before the user is
asked to stop T3 (`src/commands.mjs:173-174`, `src/commands.mjs:240-249`, and
`src/commands.mjs:275-289`). `mutateAdd` later writes that pre-confirmation
snapshot (`src/commands.mjs:322-327`).

In the normal interactive flow, T3 can still be running when the snapshot is
taken and can write settings while shutting down. A successful `add` then
overwrites those newer unmanaged instances, opaque configuration, or sensitive
redaction metadata. The backup captures the current file, but success does not
detect the stale merge. Re-read after confirmation, reject/reconfirm changed
conflicts, and build the final merge from the stopped-server document.

### TODO: Use the provider-specific native authentication command

`authCommand` always passes `['auth', 'login']` (`src/commands.mjs:403-412`).
That is correct for Claude, but the plan requires `codex login`, not
`codex auth login`. Codex profile authentication currently launches the wrong
command.

### TODO: Make rollback complete and report cleanup failures

The rollback path is not failure-safe (`src/commands.mjs:352-360`). If registry
restoration throws, settings restoration and filesystem cleanup are skipped.
Settings restoration errors are swallowed, after which the profile directory
can be removed while T3 still points to it. Other cleanup failures are also
discarded, so the reported error does not tell the user that manual recovery is
required.

Attempt every rollback step, retain all cleanup errors, and leave/recover the
state in an order that cannot silently pair modified T3 settings with a deleted
profile.

### TODO: Create the profile leaf exclusively before treating it as owned

The existence check happens before interactive prompts
(`src/commands.mjs:209-213`), but mutation later uses recursive `mkdir` and
unconditionally sets `profileCreated = true` (`src/commands.mjs:292-301`). If
the directory appears during that window, `mkdir` accepts it as existing. On a
later failure, `removeCreatedPath` recursively deletes the entire directory,
including content the tool did not create (`src/commands.mjs:352-360` and
`src/atomic.mjs:72-74`). This violates the collision and rollback ownership
rules.

Create parent directories separately, create the profile leaf with exclusive
semantics, and only remove it when that exact operation created it.

### TODO: Do not describe the Windows replacement fallback as atomic

On Windows, `replaceTarget` moves the existing target aside and then renames
the temporary file into place (`src/atomic.mjs:13-29`). A crash or interruption
between those two renames leaves `settings.json` absent. That does not meet the
plan's atomic settings replacement requirement. Use a Windows-safe replacement
primitive or explicitly redesign the operation around a recoverable journal
that is repaired before any later command proceeds.

## Medium priority

### TODO: Validate the known T3 provider-instance envelope

`validateSettingsDocument` accepts a provider instance with no `driver` and
accepts any array contents as `environment` (`src/settings.mjs:14-35`). Such a
document passes preflight, is rewritten, and can still be rejected by T3's
settings decoder after restart. Validate the known envelope fields and
environment-entry shape while continuing to preserve driver-specific `config`
as opaque data.

### TODO: Revalidate and verify the Claude link layout at mutation time

Claude resources are inspected before the sharing and stopped-server prompts
(`src/commands.mjs:219-238`), but the source types/targets are not rechecked and
the resulting links are not verified after creation
(`src/commands.mjs:300-351`). A source can disappear or change during the
prompt window, allowing a broken or unintended link to be registered as a
successful profile. Revalidate immediately before mutation and verify every
recorded link before settings/registry success is reported.

### TODO: Reject directory-link cycles, not only exact identity

Claude link preflight compares each resolved source only for exact equality
with its destination (`src/links.mjs:108-115`). A shared directory symlink can
resolve to an ancestor of the managed destination and create a cycle without
being equal to it. Apply an overlap/ancestor check to resolved directory
sources as required by the live-link safety policy.

### TODO: Support Windows command shims for provider execution

Provider execution uses bare `claude` or `codex` with `spawn` and no shell
(`src/providers.mjs:29-31` and `src/commands.mjs:389-399`). On Windows,
installations exposed through npm-style `.cmd` shims are not directly
executable by this form, so `auth` and `run` can fail even when the provider CLI
is on `PATH`. Resolve an executable safely for the platform without introducing
shell argument interpolation.

## Validation

- `npm run build` passes.
- No tests were added or run, matching the v1 plan's explicit test constraint.
