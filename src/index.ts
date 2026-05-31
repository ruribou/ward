#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/*
 * ward MCP server entrypoint: NUC operations over stdio, governed by the
 * guardrail gate (autonomy level set via WARD_AUTONOMY; read-only by default).
 * All wiring lives in createServer(); this file only connects a transport.
 */
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
