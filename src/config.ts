import { homedir } from "node:os";
import { join } from "node:path";
import type { AutonomyLevel, Locale } from "./types.js";

/** The locales ward ships text for — every label must exist in each (see i18n/). */
export const LOCALES: readonly Locale[] = ["en", "ja"];

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
   * UI language for tool titles/descriptions and approval messages. Override
   * with WARD_LANG. Default "en" so the public registry is usable by the widest
   * audience; set WARD_LANG=ja for Japanese.
   */
  lang: parseLang(process.env.WARD_LANG),
  /**
   * Optional path for an append-only, reviewable audit log. Override with
   * WARD_AUDIT_LOG. Unset (the default) means audit lines go to stderr only.
   */
  auditLog: process.env.WARD_AUDIT_LOG,
  /**
   * Where pending proposals are persisted. This is the seam that makes approval
   * out of band: the MCP server (the AI's surface) only *writes* proposals here,
   * and the separate `ward` CLI a human runs *reads and consumes* them. Because
   * the two live in different processes, the file is what they share — the AI has
   * no approve tool, so it cannot approve its own proposal. Override with
   * WARD_PROPOSALS_FILE (tests point this at a temp file).
   */
  proposalsFile: process.env.WARD_PROPOSALS_FILE ?? join(homedir(), ".ward", "proposals.json"),
} as const;

/** Falls back to the safe "read-only" floor for anything unrecognized. */
function parseAutonomy(raw: string | undefined): AutonomyLevel {
  return raw === "approval" ? "approval" : "read-only";
}

/** Falls back to English for anything other than an explicitly supported locale. */
function parseLang(raw: string | undefined): Locale {
  return raw === "ja" ? "ja" : "en";
}
