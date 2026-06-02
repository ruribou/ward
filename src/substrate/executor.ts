import { execFile, type ExecFileException } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ExecResult, Operation } from "../types.js";
import { config } from "../config.js";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** The strict argv charset — kept in lockstep with the loader's ARG_RE. */
const ARG_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Runs an operation's command on the substrate (the NUC) over SSH.
 *
 * Safety:
 * - Uses `execFile` (NOT a shell), so nothing is word-split or interpreted locally.
 * - The remote command is the operation's argv. It is either a constant from the
 *   registry or a parameterized command already *resolved* to a model-chosen enum
 *   member (see resolveOperation) — never a free-form string, and the assertion
 *   below re-checks every element, so there is no injection surface.
 * - `BatchMode=yes` makes SSH fail fast instead of hanging on a password prompt.
 *
 * This is the only place ward touches the substrate. Swapping SSH for local
 * execution (M4) or another transport happens here and nowhere else.
 *
 * Defense in depth: although the loader charset-validates every command element
 * (constants and enum members alike) and resolution re-checks the substituted
 * values, this asserts the final argv one last time — including that no `{token}`
 * placeholder survived. A violation throws *before* spawning ssh, so a malformed
 * argv can never reach the network.
 *
 * Never rejects for a remote failure: a failed command resolves to a result with
 * a non-zero exit code so the caller (and the LLM) can report it rather than crash.
 */
export function runOperation(op: Operation): Promise<ExecResult> {
  for (const part of op.command) {
    if (!ARG_RE.test(part)) {
      throw new Error(
        `ward: refusing to execute ${op.name} — unsafe argv element ${JSON.stringify(part)}`,
      );
    }
  }

  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${config.sshConnectTimeoutSec}`,
    config.sshHost,
    ...op.command,
  ];

  const start = performance.now();
  return new Promise<ExecResult>((resolve) => {
    execFile(
      "ssh",
      sshArgs,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        const ms = Math.round(performance.now() - start);
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0, ms });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : 1;
        resolve({
          stdout: stdout ?? "",
          stderr: (stderr ?? "") + failureNote(error),
          exitCode,
          ms,
        });
      },
    );
  });
}

/**
 * Turn an execFile failure into a diagnostic note appended to stderr, so a
 * timeout or signal kill is not silently mistaken for a plain `exit 1`.
 * `error.code` is a number (real exit code), a string (spawn or maxBuffer
 * error), or null (killed by a signal — our timeout kills with SIGTERM).
 */
function failureNote(error: ExecFileException): string {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `\n[ward] output exceeded ${MAX_OUTPUT_BYTES} bytes — killed and truncated`;
  }
  if (error.killed && error.signal === "SIGTERM") {
    return `\n[ward] timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
  }
  if (error.signal) {
    return `\n[ward] killed by ${error.signal}`;
  }
  if (typeof error.code === "string") {
    return `\n[ward] ssh failed: ${error.code} — ${error.message}`;
  }
  return "";
}
