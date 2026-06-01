#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { audit as defaultAudit } from "./guardrail/audit.js";
import { ProposalStore } from "./guardrail/proposals.js";
import { getLabel } from "./i18n/index.js";
import { buildPlan, formatResult } from "./render.js";
import { runOperation as defaultRunOperation } from "./substrate/executor.js";
import type { AuditEntry, ExecResult, Locale, Operation } from "./types.js";

/**
 * `ward` — the HUMAN's surface, deliberately separate from the AI's MCP server.
 *
 * The MCP server can only *propose* mutating operations (it has no approve tool);
 * a proposal sits in the shared proposal store until a human runs this CLI in
 * their own terminal. `ward approve <id>` is the only thing that executes a
 * mutating operation — so approval happens out of band, in a process the AI does
 * not drive. That is what makes "a human approves" a structural fact, not a norm
 * the AI is asked to honour.
 */
export interface CliDeps {
  runOperation: (op: Operation) => Promise<ExecResult>;
  audit: (entry: AuditEntry) => void;
  proposals: ProposalStore;
  lang: Locale;
  /** Sink for output lines; injected so tests can capture without touching stdout. */
  out: (line: string) => void;
}

/** Run one `ward` invocation. Returns the process exit code. */
export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const proposals = deps.proposals ?? new ProposalStore();
  const lang = deps.lang ?? config.lang;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runOperation = deps.runOperation ?? defaultRunOperation;
  const audit = deps.audit ?? defaultAudit;

  const [command, id] = argv;

  switch (command) {
    case "list":
    case "pending": {
      const pending = proposals.list();
      if (pending.length === 0) {
        out(getLabel("cli.noPending", lang));
        return 0;
      }
      out(getLabel("cli.pendingHeader", lang));
      for (const proposal of pending) {
        out(`  ${proposal.id}: $ ${proposal.op.command.join(" ")}${buildPlan(proposal.op, lang)}`);
      }
      return 0;
    }

    case "approve": {
      if (id === undefined) {
        out(getLabel("cli.usage", lang));
        return 2;
      }
      const proposal = proposals.consume(id);
      if (proposal === null) {
        out(getLabel("cli.notFound", lang, { id }));
        return 1;
      }
      const result = await runOperation(proposal.op);
      audit({ event: "executed", op: proposal.op, result, proposalId: proposal.id });
      out(formatResult(proposal.op, result));
      return result.exitCode === 0 ? 0 : 1;
    }

    case "reject": {
      if (id === undefined) {
        out(getLabel("cli.usage", lang));
        return 2;
      }
      const proposal = proposals.consume(id);
      if (proposal === null) {
        out(getLabel("cli.notFound", lang, { id }));
        return 1;
      }
      out(getLabel("cli.discarded", lang, { id }));
      return 0;
    }

    default:
      out(getLabel("cli.usage", lang));
      return command === undefined ? 0 : 2;
  }
}

// Auto-run only when invoked as the `ward` binary, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
