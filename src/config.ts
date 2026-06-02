import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfigFile } from "./configFile.js";
import type { AutonomyLevel, Locale } from "./types.js";

/** The locales ward ships text for — every label must exist in each (see i18n/). */
export const LOCALES: readonly Locale[] = ["en", "ja"];

/** Non-secret user preferences read once here; env still wins (see precedence below). */
const file = loadConfigFile();

/**
 * ward configuration. Intentionally holds NO secrets.
 *
 * The host's real address lives in ~/.ssh/config under an alias; only the generic
 * alias name is stored here, which is safe to commit to a public repository.
 *
 * User-settable preferences (language, ssh_host) resolve env > file > default:
 * an explicit env var overrides ~/.ward/config.yaml, which overrides the built-in
 * default. `ward config set …` writes the file; env stays the per-process override.
 */
export const config = {
  /**
   * SSH host alias (resolved by ~/.ssh/config). Override with WARD_SSH_HOST;
   * otherwise the file's ssh_host; otherwise "ward-host".
   */
  sshHost: resolveSshHost(process.env.WARD_SSH_HOST, file.ssh_host),
  /** Seconds before an SSH connection attempt is abandoned. */
  sshConnectTimeoutSec: 5,
  /**
   * How much autonomy ward grants. Override with WARD_AUTONOMY.
   *
   * Default is "read-only": the safe floor. The capability to run mutating
   * operations behind the approval gate exists in code but is NOT switched on
   * unless this is explicitly set to "approval" — staged autonomy by design.
   *
   * Deliberately NOT file-configurable: autonomy is a guardrail attribute, so
   * loosening it must be an explicit env act, never a quiet edit to a dotfile.
   */
  autonomy: parseAutonomy(process.env.WARD_AUTONOMY),
  /**
   * UI language for tool titles/descriptions and approval messages. Resolves a
   * recognized WARD_LANG > a recognized file.language > "en" (the default, so the
   * public registry is usable by the widest audience). Set WARD_LANG=ja or
   * `ward config set language ja` for Japanese.
   */
  lang: resolveLang(process.env.WARD_LANG, file.language),
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

/** env (if non-empty) > file (if non-empty) > "ward-host". */
function resolveSshHost(env: string | undefined, fromFile: string | undefined): string {
  if (env !== undefined && env !== "") return env;
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return "ward-host";
}

/** A recognized env value > a recognized file value > English; unrecognized falls through. */
function resolveLang(env: string | undefined, fromFile: string | undefined): Locale {
  const recognized = (raw: string | undefined): Locale | undefined =>
    raw === "en" || raw === "ja" ? raw : undefined;
  return recognized(env) ?? recognized(fromFile) ?? "en";
}
