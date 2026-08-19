import { dispatch, parseArguments } from "./commands.mjs";
import { CancelledError, CliError } from "./errors.mjs";
import { printCancelled, printHelp, writeError, writeLine } from "./output.mjs";
import { VERSION } from "./version.mjs";

export async function main(argv) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === "help") {
      printHelp();
      return;
    }
    if (parsed.command === "version") {
      writeLine(VERSION);
      return;
    }
    const exitCode = await dispatch(parsed);
    if (exitCode !== undefined) process.exitCode = exitCode;
  } catch (cause) {
    if (cause instanceof CancelledError) {
      printCancelled();
      return;
    }
    if (cause instanceof CliError) {
      writeError(`Error: ${cause.message}`);
      process.exitCode = cause.exitCode;
      return;
    }
    writeError(`Error: ${cause instanceof Error ? cause.message : String(cause)}`);
    writeError("Check the command and filesystem permissions, then retry.");
    process.exitCode = 1;
  }
}
