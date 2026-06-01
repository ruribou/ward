import type { RiskClass } from "../types.js";

/**
 * Measurement layer (CONCEPT RQ4): turn the audit stream into the numbers that
 * tell us how the guardrails are doing — success rate, human-intervention rate,
 * and blast radius. It only *reads* what `audit.ts` already wrote (metadata, never
 * command output), so this stays a pure, side-effect-free summarizer: feed it the
 * log text, get a report. That keeps the privacy stance intact and the metrics
 * reproducible — the same log always yields the same numbers.
 *
 * What the stream can and cannot tell us is deliberately explicit (see below):
 * rejections emit no audit event, and reversibility is not yet recorded (#18), so
 * the report names those gaps rather than hiding them behind a number.
 */

/** One serialized audit line, as written by `audit.ts`'s `serialize()`. */
export interface LoggedEvent {
  readonly ts: string;
  readonly event: "proposed" | "executed";
  readonly op: string;
  readonly risk: RiskClass;
  readonly proposalId?: string;
  readonly exitCode?: number;
  readonly ms?: number;
}

export interface ParseResult {
  readonly events: LoggedEvent[];
  /** Non-empty lines that were not a recognisable proposed/executed event (e.g. audit-write-failed, malformed). */
  readonly skipped: number;
}

/** A numerator/denominator pair plus its value, with null guarding divide-by-zero. */
export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** numerator/denominator, or null when there is nothing to divide. */
  readonly value: number | null;
}

export interface OpStat {
  readonly op: string;
  readonly risk: RiskClass;
  readonly proposed: number;
  readonly executed: number;
  readonly ok: number;
  readonly failed: number;
}

export interface Metrics {
  readonly window: {
    readonly from: string | null;
    readonly to: string | null;
    readonly events: number;
    readonly skipped: number;
  };
  readonly counts: {
    readonly proposed: number;
    readonly executed: number;
    readonly executedReadOnly: number;
    readonly executedMutating: number;
  };
  readonly successRate: { readonly overall: Ratio; readonly mutating: Ratio };
  /** proposed / (proposed + read-only executed): share of requested ops that needed a human gate. */
  readonly interventionRate: Ratio;
  /** mutating executed / proposed: share of proposed mutations that were approved and ran. */
  readonly approvalThroughRate: Ratio;
  readonly blastRadius: {
    readonly mutatingExecutions: number;
    readonly byOp: Record<string, number>;
    /** Reversibility is not yet recorded in the audit stream — depends on #18. */
    readonly reversibility: "unknown";
  };
  readonly perOp: OpStat[];
}

interface MutableOpStat {
  op: string;
  risk: RiskClass;
  proposed: number;
  executed: number;
  ok: number;
  failed: number;
}

function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function isLoggedEvent(value: unknown): value is LoggedEvent {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    (v.event === "proposed" || v.event === "executed") &&
    typeof v.op === "string" &&
    (v.risk === "read-only" || v.risk === "mutating") &&
    typeof v.ts === "string"
  );
}

/**
 * Parse a WARD_AUDIT_LOG (JSON-lines) into proposed/executed events. Blank lines,
 * `audit-write-failed` self-reports, and any malformed line are skipped — and the
 * skipped count is returned so truncation is never silent.
 */
export function parseAuditLog(text: string): ParseResult {
  const events: LoggedEvent[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLoggedEvent(parsed)) {
        events.push(parsed);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/** Aggregate parsed audit events into the RQ4 metrics. */
export function summarize({ events, skipped }: ParseResult): Metrics {
  const proposed = events.filter((e) => e.event === "proposed");
  const executed = events.filter((e) => e.event === "executed");
  const executedReadOnly = executed.filter((e) => e.risk === "read-only");
  const executedMutating = executed.filter((e) => e.risk === "mutating");
  const ok = (list: LoggedEvent[]) => list.filter((e) => e.exitCode === 0).length;

  // A mutable accumulator; a MutableOpStat[] satisfies the readonly OpStat[] the
  // caller sees once returned.
  const byOp = new Map<string, MutableOpStat>();
  const stat = (op: string, risk: RiskClass): MutableOpStat => {
    let s = byOp.get(op);
    if (s === undefined) {
      s = { op, risk, proposed: 0, executed: 0, ok: 0, failed: 0 };
      byOp.set(op, s);
    }
    return s;
  };
  for (const e of proposed) {
    stat(e.op, e.risk).proposed += 1;
  }
  for (const e of executed) {
    const s = stat(e.op, e.risk);
    s.executed += 1;
    if (e.exitCode === 0) {
      s.ok += 1;
    } else {
      s.failed += 1;
    }
  }

  const blastByOp: Record<string, number> = {};
  for (const e of executedMutating) {
    blastByOp[e.op] = (blastByOp[e.op] ?? 0) + 1;
  }

  const timestamps = events.map((e) => e.ts).sort();

  return {
    window: {
      from: timestamps[0] ?? null,
      to: timestamps[timestamps.length - 1] ?? null,
      events: events.length,
      skipped,
    },
    counts: {
      proposed: proposed.length,
      executed: executed.length,
      executedReadOnly: executedReadOnly.length,
      executedMutating: executedMutating.length,
    },
    successRate: {
      overall: ratio(ok(executed), executed.length),
      mutating: ratio(ok(executedMutating), executedMutating.length),
    },
    interventionRate: ratio(proposed.length, proposed.length + executedReadOnly.length),
    approvalThroughRate: ratio(executedMutating.length, proposed.length),
    blastRadius: {
      mutatingExecutions: executedMutating.length,
      byOp: blastByOp,
      reversibility: "unknown",
    },
    perOp: [...byOp.values()].sort((a, b) => a.op.localeCompare(b.op)),
  };
}

function pct(r: Ratio): string {
  return r.value === null ? "n/a" : `${(r.value * 100).toFixed(1)}%`;
}

function frac(r: Ratio): string {
  return `${r.numerator}/${r.denominator}`;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function padEnd(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

/** Render metrics as a human-readable report (the default `ward metrics` output). */
export function formatMetrics(m: Metrics): string {
  const lines: string[] = [];
  const window =
    m.window.from === null
      ? "no events"
      : `${m.window.from} → ${m.window.to}, ${m.window.skipped} skipped`;
  lines.push(`ward metrics — ${m.window.events} events  (${window})`);

  lines.push("");
  lines.push("Operations");
  lines.push(`  proposed (mutating, gated)   ${pad(m.counts.proposed, 5)}`);
  lines.push(`  executed                     ${pad(m.counts.executed, 5)}`);
  lines.push(`    read-only (direct)         ${pad(m.counts.executedReadOnly, 5)}`);
  lines.push(`    mutating (approved & ran)  ${pad(m.counts.executedMutating, 5)}`);

  lines.push("");
  lines.push("Success rate (exit 0)");
  lines.push(
    `  overall    ${padEnd(frac(m.successRate.overall), 7)} ${pct(m.successRate.overall)}`,
  );
  lines.push(
    `  mutating   ${padEnd(frac(m.successRate.mutating), 7)} ${pct(m.successRate.mutating)}`,
  );

  lines.push("");
  lines.push("Human-intervention rate");
  lines.push(
    `  ${frac(m.interventionRate)}  ${pct(m.interventionRate)}  (mutating gated of all requested ops)`,
  );

  lines.push("");
  lines.push("Approval-through rate");
  lines.push(
    `  ${frac(m.approvalThroughRate)}  ${pct(m.approvalThroughRate)}  (proposed mutations approved & ran)`,
  );
  lines.push("  note: rejected/pending not distinguished — `ward reject` emits no audit event");

  lines.push("");
  lines.push("Blast radius (realised state changes)");
  lines.push(`  mutating executions  ${m.blastRadius.mutatingExecutions}`);
  for (const [op, n] of Object.entries(m.blastRadius.byOp).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`    ${padEnd(op, 18)} ${n}`);
  }
  lines.push(`  reversibility: ${m.blastRadius.reversibility} (pending #18)`);

  if (m.perOp.length > 0) {
    lines.push("");
    lines.push("Per operation");
    lines.push(
      `  ${padEnd("op", 16)} ${padEnd("risk", 11)} ${pad("proposed", 8)} ${pad("executed", 8)} ${pad("ok", 4)} ${pad("failed", 6)}`,
    );
    for (const s of m.perOp) {
      lines.push(
        `  ${padEnd(s.op, 16)} ${padEnd(s.risk, 11)} ${pad(s.proposed || "-", 8)} ${pad(s.executed, 8)} ${pad(s.ok, 4)} ${pad(s.failed, 6)}`,
      );
    }
  }

  return lines.join("\n");
}
