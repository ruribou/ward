import type { Operation } from "./types.js";

/**
 * The current autonomy level. M1 is strictly read-only.
 *
 * This constant is the seam where M3's "mutating ⇒ dry-run + human approval"
 * logic will live. Today it expresses a single rule (see {@link guard}).
 */
export const AUTONOMY_LEVEL = "read-only" as const;

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
 * In M1 it enforces one invariant: only read-only operations may run. This is
 * defense in depth — the registry only contains read-only operations, AND this
 * gate would reject anything else even if one slipped in.
 */
export function guard(op: Operation): void {
  if (AUTONOMY_LEVEL === "read-only" && op.risk !== "read-only") {
    throw new GuardrailError(
      `ward: operation '${op.name}' (${op.risk}) is not permitted at autonomy level '${AUTONOMY_LEVEL}'`,
    );
  }
}
