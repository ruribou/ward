import { appendFileSync } from "node:fs";
import type { AuditEntry } from "../types.js";
import { config } from "../config.js";

/**
 * Structured audit logging: every operation leaves a trace, so what ward did is
 * reviewable after the fact (CONCEPT principle "everything as a diff").
 *
 * Three events are recorded:
 * - "proposed": a mutating operation was staged behind the approval gate (it has
 *               not run — there is no result yet).
 * - "executed": a command actually ran (carries its exit code and duration).
 * - "rejected": a human discarded a proposal without running it.
 *
 * A mutating operation therefore leaves a "proposed" line and then one resolution
 * — an "executed" line once approved, or a "rejected" line if discarded — so the
 * record shows both what was asked for and how it ended. (A proposal with neither
 * resolution is still pending.) The command's *output* is never logged, only
 * metadata.
 *
 * Sinks:
 * - Always one JSON line to stderr (Claude Code captures the MCP server's
 *   stderr; stdout is reserved for the JSON-RPC channel).
 * - Additionally appended to WARD_AUDIT_LOG when set — an opt-in, append-only
 *   file that survives restarts for a durable, reviewable history. This append
 *   is best-effort: a failure is reported (loudly, on stderr) but never thrown,
 *   so a broken log path cannot turn a successful operation into a tool error.
 */
export function audit(entry: AuditEntry): void {
  const line = `${JSON.stringify(serialize(entry))}\n`;
  process.stderr.write(line);
  if (config.auditLog !== undefined) {
    try {
      appendFileSync(config.auditLog, line);
    } catch (err) {
      // The audit record already reached stderr (the always-available sink), so
      // only the durable file copy is lost — never re-throw. For an "executed"
      // event the command has already run; throwing here would mask a real side
      // effect as a failure (issue #24). Surface the broken sink instead.
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          event: "audit-write-failed",
          auditLog: config.auditLog,
          error: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }
}

/** Flatten an entry into a stable, output-free JSON shape for the log. */
function serialize(entry: AuditEntry): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    event: entry.event,
    op: entry.op.name,
    risk: entry.op.risk,
    // Record reversibility on mutating events so the metrics summarizer can weigh
    // blast radius without re-reading the registry (#18). A mutating op is
    // reversible unless it declared `irreversible`; read-only ops change nothing
    // and carry no reversibility field.
    ...(entry.op.risk === "mutating" ? { reversible: entry.op.irreversible !== true } : {}),
    ...(entry.proposalId !== undefined ? { proposalId: entry.proposalId } : {}),
    ...(entry.result !== undefined ? { exitCode: entry.result.exitCode, ms: entry.result.ms } : {}),
  };
}
