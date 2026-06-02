import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../../guardrail/audit.js";
import type { AuditEntry, ExecResult, Operation } from "../../types.js";

const op: Operation = {
  name: "sys_disk",
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
      op: "sys_disk",
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
    expect(entry).toMatchObject({ event: "proposed", op: "sys_disk", proposalId: "p1" });
    expect(entry.exitCode).toBeUndefined();
    expect(entry.ms).toBeUndefined();
  });

  it("records reversible:true on a mutating event that declared an inverse (#18)", () => {
    const reversible: Operation = {
      name: "sys_pull_image",
      risk: "mutating",
      command: ["docker", "pull", "alpine"],
      inverse: "sys_remove_image",
    };
    expect(loggedEntry({ event: "proposed", op: reversible, proposalId: "p1" }).reversible).toBe(
      true,
    );
  });

  it("records reversible:false on a mutating event marked irreversible (#18)", () => {
    const irreversible: Operation = {
      name: "sys_reboot",
      risk: "mutating",
      command: ["sudo", "reboot"],
      irreversible: true,
    };
    expect(loggedEntry({ event: "proposed", op: irreversible, proposalId: "p2" }).reversible).toBe(
      false,
    );
  });

  it("omits the reversibility field on a read-only event (it changes nothing)", () => {
    const entry = loggedEntry({ event: "executed", op, result });
    expect(entry.reversible).toBeUndefined();
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

  it("never throws when WARD_AUDIT_LOG is unwritable, and warns loudly on stderr", async () => {
    const dir = join(tmpdir(), `ward-audit-missing-${process.pid}`);
    rmSync(dir, { recursive: true, force: true }); // parent dir absent → append throws ENOENT
    const bad = join(dir, "audit.log");
    process.env.WARD_AUDIT_LOG = bad;
    vi.resetModules(); // so config (env-read at import) and audit pick up the bad path
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { audit: freshAudit } = await import("../../guardrail/audit.js");
      // A failed file append must not surface as a thrown error: for an executed
      // event the command already ran, and throwing would mask that side effect.
      expect(() => freshAudit({ event: "executed", op, result })).not.toThrow();

      const lines = spy.mock.calls.map(
        (c) => JSON.parse(c[0] as string) as Record<string, unknown>,
      );
      // The audit record still reached stderr, the always-available sink...
      expect(lines.some((l) => l.event === "executed")).toBe(true);
      // ...and the broken file sink was reported, not silently swallowed.
      const warning = lines.find((l) => l.event === "audit-write-failed");
      expect(warning).toMatchObject({ event: "audit-write-failed", auditLog: bad });
      expect(typeof warning!.error).toBe("string");
    } finally {
      delete process.env.WARD_AUDIT_LOG;
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
