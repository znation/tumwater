/** The per-role and cross-field section rules of tumwater.json validation: the `customRoles`
 * collect-and-check block, the `roles.<id>` entry block, `review.afterMerge`'s name check,
 * the per-role daily cost caps and quiet hours, `maxConcurrentPerProvider`,
 * `claudeWindowReserve` and its mutually-exclusive spelling pair, and the `idleBackoff`
 * cross-field pair. Extracted from the single validateConfig gate (config-validation.ts) so a
 * per-role or cross-field edit lands as a per-theme diff instead of a whole-gate one; this
 * module runs once, at the gate's end, after every other section has appended its problems,
 * so the overall problem order is unchanged. These rules sit on top of the generic machinery
 * in config-field-checks.ts; the helpers passed in are the closures the gate binds once (the
 * problems-bound checkers and the shared model-triple/window-reserve sequences), and the
 * cross-cutting `customNames` set — collected in the customRoles block, consumed by the
 * roles.<id>, afterMerge, cap and quiet-hour blocks — is owned here, so validateConfig
 * passes no set across the boundary. */

import {
  CUSTOM_ROLE_KEYS,
  CUSTOM_NAME_RE,
  CUSTOM_TASK_MAX_CHARS,
  ROLE_ENTRY_KEYS,
  ROLE_INSTRUCTIONS_MAX_CHARS,
} from "./config-schema.js";
import { DIRECTOR_ROLE, allRoleIds } from "../roles/roles.js";
import { INSTANCE_ROLES, baseRoleOf } from "../roles/runner-ids.js";
import { isJsonObject } from "../files/json-object.js";
import { isNonBlankString } from "../text/text.js";
import { parseQuietHours } from "../scheduling/quiet-hours.js";
import { TUMWATER_SOURCE } from "../events/events.js";
import {
  DOLLAR_CAP,
  MAX_DURATION_SECONDS,
  POSITIVE_INTEGER,
  type NumberRule,
  checkKnownKeys,
  checkKnownRoleId,
  checkNumberField,
  show,
} from "./config-field-checks.js";

const DURATION_NON_NEGATIVE: NumberRule = {
  ok: (n) => n >= 0 && n <= MAX_DURATION_SECONDS,
  what: `a number of 0 or more, at most ${MAX_DURATION_SECONDS}`,
};

/** A per-role instance count (`roles.feature.instances`): an integer from 1 to 8. Bounded so
 * a typo like `instances: 800` cannot spawn hundreds of runners, and integer so
 * `feature-1.5` — which no role id can name — is refused. */
const INSTANCE_COUNT: NumberRule = {
  ok: (n) => Number.isInteger(n) && n >= 1 && n <= 8,
  what: "an integer from 1 to 8",
};

/** Validate one per-role map section (`maxDailyCostUsdPerRole`, `quietHoursPerRole`): the
 * value must be an object mapping role ids to entries, every key must name a known role
 * (checkKnownRoleId's guard — a typo'd id would silently no-op the section), and each entry
 * goes through `checkValue` with its role id. `expectation` is the value description the
 * type-error message quotes. One home for the section shape the two dotted per-role keys
 * share, so a third per-role map reuses it instead of re-copying the loop. */
function checkPerRoleMap(
  r: Record<string, unknown>,
  key: string,
  expectation: string,
  customNames: ReadonlySet<string>,
  problems: string[],
  checkValue: (id: string, value: unknown) => void,
): void {
  if (!(key in r)) return;
  const map = r[key];
  if (!isJsonObject(map)) {
    problems.push(`${key} must be an object mapping role ids to ${expectation} (got ${show(map)})`);
    return;
  }
  for (const [id, value] of Object.entries(map)) {
    if (!checkKnownRoleId(key, id, customNames, problems)) continue;
    checkValue(id, value);
  }
}

/** The closures the gate binds once and hands to the per-role and cross-field block: the
 * problems-bound field checkers and the shared model-triple/window-reserve sequences. */
interface RolesCrossFieldHelpers {
  checkString: (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    allowEmpty?: boolean,
  ) => void;
  checkBoolean: (obj: Record<string, unknown>, prefix: string, key: string) => void;
  checkNumber: (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    rule: NumberRule,
  ) => void;
  checkPromptLength: (label: string, value: unknown, max: number) => void;
  checkModelTripleEntry: (o: Record<string, unknown>, at: string, atBase: string) => void;
  checkWindowReserve: (label: string, value: unknown) => void;
}

/** Validate the per-role and cross-field sections that close the gate: `customRoles`, the
 * `roles.<id>` entries, `review.afterMerge`'s role names, the per-role caps and quiet hours,
 * `maxConcurrentPerProvider`, `claudeWindowReserve` and the `idleBackoff` cross-field pair,
 * each appended to `problems` in the order the gate produced. The single call site in
 * validateConfig is the point where these problems were appended, so the order across the
 * whole pass is unchanged. */
export function validateRolesAndCrossField(
  r: Record<string, unknown>,
  problems: string[],
  helpers: RolesCrossFieldHelpers,
): void {
  const customNames = validateCustomRoles(r, problems, helpers);
  validateRoleEntries(r, problems, helpers, customNames);
  validateReviewAfterMerge(r, problems, customNames);
  validatePerRoleCostCaps(r, problems, customNames);
  validatePerRoleQuietHours(r, problems, customNames);
  validateMaxConcurrentPerProvider(r, problems);
  validateClaudeWindowReserve(r, problems, helpers);
  validateIdleBackoff(r, problems);
}

/** Collect the `customRoles` names and refuse this block's bad shapes, appending to
 * `problems` and returning the set of accepted names for the later per-role sections. Names
 * become worktree dirs and git refs (plans/user-defined-loops.md), so they are validated
 * strictly — a colliding name would silently shadow a built-in's prompt (roleById wins in
 * runPrompt), validation makes that impossible instead of subtle. The collected names feed
 * the roles cross-check: an id under `roles` is valid when it is in the catalog OR listed as
 * a customRoles name. */
function validateCustomRoles(
  r: Record<string, unknown>,
  problems: string[],
  helpers: RolesCrossFieldHelpers,
): Set<string> {
  const { checkPromptLength } = helpers;
  const customNames = new Set<string>();
  if ("customRoles" in r) {
    const cl = r.customRoles;
    if (!Array.isArray(cl)) {
      problems.push(`customRoles must be an array of { name, task } entries (got ${show(cl)})`);
    } else {
      cl.forEach((entry, i) => {
        const where = `customRoles[${i}]`;
        if (!isJsonObject(entry)) {
          problems.push(`${where} must be an object with keys name and task (got ${show(entry)})`);
          return;
        }
        checkKnownKeys(entry, CUSTOM_ROLE_KEYS, where, problems);
        const name = entry.name;
        if (typeof name !== "string") {
          problems.push(
            `${where}.name must be a string matching /^[a-z0-9][a-z0-9_-]{0,31}$/ (got ${show(name)})`,
          );
        } else if (!CUSTOM_NAME_RE.test(name)) {
          problems.push(
            `${where}.name "${name}" is not a valid role name: start with a lowercase letter or digit, then at most 31 more of [a-z0-9_-]`,
          );
        } else if (name === TUMWATER_SOURCE) {
          problems.push(
            `${where}.name "${name}" is reserved: events tumwater writes about itself carry that source, so a role's events would be indistinguishable from them — pick another name`,
          );
        } else if (allRoleIds().includes(name)) {
          problems.push(`${where}.name "${name}" collides with a built-in role id — pick another name`);
        } else if (baseRoleOf(name) !== name) {
          problems.push(
            `${where}.name "${name}" would shadow the ${baseRoleOf(name)} role's instance ids — pick another name`,
          );
        } else if (customNames.has(name)) {
          problems.push(`${where}.name "${name}" is duplicated in customRoles — names must be unique`);
        } else {
          customNames.add(name);
        }
        const task = entry.task;
        // A whitespace-only task is as inert as an empty one — it rides into every one of
        // this role's run prefills as blank text, so the role has nothing to do and runs
        // no_change forever. Reject both shapes with the same message; the model-triple
        // checkString rule uses the same trim-based emptiness test.
        if (!isNonBlankString(task)) {
          problems.push(`${where}.task must be a non-empty string (got ${show(task)})`);
        } else {
          checkPromptLength(`${where}.task`, task, CUSTOM_TASK_MAX_CHARS);
        }
      });
    }
  }
  return customNames;
}

/** Validate the `roles.<id>` entry block: the object shape, `checkKnownRoleId`, the per-entry
 * settings checks, and the INSTANCE_ROLES instances rule. */
function validateRoleEntries(
  r: Record<string, unknown>,
  problems: string[],
  helpers: RolesCrossFieldHelpers,
  customNames: ReadonlySet<string>,
): void {
  const { checkString, checkBoolean, checkNumber, checkPromptLength, checkModelTripleEntry } = helpers;
  if ("roles" in r) {
    const roles = r.roles;
    if (!isJsonObject(roles)) {
      problems.push(`roles must be an object mapping role ids to settings (got ${show(roles)})`);
    } else {
      for (const [id, rc] of Object.entries(roles)) {
        // An id outside the catalog and customRoles cannot work: runPrompt has no prompt for
        // it and the role would error every run forever (checkKnownRoleId).
        if (!checkKnownRoleId("roles", id, customNames, problems)) continue;
        if (!isJsonObject(rc)) {
          problems.push(`roles.${id} must be an object (got ${show(rc)})`);
          continue;
        }
        const o = rc;
        checkKnownKeys(o, ROLE_ENTRY_KEYS, `roles.${id}`, problems);
        // Empty is a deliberate "no extra instructions". A non-empty value rides into every
        // one of this role's run prefills, so it is capped like a custom role's task.
        checkString(o, `roles.${id}.`, "instructions");
        checkPromptLength(`roles.${id}.instructions`, o.instructions, ROLE_INSTRUCTIONS_MAX_CHARS);
        checkModelTripleEntry(o, `roles.${id}.`, `roles.${id}`);
        checkBoolean(o, `roles.${id}.`, "enabled");
        checkNumber(o, `roles.${id}.`, "minRunIntervalSeconds", DURATION_NON_NEGATIVE);
        // Only feature and bugfix may split (src/roles/runner-ids.ts INSTANCE_ROLES); an
        // instances count under any other role would never spawn a runner, so reject it
        // rather than let the operator believe it did something.
        if ("instances" in o && !INSTANCE_ROLES.has(id)) {
          problems.push(
            `roles.${id}.instances is only valid for ${[...INSTANCE_ROLES].join(" and ")} (got ${show(o.instances)})`,
          );
        } else {
          checkNumber(o, `roles.${id}.`, "instances", INSTANCE_COUNT);
        }
      }
    }
  }
}

/** Validate `review.afterMerge`'s role names: a typo'd id would silently keep that role
 * reviewed before merging; the director is refused because its changes always merge on a
 * review first. */
function validateReviewAfterMerge(
  r: Record<string, unknown>,
  problems: string[],
  customNames: ReadonlySet<string>,
): void {
  if (isJsonObject(r.review) && Array.isArray(r.review.afterMerge)) {
    r.review.afterMerge.forEach((id: unknown, i) => {
      if (typeof id !== "string" || id.trim() === "") return; // Already reported by checkStringArray.
      if (id === DIRECTOR_ROLE) problems.push(`review.afterMerge[${i}] must not be "${DIRECTOR_ROLE}" — its changes are always reviewed before merging`);
      else checkKnownRoleId("review.afterMerge", id, customNames, problems);
    });
  }
}

/** Validate the per-role daily cost caps (src/gates/role-cap-gates.ts): each key must name a
 * known role — built-in or customRoles — because a typo'd id would silently no-op the cap,
 * the exact silent-ignore class the `roles.<id>` check exists to prevent (the customNames set
 * is fully collected by this point, so a custom role can be capped). Each value is a spend
 * threshold with the NON_NEGATIVE_OR_DISABLED semantics: 0 disables that role's cap. */
function validatePerRoleCostCaps(
  r: Record<string, unknown>,
  problems: string[],
  customNames: ReadonlySet<string>,
): void {
  checkPerRoleMap(r, "maxDailyCostUsdPerRole", "USD caps", customNames, problems, (id) => {
    // Same MAX_SAFE_INTEGER bound as maxDailyCostUsd's DOLLAR_CAP rule (BUGS.md
    // 2026-10-02): a finite-but-unrepresentable per-role cap is an effectively
    // uncapped budget for that role — DOLLAR_CAP is that rule, so the predicate
    // and its wording have one home. checkPerRoleMap narrowed the map, so the cast
    // is sound and checkNumberField sees the entry's value typed as before.
    checkNumberField(
      problems,
      r.maxDailyCostUsdPerRole as Record<string, unknown>,
      "maxDailyCostUsdPerRole.",
      id,
      DOLLAR_CAP,
    );
  });
}

/** Validate the per-role quiet hours (src/scheduling/quiet-hours.ts): the same known-role gate
 * as the caps — a typo'd role id would silently no-op the window. Each value must parse as a
 * quiet-hours window (an empty string means off for that role, the same disablement the
 * team-wide key takes), and the message names the key and the offending id/value verbatim. */
function validatePerRoleQuietHours(
  r: Record<string, unknown>,
  problems: string[],
  customNames: ReadonlySet<string>,
): void {
  checkPerRoleMap(r, "quietHoursPerRole", '"HH:MM-HH:MM" windows', customNames, problems, (id, value) => {
    if (typeof value !== "string") {
      problems.push(
        `quietHoursPerRole.${id} must be a "HH:MM-HH:MM" string like "23:00-07:00" (an empty string means off) (got ${show(value)})`,
      );
      return;
    }
    if (value.trim() === "") return; // empty = off for that role
    const parsed = parseQuietHours(value, `quietHoursPerRole.${id}`);
    if (!parsed.ok) problems.push(parsed.error);
  });
}

/** Validate per-provider concurrency caps (plans/provider-concurrency.md §1): a map from
 * provider key to a positive integer. Unlike the per-role maps, an unknown provider name is
 * NOT a validation error — providers live in pi's models.json, which validation does not
 * read, and a fallback's provider may only come into use later (doctor warns in part 5/5).
 * Each value must be a positive integer under a non-empty key. */
function validateMaxConcurrentPerProvider(
  r: Record<string, unknown>,
  problems: string[],
): void {
  if (r.maxConcurrentPerProvider !== undefined) {
    const map = r.maxConcurrentPerProvider;
    if (!isJsonObject(map)) {
      problems.push(
        `maxConcurrentPerProvider must be an object mapping provider names to concurrency caps (got ${show(map)})`,
      );
    } else {
      for (const [provider, value] of Object.entries(map)) {
        if (provider.trim() === "") {
          problems.push(`maxConcurrentPerProvider.<empty> — a provider key must not be empty`);
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || !POSITIVE_INTEGER.ok(value)) {
          problems.push(
            `maxConcurrentPerProvider.${provider} must be ${POSITIVE_INTEGER.what} (got ${show(value)})`,
          );
        }
      }
    }
  }
}

/** Validate `claudeWindowReserve` (the subscription-window reserve: a map from window type to
 * a fraction, 0 < f <= 1) and its mutually-exclusive spelling pair with
 * `backends.claude.windowReserve`. */
function validateClaudeWindowReserve(
  r: Record<string, unknown>,
  problems: string[],
  helpers: RolesCrossFieldHelpers,
): void {
  const { checkWindowReserve } = helpers;
  // The subscription-window reserve: a map from window type to a fraction, 0 < f <= 1.
  if (r.claudeWindowReserve !== undefined)
    checkWindowReserve("claudeWindowReserve", r.claudeWindowReserve);
  // The reserve's two spellings are mutually exclusive (plans/codex-backend.md part 2b/9): the
  // nested key is the current one; `claudeWindowReserve` is kept as claude's older spelling. A
  // file holding both is ambiguous about which drives the window, so it is rejected naming both.
  if (
    r.claudeWindowReserve !== undefined &&
    isJsonObject(r.backends) &&
    isJsonObject(r.backends.claude) &&
    r.backends.claude.windowReserve !== undefined
  )
    problems.push(
      "claudeWindowReserve and backends.claude.windowReserve set the same value — keep one (backends.claude.windowReserve is the current spelling; claudeWindowReserve is its old name)",
    );
}

/** Validate the `idleBackoff` cross-field pair (judged on the merged config, where both sides
 * are always present; on a raw file only when the file itself names both): scheduleBackoff
 * clamps every idle wait — the first included — to min(initialSeconds, maxSeconds), so a
 * smaller max silently discards the configured initial wait. Name both values so one edit
 * fixes the pair. */
function validateIdleBackoff(r: Record<string, unknown>, problems: string[]): void {
  const backoff = r.idleBackoff;
  if (
    isJsonObject(backoff) &&
    typeof backoff.initialSeconds === "number" &&
    typeof backoff.maxSeconds === "number" &&
    backoff.maxSeconds < backoff.initialSeconds
  )
    problems.push(
      `idleBackoff.maxSeconds (${show(backoff.maxSeconds)}) must be ≥ idleBackoff.initialSeconds (${show(backoff.initialSeconds)}) — every idle wait is clamped to the smaller, so the smaller max would silently shorten the configured first wait`,
    );
}

