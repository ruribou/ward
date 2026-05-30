#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { audit } from "./audit.js";
import { runOperation } from "./executor.js";
import { guard } from "./guard.js";
import { operations } from "./operations.js";

/**
 * ward MCP server (M1): exposes read-only NUC status operations as MCP tools.
 *
 * Each tool takes NO input parameters and runs a constant command from the
 * registry. Every call flows: guard (allowed?) → execute → audit → return text.
 */
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

const transport = new StdioServerTransport();
await server.connect(transport);
