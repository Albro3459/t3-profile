# Claude usage response schema

Claude usage is read from Anthropic's OAuth usage endpoint:

```text
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken>
anthropic-beta: oauth-2025-04-20
```

The access token is read only from the selected managed profile's regular
`.credentials.json` file. The token is never printed, persisted, or included
in errors. A missing, redirected, malformed, or unreadable credential file
makes that profile's usage unavailable.

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
window. HTTP, credential, timeout, JSON, and unsupported-response failures
make the complete usage check unavailable.

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
a stable machine-readable schema.
