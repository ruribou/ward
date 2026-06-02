import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";

/**
 * The user config FILE layer (~/.ward/config.yaml), shared by the MCP server and
 * the `ward` CLI without passing env. It holds ONLY non-secret user preferences:
 * the UI language and the SSH host *alias* (the real address stays in ~/.ssh/config).
 * Precedence is resolved in config.ts: env > this file > built-in default.
 *
 * Deliberately excludes `autonomy` — that is a guardrail attribute, kept env-only
 * so loosening it is never a quiet edit to a dotfile.
 */
export const CONFIG_FILE_KEYS = ["language", "ssh_host"] as const;

type ConfigFileKey = (typeof CONFIG_FILE_KEYS)[number];

export interface ConfigFileContents {
  language?: string;
  ssh_host?: string;
}

/** An alias only — no spaces, colons, or slashes (those would be a real address). */
const SSH_HOST_RE = /^[A-Za-z0-9_.-]+$/;

/** WARD_CONFIG_FILE mirrors WARD_PROPOSALS_FILE so tests can point at a temp file. */
export function resolveConfigPath(): string {
  return process.env.WARD_CONFIG_FILE ?? join(homedir(), ".ward", "config.yaml");
}

/**
 * Read the config file, tolerantly. Config must ALWAYS load: a missing file, a
 * parse error, or a non-object body all resolve to {} rather than throwing. Only
 * known keys whose value is a string are returned.
 */
export function loadConfigFile(path = resolveConfigPath()): ConfigFileContents {
  if (!existsSync(path)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") {
    return {};
  }
  const raw = parsed as Record<string, unknown>;
  const out: ConfigFileContents = {};
  for (const key of CONFIG_FILE_KEYS) {
    const value = raw[key];
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/** Throws a clear Error for an unknown key or an invalid value (the CLI maps these to exit 2). */
function validate(key: string, value: string): asserts key is ConfigFileKey {
  if (!(CONFIG_FILE_KEYS as readonly string[]).includes(key)) {
    throw new Error(`ward: "${key}" is not a settable config key`);
  }
  if (key === "language" && value !== "en" && value !== "ja") {
    throw new Error(`ward: invalid language "${value}" (expected "en" or "ja")`);
  }
  if (key === "ssh_host" && !SSH_HOST_RE.test(value)) {
    throw new Error(`ward: invalid ssh_host "${value}" (expected an alias: ${SSH_HOST_RE.source})`);
  }
}

/**
 * Set one key in the config file, preserving the other. Writes atomically (temp
 * file + rename, mkdir -p the dir — mirrors the proposal store) so a crash never
 * leaves a half-written config.
 */
export function setConfigValue(path: string, key: string, value: string): void {
  validate(key, value);
  const current = loadConfigFile(path);
  const next: ConfigFileContents = { ...current, [key]: value };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringify(next));
  renameSync(tmp, path);
}
