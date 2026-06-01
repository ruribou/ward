import { getLabel, getLabelOr } from "./i18n/index.js";
import type { ExecResult, Locale, Operation } from "./types.js";

/**
 * Human/LLM-facing text rendering shared by both surfaces: the MCP server (which
 * shows proposals and read-only results) and the `ward` CLI (which shows pending
 * proposals and the result of an approved run). Keeping it in one place means a
 * proposal and its eventual execution read the same on either side of the gate.
 */

/** Render an execution result as the text block the model/human sees. */
export function formatResult(op: Operation, result: ExecResult): string {
  const header = `$ ${op.command.join(" ")}  (exit ${result.exitCode}, ${result.ms}ms)`;
  const body = result.stdout.trim() || result.stderr.trim() || "(no output)";
  return `${header}\n\n${body}`;
}

/**
 * Build the "plan" block shown with a proposal so a human can approve an
 * *informed* write, not just a command string (CONCEPT Phase 2 dry-run/plan).
 * It combines two optional, separately-sourced parts:
 * - a human-readable effect description from i18n (`ops.<name>.plan`), and
 * - a read-only precheck the approver can run to verify current state first
 *   (`op.precheck` — shown as a suggested command; ward does not run it).
 *
 * Returns "" when an op declares neither, so the notice is unchanged for ops
 * without a plan. The leading/trailing newlines space the block off from the
 * command and approval lines around the `{plan}` slot in proposal.notice.
 */
export function buildPlan(op: Operation, lang: Locale): string {
  const lines: string[] = [];
  const description = getLabelOr(`ops.${op.name}.plan`, "", lang);
  if (description !== "") {
    lines.push(getLabel("proposal.plan", lang, { description }));
  }
  const precheck = op.precheck;
  if (precheck !== undefined && precheck.length > 0) {
    lines.push(getLabel("proposal.precheck", lang, { precheck: precheck.join(" ") }));
  }
  return lines.length === 0 ? "" : `\n${lines.join("\n")}\n`;
}
