import type { AutonomyLevel } from "./types.js";

/**
 * ward configuration. Intentionally holds NO secrets.
 *
 * The NUC's real address lives in ~/.ssh/config under an alias; only the generic
 * alias name is stored here, which is safe to commit to a public repository.
 */
export const config = {
  /** SSH host alias (resolved by ~/.ssh/config). Override with WARD_NUC_HOST. */
  sshHost: process.env.WARD_NUC_HOST ?? "nuc",
  /** Seconds before an SSH connection attempt is abandoned. */
  sshConnectTimeoutSec: 5,
  /**
   * How much autonomy ward grants. Override with WARD_AUTONOMY.
   *
   * Default is "read-only": the safe floor. The capability to run mutating
   * operations behind the approval gate exists in code but is NOT switched on
   * unless this is explicitly set to "approval" — staged autonomy by design.
   */
  autonomy: parseAutonomy(process.env.WARD_AUTONOMY),
  /**
   * Optional path for an append-only, reviewable audit log. Override with
   * WARD_AUDIT_LOG. Unset (the default) means audit lines go to stderr only.
   */
  auditLog: process.env.WARD_AUDIT_LOG,
} as const;

/** Falls back to the safe "read-only" floor for anything unrecognized. */
function parseAutonomy(raw: string | undefined): AutonomyLevel {
  return raw === "approval" ? "approval" : "read-only";
}
