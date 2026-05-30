import { afterEach, describe, expect, it, vi } from "vitest";
import { audit } from "./audit.js";
import type { ExecResult, Operation } from "./types.js";

const op: Operation = {
  name: "nuc_disk",
  title: "t",
  description: "d",
  risk: "read-only",
  command: ["df", "-h"],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audit", () => {
  it("writes one JSON line to stderr with operation metadata, not the output", () => {
    const result: ExecResult = { stdout: "SHOULD_NOT_BE_LOGGED", stderr: "", exitCode: 0, ms: 42 };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    audit(op, result);

    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;
    expect(line.endsWith("\n")).toBe(true);

    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry).toMatchObject({ op: "nuc_disk", risk: "read-only", exitCode: 0, ms: 42 });
    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false);
    expect(line).not.toContain("SHOULD_NOT_BE_LOGGED");
  });
});
