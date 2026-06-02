import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodType } from "zod";
import { config } from "./config.js";
import { audit as defaultAudit } from "./guardrail/audit.js";
import { guard } from "./guardrail/guard.js";
import { ProposalStore } from "./guardrail/proposals.js";
import { getLabel, getLabelOr } from "./i18n/index.js";
import {
  operations as defaultOperations,
  ParamResolutionError,
  resolveOperation,
} from "./registry/operations.js";
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
    // A parameterized op advertises each param as an enum at the tool boundary, so
    // the model is constrained to the allowlist by the schema — not just by ward's
    // own check. An op with no params keeps taking no input, exactly as before.
    const inputSchema = buildInputSchema(op);
    // The MCP SDK invokes the handler as `(args, extra)` for a tool WITH an input
    // schema, but as `(extra)` for one without — so the first positional arg is the
    // model's args only when there is a schema. Read it accordingly; an op with no
    // params always resolves against {}.
    server.registerTool(op.name, { title, description, inputSchema }, async (...cbArgs) => {
      const args = inputSchema === undefined ? {} : ((cbArgs[0] ?? {}) as Record<string, unknown>);
      // Resolve placeholders against the model's chosen, enum-validated values. This
      // is the single point where a model-supplied value enters the command, and it
      // is re-validated defensively even though the schema already constrained it.
      let resolved: Operation;
      try {
        resolved = resolveOperation(op, args);
      } catch (err) {
        if (err instanceof ParamResolutionError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        throw err;
      }

      const decision = guard(resolved, autonomy);

      if (decision === "require-approval") {
        // The proposal carries the RESOLVED op, so the human approves and runs
        // exactly what was proposed — nothing is re-supplied at approve time.
        const { id } = proposals.create(resolved);
        audit({ event: "proposed", op: resolved, proposalId: id });
        const text = getLabel("proposal.notice", lang, {
          id,
          risk: resolved.risk,
          command: resolved.command.join(" "),
          host: config.sshHost,
          plan: buildPlan(resolved, lang),
        });
        return { content: [{ type: "text", text }] };
      }

      const result = await runOperation(resolved);
      audit({ event: "executed", op: resolved, result });
      return { content: [{ type: "text", text: formatResult(resolved, result) }] };
    });
  }

  return server;
}

/**
 * Build the MCP tool input schema for an operation. An op without params returns
 * `undefined` — it takes no input, exactly as today. A parameterized op returns a
 * Zod raw shape with one required `z.enum([...])` per param, so the tool boundary
 * itself constrains the model to the allowlist (ward re-validates regardless). A
 * single-member enum is widened to a literal because z.enum needs a non-empty
 * tuple; the loader already guarantees `allow` is non-empty.
 */
function buildInputSchema(op: Operation): Record<string, ZodType> | undefined {
  if (op.params === undefined || op.params.length === 0) {
    return undefined;
  }
  const shape: Record<string, ZodType> = {};
  for (const param of op.params) {
    const [first, ...rest] = param.allow;
    shape[param.name] = z.enum([first!, ...rest]);
  }
  return shape;
}
