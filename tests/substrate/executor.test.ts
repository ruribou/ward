import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { runOperation } from "../../src/substrate/executor.js";
import type { Operation } from "../../src/types.js";

const op: Operation = {
  name: "nuc_disk",
  title: "t",
  description: "d",
  risk: "read-only",
  command: ["df", "-h"],
};

const mocked = vi.mocked(execFile);

type ExecCallback = (err: unknown, stdout: string, stderr: string) => void;

/** Drive the mocked execFile to invoke its callback with a given outcome. */
function whenExecFile(err: unknown, stdout = "", stderr = ""): void {
  mocked.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as ExecCallback;
    cb(err, stdout, stderr);
    return undefined as never;
  }) as never);
}

beforeEach(() => {
  mocked.mockReset();
});

describe("runOperation", () => {
  it("invokes ssh (not a shell) with BatchMode, ConnectTimeout, host, then the command verbatim", async () => {
    whenExecFile(null, "ok", "");
    await runOperation(op);

    expect(mocked).toHaveBeenCalledTimes(1);
    const call = mocked.mock.calls[0]!;
    expect(call[0]).toBe("ssh");
    expect(call[1]).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "nuc", "df", "-h"]);
  });

  it("maps a successful run to exitCode 0 and passes the output through", async () => {
    whenExecFile(null, "USED 6%", "");
    const r = await runOperation(op);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("USED 6%");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("propagates a numeric exit code and keeps stderr", async () => {
    whenExecFile({ code: 2, message: "boom" }, "", "permission denied");
    const r = await runOperation(op);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("permission denied");
  });

  it("reports a spawn failure (string error code) as exitCode 1 with a note", async () => {
    whenExecFile({ code: "ENOENT", message: "ssh not found" }, "", "");
    const r = await runOperation(op);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ENOENT");
    expect(r.stderr).toContain("[ward] ssh failed");
  });

  it("treats a signal/timeout (null error code) as exitCode 1", async () => {
    whenExecFile({ code: null, killed: true, signal: "SIGTERM", message: "timed out" }, "", "");
    const r = await runOperation(op);
    expect(r.exitCode).toBe(1);
  });
});
