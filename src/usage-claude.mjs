import { inspectCommand, INSPECT_COMMAND_TIMEOUT_MS } from "./process.mjs";
import { providerBinary } from "./providers.mjs";

export const CLAUDE_USAGE_ARGUMENTS = Object.freeze(["-p", "/usage", "--output-format", "json"]);
export const CLAUDE_USAGE_OUTPUT_LIMIT_BYTES = 65_536;

function unavailable() {
  return { status: "unavailable", windows: [] };
}

/**
 * Claude Code 2.1.235 returns a human-formatted string in envelope.result.
 * Reject it rather than coupling usage extraction to display wording.
 */
export function parseClaudeUsageEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return unavailable();
  if (typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) {
    return unavailable();
  }
  return unavailable();
}

export async function claudeUsageAdapter({ profileHome, environment, inspect = inspectCommand }) {
  try {
    const result = await inspect(
      providerBinary("claude"),
      CLAUDE_USAGE_ARGUMENTS,
      environment,
      INSPECT_COMMAND_TIMEOUT_MS,
    );
    if (!result?.found || result.code !== 0 || result.timedOut || result.outputExceeded) return unavailable();
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") return unavailable();
    if (Buffer.byteLength(result.stdout) > CLAUDE_USAGE_OUTPUT_LIMIT_BYTES || Buffer.byteLength(result.stderr) > CLAUDE_USAGE_OUTPUT_LIMIT_BYTES) {
      return unavailable();
    }
    return parseClaudeUsageEnvelope(JSON.parse(result.stdout));
  } catch {
    return unavailable();
  }
}

export function createClaudeUsageAdapter() {
  return ({ canonicalProfileHome, environment, inspect }) => claudeUsageAdapter({
    profileHome: canonicalProfileHome,
    environment,
    inspect,
  });
}
