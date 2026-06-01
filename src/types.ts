/**
 * Risk classification for an operation.
 *
 * The registry today is still entirely "read-only". "mutating" exists from day
 * one so the guardrail layer is meaningful: M3 builds the approval gate that
 * governs mutating operations, so adding the first real write later is a YAML
 * data change, not a redesign.
 */
export type RiskClass = "read-only" | "mutating";

/**
 * A single capability ward can perform against the substrate (the NUC).
 *
 * Structure only — its human/LLM-facing title and description are not stored
 * here. They live in i18n/labels_<locale>.yaml under `ops.<name>`, resolved for
 * the active locale when the tool is registered.
 */
export interface Operation {
  /** MCP tool name, e.g. "nuc_disk". Also the i18n key for its title/description. */
  readonly name: string;
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

/**
 * UI language for human/LLM-facing text — operation titles and descriptions and
 * the approval-gate messages. The strings live in i18n/labels_<locale>.yaml;
 * this only selects which file the loader reads (WARD_LANG, English default).
 * Adding a language is a new label file plus an entry here — no server change.
 */
export type Locale = "en" | "ja";

/**
 * How much autonomy ward grants — the staged-autonomy dial (CONCEPT RQ2).
 *
 * - "read-only": only read-only operations may run. The safe floor (default).
 * - "approval":  read-only runs directly; mutating runs only after an explicit
 *                human approval (the propose → approve gate).
 *
 * A future "autonomous" level (mutating runs directly) is deliberately not here
 * yet — it is the last rung of the ladder, added only with its own guardrails.
 */
export type AutonomyLevel = "read-only" | "approval";

/**
 * A mutating operation that has been *proposed* but not yet executed. It sits in
 * the pending store until a human approves it (via ward_approve) or it is
 * discarded. This is the seam where "AI proposes, human approves" becomes data.
 */
export interface Proposal {
  /** Stable, one-time handle the approver names, e.g. "p1". Never part of a command. */
  readonly id: string;
  /** The operation that will run verbatim if this proposal is approved. */
  readonly op: Operation;
}

/**
 * One entry in the audit trail. Every operation leaves a trace; mutating ones
 * leave two — a "proposed" event and, once approved, an "executed" event — so
 * the record shows both what was asked for and what actually ran.
 */
export interface AuditEntry {
  /** "proposed" = gated, awaiting approval; "executed" = the command actually ran. */
  readonly event: "proposed" | "executed";
  readonly op: Operation;
  /** Set for proposed events and for executions that came from an approval. */
  readonly proposalId?: string;
  /** Set only for "executed" events. */
  readonly result?: ExecResult;
}
