import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "../guardrail/proposals.js";
import { operations } from "../registry/operations.js";
import { createServer, type ServerDeps } from "../server.js";
import type { ExecResult, Operation } from "../types.js";

function fakeResult(over: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "FAKE", stderr: "", exitCode: 0, ms: 1, ...over };
}

// Every server gets a temp-file proposal store so tests never touch ~/.ward.
const tempPaths: string[] = [];
function tempStore(): ProposalStore {
  const path = join(tmpdir(), `ward-server-test-${process.pid}-${tempPaths.length}.json`);
  tempPaths.push(path);
  return new ProposalStore(path);
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  }
});

async function connect(deps: Partial<ServerDeps>): Promise<Client> {
  const server = createServer({ proposals: tempStore(), ...deps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as { content?: unknown }).content as
    | Array<{ type: string; text?: string }>
    | undefined;
  return content?.find((b) => b.type === "text")?.text ?? "";
}

/** A small registry with a mutating op, pinned so gate tests don't depend on the real one. */
const fakeRegistry: readonly Operation[] = [
  { name: "nuc_disk", risk: "read-only", command: ["df", "-h"] },
  // No plan description and no precheck → its proposal carries no plan block.
  { name: "nuc_reboot", risk: "mutating", command: ["sudo", "reboot"] },
  // A precheck but no i18n plan description → only the precheck line is shown.
  { name: "nuc_probe", risk: "mutating", command: ["touch", "marker"], precheck: ["ls", "marker"] },
];

describe("ward MCP server (in-memory)", () => {
  it("exposes exactly the read-only operations at the read-only floor (no writes, no approve tool)", async () => {
    const client = await connect({ runOperation: async () => fakeResult(), audit: () => {} });
    const names = (await client.listTools()).tools.map((t) => t.name);
    const readOnly = operations.filter((o) => o.risk === "read-only").map((o) => o.name);
    expect(names.sort()).toEqual(readOnly.sort());
    expect(names).not.toContain("nuc_pull");
    expect(names).not.toContain("ward_approve");
  });

  it("works with default dependencies (no injection)", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    const readOnly = operations.filter((o) => o.risk === "read-only").length;
    expect(tools.length).toBe(readOnly);
  });

  it("runs guard → executor → audit and returns formatted output", async () => {
    const seen: Operation[] = [];
    const runOperation = vi.fn(async (op: Operation) => {
      seen.push(op);
      return fakeResult({ stdout: "USED 6%", ms: 42 });
    });
    const audit = vi.fn();
    const client = await connect({ runOperation, audit });

    const res = await client.callTool({ name: "nuc_disk", arguments: {} });
    expect(textOf(res)).toContain("$ df -h");
    expect(textOf(res)).toContain("(exit 0, 42ms)");
    expect(textOf(res)).toContain("USED 6%");
    expect(seen.map((o) => o.name)).toEqual(["nuc_disk"]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "executed", op: seen[0] }));
  });

  it("falls back to stderr when stdout is empty", async () => {
    const client = await connect({
      runOperation: async () =>
        fakeResult({ stdout: "", stderr: "permission denied", exitCode: 1 }),
      audit: () => {},
    });
    const res = await client.callTool({ name: "nuc_uptime", arguments: {} });
    expect(textOf(res)).toContain("permission denied");
    expect(textOf(res)).toContain("exit 1");
  });

  it("shows a placeholder when there is no output at all", async () => {
    const client = await connect({
      runOperation: async () => fakeResult({ stdout: "", stderr: "" }),
      audit: () => {},
    });
    const res = await client.callTool({ name: "nuc_memory", arguments: {} });
    expect(textOf(res)).toContain("(no output)");
  });
});

describe("ward MCP server — propose only, approval is out of band (in-memory)", () => {
  it("never exposes an approve tool — the AI's surface can only observe and propose", async () => {
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation: async () => fakeResult(),
      audit: () => {},
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("nuc_reboot"); // it CAN propose
    expect(names).not.toContain("ward_approve"); // but it has no way to approve
    expect(names.some((n) => n.includes("approve"))).toBe(false);
  });

  it("stages a proposal in the shared store and points the human at `ward approve`, without running it", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const audit = vi.fn();
    const proposals = tempStore();
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation,
      audit,
      proposals,
    });

    const res = await client.callTool({ name: "nuc_reboot", arguments: {} });
    const text = textOf(res);
    expect(text).toContain("sudo reboot");
    expect(text).toContain("ward approve p1"); // human runs this in their terminal
    expect(text).not.toContain("ward_approve"); // there is no such tool to call

    expect(runOperation).not.toHaveBeenCalled(); // proposing does not execute
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "proposed", proposalId: "p1" }),
    );
    // It is durably staged for the separate `ward` CLI process to pick up.
    expect(proposals.list().map((p) => p.id)).toEqual(["p1"]);
    expect(proposals.get("p1")?.op.command).toEqual(["sudo", "reboot"]);
  });

  it("stages the registry's real mutating op (nuc_pull) with its plan", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const proposals = tempStore();
    const client = await connect({
      autonomy: "approval",
      runOperation,
      audit: () => {},
      proposals,
    });

    const text = textOf(await client.callTool({ name: "nuc_pull", arguments: {} }));
    expect(text).toContain("Proposal p1");
    expect(text).toContain("docker pull hello-world");
    expect(text).toContain("Plan:");
    expect(text).toContain("ward approve p1");
    expect(runOperation).not.toHaveBeenCalled();
    expect(proposals.get("p1")?.op.command).toEqual(["docker", "pull", "hello-world"]);
  });

  it("renders the proposal in the configured locale (ja)", async () => {
    const client = await connect({
      autonomy: "approval",
      lang: "ja",
      operations: fakeRegistry,
      runOperation: async () => fakeResult(),
      audit: () => {},
    });

    const text = textOf(await client.callTool({ name: "nuc_reboot", arguments: {} }));
    expect(text).toContain("提案 p1");
    expect(text).toContain("ward approve p1");
    expect(text).toContain("sudo reboot");
  });

  it("still executes read-only operations directly at the approval level", async () => {
    const runOperation = vi.fn(async () => fakeResult({ stdout: "USED 6%" }));
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation,
      audit: () => {},
    });

    const res = await client.callTool({ name: "nuc_disk", arguments: {} });
    expect(runOperation).toHaveBeenCalledOnce();
    expect(textOf(res)).toContain("USED 6%");
  });
});

describe("ward MCP server — plan preview before approval (in-memory)", () => {
  it("shows the effect description and precheck in a real mutating op's proposal", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const client = await connect({ autonomy: "approval", runOperation, audit: () => {} });

    const res = await client.callTool({ name: "nuc_pull", arguments: {} });
    const text = textOf(res);
    expect(text).toContain("Plan:");
    expect(text).toContain("hello-world image"); // from the en plan description
    expect(text).toContain("Verify first (read-only): $ docker images hello-world");
    // The plan never runs the precheck — propose stays pure (nothing touches the NUC).
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("renders the plan in the configured locale (ja)", async () => {
    const client = await connect({
      autonomy: "approval",
      lang: "ja",
      runOperation: async () => fakeResult(),
      audit: () => {},
    });

    const text = textOf(await client.callTool({ name: "nuc_pull", arguments: {} }));
    expect(text).toContain("plan:");
    expect(text).toContain("ローカル Docker イメージストアに追加"); // from the ja plan description
    expect(text).toContain("先に確認（read-only）: $ docker images hello-world");
  });

  it("shows just the precheck line when an op has a precheck but no description", async () => {
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation: async () => fakeResult(),
      audit: () => {},
    });

    const text = textOf(await client.callTool({ name: "nuc_probe", arguments: {} }));
    expect(text).toContain("Verify first (read-only): $ ls marker");
    expect(text).not.toContain("Plan:");
  });

  it("omits the plan block for a mutating op with neither a description nor a precheck", async () => {
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation: async () => fakeResult(),
      audit: () => {},
    });

    const text = textOf(await client.callTool({ name: "nuc_reboot", arguments: {} }));
    expect(text).not.toContain("Plan:");
    expect(text).not.toContain("Verify first");
  });
});
