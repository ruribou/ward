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
 * A declared parameter of a parameterized operation: a single argv slot whose
 * value the model may choose, but ONLY from a fixed enum allowlist.
 *
 * This is how a model-supplied argument enters a command without opening an
 * injection surface. The model does not type a free-form string; it *selects* a
 * member of `allow`, and every member of `allow` passed the same strict argv
 * charset as a constant command element at load time. So a chosen value is, by
 * construction, indistinguishable from a constant the registry author wrote —
 * "no free-form arbitrary args" (issue #16) holds end to end.
 *
 * The shape is deliberately a mapping with an `allow:` list rather than a bare
 * list, so a future, narrower constraint (e.g. a `type:`/`regex:` key) can be
 * added alongside `allow` without changing this interface's existing meaning.
 * This PR ships the enum allowlist only.
 */
export interface OpParam {
  /** Param name, also the {token} used in `command`/`precheck` and the tool input key. */
  readonly name: string;
  /**
   * The finite set of values the model may choose from. Non-empty; every member
   * is charset-validated by the loader exactly like a constant command element,
   * so substituting any of them can never smuggle a space or shell metacharacter.
   */
  readonly allow: readonly string[];
}

/**
 * A single capability ward can perform against the substrate (the host).
 *
 * Structure only — its human/LLM-facing title and description are not stored
 * here. They live in i18n/labels_<locale>.yaml under `ops.<name>`, resolved for
 * the active locale when the tool is registered.
 */
export interface Operation {
  /** MCP tool name, e.g. "sys_disk". Also the i18n key for its title/description. */
  readonly name: string;
  /** Risk classification — read by the guardrail gate before execution. */
  readonly risk: RiskClass;
  /**
   * The command to run, as an argv array (NO shell).
   *
   * Every element is either a constant the registry author wrote or a `{token}`
   * placeholder referencing a declared {@link params} entry. A constant is
   * charset-validated at load time; a placeholder is replaced — before execution
   * — by a model-chosen enum member that was itself charset-validated at load
   * time. The model therefore never supplies any *part* of the command beyond
   * selecting a pre-approved value, so there is no command/argument injection
   * surface. A *resolved* operation (what actually runs, and what a proposal
   * carries) holds no placeholders — see {@link resolveOperation}.
   */
  readonly command: readonly string[];
  /**
   * Optional read-only probe surfaced in a mutating op's proposal so the human
   * can verify current state before approving — half of the "plan" preview (the
   * other half is the effect description in i18n under `ops.<name>.plan`). Same
   * argv shape, charset, and `{token}` placeholder rules as `command`, validated
   * identically by the loader, and only ever shown in the propose path — ward
   * does not run it for you.
   */
  readonly precheck?: readonly string[];
  /**
   * Optional parameter declarations. An op with no `params` takes no input and is
   * a pure constant command, exactly as before. An op WITH `params` exposes each
   * one as an enum at the tool boundary; a chosen value is validated against the
   * enum and substituted into the `{token}` placeholders to produce a concrete,
   * placeholder-free command before it ever reaches the executor.
   */
  readonly params?: readonly OpParam[];
  /**
   * The operation that undoes this one — reversibility as declared data, so
   * rollback is a first-class property of a change rather than tribal knowledge
   * (issue #18, CONCEPT Phase 2). Names another *mutating* op in the registry,
   * cross-checked at load time: a dangling or read-only inverse is a load error.
   *
   * Exactly one of `inverse` / {@link irreversible} must be set on a mutating op
   * (neither, or both, fails the loader — no silent holes); a read-only op must
   * set NEITHER. The first inverse pair is sys_pull_image ⇄ sys_remove_image on
   * the same {image}. The inverse is surfaced in a proposal's plan so the operator
   * knows, before approving, how to roll the change back.
   */
  readonly inverse?: string;
  /**
   * Marks a mutating op as having no inverse — it cannot be undone. This is the
   * deliberate alternative to {@link inverse}: an op must declare one or the
   * other, so "we forgot to think about rollback" can never pass review as a
   * silently irreversible change. An irreversible op carries a larger blast
   * radius (see metrics) because its effect is permanent.
   */
  readonly irreversible?: true;
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
  /**
   * The operation that will run verbatim if this proposal is approved. For a
   * parameterized op this is the *resolved* operation — placeholders already
   * substituted with the model's chosen, enum-validated values — so the approver
   * sees and runs EXACTLY what was proposed; nothing is re-supplied at approve time.
   */
  readonly op: Operation;
}

/**
 * One entry in the audit trail. Every operation leaves a trace; a mutating one
 * leaves a "proposed" event and then exactly one resolution — an "executed" event
 * once approved, or a "rejected" event if a human discards it — so the record
 * shows both what was asked for and how it was resolved.
 */
export interface AuditEntry {
  /**
   * "proposed" = gated, awaiting approval; "executed" = the command actually ran;
   * "rejected" = a human discarded the proposal without running it.
   */
  readonly event: "proposed" | "executed" | "rejected";
  readonly op: Operation;
  /** Set for proposed events and for the execution/rejection that resolves them. */
  readonly proposalId?: string;
  /** Set only for "executed" events. */
  readonly result?: ExecResult;
}
