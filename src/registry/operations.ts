import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Operation, OpParam, RiskClass } from "../types.js";

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
 *
 * Parameterized operations (issue #16) keep that invariant while letting the
 * model choose an argument. A `{token}` placeholder in `command`/`precheck` names
 * a declared parameter; that parameter's `allow` list is a fixed enum, and every
 * enum member is charset-validated here exactly like a constant command element.
 * At call time the model may only select an enum member (see {@link
 * resolveOperation}), so a chosen value is indistinguishable from a constant the
 * author wrote — no free-form arguments, and nothing untrusted reaches argv.
 */

const NAME_RE = /^sys_[a-z]+(_[a-z]+)*$/;
const ARG_RE = /^[A-Za-z0-9_.-]+$/;
/** A param name and the {token} that references it, e.g. `image` / `{image}`. */
const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;
/** An argv element that is exactly a placeholder, e.g. `{image}`. Its inner name is captured. */
const PLACEHOLDER_RE = /^\{([a-z][a-z0-9_]*)\}$/;
const RISK_CLASSES: readonly RiskClass[] = ["read-only", "mutating"];

/** Thrown when operations.yaml is malformed or contains an unsafe entry. */
export class OperationLoadError extends Error {
  constructor(message: string) {
    super(`ward: invalid operation registry — ${message}`);
    this.name = "OperationLoadError";
  }
}

/**
 * Thrown when a call's supplied parameters do not satisfy an op's declarations:
 * a missing value, an unexpected key, or a value outside the enum allowlist.
 * Fail-closed — the operation is never resolved, so nothing reaches the executor.
 */
export class ParamResolutionError extends Error {
  constructor(message: string) {
    super(`ward: rejected operation arguments — ${message}`);
    this.name = "ParamResolutionError";
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OperationLoadError(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate an argv array (the same guard for both `command` and the optional
 * `precheck`): a non-empty array whose every element is either a constant
 * matching ARG_RE — so no entry can smuggle in spaces or shell metacharacters —
 * or a `{token}` placeholder referencing a declared parameter. Returns the
 * elements unchanged together with the set of param names the placeholders
 * referenced, so the caller can cross-check them against the declarations.
 * `field` names which array is being checked so the error points at the right place.
 */
function validateArgv(
  value: unknown,
  name: string,
  field: string,
): { argv: string[]; referenced: Set<string> } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OperationLoadError(`${name}.${field} must be a non-empty array`);
  }
  const argv: string[] = [];
  const referenced = new Set<string>();
  for (const part of value) {
    if (typeof part !== "string") {
      throw new OperationLoadError(
        `${name}.${field} has an unsafe argument ${JSON.stringify(part)} — ` +
          `only ${ARG_RE} or a {param} placeholder is allowed`,
      );
    }
    const placeholder = PLACEHOLDER_RE.exec(part);
    if (placeholder !== null) {
      referenced.add(placeholder[1]!);
      argv.push(part);
      continue;
    }
    if (!ARG_RE.test(part)) {
      throw new OperationLoadError(
        `${name}.${field} has an unsafe argument ${JSON.stringify(part)} — ` +
          `only ${ARG_RE} or a {param} placeholder is allowed ` +
          `(no spaces or shell metacharacters)`,
      );
    }
    argv.push(part);
  }
  return { argv, referenced };
}

/**
 * Validate an operation's `params` declarations: a list of {@link OpParam}, each
 * a mapping with a safe `name` and a non-empty `allow` enum whose every member
 * passes the same charset guard as a constant command element. Rejects duplicate
 * param names. Returns the parsed params keyed by name for the caller's
 * cross-checks against the placeholders actually used.
 */
function validateParams(value: unknown, name: string): Map<string, OpParam> {
  if (!Array.isArray(value)) {
    throw new OperationLoadError(`${name}.params must be an array`);
  }
  const params = new Map<string, OpParam>();
  for (const [i, raw] of value.entries()) {
    const obj = asRecord(raw, `${name}.params[${i}]`);
    const paramName = obj.name;
    if (typeof paramName !== "string" || !PARAM_NAME_RE.test(paramName)) {
      throw new OperationLoadError(
        `${name}.params[${i}].name must match ${PARAM_NAME_RE} (got ${JSON.stringify(paramName)})`,
      );
    }
    if (params.has(paramName)) {
      throw new OperationLoadError(`${name}.params has duplicate parameter "${paramName}"`);
    }
    const allowRaw = obj.allow;
    if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
      throw new OperationLoadError(
        `${name}.params.${paramName}.allow must be a non-empty enum (list of allowed values)`,
      );
    }
    const allow: string[] = [];
    for (const member of allowRaw) {
      if (typeof member !== "string" || !ARG_RE.test(member)) {
        throw new OperationLoadError(
          `${name}.params.${paramName}.allow has an unsafe value ${JSON.stringify(member)} — ` +
            `only ${ARG_RE} is allowed (no spaces or shell metacharacters)`,
        );
      }
      allow.push(member);
    }
    params.set(paramName, { name: paramName, allow });
  }
  return params;
}

function validateOperation(raw: unknown, index: number): Operation {
  const obj = asRecord(raw, `operations[${index}]`);
  const { name, risk, command, precheck, params } = obj;

  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new OperationLoadError(
      `operations[${index}].name must match ${NAME_RE} (got ${JSON.stringify(name)})`,
    );
  }
  if (typeof risk !== "string" || !RISK_CLASSES.includes(risk as RiskClass)) {
    throw new OperationLoadError(
      `${name}.risk must be one of [${RISK_CLASSES.join(", ")}] (got ${JSON.stringify(risk)})`,
    );
  }

  const declared = params === undefined ? new Map<string, OpParam>() : validateParams(params, name);

  const cmd = validateArgv(command, name, "command");
  const pre = precheck === undefined ? undefined : validateArgv(precheck, name, "precheck");
  const referenced = new Set([...cmd.referenced, ...(pre?.referenced ?? [])]);

  // Cross-check placeholders against declarations: every {token} used must resolve
  // to a declared param, and every declared param must be referenced — so the
  // command and its parameter list stay in lockstep and there are no dead params.
  for (const used of referenced) {
    if (!declared.has(used)) {
      throw new OperationLoadError(
        `${name} uses placeholder {${used}} but declares no param "${used}"`,
      );
    }
  }
  for (const declaredName of declared.keys()) {
    if (!referenced.has(declaredName)) {
      throw new OperationLoadError(
        `${name} declares param "${declaredName}" but never uses {${declaredName}} in command/precheck`,
      );
    }
  }

  const op: Operation = {
    name,
    risk: risk as RiskClass,
    command: cmd.argv,
    ...(pre !== undefined ? { precheck: pre.argv } : {}),
    ...(declared.size > 0 ? { params: [...declared.values()] } : {}),
  };
  return op;
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

/**
 * Resolve a (possibly parameterized) operation against the model's chosen
 * arguments, producing a concrete operation whose `command`/`precheck` hold no
 * placeholders — ready for the executor or to be carried by a proposal.
 *
 * This is the enforcement point for the enum allowlist: each supplied value must
 * be a member of its param's `allow` enum, every declared param must be supplied,
 * and no unexpected key is accepted. An op with no params accepts (and requires)
 * an empty argument set and is returned unchanged.
 *
 * Defense in depth: even though `allow` members were charset-validated at load
 * time, every substituted value is re-checked against ARG_RE here, so a chosen
 * value can never be anything but a safe argv element. The executor asserts the
 * same on the final argv — two independent checks guarding the same invariant.
 */
export function resolveOperation(op: Operation, args: Record<string, unknown> = {}): Operation {
  const params = op.params ?? [];

  for (const key of Object.keys(args)) {
    if (!params.some((p) => p.name === key)) {
      throw new ParamResolutionError(`${op.name} has no parameter "${key}"`);
    }
  }

  const chosen = new Map<string, string>();
  for (const param of params) {
    const value = args[param.name];
    if (value === undefined) {
      throw new ParamResolutionError(`${op.name} requires parameter "${param.name}"`);
    }
    if (typeof value !== "string" || !param.allow.includes(value)) {
      throw new ParamResolutionError(
        `${op.name}.${param.name} must be one of [${param.allow.join(", ")}] ` +
          `(got ${JSON.stringify(value)})`,
      );
    }
    if (!ARG_RE.test(value)) {
      // Unreachable for a loaded op (load-time charset guard), but asserted anyway:
      // resolution must never let anything but a safe argv element through.
      throw new ParamResolutionError(
        `${op.name}.${param.name} value ${JSON.stringify(value)} is unsafe`,
      );
    }
    chosen.set(param.name, value);
  }

  const substitute = (argv: readonly string[]): string[] =>
    argv.map((part) => {
      const placeholder = PLACEHOLDER_RE.exec(part);
      return placeholder === null ? part : chosen.get(placeholder[1]!)!;
    });

  // A resolved op carries no params (its placeholders are gone), so the result is
  // built fresh rather than spreading `op` — nothing to drop, nothing left over.
  return {
    name: op.name,
    risk: op.risk,
    command: substitute(op.command),
    ...(op.precheck !== undefined ? { precheck: substitute(op.precheck) } : {}),
  };
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
