import type { AutonomyLevel, Operation } from "../types.js";
import { config } from "../config.js";
import { decide, policy as defaultPolicy, type PolicyData } from "./policy.js";

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
 * The (autonomy level × operation risk) decision is no longer hard-coded — it is
 * read from the declarative policy (policy.yaml, see {@link decide}). With the
 * shipped policy this is still the staged-autonomy dial (CONCEPT RQ2/RQ3):
 *
 *   level \ risk   read-only        mutating
 *   ───────────────────────────────────────────────
 *   read-only      allow            deny (forbidden)
 *   approval       allow            require-approval
 *
 * Read-only operations cannot change the substrate; mutating ones are denied at
 * the read-only floor and gated behind human approval at the "approval" level.
 * A "deny" decision is raised as a {@link GuardrailError} — defense in depth, so
 * even a mutating op that reached this gate at the read-only level is refused.
 * The policy is injectable for tests; production uses the loaded policy.yaml.
 */
export function guard(
  op: Operation,
  level: AutonomyLevel = config.autonomy,
  policyData: PolicyData = defaultPolicy,
): GuardDecision {
  const decision = decide(policyData, level, op.risk, op.name);
  if (decision === "deny") {
    throw new GuardrailError(
      `ward: operation '${op.name}' (${op.risk}) is not permitted at autonomy level '${level}'`,
    );
  }
  return decision;
}
