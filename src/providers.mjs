import { providerDriver, providerTitle, validateProvider } from "./names.mjs";

const AUTH_OVERRIDE_VARIABLES = {
  claude: [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ],
  codex: ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
};

export function makeEnvironment(provider, profileHome, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  const scrubbed = new Set(AUTH_OVERRIDE_VARIABLES[provider]);
  for (const variable of Object.keys(environment)) {
    if (scrubbed.has(variable) || scrubbed.has(variable.toUpperCase())) delete environment[variable];
  }
  if (provider === "claude") {
    environment.CLAUDE_CONFIG_DIR = profileHome;
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = profileHome;
  } else {
    environment.CODEX_HOME = profileHome;
  }
  return environment;
}

export function providerBinary(provider) {
  return provider;
}

export function providerAuthArguments(provider) {
  validateProvider(provider);
  return provider === "claude" ? ["auth", "login"] : ["login"];
}

export function providerAuthStatusArguments(provider) {
  validateProvider(provider);
  return provider === "claude" ? ["auth", "status"] : ["login", "status"];
}

export function providerVersionArguments(provider) {
  validateProvider(provider);
  return ["--version"];
}

export function buildT3Instance({ provider, profileHome, sourceHome, sharing }) {
  const driver = providerDriver(provider);
  if (provider === "claude") {
    return {
      driver,
      displayName: `${providerTitle(provider)} ${profileHome.split(/[\\/]/).pop()}`,
      environment: [
        { name: "CLAUDE_CONFIG_DIR", value: profileHome, sensitive: false },
        {
          name: "CLAUDE_SECURESTORAGE_CONFIG_DIR",
          value: profileHome,
          sensitive: false,
        },
      ],
      config: { homePath: profileHome },
    };
  }

  return {
    driver,
    displayName: `${providerTitle(provider)} ${profileHome.split(/[\\/]/).pop()}`,
    config:
      sharing === "standard"
        ? { homePath: sourceHome, shadowHomePath: profileHome }
        : { homePath: profileHome, shadowHomePath: "" },
  };
}

export function reconcileT3Instance(existing, desired, instanceId) {
  if (existing === undefined) return desired;
  if (existing.driver !== desired.driver) {
    throw new Error(
      `T3 provider instance '${instanceId}' uses driver '${existing.driver}', expected '${desired.driver}'.`,
    );
  }
  if (!existing.config || typeof existing.config !== "object" || Array.isArray(existing.config)) {
    throw new Error(`T3 provider instance '${instanceId}' has an incompatible config.`);
  }

  const next = { ...existing, ...desired };
  const existingConfig = existing.config;
  if (existingConfig && typeof existingConfig === "object" && !Array.isArray(existingConfig)) {
    next.config = { ...existingConfig, ...desired.config };
  }
  if (desired.environment) {
    const managedNames = new Set(desired.environment.map((entry) => entry.name));
    next.environment = [
      ...(existing.environment ?? []).filter((entry) => !managedNames.has(entry.name)),
      ...desired.environment,
    ];
  }
  return next;
}

export function sharingSummary({ provider, sharing, sourceHome, links }) {
  if (provider === "claude") {
    return {
      live: links.map((link) => link.name),
      skipped: links.skipped ?? [],
      private: [
        "OAuth and macOS Keychain credentials",
        ".credentials.json",
        ".claude.json account/global state",
        "projects and history",
        "plugins and other runtime state",
      ],
      note:
        sharing === "standard"
          ? "Shared settings can include hooks, permissions, MCP configuration, and environment values."
          : "Authentication, settings, instructions, skills, agents, projects, and history are independent.",
      sourceHome,
    };
  }

  if (sharing === "isolated") {
    return {
      live: [],
      skipped: [],
      private: ["All Codex configuration, credentials, sessions, and runtime state"],
      note: "This profile cannot switch into T3 threads bound to the primary Codex home.",
      sourceHome,
    };
  }

  return {
    live: [
      "configuration and AGENTS.md",
      "skills/ and plugins/",
      "sessions, archived sessions, and SQLite state",
      "shell snapshots, worktrees, cache, and logs",
      "MCP lock state and other non-private primary-home entries",
    ],
    skipped: [],
    private: ["auth.json", "models_cache.json", "log, memories, and tmp"],
    note: "Shared sessions allow compatible Codex accounts to switch inside existing T3 threads.",
    sourceHome,
  };
}
