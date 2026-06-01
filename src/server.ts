import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { audit as defaultAudit } from "./guardrail/audit.js";
import { guard } from "./guardrail/guard.js";
import { ProposalStore } from "./guardrail/proposals.js";
import { getLabel, getLabelOr } from "./i18n/index.js";
import { operations as defaultOperations } from "./registry/operations.js";
import { runOperation as defaultRunOperation } from "./substrate/executor.js";
import type { AuditEntry, AutonomyLevel, ExecResult, Locale, Operation } from "./types.js";

/**
 * Side effects and policy inputs, injected so the server wiring can be exercised
 * in-memory in tests without touching the substrate (no SSH, no real NUC) and at
 * any autonomy level — with whatever registry, autonomy, and locale a test pins.
 */
export interface ServerDeps {
  runOperation: (op: Operation) => Promise<ExecResult>;
  audit: (entry: AuditEntry) => void;
  operations: readonly Operation[];
  autonomy: AutonomyLevel;
  lang: Locale;
}

/** Render an execution result as the text block the model/human sees. */
function formatResult(op: Operation, result: ExecResult): string {
  const header = `$ ${op.command.join(" ")}  (exit ${result.exitCode}, ${result.ms}ms)`;
  const body = result.stdout.trim() || result.stderr.trim() || "(no output)";
  return `${header}\n\n${body}`;
}

/**
 * Builds the ward MCP server: one tool per operation in the registry. Tool
 * titles/descriptions and the approval-gate messages are resolved from i18n for
 * the active locale (deps.lang, falling back to config.lang).
 *
 * Each tool call flows through the guardrail gate first:
 * - read-only (and mutating, only at the "autonomous" level — not built yet):
 *   guard → execute → audit → formatted output.
 * - mutating at the "approval" level: guard → *stage a proposal* → audit
 *   ("proposed") → return the proposal for review. It does NOT run. A separate
 *   ward_approve tool (registered only at this level) runs it once, on approval.
 *
 * The propose → approve split is what makes "AI proposes, human approves"
 * structural: the model cannot execute a mutating operation in a single step.
 */
export function createServer(deps: Partial<ServerDeps> = {}): McpServer {
  const runOperation = deps.runOperation ?? defaultRunOperation;
  const audit = deps.audit ?? defaultAudit;
  const operations = deps.operations ?? defaultOperations;
  const autonomy = deps.autonomy ?? config.autonomy;
  const lang = deps.lang ?? config.lang;

  const server = new McpServer({ name: "ward", version: "0.1.0" });
  const proposals = new ProposalStore();

  for (const op of operations) {
    // At the read-only floor the surface itself stays read-only: mutating ops are
    // not even exposed as tools. The gate would refuse them anyway — this is the
    // same guardrail one layer earlier, so the model never sees a write it can't do.
    if (op.risk === "mutating" && autonomy === "read-only") {
      continue;
    }
    const title = getLabelOr(`ops.${op.name}.title`, op.name, lang);
    const description = getLabelOr(`ops.${op.name}.description`, op.name, lang);
    server.registerTool(op.name, { title, description }, async () => {
      const decision = guard(op, autonomy);

      if (decision === "require-approval") {
        const { id } = proposals.create(op);
        audit({ event: "proposed", op, proposalId: id });
        const text = getLabel("proposal.notice", lang, {
          id,
          risk: op.risk,
          command: op.command.join(" "),
          host: config.sshHost,
        });
        return { content: [{ type: "text", text }] };
      }

      const result = await runOperation(op);
      audit({ event: "executed", op, result });
      return { content: [{ type: "text", text: formatResult(op, result) }] };
    });
  }

  // The approval half of the gate only exists where approvals can happen.
  if (autonomy === "approval") {
    server.registerTool(
      "ward_approve",
      {
        title: getLabel("approve.title", lang),
        description: getLabel("approve.description", lang),
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const proposal = proposals.consume(id);
        if (proposal === null) {
          return {
            content: [{ type: "text", text: getLabel("approve.rejected", lang, { id }) }],
            isError: true,
          };
        }
        const result = await runOperation(proposal.op);
        audit({ event: "executed", op: proposal.op, result, proposalId: proposal.id });
        return { content: [{ type: "text", text: formatResult(proposal.op, result) }] };
      },
    );
  }

  return server;
}
