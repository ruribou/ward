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
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  // Never drop stderr: a non-zero exit's reason often lives only there, and
  // tools like `docker pull` emit progress/warnings to stderr even on success.
  const body =
    out !== "" && err !== "" ? `stdout:\n${out}\n\nstderr:\n${err}` : out || err || "(no output)";
  return `${header}\n\n${body}`;
}

/**
 * Build the "plan" block shown with a proposal so a human can approve an
 * *informed* write, not just a command string (CONCEPT Phase 2 dry-run/plan).
 * It combines three optional, separately-sourced parts:
 * - a human-readable effect description from i18n (`ops.<name>.plan`),
 * - a reversibility line stating whether the change can be undone and, if so, via
 *   which inverse op — from the op's declared `inverse` / `irreversible` (#18), and
 * - a read-only precheck the approver can run to verify current state first
 *   (`op.precheck` — shown as a suggested command; ward does not run it).
 *
 * Returns "" when an op declares none of these, so the notice is unchanged for
 * ops without a plan. The leading/trailing newlines space the block off from the
 * command and approval lines around the `{plan}` slot in proposal.notice.
 */
export function buildPlan(op: Operation, lang: Locale): string {
  const lines: string[] = [];
  const description = getLabelOr(`ops.${op.name}.plan`, "", lang);
  if (description !== "") {
    lines.push(getLabel("proposal.plan", lang, { description }));
  }
  lines.push(...reversibilityLines(op, lang));
  const precheck = op.precheck;
  if (precheck !== undefined && precheck.length > 0) {
    lines.push(getLabel("proposal.precheck", lang, { precheck: precheck.join(" ") }));
  }
  return lines.length === 0 ? "" : `\n${lines.join("\n")}\n`;
}

/**
 * The reversibility line(s) for a mutating op's plan: state plainly whether the
 * change can be rolled back — and via which inverse op — so the operator decides
 * with that in hand. A reversible op names its inverse; an irreversible one says
 * so explicitly. Read-only ops change nothing and so contribute no line; a
 * mutating op always carries exactly one (the loader guarantees it declared one).
 */
function reversibilityLines(op: Operation, lang: Locale): string[] {
  if (op.risk !== "mutating") {
    return [];
  }
  if (op.inverse !== undefined) {
    return [getLabel("gate.reversible", lang, { inverse: op.inverse })];
  }
  if (op.irreversible === true) {
    return [getLabel("gate.irreversible", lang)];
  }
  // A mutating op with neither cannot come from the loader (it fails closed), but
  // a hand-built op in a test might omit both — say nothing rather than guess.
  return [];
}
