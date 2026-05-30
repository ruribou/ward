import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit as defaultAudit } from "./audit.js";
import { runOperation as defaultRunOperation } from "./executor.js";
import { guard } from "./guard.js";
import { operations } from "./operations.js";
import type { ExecResult, Operation } from "./types.js";

/**
 * Side effects, injected so the server wiring can be exercised in-memory in
 * tests without touching the substrate (no SSH, no real NUC).
 */
export interface ServerDeps {
  runOperation: (op: Operation) => Promise<ExecResult>;
  audit: (op: Operation, result: ExecResult) => void;
}

/**
 * Builds the ward MCP server: one tool per read-only operation in the registry.
 * Every tool call flows: guard (allowed?) → execute → audit → formatted text.
 */
export function createServer(deps: Partial<ServerDeps> = {}): McpServer {
  const runOperation = deps.runOperation ?? defaultRunOperation;
  const audit = deps.audit ?? defaultAudit;

  const server = new McpServer({ name: "ward", version: "0.1.0" });

  for (const op of operations) {
    server.registerTool(op.name, { title: op.title, description: op.description }, async () => {
      guard(op);
      const result = await runOperation(op);
      audit(op, result);

      const header = `$ ${op.command.join(" ")}  (exit ${result.exitCode}, ${result.ms}ms)`;
      const body = result.stdout.trim() || result.stderr.trim() || "(no output)";
      return { content: [{ type: "text", text: `${header}\n\n${body}` }] };
    });
  }

  return server;
}
