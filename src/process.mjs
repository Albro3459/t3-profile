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
