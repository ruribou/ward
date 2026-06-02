import { describe, expect, it } from "vitest";
import { formatMetrics, parseAuditLog, summarize } from "../../guardrail/metrics.js";

/** Build one audit JSON line, matching the shape `audit.ts` serializes. */
function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

const RO = (op: string, exitCode: number, ts: string) =>
  line({ ts, event: "executed", op, risk: "read-only", exitCode, ms: 5 });
const PROPOSE = (op: string, proposalId: string, ts: string) =>
  line({ ts, event: "proposed", op, risk: "mutating", proposalId });
// Mutating executions carry a reversibility flag (#18). The legacy EXEC omits it
// (an older log line → reversibility-unknown); EXEC_REV / EXEC_IRREV set it.
const EXEC = (op: string, proposalId: string, exitCode: number, ts: string) =>
  line({ ts, event: "executed", op, risk: "mutating", proposalId, exitCode, ms: 10 });
const EXEC_REV = (op: string, proposalId: string, exitCode: number, ts: string) =>
  line({
    ts,
    event: "executed",
    op,
    risk: "mutating",
    reversible: true,
    proposalId,
    exitCode,
    ms: 10,
  });
const EXEC_IRREV = (op: string, proposalId: string, exitCode: number, ts: string) =>
  line({
    ts,
    event: "executed",
    op,
    risk: "mutating",
    reversible: false,
    proposalId,
    exitCode,
    ms: 10,
  });
const REJECT = (op: string, proposalId: string, ts: string) =>
  line({ ts, event: "rejected", op, risk: "mutating", proposalId });

const log = [
  RO("sys_disk", 0, "2026-06-01T10:00:00Z"),
  RO("sys_disk", 0, "2026-06-01T10:01:00Z"),
  RO("sys_memory", 1, "2026-06-01T10:02:00Z"),
  PROPOSE("sys_pull_image", "p1", "2026-06-01T10:03:00Z"),
  EXEC("sys_pull_image", "p1", 0, "2026-06-01T10:04:00Z"),
  PROPOSE("sys_pull_image", "p2", "2026-06-01T10:05:00Z"),
  EXEC("sys_pull_image", "p2", 0, "2026-06-01T10:06:00Z"),
  PROPOSE("sys_remove_image", "p3", "2026-06-01T10:07:00Z"),
  EXEC("sys_remove_image", "p3", 1, "2026-06-01T10:08:00Z"),
  PROPOSE("sys_reboot", "p4", "2026-06-01T10:09:00Z"),
].join("\n");

describe("parseAuditLog", () => {
  it("skips blank lines without counting them, and counts unparseable / non-event lines", () => {
    const text = [
      "",
      RO("sys_disk", 0, "2026-06-01T10:00:00Z"),
      "{ not json",
      line({ ts: "t", event: "audit-write-failed", auditLog: "/x", error: "e" }),
      line({ event: "executed" }), // missing op/risk/ts
      "   ",
    ].join("\n");
    const { events, skipped } = parseAuditLog(text);
    expect(events).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it("recognises proposed and executed events", () => {
    const { events } = parseAuditLog(log);
    expect(events).toHaveLength(10);
  });
});

describe("summarize", () => {
  const m = summarize(parseAuditLog(log));

  it("counts events by class", () => {
    expect(m.counts).toEqual({
      proposed: 4,
      executed: 6,
      executedReadOnly: 3,
      executedMutating: 3,
      rejected: 0,
    });
  });

  it("computes success rate overall and for mutating only", () => {
    expect(m.successRate.overall).toMatchObject({ numerator: 4, denominator: 6 });
    expect(m.successRate.mutating).toMatchObject({ numerator: 2, denominator: 3 });
  });

  it("intervention rate = proposed / (proposed + read-only executed)", () => {
    expect(m.interventionRate).toMatchObject({ numerator: 4, denominator: 7 });
  });

  it("approval-through rate = mutating executed / proposed", () => {
    expect(m.approvalThroughRate).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it("resolves proposals into approved / rejected / pending (pending when neither)", () => {
    // log has 4 proposed, 3 executed-mutating, 0 rejected → 1 still pending (p4).
    expect(m.resolution).toEqual({ approved: 3, rejected: 0, pending: 1 });
  });

  it("counts rejections and folds them into the resolution", () => {
    const withReject = summarize(
      parseAuditLog([log, REJECT("sys_reboot", "p4", "2026-06-01T10:10:00Z")].join("\n")),
    );
    expect(withReject.counts.rejected).toBe(1);
    expect(withReject.resolution).toEqual({ approved: 3, rejected: 1, pending: 0 });
    expect(withReject.perOp.find((s) => s.op === "sys_reboot")).toMatchObject({
      proposed: 1,
      executed: 0,
      rejected: 1,
    });
  });

  it("blast radius counts realised mutating executions by op", () => {
    expect(m.blastRadius.mutatingExecutions).toBe(3);
    expect(m.blastRadius.byOp).toEqual({ sys_pull_image: 2, sys_remove_image: 1 });
    // The base log predates #18 (no reversible field) → all three count as unknown.
    expect(m.blastRadius.reversibility).toEqual({ reversible: 0, irreversible: 0, unknown: 3 });
  });

  it("weighs irreversible executions heavier than reversible ones in blast radius", () => {
    const wlog = [
      PROPOSE("sys_pull_image", "p1", "2026-06-01T10:00:00Z"),
      EXEC_REV("sys_pull_image", "p1", 0, "2026-06-01T10:01:00Z"), // reversible → 1
      PROPOSE("sys_pull_image", "p2", "2026-06-01T10:02:00Z"),
      EXEC_REV("sys_pull_image", "p2", 0, "2026-06-01T10:03:00Z"), // reversible → 1
      PROPOSE("sys_reboot", "p3", "2026-06-01T10:04:00Z"),
      EXEC_IRREV("sys_reboot", "p3", 0, "2026-06-01T10:05:00Z"), // irreversible → 3
    ].join("\n");
    const mw = summarize(parseAuditLog(wlog));
    expect(mw.blastRadius.mutatingExecutions).toBe(3);
    expect(mw.blastRadius.reversibility).toEqual({ reversible: 2, irreversible: 1, unknown: 0 });
    // 2 reversible (×1) + 1 irreversible (×3) = 5, strictly larger than the raw count 3.
    expect(mw.blastRadius.weighted).toBe(5);
    expect(mw.blastRadius.weighted).toBeGreaterThan(mw.blastRadius.mutatingExecutions);
  });

  it("treats a single irreversible execution as a larger blast than a single reversible one", () => {
    const rev = summarize(
      parseAuditLog(EXEC_REV("sys_pull_image", "p1", 0, "2026-06-01T10:00:00Z")),
    );
    const irrev = summarize(
      parseAuditLog(EXEC_IRREV("sys_reboot", "p1", 0, "2026-06-01T10:00:00Z")),
    );
    expect(irrev.blastRadius.weighted).toBeGreaterThan(rev.blastRadius.weighted);
  });

  it("per-op breakdown counts proposed/executed/ok/failed, sorted by name", () => {
    expect(m.perOp.map((s) => s.op)).toEqual([
      "sys_disk",
      "sys_memory",
      "sys_pull_image",
      "sys_reboot",
      "sys_remove_image",
    ]);
    expect(m.perOp.find((s) => s.op === "sys_remove_image")).toEqual({
      op: "sys_remove_image",
      risk: "mutating",
      proposed: 1,
      executed: 1,
      ok: 0,
      failed: 1,
      rejected: 0,
    });
    expect(m.perOp.find((s) => s.op === "sys_reboot")).toMatchObject({
      proposed: 1,
      executed: 0,
    });
  });

  it("reports the time window and event count", () => {
    expect(m.window).toEqual({
      from: "2026-06-01T10:00:00Z",
      to: "2026-06-01T10:09:00Z",
      events: 10,
      skipped: 0,
    });
  });

  it("guards divide-by-zero with null rates on an empty log", () => {
    const empty = summarize(parseAuditLog(""));
    expect(empty.window.events).toBe(0);
    expect(empty.window.from).toBeNull();
    expect(empty.successRate.overall.value).toBeNull();
    expect(empty.interventionRate.value).toBeNull();
    expect(empty.approvalThroughRate.value).toBeNull();
  });
});

describe("formatMetrics", () => {
  it("renders the headline sections including the proposal resolution", () => {
    const report = formatMetrics(summarize(parseAuditLog(log)));
    expect(report).toContain("ward metrics — 10 events");
    expect(report).toContain("Success rate");
    expect(report).toContain("Human-intervention rate");
    expect(report).toContain("Proposal resolution (4 proposed)");
    expect(report).toContain("rejected");
    expect(report).toContain("pending");
    expect(report).toContain("Blast radius");
    expect(report).toContain("reversibility: 0 reversible, 0 irreversible, 3 unknown");
    expect(report).toContain("weighted blast radius");
    expect(report).toContain("57.1%"); // intervention rate 4/7
  });

  it("renders the reversibility breakdown and weighted blast radius for a #18 log", () => {
    const wlog = [
      EXEC_REV("sys_pull_image", "p1", 0, "2026-06-01T10:00:00Z"),
      EXEC_IRREV("sys_reboot", "p2", 0, "2026-06-01T10:01:00Z"),
    ].join("\n");
    const report = formatMetrics(summarize(parseAuditLog(wlog)));
    expect(report).toContain("reversibility: 1 reversible, 1 irreversible");
    expect(report).not.toContain("unknown"); // no legacy lines → no unknown segment
    expect(report).toContain("weighted blast radius  4"); // 1×1 + 1×3
  });

  it("says 'no events' for an empty log", () => {
    expect(formatMetrics(summarize(parseAuditLog("")))).toContain("no events");
  });
});
