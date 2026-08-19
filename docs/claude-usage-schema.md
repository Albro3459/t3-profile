# Claude usage response schema

The exact command used for the Claude adapter is:

```text
claude -p "/usage" --output-format json
```

The redacted capture in `fixtures/claude-usage-success.json` was obtained from
Claude Code 2.1.235 with `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the managed profile home.

The top-level response is a JSON object with the usual result envelope fields,
including `type`, `subtype`, `is_error`, and `result`. In this supported CLI
version, `result` is a string containing human-formatted text. Its observed
lines are a current-session percentage and a current-week percentage/reset
line; it does not expose stable field names, a five-hour object, a weekly
object, percentage units as typed values, or reset timestamps as typed values.

This is not a machine-readable schema. The adapter therefore rejects the
envelope and returns unavailable usage. It must not parse this text with
regular expressions or depend on its wording, punctuation, locale, or display
timezone. `fixtures/claude-usage-partial-session.json` records a response with
one displayed line omitted, and `fixtures/claude-usage-malformed.json` records
an unsupported object-shaped result. Both are rejected.

A future adapter change requires a provider response whose `.result` is a
documented machine-readable object containing explicit five-hour and weekly
windows, numeric percentage units, and reset timestamp units. Until then,
shipping a successful Claude parser would violate the v3 retrieval contract.
