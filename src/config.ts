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
} as const;
