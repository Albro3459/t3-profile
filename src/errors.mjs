export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled. No changes were made.");
    this.name = "CancelledError";
    this.exitCode = 0;
  }
}

export function error(message, correction) {
  if (correction) {
    return new CliError(`${message} ${correction}`);
  }
  return new CliError(message);
}

export function assert(condition, message, correction) {
  if (!condition) {
    throw error(message, correction);
  }
}
