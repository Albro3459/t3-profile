import spawn from "cross-spawn";

import { error } from "./errors.mjs";

/** Maximum time for local provider version and authentication-status probes (5 seconds by default). */
export const INSPECT_COMMAND_TIMEOUT_MS = 5_000;
export const INSPECT_COMMAND_TERMINATION_GRACE_MS = 250;
export const INSPECT_COMMAND_FORCE_GRACE_MS = 250;
export const INSPECT_COMMAND_MAX_OUTPUT_BYTES = 65_536;

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

export function runInteractiveCommand(binary, argumentsToPass, environment = process.env) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(binary, argumentsToPass, {
        env: environment,
        stdio: "inherit",
        shell: false,
      });
      child.once("error", () => finish(1));
      child.once("close", (code, signal) => finish(signal ? 1 : code ?? 1));
    } catch {
      finish(1);
    }
  });
}

export function inspectCommand(
  binary,
  argumentsToPass,
  environment = process.env,
  timeoutMs = INSPECT_COMMAND_TIMEOUT_MS,
) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let terminationRequested = false;
    let timeout;
    let terminationGrace;
    let forceGrace;
    const append = (current, chunk, currentBytes) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const available = Math.max(0, INSPECT_COMMAND_MAX_OUTPUT_BYTES - currentBytes);
      if (bytes.byteLength > available) outputExceeded = true;
      return `${current}${bytes.subarray(0, available).toString("utf8")}`;
    };
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
    const finishAfterForceGrace = () => {
      if (settled) return;
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      finish({ found: true, code: 1, stdout, stderr, timedOut });
    };
    const forceTerminate = () => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited between termination signals.
      }
      forceGrace = setTimeout(finishAfterForceGrace, INSPECT_COMMAND_FORCE_GRACE_MS);
    };
    const beginTermination = () => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      try {
        child.kill();
      } catch {
        // Continue to the force-termination and final-deadline paths.
      }
      terminationGrace = setTimeout(forceTerminate, INSPECT_COMMAND_TERMINATION_GRACE_MS);
    };
    const finishTimeout = () => {
      if (settled) return;
      timedOut = true;
      beginTermination();
    };
    let stdoutBytes = 0;
    let stderrBytes = 0;

    try {
      child = spawn(binary, argumentsToPass, {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        stdout = append(stdout, bytes, stdoutBytes);
        stdoutBytes += bytes.byteLength;
        if (outputExceeded) beginTermination();
      });
      child.stderr.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        stderr = append(stderr, bytes, stderrBytes);
        stderrBytes += bytes.byteLength;
        if (outputExceeded) beginTermination();
      });
      child.stdout.on("error", () => beginTermination());
      child.stderr.on("error", () => beginTermination());
      child.on("error", (cause) => {
        if (cause?.code === "ENOENT") {
          finish({ found: false, code: 1, stdout, stderr, timedOut: false });
          return;
        }
        beginTermination();
      });
      child.on("close", (code, signal) => {
        finish({
          found: true,
          code: outputExceeded || timedOut || signal ? 1 : code ?? 1,
          stdout,
          stderr,
          timedOut,
        });
      });
      timeout = setTimeout(finishTimeout, timeoutMs);
      if (settled) clearTimeout(timeout);
    } catch {
      finish({ found: false, code: 1, stdout, stderr, timedOut: false });
    }
  });
}
