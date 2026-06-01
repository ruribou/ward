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

/** A small registry with a mutating op, pinned so gate tests don't depend on the real one. */
const fakeRegistry: readonly Operation[] = [
  { name: "nuc_disk", risk: "read-only", command: ["df", "-h"] },
  // No plan description and no precheck → its proposal carries no plan block.
  { name: "nuc_reboot", risk: "mutating", command: ["sudo", "reboot"] },
  // A precheck but no i18n plan description → only the precheck line is shown.
  { name: "nuc_probe", risk: "mutating", command: ["touch", "marker"], precheck: ["ls", "marker"] },
];

describe("ward MCP server (in-memory)", () => {
  it("exposes exactly the read-only operations at the read-only floor (no writes, no ward_approve)", async () => {
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

  it("gates the registry's real mutating op (nuc_pull) through propose → approve", async () => {
    const runOperation = vi.fn(async () =>
      fakeResult({ stdout: "Status: Downloaded hello-world" }),
    );
    const audit = vi.fn();
    const client = await connect({ autonomy: "approval", runOperation, audit });

    const proposed = await client.callTool({ name: "nuc_pull", arguments: {} });
    expect(textOf(proposed)).toContain("Proposal p1");
    expect(textOf(proposed)).toContain("docker pull hello-world");
    expect(textOf(proposed)).toContain("ward_approve");
    expect(runOperation).not.toHaveBeenCalled();

    const done = await client.callTool({ name: "ward_approve", arguments: { id: "p1" } });
    expect(textOf(done)).toContain("docker pull hello-world");
    expect(textOf(done)).toContain("Downloaded hello-world");
    expect(runOperation).toHaveBeenCalledOnce();
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

  it("renders approval-gate messages in the configured locale (ja)", async () => {
    const client = await connect({
      autonomy: "approval",
      lang: "ja",
      operations: fakeRegistry,
      runOperation: async () => fakeResult(),
      audit: () => {},
    });

    const res = await client.callTool({ name: "nuc_reboot", arguments: {} });
    expect(textOf(res)).toContain("提案 p1");
    expect(textOf(res)).toContain("実行するには ward_approve");
    expect(textOf(res)).toContain("sudo reboot");
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

    await client.callTool({ name: "nuc_reboot", arguments: {} });
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

    await client.callTool({ name: "nuc_reboot", arguments: {} });
    await client.callTool({ name: "ward_approve", arguments: { id: "p1" } });
    const again = await client.callTool({ name: "ward_approve", arguments: { id: "p1" } });

    expect((again as { isError?: boolean }).isError).toBe(true);
    expect(textOf(again)).toContain("p1");
    expect(runOperation).toHaveBeenCalledOnce();
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
