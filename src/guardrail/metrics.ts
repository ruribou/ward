import type { RiskClass } from "../types.js";

/**
 * Measurement layer (CONCEPT RQ4): turn the audit stream into the numbers that
 * tell us how the guardrails are doing — success rate, human-intervention rate,
 * proposal resolution (approved / rejected / pending), and blast radius. It only
 * *reads* what `audit.ts` already wrote (metadata, never command output), so this
 * stays a pure, side-effect-free summarizer: feed it the log text, get a report.
 * That keeps the privacy stance intact and the metrics reproducible — the same
 * log always yields the same numbers.
 *
 * Counts, not id-pairing: resolution is derived from event counts (proposed minus
 * approved minus rejected = pending), so it does not rely on proposal ids being a
 * stable global key — which they are not (the short `p1`-style handle resets when
 * the proposal store is cleared, while the audit log lives on).
 *
 * Reversibility now flows through the audit stream (#18): a mutating event records
 * whether the op declared an inverse. The blast radius reflects it — an
 * irreversible execution is a permanent state change and so weighs more than a
 * reversible one, which can be rolled back via its inverse. Older logs without the
 * field count as reversibility-unknown and contribute to the conservative weight
 * (treated like irreversible) rather than being silently dropped.
 */

/**
 * How heavily an irreversible mutating execution weighs in the blast radius
 * relative to a reversible one (which is 1). A permanent, un-undoable change is a
 * bigger blast radius than one a human can roll back via its declared inverse —
 * the issue's A4 link. The weight is a deliberate, single knob: change it here.
 */
export const IRREVERSIBLE_WEIGHT = 3;

/** One serialized audit line, as written by `audit.ts`'s `serialize()`. */
export interface LoggedEvent {
  readonly ts: string;
  readonly event: "proposed" | "executed" | "rejected";
  readonly op: string;
  readonly risk: RiskClass;
  /**
   * Whether the mutating op declared an inverse (reversible) or `irreversible`.
   * Present only on mutating events written by a current ward; absent on read-only
   * events and on older logs predating #18 (treated as reversibility-unknown).
   */
  readonly reversible?: boolean;
  readonly proposalId?: string;
  readonly exitCode?: number;
  readonly ms?: number;
}

export interface ParseResult {
  readonly events: LoggedEvent[];
  /** Non-empty lines that were not a recognisable audit event (e.g. audit-write-failed, malformed). */
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
  readonly rejected: number;
}

/** How the proposed mutations were resolved (counts always sum to `proposed`). */
export interface Resolution {
  readonly approved: number;
  readonly rejected: number;
  readonly pending: number;
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
    readonly rejected: number;
  };
  readonly successRate: { readonly overall: Ratio; readonly mutating: Ratio };
  /** proposed / (proposed + read-only executed): share of requested ops that needed a human gate. */
  readonly interventionRate: Ratio;
  /** mutating executed / proposed: share of proposed mutations that were approved and ran. */
  readonly approvalThroughRate: Ratio;
  /** How proposed mutations were resolved: approved (ran) / rejected / still pending. */
  readonly resolution: Resolution;
  readonly blastRadius: {
    readonly mutatingExecutions: number;
    readonly byOp: Record<string, number>;
    /**
     * Reversibility breakdown of the realised mutating executions (#18):
     * - `reversible`: ran an op with a declared inverse — can be rolled back.
     * - `irreversible`: ran an op marked `irreversible` — a permanent change.
     * - `unknown`: from an older log line without the field — counted, never dropped.
     * The three always sum to `mutatingExecutions`.
     */
    readonly reversibility: {
      readonly reversible: number;
      readonly irreversible: number;
      readonly unknown: number;
    };
    /**
     * Reversibility-weighted blast radius: each reversible execution counts 1,
     * each irreversible (or unknown) execution counts {@link IRREVERSIBLE_WEIGHT},
     * so a permanent change registers as a larger blast than an undoable one.
     */
    readonly weighted: number;
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
  rejected: number;
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
    (v.event === "proposed" || v.event === "executed" || v.event === "rejected") &&
    typeof v.op === "string" &&
    (v.risk === "read-only" || v.risk === "mutating") &&
    typeof v.ts === "string"
  );
}

/**
 * Parse a WARD_AUDIT_LOG (JSON-lines) into proposed/executed/rejected events. Blank lines,
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
  const rejected = events.filter((e) => e.event === "rejected");
  const executedReadOnly = executed.filter((e) => e.risk === "read-only");
  const executedMutating = executed.filter((e) => e.risk === "mutating");
  const ok = (list: LoggedEvent[]) => list.filter((e) => e.exitCode === 0).length;

  // A mutable accumulator; a MutableOpStat[] satisfies the readonly OpStat[] the
  // caller sees once returned.
  const byOp = new Map<string, MutableOpStat>();
  const stat = (op: string, risk: RiskClass): MutableOpStat => {
    let s = byOp.get(op);
    if (s === undefined) {
      s = { op, risk, proposed: 0, executed: 0, ok: 0, failed: 0, rejected: 0 };
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
  for (const e of rejected) {
    stat(e.op, e.risk).rejected += 1;
  }

  const blastByOp: Record<string, number> = {};
  // Fold reversibility into the blast radius (#18): a reversible execution can be
  // rolled back via its inverse and weighs 1; an irreversible — or an older,
  // field-less "unknown" — execution is a permanent change and weighs more.
  let reversible = 0;
  let irreversible = 0;
  let unknown = 0;
  let weighted = 0;
  for (const e of executedMutating) {
    blastByOp[e.op] = (blastByOp[e.op] ?? 0) + 1;
    if (e.reversible === true) {
      reversible += 1;
      weighted += 1;
    } else if (e.reversible === false) {
      irreversible += 1;
      weighted += IRREVERSIBLE_WEIGHT;
    } else {
      unknown += 1;
      weighted += IRREVERSIBLE_WEIGHT;
    }
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
      rejected: rejected.length,
    },
    successRate: {
      overall: ratio(ok(executed), executed.length),
      mutating: ratio(ok(executedMutating), executedMutating.length),
    },
    interventionRate: ratio(proposed.length, proposed.length + executedReadOnly.length),
    approvalThroughRate: ratio(executedMutating.length, proposed.length),
    resolution: {
      approved: executedMutating.length,
      rejected: rejected.length,
      pending: Math.max(0, proposed.length - executedMutating.length - rejected.length),
    },
    blastRadius: {
      mutatingExecutions: executedMutating.length,
      byOp: blastByOp,
      reversibility: { reversible, irreversible, unknown },
      weighted,
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
  lines.push(`Proposal resolution (${m.counts.proposed} proposed)`);
  lines.push(`  approved & ran  ${pad(m.resolution.approved, 4)}  ${pct(m.approvalThroughRate)}`);
  lines.push(`  rejected        ${pad(m.resolution.rejected, 4)}`);
  lines.push(`  pending         ${pad(m.resolution.pending, 4)}`);

  lines.push("");
  lines.push("Blast radius (realised state changes)");
  lines.push(`  mutating executions  ${m.blastRadius.mutatingExecutions}`);
  for (const [op, n] of Object.entries(m.blastRadius.byOp).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`    ${padEnd(op, 18)} ${n}`);
  }
  const r = m.blastRadius.reversibility;
  lines.push(
    `  reversibility: ${r.reversible} reversible, ${r.irreversible} irreversible` +
      (r.unknown > 0 ? `, ${r.unknown} unknown` : ""),
  );
  lines.push(
    `  weighted blast radius  ${m.blastRadius.weighted}  (irreversible ×${IRREVERSIBLE_WEIGHT})`,
  );

  if (m.perOp.length > 0) {
    lines.push("");
    lines.push("Per operation");
    lines.push(
      `  ${padEnd("op", 16)} ${padEnd("risk", 11)} ${pad("proposed", 8)} ${pad("executed", 8)} ${pad("ok", 4)} ${pad("failed", 6)} ${pad("rejected", 8)}`,
    );
    for (const s of m.perOp) {
      lines.push(
        `  ${padEnd(s.op, 16)} ${padEnd(s.risk, 11)} ${pad(s.proposed || "-", 8)} ${pad(s.executed, 8)} ${pad(s.ok, 4)} ${pad(s.failed, 6)} ${pad(s.rejected || "-", 8)}`,
      );
    }
  }

  return lines.join("\n");
}
