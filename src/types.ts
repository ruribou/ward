/**
 * Risk classification for an operation.
 *
 * M1 uses only "read-only". "mutating" exists from day one so the guardrail layer
 * is meaningful now and so M3 (the first writes) is a data change, not a redesign.
 */
export type RiskClass = "read-only" | "mutating";

/** A single capability ward can perform against the substrate (the NUC). */
export interface Operation {
  /** MCP tool name, e.g. "nuc_disk". */
  readonly name: string;
  /** Short, human/LLM-facing title. */
  readonly title: string;
  /** Description the LLM uses to decide when to call this tool. */
  readonly description: string;
  /** Risk classification — read by the guardrail gate before execution. */
  readonly risk: RiskClass;
  /**
   * The exact command to run, as an argv array (NO shell).
   * Every element is a constant in code: the model never supplies any part of it,
   * so there is no command/argument injection surface.
   */
  readonly command: readonly string[];
}

/** Result of executing an operation against the substrate. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Wall-clock duration in milliseconds. */
  readonly ms: number;
}
