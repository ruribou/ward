import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { config } from "../config.js";
import type { Locale } from "../types.js";

/**
 * UI text loader. Every human/LLM-facing string — operation titles and
 * descriptions (keyed `ops.<name>`) and the approval-gate messages — lives in
 * i18n/labels_<locale>.yaml as a nested key tree, kept separate from the
 * operation registry (structure) and the code. This resolves a dot-path key for
 * the active locale and substitutes {var} placeholders. Adding a language is a
 * new label file plus a Locale entry — no change here or in the server.
 */

const cache = new Map<Locale, Record<string, unknown>>();

function load(locale: Locale): Record<string, unknown> {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const path = fileURLToPath(new URL(`../../i18n/labels_${locale}.yaml`, import.meta.url));
  const data = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  cache.set(locale, data);
  return data;
}

function resolveKey(data: Record<string, unknown>, key: string): unknown {
  let current: unknown = data;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : value;
  });
}

/** Resolve a label by dot-path key; throws if it is missing (a missing UI string is a bug). */
export function getLabel(
  key: string,
  locale: Locale = config.lang,
  vars?: Record<string, string>,
): string {
  const value = resolveKey(load(locale), key);
  if (typeof value !== "string") {
    throw new Error(`ward i18n: missing label "${key}" for locale "${locale}"`);
  }
  return vars === undefined ? value : applyVars(value, vars);
}

/** Resolve a label, falling back to a default when the key is absent (never throws). */
export function getLabelOr(key: string, fallback: string, locale: Locale = config.lang): string {
  const value = resolveKey(load(locale), key);
  return typeof value === "string" ? value : fallback;
}

/** Clear the per-locale cache. For tests. */
export function _resetLabelCache(): void {
  cache.clear();
}
