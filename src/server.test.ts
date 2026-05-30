import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { operations } from "./operations.js";
import { createServer, type ServerDeps } from "./server.js";
import type { ExecResult, Operation } from "./types.js";

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

function textOf(res: { content?: unknown }): string {
  const content = res.content as Array<{ type: string; text?: string }> | undefined;
  return content?.find((b) => b.type === "text")?.text ?? "";
}

describe("ward MCP server (in-memory)", () => {
  it("registers exactly the read-only registry as tools", async () => {
    const client = await connect({ runOperation: async () => fakeResult(), audit: () => {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...operations].map((o) => o.name).sort());
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
    expect(audit).toHaveBeenCalledOnce();
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
