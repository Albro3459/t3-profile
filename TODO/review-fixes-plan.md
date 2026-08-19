# t3-profile v1 review-fix implementation plan

Status: ready for implementation. This plan resolves every finding in
`TODO/review.md` without adding v2 behavior.

## Required outcome

After this work:

- interactive `add` merges only a settings document read after the user confirms
  T3 is stopped;
- a changed summary-relevant input causes a clean failure before control files
  are mutated;
- rollback either restores both control files and removes only tool-owned
  filesystem entries, or retains the profile and reports exact manual recovery
  information;
- settings replacement never removes the destination before the replacement is
  ready;
- Claude links are cycle-safe, revalidated, and verified;
- Codex authentication runs `codex login`;
- `auth` and `run` safely support Windows `.cmd` shims;
- existing provider-instance envelopes are validated to T3's public envelope
  contract while driver configuration remains opaque.

No command syntax, registry schema, sharing policy, or v2 feature changes are
included.

## Fixed design decisions

1. Summary-relevant changes detected after the final summary are not silently
   accepted and do not trigger another prompt. `add` exits nonzero with an
   instruction to rerun it so the user sees and confirms a new summary.
   Unrelated settings changes are merged from the stopped-server snapshot and
   preserved without requiring another confirmation.
2. Cross-process locking remains out of scope. The implementation closes the
   interactive stale-read window and performs a final content check immediately
   before each control-file write. A mismatch fails closed.
3. Windows atomic replacement uses a same-directory temporary file followed by
   one replacing rename. The current move-old-aside fallback is removed. A
   transient Windows rename failure is retried; a persistent failure leaves the
   original target in place and aborts.
4. Rollback never recursively deletes a profile directory. It removes recorded
   links, then removes only empty directories that this invocation created.
5. If either settings or registry restoration cannot be verified, the managed
   profile is retained for recovery. The error identifies the failed rollback
   steps and the settings backup path.
6. Add `cross-spawn@7.0.6` as the single runtime dependency. It resolves PATH,
   PATHEXT, shebangs, and `.cmd` shims while preserving the argument-array API;
   application code must not use `shell: true` or build a command string from
   provider arguments.
7. Do not add or run automated tests. Validation follows the build and manual
   filesystem/settings checks required by the v1 plan.

## Files to change

- `package.json` and the generated `package-lock.json`
- `src/atomic.mjs`
- `src/commands.mjs`
- `src/errors.mjs`
- `src/links.mjs`
- `src/providers.mjs`
- `src/registry.mjs`
- `src/settings.mjs`
- new `src/process.mjs`
- `README.md` only if implementation-visible recovery wording is needed
- `TODO/review.md` to mark each finding resolved after validation

## Implementation sequence

### 1. Replace the non-atomic Windows fallback

In `src/atomic.mjs`:

1. Keep temporary files in the target directory, open them with `wx`, write the
   complete payload, sync the handle, and close it before replacement.
2. Replace `replaceTarget` with a helper that calls `fs.rename(temporary,
   target)` without first renaming or unlinking `target`.
3. On Windows only, retry `EPERM`, `EACCES`, and `EBUSY` failures after 10, 25,
   50, 100, and 200 milliseconds. Do not retry `ENOENT`, `ENOTDIR`, or other
   structural errors.
4. If all attempts fail, delete only the temporary file and propagate an
   actionable error. The original target must remain at its original path.
5. Keep the existing mode-preservation behavior. Do not add a platform command,
   native addon, or move-aside recovery file.

Add content-checked file helpers:

- `readCurrentFile(path)` returns `{ exists, raw, mode }` and rejects symlinks
  and non-files;
- `writeAtomicIfUnchanged(path, expectedRaw, nextRaw, mode, label)` re-reads the
  target immediately before replacement and rejects if presence or contents no
  longer match `expectedRaw`;
- `restoreAtomicIfUnchanged(path, writtenRaw, originalRaw, originalMode, label)`
  restores only when the current contents still equal this invocation's written
  payload.

Use `null` as the expected/original value for a file that must not exist. Error
messages must identify the changed file but never include its contents.

### 2. Validate the T3 provider-instance envelope

In `src/settings.mjs`, extend `validateSettingsDocument` to match the known T3
envelope contract:

- every `providerInstances` key is 1-64 characters and matches
  `^[a-zA-Z][a-zA-Z0-9_-]*$`;
- every instance is a plain object;
- `driver` is required and follows the same open-slug rule;
- optional `displayName` and `accentColor` are nonempty trimmed strings;
- optional `enabled` is boolean;
- optional `environment` is an array of plain objects;
- every environment entry has a `name` of 1-128 characters matching
  `^[a-zA-Z_][a-zA-Z0-9_]*$`;
- optional/defaultable `value` is a string when present;
- optional/defaultable `sensitive` is boolean when present;
- optional `valueRedacted` is boolean;
- optional `config` is accepted without inspection and preserved exactly.

Do not restrict `driver` to Claude or Codex. Unknown valid driver slugs and all
unrecognized envelope properties must round-trip unchanged.

### 3. Make the confirmed add intent immutable

Refactor `prepareAdd` in `src/commands.mjs` into two phases.

`prepareAddIntent(options)` performs the current validation, sharing selection,
and final summary preparation. Store the summary-relevant snapshot:

- normalized source and managed paths;
- the initial registry/settings snapshots used for collision checks and the
  displayed custom-primary values; these snapshots are never passed to the
  mutation phase;
- intended instance ID;
- sharing mode;
- Claude manifest entries, skipped names, resolved source targets, and types.

`finalizeAddIntent(intent)` runs only after `confirmStopped` returns and before
any mutation. It must:

1. re-read and validate settings and registry;
2. rerun profile, registry, instance-ID, settings-instance, parent-directory,
   and control-path collision checks;
3. re-inspect Claude resources and rerun link capability/safety preflight;
4. compare the new sharing manifest and resolved targets with the confirmed
   snapshot;
5. compare every custom-primary value with the value shown in the summary;
6. fail with `Inputs changed while waiting for T3 to stop. Rerun add to review
   the new state.` if any confirmed value changed;
7. build `nextSettings` only from this post-confirmation settings document;
8. build the exact next registry document only from this post-confirmation
   registry document.

The `--yes` path still calls `finalizeAddIntent`; it merely skips prompts and
asserts that T3 was already stopped.

### 4. Make profile ownership exclusive and rollback-safe

Before mutation, ensure the managed root, `profiles`, and provider parent are
real directories and not links. Track which missing parent directories this
invocation creates.

Create the profile leaf with:

```js
await fs.mkdir(profileHome, { mode: 0o700 });
```

Do not pass `recursive: true` for the leaf. Convert `EEXIST` into the existing
profile-collision error. Set `profileCreated` only after this exact call
succeeds.

Replace `removeCreatedPath` with empty-directory cleanup:

1. remove only links returned by `createLinks` and verified as links;
2. call `fs.rmdir` for the created profile leaf;
3. if it is not empty, retain it and record an incomplete-cleanup error;
4. remove created parent directories in reverse order only while they are empty;
5. never use recursive removal for managed profile rollback.

### 5. Revalidate, create, and verify Claude links

In `src/links.mjs`:

1. For a file source, reject exact resolved source/destination identity.
2. For a directory source, reject identity and either ancestor relationship by
   applying `pathsOverlap(realSource, destination)`.
3. Immediately before link creation, stat and realpath every source again and
   require the same type and resolved target that appeared in the finalized
   intent.
4. Resolve existing destination links with `fs.realpath`, not a one-level
   `readlink`, so a source that is itself a symlink remains idempotent.
5. After creation, verify for every manifest entry that the destination is a
   link, resolves to the expected real source, and presents the expected
   file/directory type.
6. Return the verified created-link list to the transaction. Do not write
   settings or registry until this verification passes.

Keep Codex standard sharing delegated to T3's shadow-home implementation. Its
directory and file link capability probes remain pre-mutation requirements.

### 6. Write control files with stale-state guards

Refactor `backupAndWriteSettings` in `src/settings.mjs`:

1. accept the finalized settings raw contents as `expectedRaw`;
2. perform the immediate unchanged-content check;
3. write the backup from those exact bytes and return its path;
4. serialize `nextSettings` once and retain that exact string as `writtenRaw`;
5. atomically replace settings with `writtenRaw`;
6. return `{ backupPath, writtenRaw }` for verification and rollback.

Apply the same expected-raw rule to the registry write. An absent registry uses
`expectedRaw: null` and must still be absent immediately before creation.

Verification after both writes must check:

- the complete parsed settings document deeply equals `nextSettings`;
- the complete decoded registry deeply equals the intended profile array, not
  merely that a provider/name entry exists;
- the managed instance and any custom-primary paths have the expected values;
- every recorded Claude link still passes link verification.

### 7. Make rollback exhaustive and diagnosable

Represent mutation state explicitly in `mutateAdd`:

- created directories;
- created links;
- settings original raw/mode, written raw, and backup path;
- registry original raw/mode and written raw.

On failure, attempt all applicable control-file restores independently in this
order:

1. restore settings only if it still equals `settingsWrittenRaw`;
2. restore registry only if it still equals `registryWrittenRaw`;
3. re-read both files and verify their original presence and contents.

Only when both control files are restored or were never changed may rollback
remove links and empty created directories. Otherwise retain the profile so no
persisted control entry points to a deleted home.

Use a `settleRollbackStep` helper that awaits each step in the stated order and
records its error instead of throwing; no rollback operation may prevent later
restoration attempts. If rollback is complete, rethrow the original failure. If
rollback is incomplete, throw a `CliError` that contains:

- the original operation failure;
- each failed restore/cleanup step and path;
- the settings backup path when one exists;
- the correction `Leave T3 stopped, restore the listed files, then retry.`

Update `src/errors.mjs` only as needed to retain structured cleanup details.
Continue printing the first line with `Error:` and do not print file contents or
environment values.

### 8. Correct provider authentication and process spawning

In `src/providers.mjs`, add:

```js
export function providerAuthArguments(provider) {
  return provider === "claude" ? ["auth", "login"] : ["login"];
}
```

Validate the provider before returning. Use this helper from `authCommand`.

Add `cross-spawn@7.0.6` with `npm install cross-spawn@7.0.6`, retaining the
generated lockfile. Move `runProvider` into new `src/process.mjs` and use
`cross-spawn` with:

```js
spawn(binary, args, { env, stdio: "inherit", shell: false });
```

Pass the argument array unchanged. Preserve the current ENOENT/actionable-error
mapping and child exit-code behavior. Do not concatenate arguments, quote them
manually, invoke `cmd.exe` directly, or enable a shell. Add the new module to the
syntax-build script.

### 9. Update documentation and close the review

Keep README command and sharing descriptions unchanged unless recovery output
adds user-visible instructions that need documentation. Update
`TODO/review.md` after implementation:

- mark each item resolved;
- reference the resolving file/function;
- record the completed validation cases;
- retain the review as implementation history.

## Manual validation matrix

Run `npm run build`, then perform these checks without using real credentials or
the real T3 settings file. Use explicit temporary `T3_PROFILE_HOME`,
`T3CODE_HOME`, provider homes, and stub provider commands.

1. **Stopped-state refresh:** change an unrelated unmanaged provider instance
   after the summary but before confirmation. `add` must merge from the fresh
   stopped-server snapshot and retain that changed instance.
2. **Shutdown write preservation:** change opaque config and a redacted
   environment entry during the prompt. The final document must preserve both
   values exactly while adding the managed instance.
3. **Custom-primary conflict:** change a displayed primary home during the
   prompt. `add` must require a rerun and display the new value on that rerun.
4. **Profile collision window:** create the profile leaf during the prompt.
   `add` must fail with `EEXIST` handling and must not alter or remove its
   contents.
5. **Source drift:** remove, retarget, and type-change each Claude shared
   resource during the prompt. Every case must fail before control-file writes.
6. **Cycle safety:** point a shared directory symlink at the managed profile's
   parent. Preflight must reject it before mutation.
7. **Link verification:** use a source that is itself a symlink. Creation and a
   repeated verifier call must accept the expected final target.
8. **Settings write failure:** make settings replacement fail. The original
   settings and registry must remain, and only empty tool-created directories
   may be removed.
9. **Registry write failure:** allow settings replacement, then fail the
   registry write. Settings must restore exactly and the profile must be removed
   only after restoration verifies.
10. **Rollback restoration failure:** prevent settings restoration after a later
    failure. The profile must remain, the error must name the failed restore and
    backup, and no cleanup failure may be hidden.
11. **Malformed envelope:** try missing/invalid drivers, invalid instance IDs,
    malformed environment entries, and invalid optional field types. Each must
    fail before backup or mutation. Unknown valid drivers and opaque configs
    must be preserved.
12. **Codex auth:** a stub `codex` command must receive exactly `login`.
13. **Claude auth:** a stub `claude` command must receive exactly `auth login`.
14. **Argument fidelity:** `run` must pass spaces, quotes, parentheses,
    ampersands, and empty arguments unchanged to the stub provider.
15. **Windows atomic replacement:** under target-file contention, replacement
    must either succeed with the complete new file or fail with the complete old
    file still at the original path; it must never expose a missing target.
16. **Windows shims:** on a Windows host, run `auth` and `run` through `.cmd`
    stubs whose paths contain spaces and verify exact argument fidelity.
17. **Success verification:** inspect the final profile, links, registry,
    settings, backup, permissions, stdout, and stderr for both providers and both
    sharing modes.

Implementation is complete only when the build passes, all applicable macOS
checks pass, and the Windows-only checks are either completed on Windows or
explicitly reported as outstanding platform validation.

## Completion checklist

- All eight findings in `TODO/review.md` are resolved.
- No stale pre-confirmation settings document is written.
- No rollback path suppresses an error.
- No rollback recursively deletes a managed profile.
- The original settings path is never moved aside before replacement.
- Full settings, registry, and link verification occurs before success output.
- Codex and Claude receive their exact native login arguments.
- Provider arguments remain array-based; application code never enables a shell
  or interpolates arguments into a command string.
- No v2 behavior or automated test suite is added.
