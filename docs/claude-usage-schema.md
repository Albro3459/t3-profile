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
The partial fixture omits `seven_day`; the malformed fixture uses an invalid
percentage and reset timestamp. Invalid fields affect only their labeled
window. HTTP, credential, timeout, JSON, and unsupported-response failures
make the complete usage check unavailable.

This endpoint is undocumented and may be rate-limited or changed by Anthropic.
The direct API path is intentional: the `claude -p "/usage" --output-format
json` envelope currently places human-formatted text in `.result`, which is not
a stable machine-readable schema.
