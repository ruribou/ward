import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { operations } from "../registry/operations.js";
import { createServer, type ServerDeps } from "../server.js";
import type { ExecResult, Operation } from "../types.js";

function fakeResult(over: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "FAKE", stderr: "", exitCode: 0, ms: 1, ...over };
}

async function connect(deps: Partial<ServerDeps>): Promise<Client> {
  const server = createServer(deps);
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

/** A registry with a mutating op — what operations.yaml deliberately lacks yet. */
const fakeRegistry: readonly Operation[] = [
  { name: "nuc_disk", title: "disk", description: "d", risk: "read-only", command: ["df", "-h"] },
  {
    name: "nuc_reboot",
    title: "reboot",
    description: "d",
    risk: "mutating",
    command: ["sudo", "reboot"],
  },
];

describe("ward MCP server (in-memory)", () => {
  it("registers exactly the read-only registry as tools (no ward_approve at the read-only floor)", async () => {
    const client = await connect({ runOperation: async () => fakeResult(), audit: () => {} });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...operations].map((o) => o.name).sort());
    expect(names).not.toContain("ward_approve");
  });

  it("works with default dependencies (no injection)", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.length).toBe(operations.length);
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

describe("ward MCP server — approval gate (in-memory)", () => {
  it("registers ward_approve only at the approval level", async () => {
    const ap = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation: async () => fakeResult(),
      audit: () => {},
    });
    expect((await ap.listTools()).tools.map((t) => t.name)).toContain("ward_approve");
  });

  it("proposes a mutating operation instead of executing it", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const audit = vi.fn();
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation,
      audit,
    });

    const res = await client.callTool({ name: "nuc_reboot", arguments: {} });
    expect(textOf(res)).toContain("p1");
    expect(textOf(res)).toContain("ward_approve");
    expect(textOf(res)).toContain("sudo reboot");
    expect(runOperation).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "proposed", proposalId: "p1" }),
    );
  });

  it("executes the proposed operation exactly once on ward_approve", async () => {
    const runOperation = vi.fn(async () => fakeResult({ stdout: "rebooted", ms: 5 }));
    const audit = vi.fn();
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation,
      audit,
    });

    await client.callTool({ name: "nuc_reboot", arguments: {} }); // mints p1
    const res = await client.callTool({ name: "ward_approve", arguments: { id: "p1" } });

    expect(runOperation).toHaveBeenCalledOnce();
    expect(textOf(res)).toContain("sudo reboot");
    expect(textOf(res)).toContain("rebooted");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "executed", proposalId: "p1" }),
    );
  });

  it("refuses a second approval of the same id (one-time use)", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation,
      audit: () => {},
    });

    await client.callTool({ name: "nuc_reboot", arguments: {} }); // mints p1
    await client.callTool({ name: "ward_approve", arguments: { id: "p1" } }); // consumes p1
    const again = await client.callTool({ name: "ward_approve", arguments: { id: "p1" } });

    expect((again as { isError?: boolean }).isError).toBe(true);
    expect(textOf(again)).toContain("p1");
    expect(runOperation).toHaveBeenCalledOnce(); // not run again
  });

  it("refuses an unknown proposal id without executing anything", async () => {
    const runOperation = vi.fn(async () => fakeResult());
    const client = await connect({
      autonomy: "approval",
      operations: fakeRegistry,
      runOperation,
      audit: () => {},
    });

    const res = await client.callTool({ name: "ward_approve", arguments: { id: "p999" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(runOperation).not.toHaveBeenCalled();
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
