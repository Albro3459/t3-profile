# t3-profile v2 review fixes

Status: implementation plan only. This document covers the findings from the
v2 implementation review of commit `48a4773`.

## Goals

- Make destructive profile removal stay inside the managed root even when
  filesystem paths have been replaced or redirected.
- Require an explicit stopped-T3 confirmation before every operation that
  mutates T3 settings or a T3-managed profile layout.
- Keep provider authentication and diagnostics bound to the selected profile.
- Make `doctor` bounded and accurate for the conditions it reports.
- Correct the removal disclosures and v2 documentation.

## Command confirmation contract

The stopped-T3 boundary applies to commands that will mutate T3 settings or a
profile layout used by T3:

- `add` confirms that T3 is fully stopped after the creation/sharing summary
  and before creating the profile or changing settings.
- `sync` confirms only when its final plan contains changes. `--dry-run` and an
  already-synchronized no-op do not prompt.
- `remove` first obtains the destructive removal confirmation, then separately
  confirms that T3 is fully stopped immediately before securing the profile
  home and changing control files.

Use the same explicit prompt for all three mutation paths:

```text
T3 is fully stopped and ready to update? [y/N]
```

`--yes` is the non-interactive assertion that the user has already stopped T3
and accepts the command's other confirmations. It must not bypass validation
or post-confirmation state checks. Read-only commands such as `list` and
`doctor`, provider-only commands such as `auth` and `run`, dry runs, cancelled
commands, and mutation no-ops do not require T3 to be stopped.

Centralize this behavior in a small confirmation helper so future T3 settings
mutations cannot silently invent a different prompt or skip the boundary. Keep
the destructive `remove` confirmation separate: confirming that T3 is stopped
is not the same as consenting to permanent deletion.

## Fix 1: contain recursive removal

Affected areas: `src/commands.mjs`, with reusable path validation placed in
`src/paths.mjs` if it keeps the command flow smaller.

The current removal flow validates the lexical profile path and the final
directory entry, but an intermediate `profiles` or provider directory can be a
symbolic link. `rename` and recursive removal can therefore operate on a
directory outside the managed root.

Implementation requirements:

1. Resolve the expected managed chain as `managedRoot/profiles/provider/name`.
2. Inspect the managed root, `profiles`, and provider parent with `lstat` and
   reject symbolic links, junctions/reparse points, and non-directories.
3. Canonicalize the existing parent and profile home and require both to remain
   within the canonical managed root. A lexical prefix check is insufficient.
4. Record filesystem identity for the validated parent and profile home, then
   revalidate the chain immediately before moving the home to its holding path.
5. After the move, verify the holding path has the recorded profile identity
   and that the parent chain has not changed.
6. Revalidate the parent chain and holding-path identity again immediately
   before recursive deletion. Fail closed and retain the holding directory if
   ownership or containment cannot be established.
7. Apply equivalent validation before attempting to roll a holding directory
   back to the original profile path.
8. Never broaden cleanup to the managed root, provider parent, source home, or
   an unverified path. An incomplete removal must report the retained path and
   manual recovery steps.

The source primary home and every path outside the verified managed profile
home remain non-owned and must never be deleted.

## Fix 2: enforce the stopped-T3 boundary

Affected areas: `src/commands.mjs`, `src/output.mjs`, and `README.md`.

1. Extract the existing stopped-T3 prompt into the shared confirmation helper.
2. Keep `add` on the helper without changing its current mutation ordering.
3. Use the helper for `sync` after showing the deterministic plan and before
   its final reads and write.
4. For `remove`, keep `Permanently remove this profile? [y/N]` as the explicit
   destructive confirmation, then invoke the stopped-T3 helper immediately
   before the final registry/settings/home revalidation.
5. Ensure cancellation before either boundary performs no filesystem or
   settings mutation.
6. Document exactly which commands prompt, which no-op paths do not, and that
   `--yes` asserts both stopped state and command consent.

The confirmation is an offline-safety contract, not process detection. v2
continues to trust the user's answer and does not inspect or terminate T3
processes.

## Fix 3: revalidate `sync` filesystem state after confirmation

Affected area: `src/commands.mjs`.

The initial sync plan validates managed identities and profile-home existence,
but the final phase checks only settings and registry bytes. A profile home can
disappear, change identity, or become redirected while the command waits for
confirmation.

1. Factor profile identity and home validation into a helper shared by the
   initial and final sync phases.
2. Reject unexpected registry identity fields, symlinked/reparse-point homes,
   non-directories, missing homes, and invalid managed parent chains.
3. Record the initial home identities for an interactive mutation and require
   the final homes to match before writing settings.
4. Rebuild the final sync plan only after registry, settings, and filesystem
   validation all pass.
5. Preserve current dry-run behavior: validate and print, but do not prompt or
   write.

## Fix 4: scrub every Claude authentication override

Affected area: `src/providers.mjs`.

Add these Claude variables to the case-insensitive authentication override
scrub set:

```text
CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
```

Continue scrubbing the existing token and API-key variables before setting
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. This environment
builder is shared by `add` authentication, `auth`, `run`, and `doctor`; all
four paths must select the requested profile rather than an inherited account.
Do not print variable values.

## Fix 5: disclose native credential retention

Affected areas: `src/output.mjs` and `README.md`.

The removal summary must distinguish data inside the managed profile home from
credentials held by the provider or operating system. State that:

- the managed profile home, including private files and local history stored
  there, will be deleted;
- removal does not perform native logout or token revocation; and
- credentials may remain in macOS Keychain or another provider credential
  store until the user revokes or logs them out separately.

Do not claim that all private authentication is permanently deleted. This is a
disclosure change only; v2 must not start manipulating Keychain entries or
provider credential stores.

## Fix 6: make Claude link diagnostics type-aware

Affected area: `src/commands.mjs`, with reuse from `src/links.mjs` where
practical.

For every registry-owned Claude link, `doctor` must verify all of the following:

- the destination is a symbolic link or the expected supported Windows link
  form;
- its resolved target matches the registered source;
- the resolved source and destination target match the registered `file` or
  `directory` type; and
- the destination belongs under the validated managed profile home.

A missing source, broken link, replaced source type, redirected destination,
or unreadable target must produce an error rather than a pass. Keep diagnostics
read-only and avoid repairing links inside `doctor`.

## Fix 7: bound provider diagnostic commands

Affected areas: `src/process.mjs` and `src/commands.mjs`.

1. Add an explicit timeout to `inspectCommand`; use a short documented default
   suitable for local `--version` and authentication-status checks.
2. On timeout, stop only the child process started by this invocation, finish
   collecting its bounded output, and resolve once with a distinct timeout
   result.
3. Guard the error, close, and timeout paths so only one result wins and timer
   resources are always cleared.
4. Report a timed-out version or authentication probe separately from a
   missing binary and from a confirmed unauthenticated result.
5. Retain the existing output-size bound and never include captured credential
   material in diagnostics.

## Documentation cleanup

- Change the `README.md` shutdown section from “v1 trusts this confirmation”
  to “v2 trusts this confirmation.”
- Keep help text, README command behavior, prompt wording, and `--yes`
  semantics synchronized.
- Describe retained native credentials next to the removal behavior, not only
  in a distant security section.

## Implementation order

1. Add the managed-chain validation and harden `remove` before changing its
   prompts.
2. Centralize stopped-T3 confirmation and route `add`, mutating `sync`, and
   `remove` through it.
3. Add post-confirmation sync filesystem validation.
4. Complete Claude environment scrubbing.
5. Harden link diagnostics and provider probe timeouts.
6. Update output and documentation disclosures.
7. Perform the validation pass below and record the results in this document.

Each step should remain reviewable and avoid unrelated refactors or new
dependencies.

## Validation checklist

Follow repository policy: do not add or run an automated test suite for this
work unless that policy changes. Use focused fixture/manual checks plus the
existing syntax build.

- `npm run build` passes.
- `git diff --check` passes.
- Interactive `add`, mutating `sync`, and `remove` each show the exact
  stopped-T3 prompt; declining it leaves files unchanged.
- `remove` still asks separately for permanent-deletion consent.
- `--yes` performs no prompts but still executes all validation and drift
  checks.
- `sync --dry-run` and an already-synchronized `sync` do not ask the user to
  stop T3 and do not write settings or backups.
- Replacing `profiles` or the provider parent with a symlink/junction makes
  `remove` fail while an external victim directory and all control files stay
  unchanged.
- Changing the profile home while `sync` waits for confirmation makes sync
  fail before creating a backup or writing settings.
- Stubbed Claude invocations confirm both file-descriptor override variables
  are absent and the selected profile variables are present.
- The removal summary warns that native credential-store entries may remain.
- A Claude shared-directory source replaced by a regular file produces a
  doctor error.
- A deliberately stalled version or authentication-status probe times out,
  reports the timeout, and leaves no child process running.
- Normal missing-binary, unauthenticated, healthy-link, and synchronized-profile
  diagnostics retain their expected exit status and wording.
- Final manual inspection confirms settings/registry preservation, backup
  creation only for actual settings writes, and no changes outside the fixture
  managed root and T3 settings path.

## Completion criteria

- Recursive removal cannot proceed through an unverified or redirected managed
  parent.
- Every T3 settings mutation has an explicit stopped-T3 assertion and a final
  state revalidation immediately before mutation.
- Provider execution cannot inherit any known Claude token or API-key override.
- Removal output does not imply native credentials were revoked.
- `doctor` reports link type drift accurately and cannot wait forever on a
  provider command.
- README and CLI output describe the implemented v2 behavior without version
  or confirmation inconsistencies.
