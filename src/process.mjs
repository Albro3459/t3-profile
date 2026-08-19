import spawn from "cross-spawn";

import { error } from "./errors.mjs";

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

export function inspectCommand(binary, argumentsToPass, environment = process.env) {
  return new Promise((resolve) => {
    const child = spawn(binary, argumentsToPass, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(0, 65_536);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (cause) => {
      resolve({ found: cause?.code !== "ENOENT", code: 1, stdout, stderr });
    });
    child.once("close", (code, signal) => {
      resolve({ found: true, code: signal ? 1 : code ?? 1, stdout, stderr });
    });
  });
}
