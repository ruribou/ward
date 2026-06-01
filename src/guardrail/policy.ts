import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { AutonomyLevel, RiskClass } from "../types.js";

/**
 * Guardrail policy as data (CONCEPT RQ3): the (autonomy level × operation risk)
 * decision matrix lives in policy.yaml — the single source of truth for "what is
 * permitted" — and is loaded + validated here, mirroring the operation registry.
 * Changing what ward may do is a reviewable YAML diff, not a code edit.
 *
 * The validation is a *runtime guardrail*, not a convenience: a malformed policy
 * (unknown level/risk key, a bad decision value, a missing cell) makes loading
 * throw, so the server fails closed — it never starts with an ambiguous policy.
 * At decision time the same posture holds: anything the policy does not
 * explicitly allow is denied (see {@link decide}).
 */

/** A single guardrail decision. "deny" is forbidden; {@link guard} turns it into an error. */
export type Decision = "allow" | "require-approval" | "deny";

/**
 * The parsed policy: the default matrix plus optional per-op overrides. Marked
 * Partial because the *data* may omit cells — {@link decide} treats any gap as a
 * denial — but {@link parsePolicy} requires every known cell to be present, so a
 * value coming from the loader is in practice complete.
 */
export interface PolicyData {
  readonly defaults: Partial<Record<AutonomyLevel, Partial<Record<RiskClass, Decision>>>>;
  /** Keyed by op name → autonomy level → decision. */
  readonly overrides: Record<string, Partial<Record<AutonomyLevel, Decision>>>;
}

/** The autonomy levels a policy must declare. Anything else decides to "deny". */
const KNOWN_LEVELS: readonly AutonomyLevel[] = ["read-only", "approval"];
const KNOWN_RISKS: readonly RiskClass[] = ["read-only", "mutating"];
const DECISIONS: readonly Decision[] = ["allow", "require-approval", "deny"];

/** Thrown when policy.yaml is malformed or incomplete. */
export class PolicyLoadError extends Error {
  constructor(message: string) {
    super(`ward: invalid guardrail policy — ${message}`);
    this.name = "PolicyLoadError";
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyLoadError(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asDecision(value: unknown, where: string): Decision {
  if (typeof value !== "string" || !DECISIONS.includes(value as Decision)) {
    throw new PolicyLoadError(
      `${where} must be one of [${DECISIONS.join(", ")}] (got ${JSON.stringify(value)})`,
    );
  }
  return value as Decision;
}

function parseDefaults(raw: unknown): PolicyData["defaults"] {
  const obj = asRecord(raw, "defaults");
  for (const level of Object.keys(obj)) {
    if (!KNOWN_LEVELS.includes(level as AutonomyLevel)) {
      throw new PolicyLoadError(
        `defaults has unknown autonomy level ${JSON.stringify(level)} ` +
          `(known: [${KNOWN_LEVELS.join(", ")}])`,
      );
    }
  }
  const defaults: Partial<Record<AutonomyLevel, Record<RiskClass, Decision>>> = {};
  for (const level of KNOWN_LEVELS) {
    const byRisk = asRecord(obj[level], `defaults.${level}`);
    for (const risk of Object.keys(byRisk)) {
      if (!KNOWN_RISKS.includes(risk as RiskClass)) {
        throw new PolicyLoadError(
          `defaults.${level} has unknown risk class ${JSON.stringify(risk)}`,
        );
      }
    }
    const cells = {} as Record<RiskClass, Decision>;
    for (const risk of KNOWN_RISKS) {
      if (byRisk[risk] === undefined) {
        throw new PolicyLoadError(`defaults.${level} is missing risk class "${risk}"`);
      }
      cells[risk] = asDecision(byRisk[risk], `defaults.${level}.${risk}`);
    }
    defaults[level] = cells;
  }
  return defaults;
}

function parseOverrides(raw: unknown): PolicyData["overrides"] {
  if (raw === undefined) {
    return {};
  }
  const obj = asRecord(raw, "overrides");
  const overrides: Record<string, Partial<Record<AutonomyLevel, Decision>>> = {};
  for (const [opName, byLevelRaw] of Object.entries(obj)) {
    const byLevel = asRecord(byLevelRaw, `overrides.${opName}`);
    const parsed: Partial<Record<AutonomyLevel, Decision>> = {};
    for (const [level, decision] of Object.entries(byLevel)) {
      if (!KNOWN_LEVELS.includes(level as AutonomyLevel)) {
        throw new PolicyLoadError(
          `overrides.${opName} has unknown autonomy level ${JSON.stringify(level)}`,
        );
      }
      parsed[level as AutonomyLevel] = asDecision(decision, `overrides.${opName}.${level}`);
    }
    overrides[opName] = parsed;
  }
  return overrides;
}

/**
 * Parse and validate a policy from YAML text. Pure (no I/O), so it is the
 * unit-testable heart of the loader. Throws {@link PolicyLoadError} on the first
 * problem it finds.
 */
export function parsePolicy(yamlText: string): PolicyData {
  const root = asRecord(parse(yamlText), "document root");
  return {
    defaults: parseDefaults(root.defaults),
    overrides: parseOverrides(root.overrides),
  };
}

/**
 * Decide what to do with an operation. A per-op override wins; otherwise the
 * default for (level, risk) applies; and anything the policy does not cover is
 * denied — fail-closed.
 */
export function decide(
  policyData: PolicyData,
  level: AutonomyLevel,
  risk: RiskClass,
  opName: string,
): Decision {
  const override = policyData.overrides[opName]?.[level];
  if (override !== undefined) {
    return override;
  }
  return policyData.defaults[level]?.[risk] ?? "deny";
}

/** Policy file location. Override with WARD_POLICY_FILE (e.g. in tests). */
const POLICY_PATH =
  process.env.WARD_POLICY_FILE ?? fileURLToPath(new URL("../../policy.yaml", import.meta.url));

/**
 * The loaded, validated policy. Evaluated at import time, so a malformed
 * policy.yaml throws here — before the server can register any tools.
 */
export const policy: PolicyData = parsePolicy(readFileSync(POLICY_PATH, "utf8"));
