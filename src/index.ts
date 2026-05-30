#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/*
 * ward MCP server (M1) entrypoint: read-only NUC status over stdio.
 * All wiring lives in createServer(); this file only connects a transport.
 */
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
