import {
  MODEL_TRIPLE_KEYS,
  MODEL_TIERS,
  TIER_MAP_KEYS,
  THINKING_LEVELS,
} from "./config-schema.js";
import { allRoleIds } from "../roles/roles.js";
import { isJsonObject } from "../files/json-object.js";
import { didYouMean, suggestClosest, typoSuffix } from "../text/suggest.js";
import { truncate, isNonBlankString } from "../text/text.js";

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
 * were found and listing what is valid so one edit fixes them, plus the shared did-you-mean
 * annotation for a near miss (a `maxDailyCostUss` typo reads the same hint `tumwater config
 * set` prints). */
export function checkKnownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key))
      problems.push(
        `unknown key "${key}" in ${where} (valid keys: ${known.join(", ")})${typoSuffix(key, known)}${
          key === "agent" ? ' — "agent" is retired, write "backend"' : ""
        }`,
      );
  }
}

/** Read an optional field once and hand it to `check` — the rule every per-field checker and
 * checkObjectSection share: a key absent from the raw file is not validated here (its type's
 * default fills it later), while a present one is read and checked exactly once. One home of
 * that guard, so no checker can drift into reporting a missing key as a wrong value. */
function whenPresent(
  obj: Record<string, unknown>,
  key: string,
  check: (value: unknown) => void,
): void {
  if (!(key in obj)) return;
  check(obj[key]);
}

/** Run a section's rule body only when its optional key is a plain JSON object: an absent key
 * leaves everything alone, present-but-not-an-object reports the one type problem against the
 * key (through show) and skips the body, and an object hands off to `validate` — so a
 * wrongly-typed section cannot also make every field under it report a second error. The one
 * home of the present→object→validate shape the check, idleBackoff, review, and fallbackModel
 * sections share. */
export function checkObjectSection(
  root: Record<string, unknown>,
  key: string,
  problems: string[],
  validate: (obj: Record<string, unknown>) => void,
): void {
  whenPresent(root, key, (value) => {
    if (!isJsonObject(value)) {
      problems.push(`${key} must be an object (got ${show(value)})`);
      return;
    }
    validate(value);
  });
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

/** The upper bound every seconds field that feeds a ×1000 duration shares: 2147483 s
 * × 1000 stays inside node's signed-32-bit setTimeout/setInterval range (2^31−1 ms,
 * about 24.8 days). Above it node clamps the delay to 1ms — a one-zero typo like
 * `"runTimeoutSeconds": 1e300` became Infinity ms, and every pi run died the moment it
 * started (BUGS.md 2026-10-03). One home for the bound, shared by the config schema's
 * duration rules (config-validation.ts) and checkMinRunInterval (config-keys.ts), so the
 * dashboard's interval editor cannot drift from the schema's bound. */
export const MAX_DURATION_SECONDS = 2147483;

/** Shared known-role guard for the per-role config sections (`roles.<id>` entries and
 * `maxDailyCostUsdPerRole.<id>` keys): an id outside the role catalog and customRoles cannot
 * work — a `roles` typo spawns a phantom role that errors every run forever; a caps typo
 * silently no-ops the cap — so both reject it here with the valid ids, the same message shape
 * `tumwater logs --transcript` uses for a bad flag value. Returns true when the id is known. */
export function checkKnownRoleId(
  section: string,
  id: string,
  customNames: ReadonlySet<string>,
  problems: string[],
): boolean {
  if (allRoleIds().includes(id) || customNames.has(id)) return true;
  const validIds = [...allRoleIds(), ...customNames];
  problems.push(
    `${section}.${id} is not a known role (valid ids: ${validIds.join(", ")})${typoSuffix(id, validIds)}`,
  );
  return false;
}

/** Validate one string field when present. `allowEmpty` defaults true; the model-triple fields
 * pass false — pi-args.ts skips an empty value when it builds its flags, so `"provider": ""`
 * would be silently ignored and the team would quietly fall back to pi's default — and an
 * empty `fallbackModel` field makes fallbackPair drop it, so the fallback never engages. */
export function checkStringField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  allowEmpty = true,
): void {
  whenPresent(obj, key, (v) => {
    if (typeof v !== "string") problems.push(`${prefix}${key} must be a string (got ${show(v)})`);
    else if (!allowEmpty && v.trim() === "")
      problems.push(`${prefix}${key} must not be empty (got ${show(v)})`);
  });
}

function checkModelSiblingFields(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
): void {
  for (const key of MODEL_TRIPLE_KEYS)
    if (key !== "model") checkStringField(problems, obj, prefix, key, false);
  const t = obj.thinking;
  if (isNonBlankString(t) && !THINKING_LEVELS.has(t))
    problems.push(
      `${prefix}thinking must be one of ${[...THINKING_LEVELS].join(", ")} (got ${show(t)})${typoSuffix(t, [...THINKING_LEVELS])}`,
    );
}

function checkTierMapModel(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  m: Record<string, unknown>,
): void {
  checkKnownKeys(m, TIER_MAP_KEYS, `${prefix}model`, problems);
  if (obj.provider !== undefined)
    problems.push(
      `${prefix}model as a map by tier cannot coexist with ${prefix ? prefix : "the legacy top-level "}provider — move the provider into each tier's model id (got provider ${show(obj.provider)})`,
    );
  for (const [tier, v] of Object.entries(m))
    // An object entry (`{ backend?, model?, thinking? }`) is validated by validateConfig.
    if (!isNonBlankString(v) && !isJsonObject(v))
      problems.push(
        `${prefix}model.${tier} must be a non-empty model id (got ${show(v)})`,
      );
}

function whatModelMustBe(modelShape: "selector" | "tier-map" | "tier-name"): string {
  return modelShape === "tier-map"
    ? "a model id or a map by tier (small, default, strong)"
    : modelShape === "tier-name"
      ? "a model id or a tier name (small, default, strong)"
      : "a string";
}

function checkStringModel(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  m: unknown,
  modelShape: "selector" | "tier-map" | "tier-name",
): void {
  if (typeof m !== "string") {
    problems.push(`${prefix}model must be ${whatModelMustBe(modelShape)} (got ${show(m)})`);
    return;
  }
  if (m.trim() === "") {
    problems.push(`${prefix}model must not be empty (got ${show(m)})`);
    return;
  }
  if ((MODEL_TIERS as readonly string[]).includes(m)) {
    if (modelShape === "tier-name") return; // A valid tier reference.
    problems.push(
      `${prefix}model must name a model id — tier names are valid only as roles.<id>.model or review.model values (got ${show(m)})`,
    );
    return;
  }
  if (modelShape === "tier-name" && !m.includes("/") && obj.provider === undefined)
    suggestTierFix(problems, prefix, m);
}

function suggestTierFix(problems: string[], prefix: string, m: string): void {
  const tier = suggestClosest(m, MODEL_TIERS);
  if (tier !== null)
    problems.push(
      `${prefix}model ${show(m)} is not a tier name or a model id pi can resolve${didYouMean(tier)}`,
    );
}

/** Every model-override section validates the same provider/model/thinking triple the same
 * way: empty strings are rejected (see checkStringField) and thinking is value-checked —
 * pi only recognizes THINKING_LEVELS and silently drops anything else, so a typo would run
 * the roles at pi's default depth and never say so.
 *
 * `modelShape` widens `model` per plans/model-tiers.md: "selector" (the default, for the
 * legacy `fallbackModel` object) keeps it a plain selector string; "tier-map" (top level)
 * also accepts a map whose keys are exactly the three tiers and whose values are non-empty
 * selector strings — a map cannot coexist with a legacy provider in the same section, since
 * the provider's old meaning (the whole string is a bare id under it) has no per-tier
 * reading; "tier-name" (roles.<id>.model, review.model) also accepts a bare tier name as a
 * reference into the top-level map. A bare value within two edits of a tier name (ignoring
 * case) is rejected as a misspelled tier reference. Tier names are valid ONLY where a tier
 * reference means something: elsewhere (top level, fallbackModel) one is rejected with the two
 * places that accept it, so a misplaced `"model": "strong"` is an error naming its fix instead of a
 * bare model pattern pi can never resolve. */
export function checkModelTripleField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  modelShape: "selector" | "tier-map" | "tier-name" = "selector",
): void {
  checkModelSiblingFields(problems, obj, prefix);
  const m = obj.model;
  if (m === undefined) return;
  if (modelShape === "tier-map" && isJsonObject(m)) {
    checkTierMapModel(problems, obj, prefix, m);
    return;
  }
  checkStringModel(problems, obj, prefix, m, modelShape);
}

/** Validate one numeric field against a NumberRule when present. */
export function checkNumberField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  rule: NumberRule,
): void {
  whenPresent(obj, key, (v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || !rule.ok(v))
      problems.push(`${prefix}${key} must be ${rule.what} (got ${show(v)})`);
  });
}

/** Validate one boolean field when present. */
export function checkBooleanField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
): void {
  whenPresent(obj, key, (v) => {
    if (typeof v !== "boolean")
      problems.push(`${prefix}${key} must be true or false (got ${show(v)})`);
  });
}

/** Validate one array-of-strings field when present. A blank entry has no valid meaning and
 * would otherwise be silently inert: pi-args.ts passes every `piArgs` element straight to pi's
 * CLI, where an empty string is read as an empty user MESSAGE (pi's args parser pushes any
 * non-flag token, "" included, as a message), and isExemptPath skips a blank
 * `review.exemptPaths` entry so it never matches anything. Its message names the position
 * so one edit removes it. */
export function checkStringArrayField(
  problems: string[],
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
): void {
  whenPresent(obj, key, (v) => {
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      problems.push(`${prefix}${key} must be an array of strings (got ${show(v)})`);
      return;
    }
    const arr = v;
    const blankAt = arr.findIndex((s) => s.trim() === "");
    if (blankAt >= 0)
      problems.push(`${prefix}${key}[${blankAt}] must not be blank (got ${show(arr[blankAt])})`);
  });
}

/** Report every passthrough arg in `args` whose flag the harness sets itself — the one screen
 * behind both of validateConfig's reserved-flag checks (top-level `piArgs` and each
 * `backends.<id>.args`). `argsPath` names the array in the message (`piArgs`, `backends.pi.args`),
 * and `whyFor` resolves the flag's reason against the reserved set it is screened against, or
 * undefined when the flag is not reserved. The flag is matched even when the arg carries its
 * value as `--flag=value` (split on the first `=`), so that joined spelling cannot slip past
 * and be appended last. An arg that is not a string is skipped: checkStringArrayField has
 * already reported it. */
export function checkReservedArgs(
  problems: string[],
  args: readonly unknown[],
  argsPath: string,
  whyFor: (flag: string) => string | undefined,
): void {
  args.forEach((arg, i) => {
    if (typeof arg !== "string") return;
    const why = whyFor(arg.split("=", 1)[0] as string);
    if (why) problems.push(`${argsPath}[${i}] ${show(arg)} duplicates a flag tumwater sets — ${why}`);
  });
}

/** The config <key> a `-c <key>=…` / `--config <key>=…` / `-c<key>=…` / `-c=<key>=…` /
 * `--config=<key>=…` argv element names, or undefined when the element is not a keyed codex
 * config passthrough. Codex takes the key and value in one token (`-c key=value`), and accepts a
 * joined `-c=<key>=<value>` identically to `-c <key>=<value>`; `-c` and `--config` alone are
 * followed by the `<key>=<value>` token as the next element, so the scanner passes both. Kept
 * here beside its one caller (the codex `backends.args` screen); the tokens actually split by
 * checkReservedArgs cannot see this form, which is why the scan is its own loop. */
export function codexConfigKey(arg: string, next: string | undefined): string | undefined {
  let rest: string | undefined;
  if (arg === "-c" || arg === "--config") rest = next;
  else if (arg.startsWith("--config=")) rest = arg.slice("--config=".length);
  else if (arg.startsWith("-c=")) rest = arg.slice(3);
  else if (arg.startsWith("-c") && arg.length > 2 && !arg.startsWith("--")) rest = arg.slice(2);
  if (rest === undefined) return undefined;
  const eq = rest.indexOf("=");
  const key = (eq === -1 ? rest : rest.slice(0, eq)).trim();
  return key === "" ? undefined : key;
}
