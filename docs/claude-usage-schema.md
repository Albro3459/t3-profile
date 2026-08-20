# Claude usage response schema

Claude usage is read from Anthropic's OAuth usage endpoint:

```text
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken>
anthropic-beta: oauth-2025-04-20
```

On macOS, Claude authentication writes to the selected managed profile's
Claude Code Keychain item whenever the login Keychain is unlocked, including
over SSH. When it is locked, Claude falls back to the profile's regular
`.credentials.json` file; SSH itself does not select the storage backend. The
item name is derived from the profile home using the same path hash as the
tested Claude Code version. Other platforms use the credential file directly.
The token is kept only in memory and is never printed, persisted, or included
in errors. Missing, redirected, malformed, or unreadable credentials make that
profile's usage unavailable.

The usage command can identify a matching item whose secret is inaccessible
because the confirmed login Keychain is locked. In an eligible interactive
terminal it may ask once whether to unlock it, retry all providers and
profiles, and relock it afterward. Relocking is best effort; Codex Keychain
recovery is not implemented or tested because its credential backend is
configurable. The lock check is deliberately conservative: it first confirms
the matching item in the resolved login Keychain, then accepts only the known
Security statuses -25308 or -25315, the observed macOS 26 process status 24,
and bounded known `security` diagnostics.
If `/usr/bin/security` cannot make that confirmation, recovery is skipped.

The response is a JSON object. The supported window fields are:

```json
{
  "five_hour": {
    "utilization": 12,
    "resets_at": "2026-08-19T17:59:00Z"
  },
  "seven_day": {
    "utilization": 34,
    "resets_at": "2026-08-24T19:59:00Z"
  }
}
```

`utilization` is a numeric percentage from 0 through 100. `resets_at` is an
ISO-8601 timestamp. The adapter normalizes `five_hour` to `five_hour` and
`seven_day` to `week`, then formats both in the invocation's display timezone.

The success fixture is [claude-usage-success.json](../fixtures/claude-usage-success.json).
The partial fixture omits `seven_day`. The malformed fixture uses an invalid
percentage and reset timestamp. Invalid fields affect only their labeled
window. On HTTP 401, the adapter invokes the selected profile's native Claude
Code `/usage` command once without session persistence, discards its output,
rereads the credential, and retries the typed endpoint once if the access token
changed. This delegates refresh-token rotation and credential locking to
Claude Code. Other HTTP, credential, timeout, JSON, and unsupported-response
failures make the complete usage check unavailable.

## Observed inactive-session response

An account with no currently started five-hour session returned HTTP 200 with
the normal response envelope. The five-hour bucket was not an error:

```json
{
  "five_hour": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day": {
    "utilization": 13.0,
    "resets_at": "2026-08-26T09:59:59.581733+00:00"
  },
  "limits": [
    {
      "kind": "session",
      "percent": 0,
      "resets_at": null,
      "is_active": false
    },
    {
      "kind": "weekly_all",
      "percent": 13,
      "resets_at": "2026-08-26T09:59:59.581733+00:00",
      "is_active": true
    }
  ]
}
```

This corresponds to the Claude website's state where it is waiting for a
message to start the session. The complete captured response is
[claude-usage-no-active-session.json](../fixtures/claude-usage-no-active-session.json).
The adapter normalizes this as an inactive window and displays `5h 0% · not
started`, rather than treating it as a provider failure. We have not yet
captured an inactive weekly window, but expect the symmetric representation:
`seven_day` with `utilization: 0`, `resets_at: null`, and a `limits` entry with
`kind: "weekly_all"` and `is_active: false`.

This endpoint is undocumented and may be rate-limited or changed by Anthropic.
The direct API path is intentional: the `claude -p "/usage" --output-format
json` envelope currently places human-formatted text in `.result`, which is not
a stable machine-readable schema. The native command is used only for bounded
401 recovery; its human-formatted output is never parsed.
