import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Operation, RiskClass } from "../types.js";

/**
 * The capability registry is declared in operations.yaml (the single source of
 * truth for "what ward can do") and loaded + validated here. Adding a capability
 * is a YAML edit — a reviewable diff — not a code change.
 *
 * The validation below is a *runtime guardrail*, not a convenience: because the
 * YAML is hand-written, this loader is what keeps the injection invariant true.
 * Anything malformed (unknown risk class, a command argument containing a shell
 * metacharacter, a duplicate name, …) makes loading throw, so the server fails
 * closed — it never starts with an unsafe operation in its registry.
 *
 * `command` is validated to a strict charset so that even though a human types
 * the YAML, no entry can smuggle in spaces or shell metacharacters (; | $ ( ) `).
 * Combined with execFile (no shell) in the executor, there is no command or
 * argument injection surface.
 */

const NAME_RE = /^nuc_[a-z]+$/;
const ARG_RE = /^[A-Za-z0-9_.-]+$/;
const RISK_CLASSES: readonly RiskClass[] = ["read-only", "mutating"];

/** Thrown when operations.yaml is malformed or contains an unsafe entry. */
export class OperationLoadError extends Error {
  constructor(message: string) {
    super(`ward: invalid operation registry — ${message}`);
    this.name = "OperationLoadError";
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OperationLoadError(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function validateOperation(raw: unknown, index: number): Operation {
  const obj = asRecord(raw, `operations[${index}]`);
  const { name, title, description, risk, command } = obj;

  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new OperationLoadError(
      `operations[${index}].name must match ${NAME_RE} (got ${JSON.stringify(name)})`,
    );
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new OperationLoadError(`${name}.title must be a non-empty string`);
  }
  if (typeof description !== "string" || description.length === 0) {
    throw new OperationLoadError(`${name}.description must be a non-empty string`);
  }
  if (typeof risk !== "string" || !RISK_CLASSES.includes(risk as RiskClass)) {
    throw new OperationLoadError(
      `${name}.risk must be one of [${RISK_CLASSES.join(", ")}] (got ${JSON.stringify(risk)})`,
    );
  }
  if (!Array.isArray(command) || command.length === 0) {
    throw new OperationLoadError(`${name}.command must be a non-empty array`);
  }

  const argv: string[] = [];
  for (const part of command) {
    if (typeof part !== "string" || !ARG_RE.test(part)) {
      throw new OperationLoadError(
        `${name}.command has an unsafe argument ${JSON.stringify(part)} — ` +
          `only ${ARG_RE} is allowed (no spaces or shell metacharacters)`,
      );
    }
    argv.push(part);
  }

  return { name, title, description, risk: risk as RiskClass, command: argv };
}

/**
 * Parse and validate an operation registry from YAML text. Pure (no I/O), so it
 * is the unit-testable heart of the loader. Throws {@link OperationLoadError} on
 * the first problem it finds.
 */
export function parseOperations(yamlText: string): Operation[] {
  const root = asRecord(parse(yamlText), "document root");
  const list = root.operations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new OperationLoadError("`operations` must be a non-empty array");
  }

  const ops = list.map(validateOperation);

  const names = ops.map((o) => o.name);
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (duplicates.length > 0) {
    throw new OperationLoadError(`duplicate operation name(s): ${duplicates.join(", ")}`);
  }

  return ops;
}

/** Registry file location. Override with WARD_OPERATIONS_FILE (e.g. in tests). */
const REGISTRY_PATH =
  process.env.WARD_OPERATIONS_FILE ??
  fileURLToPath(new URL("../../operations.yaml", import.meta.url));

/**
 * The loaded, validated registry. Evaluated at import time, so a malformed
 * operations.yaml throws here — before the server can register any tools.
 */
export const operations: readonly Operation[] = parseOperations(
  readFileSync(REGISTRY_PATH, "utf8"),
);
