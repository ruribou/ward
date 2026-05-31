import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../../guardrail/audit.js";
import type { AuditEntry, ExecResult, Operation } from "../../types.js";

const op: Operation = {
  name: "nuc_disk",
  title: "t",
  description: "d",
  risk: "read-only",
  command: ["df", "-h"],
};
const result: ExecResult = { stdout: "SHOULD_NOT_BE_LOGGED", stderr: "", exitCode: 0, ms: 42 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Capture the single JSON line audit() writes to stderr and parse it. */
function loggedEntry(entry: AuditEntry): Record<string, unknown> {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  audit(entry);
  expect(spy).toHaveBeenCalledOnce();
  const line = spy.mock.calls[0]![0] as string;
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("audit", () => {
  it("writes an executed event with metadata, never the command output", () => {
    const entry = loggedEntry({ event: "executed", op, result });
    expect(entry).toMatchObject({
      event: "executed",
      op: "nuc_disk",
      risk: "read-only",
      exitCode: 0,
      ms: 42,
    });
    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false);
    expect(JSON.stringify(entry)).not.toContain("SHOULD_NOT_BE_LOGGED");
  });

  it("records a proposed event with its proposalId and no exit code", () => {
    const entry = loggedEntry({ event: "proposed", op, proposalId: "p1" });
    expect(entry).toMatchObject({ event: "proposed", op: "nuc_disk", proposalId: "p1" });
    expect(entry.exitCode).toBeUndefined();
    expect(entry.ms).toBeUndefined();
  });

  it("carries the proposalId through to the executed event after approval", () => {
    const entry = loggedEntry({ event: "executed", op, result, proposalId: "p7" });
    expect(entry).toMatchObject({ event: "executed", proposalId: "p7", exitCode: 0 });
  });

  it("appends to WARD_AUDIT_LOG when set, as a durable record across calls", async () => {
    const tmp = join(tmpdir(), `ward-audit-test-${process.pid}.log`);
    rmSync(tmp, { force: true });
    process.env.WARD_AUDIT_LOG = tmp;
    vi.resetModules(); // so config (env-read at import) and audit pick up the path
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { audit: freshAudit } = await import("../../guardrail/audit.js");
      freshAudit({ event: "proposed", op, proposalId: "p1" });
      freshAudit({ event: "executed", op, result, proposalId: "p1" });

      const lines = readFileSync(tmp, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ event: "proposed", proposalId: "p1" });
      expect(JSON.parse(lines[1]!)).toMatchObject({
        event: "executed",
        proposalId: "p1",
        exitCode: 0,
      });
    } finally {
      delete process.env.WARD_AUDIT_LOG;
      rmSync(tmp, { force: true });
      vi.resetModules();
    }
  });
});
