import type { ExecResult, Operation } from "./types.js";

/**
 * Structured audit logging: every operation invocation leaves a trace.
 *
 * M1: one JSON line per call to stderr (Claude Code captures the MCP server's
 * stderr). The command output itself is not logged — only metadata. In M3 this
 * seam grows into a persistent, reviewable record of what was changed.
 *
 * stderr is used deliberately: stdout is reserved for the MCP JSON-RPC channel.
 */
export function audit(op: Operation, result: ExecResult): void {
  const entry = {
    ts: new Date().toISOString(),
    op: op.name,
    risk: op.risk,
    exitCode: result.exitCode,
    ms: result.ms,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
