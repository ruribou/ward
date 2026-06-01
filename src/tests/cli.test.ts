import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli.js";
import { ProposalStore } from "../guardrail/proposals.js";
import { createServer } from "../server.js";
import type { ExecResult, Operation } from "../types.js";

const op: Operation = { name: "nuc_reboot", risk: "mutating", command: ["sudo", "reboot"] };

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

  it("reject discards a proposal so it can never run", async () => {
    const proposals = new ProposalStore(path);
    const { id } = proposals.create(op);
    const runOperation = vi.fn(async () => fakeResult());

    const rejectCode = await runCli(["reject", id], { proposals, runOperation, out: () => {} });
    expect(rejectCode).toBe(0);

    const approveCode = await runCli(["approve", id], {
      proposals: new ProposalStore(path),
      runOperation,
      out: () => {},
    });
    expect(approveCode).toBe(1); // already gone
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("an unknown command prints usage and exits 2", async () => {
    const cap = capture();
    const code = await runCli(["frobnicate"], { proposals: new ProposalStore(path), out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain("Usage");
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

    // AI proposes — the server writes to the store but runs nothing.
    await client.callTool({ name: "nuc_pull", arguments: {} });
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
