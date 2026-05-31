import type { AutonomyLevel, Operation } from "../types.js";
import { config } from "../config.js";

/**
 * What the guardrail gate decided for an operation:
 * - "allow":            run it now.
 * - "require-approval": it is permitted, but only after explicit human approval
 *                       (the propose → approve gate). The caller must NOT run it
 *                       directly — it stages a proposal instead.
 *
 * A forbidden operation is not a decision: {@link guard} throws for it.
 */
export type GuardDecision = "allow" | "require-approval";

/** Thrown when an operation is not permitted at the current autonomy level. */
export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailError";
  }
}

/**
 * The guardrail gate. Every operation passes through here before it can execute.
 *
 * It maps (autonomy level × operation risk) to a decision:
 *
 *   level \ risk   read-only        mutating
 *   ───────────────────────────────────────────────
 *   read-only      allow            THROW (forbidden)
 *   approval       allow            require-approval
 *
 * Read-only operations are always allowed — they cannot change the substrate.
 * Mutating operations are forbidden outright at the read-only floor, and gated
 * behind human approval at the "approval" level. This is the staged-autonomy
 * dial (CONCEPT RQ2): widening what ward may do is a config change here, not a
 * rewrite, and it is defense in depth — even if a mutating op reached this gate
 * at the read-only level, it would be refused.
 */
export function guard(op: Operation, level: AutonomyLevel = config.autonomy): GuardDecision {
  if (op.risk === "read-only") {
    return "allow";
  }
  // op.risk === "mutating"
  if (level === "approval") {
    return "require-approval";
  }
  throw new GuardrailError(
    `ward: operation '${op.name}' (${op.risk}) is not permitted at autonomy level '${level}'`,
  );
}
