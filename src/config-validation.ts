import { allRoleIds } from "./roles.js";
import { isJsonObject } from "./json-object.js";
import { truncate } from "./text.js";

/** Schema validation for tumwater.json: the key lists (the one source of truth for what a valid
 * file may hold at each level, kept in sync with TumwaterConfig/BackoffConfig/RoleConfig in
 * types.ts) and validateConfig, the gate every load and save passes through. Split out of
 * config.ts — which keeps defaultConfig and everything that reads or writes the file (load/save/
 * cache, budget editing, per-role views) — because this is a self-contained concern with its own
 * sync obligation: it depends only on the role catalog (allRoleIds), not on any persistence. */

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
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
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
  "landBatchMax",
  "minTickIntervalSeconds",
  "tickTimeoutSeconds",
  "quietTimeoutSeconds",
  "toolCallStallSeconds",
  "logMaxBytes",
  "sessionRetentionDays",
  "maxDailyCostUsd",
  "fallbackModel",
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
/** The provider/model/thinking triple every model-override section shares — top level,
 * `review`, `fallbackModel` (plans/fallback-model.md), and each `roles.<id>` entry — so one
 * mental model and one validator cover them all. */
const MODEL_TRIPLE_KEYS = ["provider", "model", "thinking"];
/** pi's accepted `--thinking` levels (pi's own `--help`). pi WARNS and falls back to its own
 * default on any other value rather than failing, so a misspelled level would silently run the
 * fleet at the wrong reasoning depth — the same silent-ignore class this validator exists to
 * catch. Kept in sync with pi's CLI (dist/cli/args.js VALID_THINKING_LEVELS). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CUSTOM_LOOP_KEYS = ["name", "task"];
/** A custom loop's name becomes a worktree dir and a git ref, so it is validated strictly:
 * lowercase alphanumerics plus dash/underscore, starting with an alphanumeric, ≤ 32 chars. */
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** A custom loop's task rides into every one of that loop's tick prefills, so it is capped:
 * unbounded text would be a standing per-tick cost. */
const CUSTOM_TASK_MAX_CHARS = 4096;

/** A role's extra instructions ride into every one of that role's tick prefills, so they are
 * capped like a custom loop's task: unbounded text would be a standing per-tick cost (and
 * could crowd the prompt toward the model's context ceiling). */
const ROLE_INSTRUCTIONS_MAX_CHARS = 4096;

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

/** The numeric shapes a tumwater.json field must satisfy, each bundled with the wording its
 * violation reports — one definition per shape, so a predicate and the text explaining it
 * cannot drift apart across the fields that share it. */
interface NumberRule {
  ok: (n: number) => boolean;
  what: string;
}

const NON_NEGATIVE: NumberRule = { ok: (n) => n >= 0, what: "a number of 0 or more" };
const NON_NEGATIVE_OR_DISABLED: NumberRule = {
  ok: (n) => n >= 0,
  what: "a number of 0 or more (0 disables)",
};
const POSITIVE: NumberRule = { ok: (n) => n > 0, what: "a number greater than 0" };
const POSITIVE_INTEGER: NumberRule = {
  ok: (n) => Number.isInteger(n) && n >= 1,
  what: "an integer of at least 1",
};
const AT_LEAST_ONE: NumberRule = { ok: (n) => n >= 1, what: "a number of at least 1" };

/** Validate user-supplied tumwater.json values before defaults are filled in, so a typo
 * fails fast with an actionable message instead of misbehaving at runtime — e.g. a
 * non-numeric tickTimeoutSeconds becomes NaN and kills every pi run instantly, a
 * non-numeric logMaxBytes rotates the event log on every write, an unknown role id (a
 * misspelled entry under `roles`) spawns a phantom loop that errors every tick, and an
 * unknown key is silently ignored so the intended setting never takes effect. Collects
 * every problem so one edit can fix them all; throws a single Error listing them. */
export function validateConfig(raw: unknown): void {
  if (!isJsonObject(raw)) {
    throw new Error(`tumwater.json must be a JSON object (got ${typeName(raw)})`);
  }
  const problems: string[] = [];

  // `allowEmpty` defaults true: an empty `instructions` is a deliberate "no extra
  // instructions". The model-triple fields (provider/model/thinking) pass false: pi.ts skips
  // an empty value when it builds its flags, so `"provider": ""` would be silently ignored
  // and the fleet would quietly fall back to pi's default — and an empty `fallbackModel`
  // field makes fallbackPair drop it, so the fallback never engages. Reject it here instead.
  const checkString = (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    allowEmpty = true,
  ): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "string") problems.push(`${prefix}${key} must be a string (got ${show(v)})`);
    else if (!allowEmpty && v.trim() === "")
      problems.push(`${prefix}${key} must not be empty (got ${show(v)})`);
  };

  // Every model-override section validates the same provider/model/thinking triple the same
  // way: empty strings are rejected because pi.ts skips them when building flags and
  // fallbackPair drops an empty fallbackModel field, so an empty value would be silently
  // ignored rather than honored.
  const checkModelTriple = (obj: Record<string, unknown>, prefix: string): void => {
    for (const key of MODEL_TRIPLE_KEYS) checkString(obj, prefix, key, false);
    // thinking is also value-checked: pi only recognizes THINKING_LEVELS and silently drops
    // anything else, so a typo would run the loops at pi's default depth and never say so.
    const t = obj.thinking;
    if (typeof t === "string" && t.trim() !== "" && !THINKING_LEVELS.has(t))
      problems.push(
        `${prefix}thinking must be one of ${[...THINKING_LEVELS].join(", ")} (got ${show(t)})`,
      );
  };

  const checkNumber = (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    rule: NumberRule,
  ): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v) || !rule.ok(v))
      problems.push(`${prefix}${key} must be ${rule.what} (got ${show(v)})`);
  };

  // Field-type validators shared by every section that carries the same kind of value: a
  // boolean flag (autoRestart, review.enabled, roles.<id>.enabled) and a list of strings
  // (piArgs, review.exemptPaths). Their messages cannot drift per field.
  const checkBoolean = (obj: Record<string, unknown>, prefix: string, key: string): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "boolean")
      problems.push(`${prefix}${key} must be true or false (got ${show(v)})`);
  };

  const checkStringArray = (obj: Record<string, unknown>, prefix: string, key: string): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      problems.push(`${prefix}${key} must be an array of strings (got ${show(v)})`);
      return;
    }
    // A blank entry has no valid meaning and would otherwise be silently inert: pi.ts passes
    // every `piArgs` element straight to pi's CLI, where an empty string is read as an empty
    // user MESSAGE (pi's args parser pushes any non-flag token, "" included, as a message),
    // and isExemptPath skips a blank pattern so a blank `review.exemptPaths` entry never
    // matches anything. Name its position so one edit removes it.
    const arr = v as string[];
    const blankAt = arr.findIndex((s) => s.trim() === "");
    if (blankAt >= 0)
      problems.push(`${prefix}${key}[${blankAt}] must not be blank (got ${show(arr[blankAt])})`);
  };

  const r = raw; // Narrowed to an object by isJsonObject above.
  checkKnownKeys(r, TOP_LEVEL_KEYS, "tumwater.json", problems);
  checkModelTriple(r, "");
  checkStringArray(r, "", "piArgs");
  checkNumber(r, "", "maxConcurrent", POSITIVE_INTEGER);
  checkNumber(r, "", "landBatchMax", POSITIVE_INTEGER);
  checkNumber(r, "", "minTickIntervalSeconds", NON_NEGATIVE);
  checkNumber(r, "", "tickTimeoutSeconds", POSITIVE);
  checkNumber(r, "", "quietTimeoutSeconds", NON_NEGATIVE_OR_DISABLED);
  checkNumber(r, "", "toolCallStallSeconds", NON_NEGATIVE_OR_DISABLED);
  checkNumber(r, "", "logMaxBytes", POSITIVE);
  checkNumber(r, "", "sessionRetentionDays", NON_NEGATIVE_OR_DISABLED);
  checkNumber(r, "", "maxDailyCostUsd", NON_NEGATIVE_OR_DISABLED);
  checkNumber(r, "", "thrashTurns", NON_NEGATIVE);
  checkNumber(r, "", "thrashMinutes", NON_NEGATIVE);

  checkBoolean(r, "", "autoRestart");

  if ("idleBackoff" in r) {
    const b = r.idleBackoff;
    if (!isJsonObject(b)) {
      problems.push(`idleBackoff must be an object (got ${show(b)})`);
    } else {
      const o = b;
      checkKnownKeys(o, BACKOFF_KEYS, "idleBackoff", problems);
      checkNumber(o, "idleBackoff.", "initialSeconds", NON_NEGATIVE);
      checkNumber(o, "idleBackoff.", "factor", AT_LEAST_ONE);
      checkNumber(o, "idleBackoff.", "maxSeconds", NON_NEGATIVE);
    }
  }

  if ("review" in r) {
    const rv = r.review;
    if (!isJsonObject(rv)) {
      problems.push(`review must be an object (got ${show(rv)})`);
    } else {
      const o = rv;
      checkKnownKeys(o, REVIEW_KEYS, "review", problems);
      checkBoolean(o, "review.", "enabled");
      checkStringArray(o, "review.", "exemptPaths");
      // An exemption pattern is matched against a repo-relative path (exemptions.ts), so a
      // pattern shaped like something git never emits can never match: the diff it was meant
      // to exempt gets a model review anyway, and the operator never learns the pattern was
      // inert. Reject the shapes git paths never take — an absolute path, a "./" prefix, a
      // ".." segment, or a trailing "/" — the blank-entry rule above applied to the pattern's
      // shape instead of its emptiness. Each message names the position so one edit fixes it.
      if (Array.isArray(o.exemptPaths)) {
        (o.exemptPaths as unknown[]).forEach((p, i) => {
          if (typeof p !== "string" || p.trim() === "") return; // Already reported by checkStringArray.
          const fix =
            p.startsWith("/") || p.startsWith("./")
              ? 'must be repo-relative — drop the leading "/" or "./"'
              : p.split("/").includes("..")
                ? 'must not contain a ".." segment — patterns match repo-relative paths'
                : p.endsWith("/")
                  ? 'must name files, not a directory — drop the trailing "/" (e.g. "docs/**")'
                  : null;
          if (fix) problems.push(`review.exemptPaths[${i}] ${fix} (got ${show(p)})`);
        });
      }
      checkModelTriple(o, "review.");
    }
  }

  // The free fallback model (plans/fallback-model.md): shape only — whether the named pair is
  // actually cost-free is a question about pi's models.json, not about this file, so it is
  // answered at run time (src/pi-models.ts) rather than failing a load here. An empty object is
  // rejected: it names nothing, so it would silently never engage.
  if ("fallbackModel" in r) {
    const fb = r.fallbackModel;
    if (!isJsonObject(fb)) {
      problems.push(`fallbackModel must be an object (got ${show(fb)})`);
    } else {
      checkKnownKeys(fb, MODEL_TRIPLE_KEYS, "fallbackModel", problems);
      checkModelTriple(fb, "fallbackModel.");
      if (!("provider" in fb) && !("model" in fb))
        problems.push(`fallbackModel must name a provider or a model (got ${show(fb)})`);
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
        if (!isJsonObject(entry)) {
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
    if (!isJsonObject(roles)) {
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
        if (!isJsonObject(rc)) {
          problems.push(`roles.${id} must be an object (got ${show(rc)})`);
          continue;
        }
        const o = rc;
        checkKnownKeys(o, ROLE_ENTRY_KEYS, `roles.${id}`, problems);
        // Empty is a deliberate "no extra instructions". A non-empty value rides into every
        // one of this role's tick prefills, so it is capped like a custom loop's task.
        checkString(o, `roles.${id}.`, "instructions");
        const instructions = o.instructions;
        if (typeof instructions === "string" && instructions.length > ROLE_INSTRUCTIONS_MAX_CHARS)
          problems.push(
            `roles.${id}.instructions is ${instructions.length} chars — shorten it to at most ${ROLE_INSTRUCTIONS_MAX_CHARS}: it rides into every tick's prefill`,
          );
        checkModelTriple(o, `roles.${id}.`);
        checkBoolean(o, `roles.${id}.`, "enabled");
        checkNumber(o, `roles.${id}.`, "minTickIntervalSeconds", NON_NEGATIVE);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid tumwater.json:\n  - ${problems.join("\n  - ")}`);
  }
}
