import spawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";

import {
  INSPECT_COMMAND_FORCE_GRACE_MS,
  INSPECT_COMMAND_TERMINATION_GRACE_MS,
} from "./process.mjs";

export const JSON_RPC_MAX_OUTPUT_BYTES = 65_536;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function isValidRequestId(id) {
  return id === null ||
    typeof id === "string" ||
    (typeof id === "number" && Number.isFinite(id));
}

function jsonRpcError(message) {
  return new Error(`JSON-RPC inspection failed: ${message}`);
}

/**
 * Run a short request/notification sequence against a newline-delimited
 * JSON-RPC process. The child is always closed and reaped before this settles.
 */
export async function runBidirectionalJsonRpc({
  binary,
  argumentsToPass = [],
  environment,
  steps,
  timeoutMs = 5_000,
  maxOutputBytes = JSON_RPC_MAX_OUTPUT_BYTES,
}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError("JSON-RPC inspection requires at least one step.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError("JSON-RPC output bound must be a positive integer.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("JSON-RPC timeout must be a non-negative number.");
  }

  let child;
  let closeResolve;
  let closed = false;
  let cleanupStarted = false;
  let sequenceComplete = false;
  let failure;
  let failInspection;
  const closePromise = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const failurePromise = new Promise((_, reject) => {
    failInspection = (cause) => {
      if (failure) return;
      failure = cause instanceof Error ? cause : jsonRpcError(String(cause));
      reject(failure);
    };
  });
  failurePromise.catch(() => {});
  let timeout;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutRemainder = "";
  let stdoutRemainderBytes = 0;
  const stdoutDecoder = new StringDecoder("utf8");
  const responses = new Map();
  const waiters = new Map();
  const seenResponseIds = new Set();
  const requestedIds = new Set();

  const fail = (cause) => {
    if (!failure) failInspection(cause);
  };

  const settleResponse = (message) => {
    if (!isObject(message)) {
      fail(jsonRpcError("received a non-object JSONL message"));
      return;
    }
    if (Object.hasOwn(message, "jsonrpc") && message.jsonrpc !== "2.0") {
      fail(jsonRpcError("received a non-JSON-RPC 2.0 message"));
      return;
    }
    if (!Object.hasOwn(message, "id")) return;
    if (!isValidRequestId(message.id)) {
      fail(jsonRpcError("received a response with an invalid ID"));
      return;
    }
    const key = requestKey(message.id);
    if (!waiters.has(key) && !requestedIds.has(key) && !seenResponseIds.has(key)) return;
    if (seenResponseIds.has(key)) {
      fail(jsonRpcError(`received duplicate response for request ${String(message.id)}`));
      return;
    }
    if (Object.hasOwn(message, "error")) {
      fail(jsonRpcError(`request ${String(message.id)} returned an error`));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      fail(jsonRpcError(`response ${String(message.id)} has no result`));
      return;
    }
    seenResponseIds.add(key);
    responses.set(key, message.result);
    const resolve = waiters.get(key);
    if (resolve) {
      waiters.delete(key);
      resolve(message.result);
    }
  };

  const parseStdout = (chunk) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    stdoutBytes += value.byteLength;
    if (stdoutBytes > maxOutputBytes) {
      fail(jsonRpcError("stdout exceeded its bound"));
      return;
    }
    stdoutRemainder += stdoutDecoder.write(value);
    stdoutRemainderBytes += value.byteLength;
    let newline;
    while ((newline = stdoutRemainder.indexOf("\n")) !== -1) {
      const line = stdoutRemainder.slice(0, newline);
      stdoutRemainderBytes -= Buffer.byteLength(line) + 1;
      stdoutRemainder = stdoutRemainder.slice(newline + 1);
      if (Buffer.byteLength(line) > maxOutputBytes) {
        fail(jsonRpcError("JSONL line exceeded its bound"));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(jsonRpcError("received malformed JSONL"));
        return;
      }
      settleResponse(message);
    }
  };

  const parseRemainder = () => {
    stdoutRemainder += stdoutDecoder.end();
    if (!cleanupStarted && (stdoutRemainder.length !== 0 || stdoutRemainderBytes !== 0)) {
      fail(jsonRpcError("received an incomplete JSONL message"));
    }
  };

  const writeMessage = (message) => new Promise((resolve, reject) => {
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      reject(jsonRpcError("stdin is closed"));
      return;
    }
    const payload = `${JSON.stringify(message)}\n`;
    try {
      child.stdin.write(payload, (cause) => {
        if (cause) reject(cause);
        else resolve();
      });
    } catch (cause) {
      reject(cause);
    }
  });

  const waitForResponse = (id) => {
    const key = requestKey(id);
    if (responses.has(key)) return Promise.resolve(responses.get(key));
    if (waiters.has(key) || seenResponseIds.has(key)) {
      return Promise.reject(jsonRpcError(`duplicate request ID ${String(id)}`));
    }
    const response = new Promise((resolve) => waiters.set(key, resolve));
    return Promise.race([response, failurePromise]);
  };

  const cleanup = async () => {
    if (cleanupStarted) return closePromise;
    cleanupStarted = true;
    clearTimeout(timeout);
    if (!child) {
      closed = true;
      closeResolve();
      return closePromise;
    }
    try {
      child?.stdin?.end();
    } catch {
      // The stream may already be closed.
    }
    if (!closed) {
      try {
        child?.kill();
      } catch {
        // The process may have exited between the response and cleanup.
      }
      await Promise.race([closePromise, delay(INSPECT_COMMAND_TERMINATION_GRACE_MS)]);
    }
    if (!closed) {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The process may have exited between termination signals.
      }
      await Promise.race([closePromise, delay(INSPECT_COMMAND_FORCE_GRACE_MS)]);
    }
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (!closed) {
      await closePromise;
    }
    return closePromise;
  };

  try {
    child = spawn(binary, argumentsToPass, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.on("data", parseStdout);
    child.stderr.on("data", (chunk) => {
      stderrBytes += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))).byteLength;
      if (stderrBytes > maxOutputBytes) fail(jsonRpcError("stderr exceeded its bound"));
    });
    child.stdout.on("error", (cause) => {
      if (!cleanupStarted) fail(cause);
    });
    child.stderr.on("error", (cause) => {
      if (!cleanupStarted) fail(cause);
    });
    child.stdin.on("error", (cause) => {
      if (!cleanupStarted) fail(cause);
    });
    child.once("error", (cause) => fail(cause));
    child.once("close", (code, signal) => {
      closed = true;
      parseRemainder();
      closeResolve();
      if (!cleanupStarted && !sequenceComplete && !failure) {
        fail(jsonRpcError("the app-server exited before the sequence completed"));
      }
    });
    timeout = setTimeout(() => fail(jsonRpcError("inspection timed out")), timeoutMs);
    if (closed) clearTimeout(timeout);

    const results = new Map();
    for (const step of steps) {
      if (!step || (step.type !== "request" && step.type !== "notification")) {
        throw new TypeError("JSON-RPC steps must be requests or notifications.");
      }
      if (step.type === "notification") {
        if (typeof step.method !== "string") throw new TypeError("JSON-RPC notifications require a method.");
        await Promise.race([writeMessage({ jsonrpc: "2.0", method: step.method, params: step.params }), failurePromise]);
        continue;
      }
      if (!Object.hasOwn(step, "id")) throw new TypeError("JSON-RPC requests require an ID.");
      if (typeof step.method !== "string") throw new TypeError("JSON-RPC requests require a method.");
      if (!isValidRequestId(step.id)) throw new TypeError("JSON-RPC request IDs must be strings, numbers, or null.");
      const key = requestKey(step.id);
      if (requestedIds.has(key)) throw jsonRpcError(`duplicate request ID ${String(step.id)}`);
      requestedIds.add(key);
      await Promise.race([
        writeMessage({ jsonrpc: "2.0", id: step.id, method: step.method, params: step.params }),
        failurePromise,
      ]);
      results.set(step.id, await waitForResponse(step.id));
    }
    if (failure) throw failure;
    sequenceComplete = true;
    return results;
  } catch (cause) {
    fail(cause);
    throw failure ?? cause;
  } finally {
    await cleanup();
    if (failure) throw failure;
  }
}
