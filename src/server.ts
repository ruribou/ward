import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { audit as defaultAudit } from "./guardrail/audit.js";
import { guard } from "./guardrail/guard.js";
import { ProposalStore } from "./guardrail/proposals.js";
import { getLabel, getLabelOr } from "./i18n/index.js";
import { operations as defaultOperations } from "./registry/operations.js";
import { buildPlan, formatResult } from "./render.js";
import { runOperation as defaultRunOperation } from "./substrate/executor.js";
import type { AuditEntry, AutonomyLevel, ExecResult, Locale, Operation } from "./types.js";

/**
 * Side effects and policy inputs, injected so the server wiring can be exercised
 * in-memory in tests without touching the substrate (no SSH, no real NUC) and at
 * any autonomy level — with whatever registry, autonomy, locale, and (file-backed)
 * proposal store a test pins.
 */
export interface ServerDeps {
  runOperation: (op: Operation) => Promise<ExecResult>;
  audit: (entry: AuditEntry) => void;
  operations: readonly Operation[];
  autonomy: AutonomyLevel;
  lang: Locale;
  proposals: ProposalStore;
}

/**
 * Builds the ward MCP server: one tool per operation in the registry. Tool
 * titles/descriptions and the proposal message are resolved from i18n for the
 * active locale (deps.lang, falling back to config.lang).
 *
 * This is the AI's surface, and it can ONLY observe and propose:
 * - read-only: guard → execute → audit → formatted output.
 * - mutating at the "approval" level: guard → *stage a proposal* in the shared
 *   store → audit ("proposed") → return the proposal + its plan. It does NOT run.
 *
 * Crucially there is no approve tool here. A mutating operation runs only when a
 * human runs the separate `ward approve <id>` CLI, which consumes the proposal
 * from the same store. The AI cannot approve its own proposal because it has no
 * tool to do so — approval is out of band, in a process the AI does not drive.
 * (This holds as long as the AI is not also handed direct substrate credentials;
 * making ward the only door is a further, separate layer.)
 */
export function createServer(deps: Partial<ServerDeps> = {}): McpServer {
  const runOperation = deps.runOperation ?? defaultRunOperation;
  const audit = deps.audit ?? defaultAudit;
  const operations = deps.operations ?? defaultOperations;
  const autonomy = deps.autonomy ?? config.autonomy;
  const lang = deps.lang ?? config.lang;
  const proposals = deps.proposals ?? new ProposalStore();

  const server = new McpServer({ name: "ward", version: "0.1.0" });

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
          plan: buildPlan(op, lang),
        });
        return { content: [{ type: "text", text }] };
      }

      const result = await runOperation(op);
      audit({ event: "executed", op, result });
      return { content: [{ type: "text", text: formatResult(op, result) }] };
    });
  }

  return server;
}
