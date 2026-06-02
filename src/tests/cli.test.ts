import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEntrypoint, runCli, waitForConsumption } from "../cli.js";
import { ProposalStore } from "../guardrail/proposals.js";
import { createServer } from "../server.js";
import type { ExecResult, Operation } from "../types.js";

const op: Operation = { name: "sys_reboot", risk: "mutating", command: ["sudo", "reboot"] };

function fakeResult(over: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "FAKE", stderr: "", exitCode: 0, ms: 1, ...over };
}

/** Collect output lines the CLI emits. */
function capture() {
  const lines: string[] = [];
  return { out: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

let counter = 0;
let path: string;

beforeEach(() => {
  counter += 1;
  path = join(tmpdir(), `ward-cli-test-${process.pid}-${counter}.json`);
});

afterEach(() => {
  rmSync(path, { force: true });
  rmSync(`${path}.tmp`, { force: true });
});

describe("ward CLI — the human's out-of-band approval surface", () => {
  it("list reports when there is nothing pending", async () => {
    const cap = capture();
    const code = await runCli(["list"], { proposals: new ProposalStore(path), out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("No pending proposals");
  });

  it("list shows pending proposals and their command", async () => {
    const proposals = new ProposalStore(path);
    proposals.create(op);
    const cap = capture();
    const code = await runCli(["list"], { proposals, out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("p1");
    expect(cap.text()).toContain("sudo reboot");
  });

  it("approve runs the proposed operation exactly once, then the id is spent", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    const runOperation = vi.fn(async () => fakeResult({ stdout: "rebooted", ms: 5 }));
    const audit = vi.fn();
    const cap = capture();

    const code = await runCli(["approve", id], { proposals, runOperation, audit, out: cap.out });
    expect(code).toBe(0);
    expect(runOperation).toHaveBeenCalledOnce();
    expect(cap.text()).toContain("sudo reboot");
    expect(cap.text()).toContain("rebooted");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "executed", proposalId: "p1" }),
    );

    // One-time use: a fresh handle (another process) cannot approve it again.
    const again = await runCli(["approve", id], {
      proposals: new ProposalStore(path),
      runOperation,
      out: () => {},
    });
    expect(again).toBe(1);
    expect(runOperation).toHaveBeenCalledOnce();
  });

  it("approve of an unknown id runs nothing and exits non-zero", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const cap = capture();
    const code = await runCli(["approve", "p999"], {
      proposals: new ProposalStore(path),
      runOperation,
      out: cap.out,
    });
    expect(code).toBe(1);
    expect(runOperation).not.toHaveBeenCalled();
    expect(cap.text()).toContain("p999");
  });

  it("approve surfaces a non-zero exit from the operation", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    const runOperation = vi.fn(async () => fakeResult({ stdout: "", stderr: "boom", exitCode: 2 }));
    const cap = capture();
    const code = await runCli(["approve", id], {
      proposals,
      runOperation,
      audit: () => {},
      out: cap.out,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain("boom");
  });

  it("approve with no id prints usage and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["approve"], { proposals: new ProposalStore(path), out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("ward approve <id>");
  });

  it("reject discards a proposal so it can never run, and records a rejected audit event", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    const runOperation = vi.fn(async () => fakeResult());
    const audit = vi.fn();

    const rejectCode = await runCli(["reject", id], {
      proposals,
      runOperation,
      audit,
      out: () => {},
    });
    expect(rejectCode).toBe(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rejected", proposalId: "p1" }),
    );

    const approveCode = await runCli(["approve", id], {
      proposals: new ProposalStore(path),
      runOperation,
      out: () => {},
    });
    expect(approveCode).toBe(1); // already gone
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("reject of an unknown id records no audit event", async () => {
    const audit = vi.fn();
    const code = await runCli(["reject", "p999"], {
      proposals: new ProposalStore(path),
      audit,
      out: () => {},
    });
    expect(code).toBe(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("an unknown command prints usage and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["frobnicate"], { proposals: new ProposalStore(path), out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("Usage");
  });
});

describe("ward wait — block until a human consumes the proposal (read-only)", () => {
  it("returns 0 once the proposal leaves the pending store, telling the agent to verify", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    let ticks = 0;
    // The human consumes it (out of band) on the 3rd poll; wait never approves.
    const sleep = vi.fn(async () => {
      ticks += 1;
      if (ticks === 3) {
        new ProposalStore(path).consume(id);
      }
    });
    const cap = capture();
    const code = await runCli(["wait", id, "--interval=5"], {
      proposals,
      sleep,
      now: () => 0,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.text()).toContain("verify");
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("returns 124 on timeout while the proposal is still pending", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    let clock = 0;
    const sleep = vi.fn(async () => {
      clock += 1000; // advance past the 1s timeout on the first sleep
    });
    const cap = capture();
    const code = await runCli(["wait", id, "--timeout=1"], {
      proposals,
      sleep,
      now: () => clock,
      out: cap.out,
    });
    expect(code).toBe(124);
    expect(cap.text()).toContain("still pending");
    expect(cap.text()).toContain("1"); // the {timeout} seconds
  });

  it("rejects an invalid id with exit 2 and never polls", async () => {
    const sleep = vi.fn(async () => {});
    const cap = capture();
    const code = await runCli(["wait", "not-an-id"], {
      proposals: new ProposalStore(path),
      sleep,
      now: () => 0,
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.text()).toContain("not-an-id");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("prints usage and exits 2 when no id is given", async () => {
    const cap = capture();
    const code = await runCli(["wait"], { proposals: new ProposalStore(path), out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("ward wait <id>");
  });
});

describe("waitForConsumption — the pure poll (read-only, no real timers)", () => {
  it("returns 'consumed' when get() becomes null after N fake sleeps", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    let ticks = 0;
    const sleep = vi.fn(async () => {
      ticks += 1;
      if (ticks === 2) {
        new ProposalStore(path).consume(id);
      }
    });
    const outcome = await waitForConsumption(proposals, id, {
      intervalMs: 1,
      timeoutMs: 1_000_000,
      sleep,
      now: () => 0,
    });
    expect(outcome).toBe("consumed");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns 'timeout' when the injected clock passes timeoutMs while still pending", async () => {
    const proposals = new ProposalStore(path);
    proposals.create(op);
    let clock = 0;
    const sleep = vi.fn(async () => {
      clock += 500;
    });
    const outcome = await waitForConsumption(proposals, "p1", {
      intervalMs: 1,
      timeoutMs: 1000,
      sleep,
      now: () => clock,
    });
    expect(outcome).toBe("timeout");
    // start=0; tick→500 (<1000, sleeps again); tick→1000 (>=1000, times out).
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns 'consumed' immediately when the id is gone at the first check", async () => {
    const proposals = new ProposalStore(path); // empty store: get() is null
    const sleep = vi.fn(async () => {});
    const outcome = await waitForConsumption(proposals, "p1", {
      intervalMs: 1,
      timeoutMs: 1000,
      sleep,
      now: () => 0,
    });
    expect(outcome).toBe("consumed");
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("end to end — AI proposes via MCP, human approves via CLI (shared store)", () => {
  it("the server stages a proposal it cannot run; only the CLI executes it", async () => {
    const serverRun = vi.fn(async () => fakeResult());
    const server = createServer({
      autonomy: "approval",
      runOperation: serverRun,
      audit: () => {},
      proposals: new ProposalStore(path), // same file the CLI will read
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);

    // AI proposes — the server writes the RESOLVED op to the store but runs nothing.
    await client.callTool({ name: "sys_pull_image", arguments: { image: "hello-world" } });
    expect(serverRun).not.toHaveBeenCalled();

    // Human approves out of band, in a separate process reading the same store.
    const cliRun = vi.fn(async () => fakeResult({ stdout: "Downloaded hello-world" }));
    const cap = capture();
    const code = await runCli(["approve", "p1"], {
      proposals: new ProposalStore(path),
      runOperation: cliRun,
      audit: () => {},
      out: cap.out,
    });

    expect(code).toBe(0);
    expect(cliRun).toHaveBeenCalledOnce(); // the CLI is what ran it
    expect(serverRun).not.toHaveBeenCalled(); // the AI's surface never did
    expect(cap.text()).toContain("docker pull hello-world");
    expect(cap.text()).toContain("Downloaded hello-world");
  });
});

describe("isEntrypoint — recognises the bin even when installed as a symlink", () => {
  // npm/nodebrew install `ward` as a symlink to dist/cli.js; the entry check must
  // resolve symlinks or the CLI silently does nothing (regression from #29).
  let real: string;
  let link: string;

  beforeEach(() => {
    real = join(tmpdir(), `ward-entry-real-${process.pid}-${counter}.js`);
    link = join(tmpdir(), `ward-entry-link-${process.pid}-${counter}.js`);
    writeFileSync(real, "// entry stub\n");
    symlinkSync(real, link);
  });

  afterEach(() => {
    rmSync(link, { force: true });
    rmSync(real, { force: true });
  });

  it("matches when argv[1] is a symlink to the real module", () => {
    expect(isEntrypoint(link, pathToFileURL(real).href)).toBe(true);
  });

  it("matches when argv[1] is the real path itself", () => {
    expect(isEntrypoint(real, pathToFileURL(real).href)).toBe(true);
  });

  it("does not match an unrelated path, undefined, or a nonexistent path", () => {
    expect(isEntrypoint(tmpdir(), pathToFileURL(real).href)).toBe(false);
    expect(isEntrypoint(undefined, pathToFileURL(real).href)).toBe(false);
    expect(isEntrypoint(join(tmpdir(), "does-not-exist.js"), pathToFileURL(real).href)).toBe(false);
  });
});

describe("ward metrics — summarizing the audit log", () => {
  const sampleLog = [
    JSON.stringify({ ts: "t1", event: "executed", op: "sys_disk", risk: "read-only", exitCode: 0 }),
    JSON.stringify({
      ts: "t2",
      event: "proposed",
      op: "sys_pull_image",
      risk: "mutating",
      proposalId: "p1",
    }),
    JSON.stringify({
      ts: "t3",
      event: "executed",
      op: "sys_pull_image",
      risk: "mutating",
      proposalId: "p1",
      exitCode: 0,
    }),
  ].join("\n");

  it("reads a piped log from stdin when no path is given", async () => {
    const cap = capture();
    const code = await runCli(["metrics"], { out: cap.out, readStdin: () => sampleLog });
    expect(code).toBe(0);
    expect(cap.text()).toContain("ward metrics — 3 events");
    expect(cap.text()).toContain("Human-intervention rate");
  });

  it("reads the log from an explicit path argument", async () => {
    const cap = capture();
    const code = await runCli(["metrics", "/some/audit.log"], {
      out: cap.out,
      readFile: (p) => (p === "/some/audit.log" ? sampleLog : ""),
    });
    expect(code).toBe(0);
    expect(cap.text()).toContain("mutating executions  1");
  });

  it("emits machine-readable JSON with --json", async () => {
    const cap = capture();
    const code = await runCli(["metrics", "--json"], { out: cap.out, readStdin: () => sampleLog });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.text());
    expect(parsed.counts).toMatchObject({ proposed: 1, executed: 2, executedMutating: 1 });
  });

  it("returns 1 with a clear message when the source cannot be read", async () => {
    const cap = capture();
    const code = await runCli(["metrics", "/nope.log"], {
      out: cap.out,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain("cannot read");
  });
});

describe("ward config — user preferences in ~/.ward/config.yaml", () => {
  let configFilePath: string;

  beforeEach(() => {
    configFilePath = join(tmpdir(), `ward-config-cli-${process.pid}-${counter}.yaml`);
  });

  afterEach(() => {
    rmSync(configFilePath, { force: true });
    rmSync(`${configFilePath}.tmp`, { force: true });
  });

  it("set writes the file; a later get reflects it", async () => {
    const setCap = capture();
    const setCode = await runCli(["config", "set", "language", "ja"], {
      configFilePath,
      out: setCap.out,
    });
    expect(setCode).toBe(0);
    expect(setCap.text()).toContain(configFilePath);

    const getCap = capture();
    const getCode = await runCli(["config", "get"], { configFilePath, out: getCap.out });
    expect(getCode).toBe(0);
    expect(getCap.text()).toContain("language = ja");
    expect(getCap.text()).toContain(configFilePath);
  });

  it("bare `config` behaves like `config get` and notes unset keys", async () => {
    const cap = capture();
    const code = await runCli(["config"], { configFilePath, out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain("ssh_host");
    expect(cap.text()).toContain("unset");
  });

  it("set of an unknown key prints an error and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["config", "set", "autonomy", "approval"], {
      configFilePath,
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.text()).toContain("autonomy");
  });

  it("set of an invalid value prints an error and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["config", "set", "language", "fr"], {
      configFilePath,
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.text().toLowerCase()).toContain("invalid");
  });

  it("set with a missing value prints the config usage and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["config", "set", "language"], { configFilePath, out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("ward config");
  });

  it("path prints the resolved path and exits 0", async () => {
    const cap = capture();
    const code = await runCli(["config", "path"], { configFilePath, out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toBe(configFilePath);
  });

  it("an unknown subcommand prints the config usage and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["config", "frobnicate"], { configFilePath, out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("ward config");
  });
});
