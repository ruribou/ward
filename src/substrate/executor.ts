import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ExecResult, Operation } from "../types.js";
import { config } from "../config.js";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs an operation's command on the substrate (the NUC) over SSH.
 *
 * Safety:
 * - Uses `execFile` (NOT a shell), so nothing is word-split or interpreted locally.
 * - The remote command is the operation's constant argv — the model supplies no
 *   part of it, so there is no injection surface.
 * - `BatchMode=yes` makes SSH fail fast instead of hanging on a password prompt.
 *
 * This is the only place ward touches the substrate. Swapping SSH for local
 * execution (M4) or another transport happens here and nowhere else.
 *
 * Never rejects: a failed command resolves to a result with a non-zero exit code
 * so the caller (and the LLM) can report it rather than crash.
 */
export function runOperation(op: Operation): Promise<ExecResult> {
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
        const code = error.code; // string (e.g. "ENOENT") | number (exit code) | null (signal/timeout)
        const exitCode = typeof code === "number" ? code : 1;
        const note =
          typeof code === "string" ? `\n[ward] ssh failed: ${code} — ${error.message}` : "";
        resolve({ stdout: stdout ?? "", stderr: (stderr ?? "") + note, exitCode, ms });
      },
    );
  });
}
