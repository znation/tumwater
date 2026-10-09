import {
  BACKOFF_KEYS,
  CHECK_KEYS,
  CUSTOM_LOOP_KEYS,
  CUSTOM_NAME_RE,
  CUSTOM_TASK_MAX_CHARS,
  HARNESS_PI_FLAGS,
  MODEL_TRIPLE_KEYS,
  REVIEW_KEYS,
  ROLE_ENTRY_KEYS,
  TOP_LEVEL_KEYS,
  ROLE_INSTRUCTIONS_MAX_CHARS,
  TIER_MAP_KEYS,
} from "./config-schema.js";
import { allRoleIds } from "../roles/roles.js";
import { INSTANCE_ROLES, baseRoleOf } from "../roles/loop-ids.js";
import { isJsonObject } from "../files/json-object.js";
import { isNonBlankString, tooLongMessage } from "../text/text.js";
import { PREFILL_REASON } from "../text/phrases.js";
import { parseQuietHours } from "../scheduling/quiet-hours.js";
import { parseModelSelector } from "./model-selector.js";
import {
  AT_LEAST_ONE,
  type NumberRule,
  checkBooleanField,
  checkKnownKeys,
  checkKnownRoleId,
  checkModelTripleField,
  checkNumberField,
  checkObjectSection,
  checkStringArrayField,
  checkStringField,
  NON_NEGATIVE,
  NON_NEGATIVE_OR_DISABLED,
  DOLLAR_CAP,
  POSITIVE,
  POSITIVE_INTEGER,
  show,
  typeName,
} from "./config-field-checks.js";

/** Schema validation for tumwater.json: validateConfig, the gate every load and save passes
 * through (config.ts's load/save, config-write.ts's budget editing and director config
 * requests), judged against the key allow-lists and value shapes that live beside the types
 * they mirror in config-schema.ts. Split out of config.ts — which keeps defaultConfig and the
 * read side (load/save/cache, per-role views) — because this is a self-contained concern:
 * it depends only on the schema, the role catalog (allRoleIds), and message wording, not on
 * any persistence. The generic check machinery those rules share — message rendering, the
 * unknown-key and known-role guards, the NumberRule table, and the per-field type checkers —
 * lives in config-field-checks.ts; this module is the section-by-section rules plus the
 * cross-field checks, and the one export gate (validateConfig) for them. */

/** The upper bound every seconds field that feeds a ×1000 duration shares: 2147483 s
 * × 1000 stays inside node's signed-32-bit setTimeout/setInterval range (2^31−1 ms,
 * about 24.8 days). Above it node clamps the delay to 1ms — a one-zero typo like
 * `"tickTimeoutSeconds": 1e300` became Infinity ms, and every pi run died the moment it
 * started (BUGS.md 2026-10-03). */
const MAX_DURATION_SECONDS = 2147483;
const DURATION_POSITIVE: NumberRule = {
  ok: (n) => n > 0 && n <= MAX_DURATION_SECONDS,
  what: `a number greater than 0, at most ${MAX_DURATION_SECONDS}`,
};
const DURATION_NON_NEGATIVE: NumberRule = {
  ok: (n) => n >= 0 && n <= MAX_DURATION_SECONDS,
  what: `a number of 0 or more, at most ${MAX_DURATION_SECONDS}`,
};
const DURATION_OR_DISABLED: NumberRule = {
  ok: (n) => n >= 0 && n <= MAX_DURATION_SECONDS,
  what: `a number of 0 or more, at most ${MAX_DURATION_SECONDS} (0 disables)`,
};

/** A per-role instance count (`roles.feature.instances`): an integer from 1 to 8. Bounded so
 * a typo like `instances: 800` cannot spawn hundreds of runners, and integer so
 * `feature-1.5` — which no loop id can name — is refused. */
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

/** Validate tumwater.json values, so a typo fails fast with an actionable message instead
 * of misbehaving at runtime — e.g. a non-numeric tickTimeoutSeconds becomes NaN and kills
 * every pi run instantly, a non-numeric logMaxBytes rotates the event log on every write, an
 * unknown role id (a misspelled entry under `roles`) spawns a phantom loop that errors every
 * tick, and an unknown key is silently ignored so the intended setting never takes effect.
 * Collects every problem so one edit can fix them all; throws a single Error listing them.
 * `label` names the file in the thrown messages — validateConfig also gates the tracked
 * example template, whose problems must not be misreported as tumwater.json's.
 *
 * Called on two shapes: the raw file before defaults are filled in (load's first pass, the
 * example template — per-key rules there keep their precise messages, naming exactly what
 * the file holds), and the fully merged config (load's second pass, saveConfig,
 * applyConfigRequest) — the shape that actually runs, so cross-field rules that depend on
 * defaults are judged here, where both sides of the comparison are always present.
 */
export function validateConfig(raw: unknown, label = "tumwater.json"): void {
  if (!isJsonObject(raw)) {
    throw new Error(`${label} must be a JSON object (got ${typeName(raw)})`);
  }
  const problems: string[] = [];

  // The generic checkers from config-field-checks.ts, bound to this pass's problems array so
  // the section rules below read as direct field checks.
  const checkString = (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    allowEmpty = true,
  ): void => checkStringField(problems, obj, prefix, key, allowEmpty);
  const checkModelTriple = (
    obj: Record<string, unknown>,
    prefix: string,
    modelShape?: "selector" | "tier-map" | "tier-name",
  ): void => checkModelTripleField(problems, obj, prefix, modelShape);
  const checkNumber = (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    rule: NumberRule,
  ): void => checkNumberField(problems, obj, prefix, key, rule);
  const checkBoolean = (obj: Record<string, unknown>, prefix: string, key: string): void =>
    checkBooleanField(problems, obj, prefix, key);
  const checkStringArray = (obj: Record<string, unknown>, prefix: string, key: string): void =>
    checkStringArrayField(problems, obj, prefix, key);

  const r = raw; // Narrowed to an object by isJsonObject above.
  checkKnownKeys(r, TOP_LEVEL_KEYS, label, problems);
  // The top level's `model` may be a selector string or a map by tier (plans/model-tiers.md);
  // provider/thinking validate as before. A string selector that parses to an empty provider
  // or model half is reported separately (checkSelectorHalves).
  checkModelTriple(r, "", "tier-map");
  checkSelectorHalves(r, "", "model", r.provider, problems);
  // An empty baseBranch would silently fall back to the checked-out branch — the one value
  // the operator's explicit setting must never degrade to unannounced.
  checkString(r, "", "baseBranch", false);
  // An empty agentBin would silently fall back to "pi" — the same silent-ignore class: the
  // operator named a binary, so a blank value must fail validation, not run the default.
  checkString(r, "", "agentBin", false);
  checkStringArray(r, "", "piArgs");
  // A piArgs entry that repeats a harness-managed flag is appended after the harness's own and
  // pi's parser is last-wins, so it silently overrides it (see HARNESS_PI_FLAGS). Name the
  // position and the flag so one edit removes it.
  if (Array.isArray(r.piArgs)) {
    (r.piArgs as unknown[]).forEach((arg, i) => {
      if (typeof arg !== "string") return; // Already reported by checkStringArray.
      const why = HARNESS_PI_FLAGS.get(arg);
      if (why) problems.push(`piArgs[${i}] ${show(arg)} duplicates a flag the harness sets — ${why}`);
    });
  }
  checkNumber(r, "", "maxConcurrent", POSITIVE_INTEGER);
  checkNumber(r, "", "landBatchMax", POSITIVE_INTEGER);
  checkNumber(r, "", "maxConcurrentChecks", POSITIVE_INTEGER);
  checkNumber(r, "", "worktreeSlots", POSITIVE_INTEGER);
  checkNumber(r, "", "minTickIntervalSeconds", DURATION_NON_NEGATIVE);
  checkNumber(r, "", "tickTimeoutSeconds", DURATION_POSITIVE);
  checkNumber(r, "", "quietTimeoutSeconds", DURATION_OR_DISABLED);
  checkNumber(r, "", "toolCallStallSeconds", DURATION_OR_DISABLED);
  checkNumber(r, "", "logMaxBytes", POSITIVE);
  checkNumber(r, "", "sessionRetentionDays", NON_NEGATIVE_OR_DISABLED);
  checkNumber(r, "", "maxDailyCostUsd", DOLLAR_CAP);
  // Disk floor (plans/disk-floor.md, part 1/4): 0 disables the hold, so only a negative
  // value or a non-number is a problem.
  checkNumber(r, "", "diskHoldGB", NON_NEGATIVE);
  // Pressure reclaim (plans/disk-floor.md, part 2/4): 0 disables it; a nonzero threshold must
  // sit at or above the hold floor, or reclaim would trigger only after the hold already
  // engaged. Both fields' own type checks report non-numbers above, so this rebukes only a
  // valid number pair.
  checkNumber(r, "", "diskReclaimGB", NON_NEGATIVE);
  // Idle reclaim (plans/disk-floor.md, part 3/4): 0 disables it, so only a negative value or a
  // non-number is a problem.
  checkNumber(r, "", "worktreeIdleReclaimHours", NON_NEGATIVE);
  if (
    typeof r.diskHoldGB === "number" &&
    typeof r.diskReclaimGB === "number" &&
    r.diskReclaimGB !== 0 &&
    r.diskReclaimGB < r.diskHoldGB
  ) {
    problems.push(
      `diskReclaimGB (${show(r.diskReclaimGB)}) must be at least diskHoldGB (${show(r.diskHoldGB)}) unless it is 0 (disabled)`,
    );
  }
  checkNumber(r, "", "thrashTurns", NON_NEGATIVE);
  checkNumber(r, "", "thrashMinutes", NON_NEGATIVE);

  checkBoolean(r, "", "autoRestart");

  // Quiet hours (src/scheduling/quiet-hours.ts): the value is off when empty or absent, and
  // otherwise must parse as "HH:MM-HH:MM" — parseQuietHours's message is the one actionable
  // wording, so validateConfig and `config set` cannot drift apart on what a valid window is.
  if ("quietHours" in r) {
    const parsed = parseQuietHours(r.quietHours);
    if (!parsed.ok) problems.push(parsed.error);
  }

  // The operator notify hook (src/events/notify.ts): absent or empty string means off,
  // otherwise the value is the shell command the orchestrator runs on notable events — so it
  // must be a string when present, and an empty string stays valid (it is how `config set
  // notify ""` clears the hook).
  if ("notify" in r && typeof r.notify !== "string") {
    problems.push(
      `notify must be a string (the shell command to run on notable events, empty string disables; got ${show(r.notify)})`,
    );
  }

  // The project's own verification command (plans/portability.md §6/7): a blank command is the
  // same silent-ignore class as a blank agentBin — the operator named a check, so an empty or
  // whitespace-only value must fail validation, not silently fall back to npm detection.
  checkObjectSection(r, "check", problems, (o) => {
    checkKnownKeys(o, CHECK_KEYS, "check", problems);
    checkString(o, "check.", "command", false);
    // gateCommand is a string like command, but blank means off: falling back from it runs
    // the FULL check at the gate — the stronger check, never a silently weaker one.
    checkString(o, "check.", "gateCommand");
    checkString(o, "check.", "cwd");
    checkNumber(o, "check.", "timeoutSeconds", DURATION_POSITIVE);
  });

  checkObjectSection(r, "idleBackoff", problems, (o) => {
    checkKnownKeys(o, BACKOFF_KEYS, "idleBackoff", problems);
    checkNumber(o, "idleBackoff.", "initialSeconds", DURATION_NON_NEGATIVE);
    checkNumber(o, "idleBackoff.", "factor", AT_LEAST_ONE);
    checkNumber(o, "idleBackoff.", "maxSeconds", DURATION_NON_NEGATIVE);
  });

  checkObjectSection(r, "review", problems, (o) => {
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
        if (!isNonBlankString(p)) return; // Already reported by checkStringArray.
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
    checkModelTriple(o, "review.", "tier-name");
    checkSelectorHalves(o, "review.", "model", o.provider ?? r.provider, problems);
    checkNumber(o, "review.", "timeoutSeconds", DURATION_POSITIVE);
  });

  // The free fallback model (plans/fallback-model.md): shape only — whether the named pair is
  // actually cost-free is a question about pi's models.json, not about this file, so it is
  // answered at run time (src/pi/pi-models.ts) rather than failing a load here. An empty object is
  // rejected: it names nothing, so it would silently never engage.
  // The selector-string shorthand `fallback` (plans/model-tiers.md) validates as one non-empty
  // string; the map form takes per-tier entries whose values are selector strings or "pause"
  // (the pause entries are consulted per tier in part 5/8). Setting both forms — or the map
  // form and `fallbackModel` — is an error naming both keys, since which one wins is not a
  // question the file should ever pose.
  if ("fallback" in r && r.fallback !== undefined) {
    const f = r.fallback;
    if (isJsonObject(f)) {
      checkKnownKeys(f, TIER_MAP_KEYS, "fallback", problems);
      for (const [tier, v] of Object.entries(f))
        if (!isNonBlankString(v))
          problems.push(
            `fallback.${tier} must be a non-empty selector string or "pause" (got ${show(v)})`,
          );
    } else if (!isNonBlankString(f)) {
      problems.push(`fallback must be a selector string or a map by tier (got ${show(f)})`);
    } else if (f === "pause") {
      problems.push(
        `fallback "pause" is only valid as a tier map value — a string fallback must name a selector`,
      );
    } else {
      // A selector-string fallback still parses to halves: report an empty one.
      checkSelectorHalves({ fallback: f }, "", "fallback", undefined, problems);
    }
  }
  if ("fallback" in r && "fallbackModel" in r)
    problems.push(`fallback and fallbackModel both name the budget fallback — keep only one (got fallback ${show(r.fallback)} and fallbackModel ${show(r.fallbackModel)})`);
  checkObjectSection(r, "fallbackModel", problems, (o) => {
    checkKnownKeys(o, MODEL_TRIPLE_KEYS, "fallbackModel", problems);
    checkModelTriple(o, "fallbackModel.");
    if (!("provider" in o) && !("model" in o))
      problems.push(`fallbackModel must name a provider or a model (got ${show(o)})`);
  });

  /** A selector string that parses to an empty provider or model half (`"/id"`, `"p/"`) passes
 * the non-empty-string rule but never reaches pi: piArgs skips an empty value when it builds
 * its flags (config-field-checks' model-triple note), and fallbackPair drops an empty half, so
 * the fleet silently runs pi's default model — the same silent-ignore class the empty-string
 * rules exist to prevent. Checked only when no legacy provider is in scope: under one, the
 * whole string is the id (config-views' parse), so a `/` in it is ordinary text and the parse
 * cannot produce an empty half. */
function checkSelectorHalves(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  legacyProvider: unknown,
  problems: string[],
): void {
  const v = obj[key];
  if (!isNonBlankString(v)) return;
  const legacy = isNonBlankString(legacyProvider) ? legacyProvider : undefined;
  const sel = parseModelSelector(v, legacy);
  if (sel.provider !== undefined && sel.provider.trim() === "")
    problems.push(
      `${prefix}${key} ${show(v)} parses to an empty provider half — pi would silently run its default model`,
    );
  if (sel.model.trim() === "")
    problems.push(
      `${prefix}${key} ${show(v)} parses to an empty model half — pi would silently run its default model`,
    );
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
        } else if (baseRoleOf(name) !== name) {
          problems.push(
            `${where}.name "${name}" would shadow the ${baseRoleOf(name)} loop's instance ids — pick another name`,
          );
        } else if (customNames.has(name)) {
          problems.push(`${where}.name "${name}" is duplicated in customLoops — names must be unique`);
        } else {
          customNames.add(name);
        }
        const task = entry.task;
        // A whitespace-only task is as inert as an empty one — it rides into every one of
        // this loop's tick prefills as blank text, so the loop has nothing to do and ticks
        // no_change forever. Reject both shapes with the same message; the model-triple
        // checkString rule uses the same trim-based emptiness test.
        if (!isNonBlankString(task)) {
          problems.push(`${where}.task must be a non-empty string (got ${show(task)})`);
        } else if (task.length > CUSTOM_TASK_MAX_CHARS) {
          problems.push(
            tooLongMessage(
              `${where}.task`,
              task.length,
              CUSTOM_TASK_MAX_CHARS,
              PREFILL_REASON,
            ),
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
        // it and the loop would error every tick forever (checkKnownRoleId).
        if (!checkKnownRoleId("roles", id, customNames, problems)) continue;
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
            tooLongMessage(
              `roles.${id}.instructions`,
              instructions.length,
              ROLE_INSTRUCTIONS_MAX_CHARS,
              PREFILL_REASON,
            ),
          );
        checkModelTriple(o, `roles.${id}.`, "tier-name");
        checkSelectorHalves(o, `roles.${id}.`, "model", o.provider ?? r.provider, problems);
        checkBoolean(o, `roles.${id}.`, "enabled");
        checkNumber(o, `roles.${id}.`, "minTickIntervalSeconds", DURATION_NON_NEGATIVE);
        // Only feature and bugfix may split (src/roles/loop-ids.ts INSTANCE_ROLES); an
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

  // Per-role daily cost caps (src/gates/role-cap-gates.ts): each key must name a known role —
  // built-in or customLoops — because a typo'd id would silently no-op the cap, the exact
  // silent-ignore class the `roles.<id>` check exists to prevent (the customNames set above
  // is fully collected by this point, so a custom loop can be capped). Each value is a
  // spend threshold with the NON_NEGATIVE_OR_DISABLED semantics: 0 disables that role's cap.
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

  // Per-role quiet hours (src/scheduling/quiet-hours.ts): the same known-role gate as the
  // caps — a typo'd role id would silently no-op the window. Each value must parse as a
  // quiet-hours window (an empty string means off for that role, the same disablement the
  // fleet-wide key takes), and the message names the key and the offending id/value verbatim.
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

  // Cross-field (judged on the merged config, where both sides are always present; on a raw
  // file only when the file itself names both): scheduleBackoff clamps every idle wait — the
  // first included — to min(initialSeconds, maxSeconds), so a smaller max silently discards
  // the configured initial wait. Name both values so one edit fixes the pair.
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

  if (problems.length > 0) {
    throw new Error(`invalid ${label}:\n  - ${problems.join("\n  - ")}`);
  }
}
