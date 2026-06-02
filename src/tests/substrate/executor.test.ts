import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { runOperation } from "../../substrate/executor.js";
import type { Operation } from "../../types.js";

const op: Operation = {
  name: "sys_disk",
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
    expect(call[1]).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "ward-host",
      "df",
      "-h",
    ]);
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

  it("flags a timeout (killed with SIGTERM) distinctly from a plain exit 1", async () => {
    whenExecFile(
      { code: null, killed: true, signal: "SIGTERM", message: "timed out" },
      "partial",
      "",
    );
    const r = await runOperation(op);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("partial");
    expect(r.stderr).toContain("[ward] timed out");
    expect(r.stderr).not.toContain("ssh failed");
  });

  it("names the signal when killed by a non-timeout signal", async () => {
    whenExecFile({ code: null, killed: true, signal: "SIGKILL", message: "killed" }, "", "");
    const r = await runOperation(op);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[ward] killed by SIGKILL");
  });

  it("refuses (throws, before spawning ssh) an argv element that fails the charset guard", async () => {
    whenExecFile(null, "", "");
    // Defense in depth: a surviving placeholder or any unsafe element must never run.
    const unsafe: Operation = {
      name: "sys_pull_image",
      risk: "mutating",
      command: ["docker", "pull", "{image}"],
    };
    expect(() => runOperation(unsafe)).toThrow(/unsafe argv element/);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("accepts ':' and '/' in argv (a resolved port mapping / localhost URL) — #49", async () => {
    whenExecFile(null, "200", "");
    const run: Operation = {
      name: "sys_run_container",
      risk: "mutating",
      command: ["docker", "run", "-d", "--name", "web", "-p", "8080:80", "nginx"],
    };
    const check: Operation = {
      name: "sys_http_check",
      risk: "read-only",
      command: ["curl", "-sS", "-I", "--max-time", "5", "http://localhost:8080/"],
    };
    await expect(runOperation(run)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runOperation(check)).resolves.toMatchObject({ exitCode: 0 });
    // The widened charset still passes the elements through to ssh verbatim.
    expect(mocked.mock.calls.at(-1)?.[1]).toContain("http://localhost:8080/");
  });

  it("still refuses a space or shell metacharacter even with the widened charset — #49", () => {
    whenExecFile(null, "", "");
    // `:` is allowed now, but a space (word-split) or `;`/`$()`/backtick (shell
    // metachars) would be interpreted by the remote shell after ssh reassembles argv.
    for (const bad of ["8080:80 reboot", "80:80;reboot", "$(reboot):80", "http://localhost/`id`"]) {
      const op: Operation = { name: "sys_probe", risk: "read-only", command: ["echo", bad] };
      expect(() => runOperation(op)).toThrow(/unsafe argv element/);
    }
    expect(mocked).not.toHaveBeenCalled();
  });

  it("explains a maxBuffer overflow instead of reading as an ssh failure", async () => {
    whenExecFile(
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, message: "maxBuffer exceeded" },
      "truncated output",
      "",
    );
    const r = await runOperation(op);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("truncated output");
    expect(r.stderr).toContain("[ward] output exceeded");
    expect(r.stderr).not.toContain("ssh failed");
  });
});
