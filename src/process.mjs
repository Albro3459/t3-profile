import spawn from "cross-spawn";

import { error } from "./errors.mjs";

/** Maximum time for local provider version and authentication-status probes (5 seconds by default). */
export const INSPECT_COMMAND_TIMEOUT_MS = 5_000;
export const INSPECT_COMMAND_TERMINATION_GRACE_MS = 250;
export const INSPECT_COMMAND_FORCE_GRACE_MS = 250;

export function runProvider(binary, argumentsToPass, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argumentsToPass, {
      env: environment,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (cause) => {
      if (cause?.code === "ENOENT") {
        reject(error(`The '${binary}' command was not found.`, `Install ${binary} and ensure it is on PATH.`));
      } else {
        reject(error(`Could not start '${binary}'.`, "Check its permissions and retry."));
      }
    });
    child.once("close", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

export function inspectCommand(
  binary,
  argumentsToPass,
  environment = process.env,
  timeoutMs = INSPECT_COMMAND_TIMEOUT_MS,
) {
  return new Promise((resolve) => {
    const child = spawn(binary, argumentsToPass, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout;
    let terminationGrace;
    let forceGrace;
    const append = (current, chunk) => `${current}${chunk}`.slice(0, 65_536);
    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(terminationGrace);
      clearTimeout(forceGrace);
      timeout = undefined;
      terminationGrace = undefined;
      forceGrace = undefined;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const finishTimeout = () => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited between the close and kill paths.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ found: true, code: 1, stdout, stderr, timedOut: true });
    };
    const forceTerminate = () => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The final deadline still guarantees a bounded result.
      }
      forceGrace = setTimeout(finishTimeout, INSPECT_COMMAND_FORCE_GRACE_MS);
    };
    const beginTimeout = () => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Continue to the force-termination and final-deadline paths.
      }
      terminationGrace = setTimeout(forceTerminate, INSPECT_COMMAND_TERMINATION_GRACE_MS);
    };
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderr = append(stderr, chunk);
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (cause) => {
      if (timedOut) {
        finish({ found: true, code: 1, stdout, stderr, timedOut: true });
        return;
      }
      finish({ found: cause?.code !== "ENOENT", code: 1, stdout, stderr, timedOut: false });
    });
    child.on("close", (code, signal) => {
      finish({ found: true, code: signal ? 1 : code ?? 1, stdout, stderr, timedOut });
    });
    timeout = setTimeout(beginTimeout, timeoutMs);
  });
}
