import {
  MODEL_TRIPLE_KEYS,
  THINKING_LEVELS,
} from "./config-schema.js";
import { allRoleIds } from "../roles.js";
import { truncate, isNonBlankString } from "../text.js";

/** The generic field-check machinery behind validateConfig (config-validation.ts): error
 * message rendering (show, typeName), the unknown-key and known-role guards, the NumberRule
 * table, and the per-field type checkers. Extracted from config-validation.ts — which keeps
 * the section-by-section rules and the cross-field checks and stays the one export gate
 * (validateConfig) — so the machinery the sections share has one home beside the rule
 * table it applies. Every checker collects into the caller's `problems` array rather than
 * throwing, so one load reports every problem in the file. */

/** The longest value rendered in an error message. A wrongly-typed section (the whole `roles`
 * object under `autoRestart`, say) would otherwise dump kilobytes into a message meant to be
 * read at a glance; the cut goes through text.ts's surrogate-safe truncate, so it never emits a
 * lone surrogate and always ends in an ellipsis. */
const SHOW_MAX_CHARS = 120;

/** Render a value for an error message. `undefined` reads as "missing" (the key is absent) and a
 * non-finite number is spelled out: JSON.stringify renders Infinity and NaN as "null", which
 * names a value the user never wrote (a numeric literal past ~1.8e308 parses to Infinity), and
 * that null is exactly the misreading a validation error exists to prevent. Anything longer than
 * SHOW_MAX_CHARS is truncated so the message stays one readable line. */
export function show(v: unknown): string {
  if (v === undefined) return "missing";
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return truncate(JSON.stringify(v) ?? String(v), SHOW_MAX_CHARS);
}

/** JSON type name for top-level error messages ("an array", "null", "string", …). */
export function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

/** Collect the keys present in `obj` but not in `known` into problems, naming where they
 * were found and listing what is valid so one edit fixes them. */
export function checkKnownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key))
      problems.push(`unknown key "${key}" in ${where} (valid keys: ${known.join(", ")})`);
  }
}

/** The numeric shapes a tumwater.json field must satisfy, each bundled with the wording its
 * violation reports — one definition per shape, so a predicate and the text explaining it
 * cannot drift apart across the fields that share it. */
export interface NumberRule {
  ok: (n: number) => boolean;
  what: string;
}

export const NON_NEGATIVE: NumberRule = { ok: (n) => n >= 0, what: "a number of 0 or more" };
export const NON_NEGATIVE_OR_DISABLED: NumberRule = {
  ok: (n) => n >= 0,
  what: "a number of 0 or more (0 disables)",
};
/** maxDailyCostUsd's rule: like NON_NEGATIVE_OR_DISABLED plus the MAX_SAFE_INTEGER bound
 * checkDailyBudgetUsd applies (BUGS.md 2026-10-02) — a finite-but-unrepresentable cap
 * ("9"×25 → 1e24) is an effectively uncapped budget, so `config set` and the GUI's
 * /api/config-set are refused at the same boundary the TUI's editor enforces. */
export const DOLLAR_CAP: NumberRule = {
  ok: (n) => n >= 0 && n <= Number.MAX_SAFE_INTEGER,
  what: `a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER} (0 disables)`,
};
export const POSITIVE: NumberRule = { ok: (n) => n > 0, what: "a number greater than 0" };
export const POSITIVE_INTEGER: NumberRule = {
  ok: (n) => Number.isInteger(n) && n >= 1,
  what: "an integer of at least 1",
};
export const AT_LEAST_ONE: NumberRule = { ok: (n) => n >= 1, what: "a number of at least 1" };

/** Shared known-role guard for the per-role config sections (`roles.<id>` entries and
 * `maxDailyCostUsdPerRole.<id>` keys): an id outside the role catalog and customLoops cannot
 * work — a `roles` typo spawns a phantom loop that errors every tick forever; a caps typo
 * silently no-ops the cap — so both reject it here with the valid ids, the same message shape
 * `tumwater logs --role` uses for a bad flag value. Returns true when the id is known. */
export function checkKnownRoleId(
  section: string,
  id: string,
  customNames: ReadonlySet<string>,
  problems: string[],
): boolean {
  if (allRoleIds().includes(id) || customNames.has(id)) return true;
  problems.push(
    `${section}.${id} is not a known role (valid ids: ${[...allRoleIds(), ...customNames].join(", ")})`,
  );
  return false;
}

/** Validate one string field when present. `allowEmpty` defaults true; the model-triple fields
 * pass false — pi.ts skips an empty value when it builds its flags, so `"provider": ""` would
 * be silently ignored and the fleet would quietly fall back to pi's default — and an empty
 * `fallbackModel` field makes fallbackPair drop it, so the fallback never engages. */
export function checkStringField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  allowEmpty = true,
): void {
  if (!(key in obj)) return;
  const v = obj[key];
  if (typeof v !== "string") problems.push(`${prefix}${key} must be a string (got ${show(v)})`);
  else if (!allowEmpty && v.trim() === "")
    problems.push(`${prefix}${key} must not be empty (got ${show(v)})`);
}

/** Every model-override section validates the same provider/model/thinking triple the same
 * way: empty strings are rejected (see checkStringField) and thinking is value-checked —
 * pi only recognizes THINKING_LEVELS and silently drops anything else, so a typo would run
 * the loops at pi's default depth and never say so. */
export function checkModelTripleField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
): void {
  for (const key of MODEL_TRIPLE_KEYS) checkStringField(problems, obj, prefix, key, false);
  const t = obj.thinking;
  if (isNonBlankString(t) && !THINKING_LEVELS.has(t))
    problems.push(
      `${prefix}thinking must be one of ${[...THINKING_LEVELS].join(", ")} (got ${show(t)})`,
    );
}

/** Validate one numeric field against a NumberRule when present. */
export function checkNumberField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  rule: NumberRule,
): void {
  if (!(key in obj)) return;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v) || !rule.ok(v))
    problems.push(`${prefix}${key} must be ${rule.what} (got ${show(v)})`);
}

/** Validate one boolean field when present. */
export function checkBooleanField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
): void {
  if (!(key in obj)) return;
  const v = obj[key];
  if (typeof v !== "boolean")
    problems.push(`${prefix}${key} must be true or false (got ${show(v)})`);
}

/** Validate one array-of-strings field when present. A blank entry has no valid meaning and
 * would otherwise be silently inert: pi.ts passes every `piArgs` element straight to pi's CLI,
 * where an empty string is read as an empty user MESSAGE (pi's args parser pushes any
 * non-flag token, "" included, as a message), and isExemptPath skips a blank
 * `review.exemptPaths` entry so it never matches anything. Its message names the position
 * so one edit removes it. */
export function checkStringArrayField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
): void {
  if (!(key in obj)) return;
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
    problems.push(`${prefix}${key} must be an array of strings (got ${show(v)})`);
    return;
  }
  const arr = v as string[];
  const blankAt = arr.findIndex((s) => s.trim() === "");
  if (blankAt >= 0)
    problems.push(`${prefix}${key}[${blankAt}] must not be blank (got ${show(arr[blankAt])})`);
}