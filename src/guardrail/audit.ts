import { appendFileSync } from "node:fs";
import type { AuditEntry } from "../types.js";
import { config } from "../config.js";

/**
 * Structured audit logging: every operation leaves a trace, so what ward did is
 * reviewable after the fact (CONCEPT principle "everything as a diff").
 *
 * Two events are recorded:
 * - "proposed": a mutating operation was staged behind the approval gate (it has
 *               not run — there is no result yet).
 * - "executed": a command actually ran (carries its exit code and duration).
 *
 * A mutating operation therefore leaves a "proposed" line and, once approved, an
 * "executed" line — the record shows both what was asked for and what ran. The
 * command's *output* is never logged, only metadata.
 *
 * Sinks:
 * - Always one JSON line to stderr (Claude Code captures the MCP server's
 *   stderr; stdout is reserved for the JSON-RPC channel).
 * - Additionally appended to WARD_AUDIT_LOG when set — an opt-in, append-only
 *   file that survives restarts for a durable, reviewable history.
 */
export function audit(entry: AuditEntry): void {
  const line = `${JSON.stringify(serialize(entry))}\n`;
  process.stderr.write(line);
  if (config.auditLog !== undefined) {
    appendFileSync(config.auditLog, line);
  }
}

/** Flatten an entry into a stable, output-free JSON shape for the log. */
function serialize(entry: AuditEntry): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    event: entry.event,
    op: entry.op.name,
    risk: entry.op.risk,
    ...(entry.proposalId !== undefined ? { proposalId: entry.proposalId } : {}),
    ...(entry.result !== undefined ? { exitCode: entry.result.exitCode, ms: entry.result.ms } : {}),
  };
}
