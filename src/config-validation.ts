import { allRoleIds } from "./roles.js";

/** Schema validation for tumwater.json: the key lists (the one source of truth for what a valid
 * file may hold at each level, kept in sync with TumwaterConfig/BackoffConfig/RoleConfig in
 * types.ts) and validateConfig, the gate every load and save passes through. Split out of
 * config.ts — which keeps defaultConfig and everything that reads or writes the file (load/save/
 * cache, budget editing, per-role views) — because this is a self-contained concern with its own
 * sync obligation: it depends only on the role catalog (allRoleIds), not on any persistence. */

/** Render a value for an error message. */
export function show(v: unknown): string {
  return v === undefined ? "missing" : (JSON.stringify(v) ?? String(v));
}

/** JSON type name for top-level error messages ("an array", "null", "string", …). */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

/** True when `v` is a plain JSON object — not null, not an array. Every section of
 * tumwater.json must have this shape; the predicate lives in one place so its semantics
 * cannot drift between sections (and it narrows the type, removing the casts). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every key tumwater.json may hold, by level. Anything else is a typo that would be
 * silently ignored at runtime — the intended setting falls back to its default with no
 * warning — so it fails fast here instead (e.g. `tickTimeoutSecondss` does nothing).
 * Keep in sync with TumwaterConfig/BackoffConfig/RoleConfig in types.ts. */
const TOP_LEVEL_KEYS = [
  "provider",
  "model",
  "thinking",
  "piArgs",
  "maxConcurrent",
  "minTickIntervalSeconds",
  "tickTimeoutSeconds",
  "quietTimeoutSeconds",
  "logMaxBytes",
  "sessionRetentionDays",
  "maxDailyCostUsd",
  "thrashTurns",
  "thrashMinutes",
  "idleBackoff",
  "autoRestart",
  "review",
  "customLoops",
  "roles",
];
const BACKOFF_KEYS = ["initialSeconds", "factor", "maxSeconds"];
const ROLE_ENTRY_KEYS = [
  "enabled",
  "instructions",
  "provider",
  "model",
  "thinking",
  "minTickIntervalSeconds",
];
const REVIEW_KEYS = ["enabled", "exemptPaths", "provider", "model", "thinking"];
const CUSTOM_LOOP_KEYS = ["name", "task"];
/** A custom loop's name becomes a worktree dir and a git ref, so it is validated strictly:
 * lowercase alphanumerics plus dash/underscore, starting with an alphanumeric, ≤ 32 chars. */
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** A custom loop's task rides into every one of that loop's tick prefills, so it is capped:
 * unbounded text would be a standing per-tick cost. */
const CUSTOM_TASK_MAX_CHARS = 4096;

/** Collect the keys present in `obj` but not in `known` into problems, naming where they
 * were found and listing what is valid so one edit fixes them. */
function checkKnownKeys(
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

/** Validate user-supplied tumwater.json values before defaults are filled in, so a typo
 * fails fast with an actionable message instead of misbehaving at runtime — e.g. a
 * non-numeric tickTimeoutSeconds becomes NaN and kills every pi run instantly, a
 * non-numeric logMaxBytes rotates the event log on every write, an unknown role id (a
 * misspelled entry under `roles`) spawns a phantom loop that errors every tick, and an
 * unknown key is silently ignored so the intended setting never takes effect. Collects
 * every problem so one edit can fix them all; throws a single Error listing them. */
export function validateConfig(raw: unknown): void {
  if (!isPlainObject(raw)) {
    throw new Error(`tumwater.json must be a JSON object (got ${typeName(raw)})`);
  }
  const problems: string[] = [];

  const checkString = (obj: Record<string, unknown>, prefix: string, key: string): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "string") problems.push(`${prefix}${key} must be a string (got ${show(v)})`);
  };

  const checkNumber = (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    ok: (n: number) => boolean,
    what: string,
  ): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v) || !ok(v))
      problems.push(`${prefix}${key} must be ${what} (got ${show(v)})`);
  };

  const r = raw; // Narrowed to an object by isPlainObject above.
  checkKnownKeys(r, TOP_LEVEL_KEYS, "tumwater.json", problems);
  for (const key of ["provider", "model", "thinking"]) checkString(r, "", key);
  if ("piArgs" in r) {
    const v = r.piArgs;
    if (!Array.isArray(v) || !v.every((a) => typeof a === "string"))
      problems.push(`piArgs must be an array of strings (got ${show(v)})`);
  }
  checkNumber(r, "", "maxConcurrent", (n) => Number.isInteger(n) && n >= 1, "an integer of at least 1");
  checkNumber(r, "", "minTickIntervalSeconds", (n) => n >= 0, "a number of 0 or more");
  checkNumber(r, "", "tickTimeoutSeconds", (n) => n > 0, "a number greater than 0");
  checkNumber(r, "", "quietTimeoutSeconds", (n) => n >= 0, "a number of 0 or more (0 disables)");
  checkNumber(r, "", "logMaxBytes", (n) => n > 0, "a number greater than 0");
  checkNumber(r, "", "sessionRetentionDays", (n) => n >= 0, "a number of 0 or more (0 disables)");
  checkNumber(r, "", "maxDailyCostUsd", (n) => n >= 0, "a number of 0 or more (0 disables)");
  checkNumber(r, "", "thrashTurns", (n) => n >= 0, "a number of 0 or more");
  checkNumber(r, "", "thrashMinutes", (n) => n >= 0, "a number of 0 or more");

  if ("autoRestart" in r && typeof r.autoRestart !== "boolean")
    problems.push(`autoRestart must be true or false (got ${show(r.autoRestart)})`);

  if ("idleBackoff" in r) {
    const b = r.idleBackoff;
    if (!isPlainObject(b)) {
      problems.push(`idleBackoff must be an object (got ${show(b)})`);
    } else {
      const o = b;
      checkKnownKeys(o, BACKOFF_KEYS, "idleBackoff", problems);
      checkNumber(o, "idleBackoff.", "initialSeconds", (n) => n >= 0, "a number of 0 or more");
      checkNumber(o, "idleBackoff.", "factor", (n) => n >= 1, "a number of at least 1");
      checkNumber(o, "idleBackoff.", "maxSeconds", (n) => n >= 0, "a number of 0 or more");
    }
  }

  if ("review" in r) {
    const rv = r.review;
    if (!isPlainObject(rv)) {
      problems.push(`review must be an object (got ${show(rv)})`);
    } else {
      const o = rv;
      checkKnownKeys(o, REVIEW_KEYS, "review", problems);
      if ("enabled" in o && typeof o.enabled !== "boolean")
        problems.push(`review.enabled must be true or false (got ${show(o.enabled)})`);
      if ("exemptPaths" in o) {
        const v = o.exemptPaths;
        if (!Array.isArray(v) || !v.every((p) => typeof p === "string"))
          problems.push(`review.exemptPaths must be an array of strings (got ${show(v)})`);
      }
      for (const key of ["provider", "model", "thinking"]) checkString(o, "review.", key);
    }
  }

  // Custom loops (plans/user-defined-loops.md): names become worktree dirs and git refs, so
  // they are validated strictly — a colliding name would silently shadow a built-in's prompt
  // (roleById wins in tickPrompt), validation makes that impossible instead of subtle. The
  // collected names feed the roles cross-check below: an id under `roles` is valid when it is
  // in the catalog OR listed as a customLoops name.
  const customNames = new Set<string>();
  if ("customLoops" in r) {
    const cl = r.customLoops;
    if (!Array.isArray(cl)) {
      problems.push(`customLoops must be an array of { name, task } entries (got ${show(cl)})`);
    } else {
      cl.forEach((entry, i) => {
        const where = `customLoops[${i}]`;
        if (!isPlainObject(entry)) {
          problems.push(`${where} must be an object with keys name and task (got ${show(entry)})`);
          return;
        }
        checkKnownKeys(entry, CUSTOM_LOOP_KEYS, where, problems);
        const name = entry.name;
        if (typeof name !== "string") {
          problems.push(
            `${where}.name must be a string matching /^[a-z0-9][a-z0-9_-]{0,31}$/ (got ${show(name)})`,
          );
        } else if (!CUSTOM_NAME_RE.test(name)) {
          problems.push(
            `${where}.name "${name}" is not a valid loop name: start with a lowercase letter or digit, then at most 31 more of [a-z0-9_-]`,
          );
        } else if (allRoleIds().includes(name)) {
          problems.push(`${where}.name "${name}" collides with a built-in role id — pick another name`);
        } else if (customNames.has(name)) {
          problems.push(`${where}.name "${name}" is duplicated in customLoops — names must be unique`);
        } else {
          customNames.add(name);
        }
        const task = entry.task;
        if (typeof task !== "string" || task.length === 0) {
          problems.push(`${where}.task must be a non-empty string (got ${show(task)})`);
        } else if (task.length > CUSTOM_TASK_MAX_CHARS) {
          problems.push(
            `${where}.task is ${task.length} chars — shorten it to at most ${CUSTOM_TASK_MAX_CHARS}: it rides into every tick's prefill`,
          );
        }
      });
    }
  }

  if ("roles" in r) {
    const roles = r.roles;
    if (!isPlainObject(roles)) {
      problems.push(`roles must be an object mapping role ids to settings (got ${show(roles)})`);
    } else {
      for (const [id, rc] of Object.entries(roles)) {
        // An id outside the catalog and customLoops cannot work: tickPrompt has no prompt for
        // it and the loop would error every tick forever. Reject it here with the valid ids —
        // the same message shape `tumwater logs --role` uses for a bad flag value.
        if (!allRoleIds().includes(id) && !customNames.has(id)) {
          problems.push(
            `roles.${id} is not a known role (valid ids: ${[...allRoleIds(), ...customNames].join(", ")})`,
          );
          continue;
        }
        if (!isPlainObject(rc)) {
          problems.push(`roles.${id} must be an object (got ${show(rc)})`);
          continue;
        }
        const o = rc;
        checkKnownKeys(o, ROLE_ENTRY_KEYS, `roles.${id}`, problems);
        for (const key of ["instructions", "provider", "model", "thinking"])
          checkString(o, `roles.${id}.`, key);
        if ("enabled" in o && typeof o.enabled !== "boolean")
          problems.push(`roles.${id}.enabled must be true or false (got ${show(o.enabled)})`);
        checkNumber(
          o,
          `roles.${id}.`,
          "minTickIntervalSeconds",
          (n) => n >= 0,
          "a number of 0 or more",
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid tumwater.json:\n  - ${problems.join("\n  - ")}`);
  }
}
