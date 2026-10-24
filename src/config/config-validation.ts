import {
  MODEL_TIERS,
  BACKOFF_KEYS,
  BOOTSTRAP_KEYS,
  CHECK_KEYS,
  CUSTOM_ROLE_KEYS,
  CUSTOM_NAME_RE,
  CUSTOM_TASK_MAX_CHARS,
  REVIEW_KEYS,
  ROLE_ENTRY_KEYS,
  TOP_LEVEL_KEYS,
  ROLE_INSTRUCTIONS_MAX_CHARS,
} from "./config-schema.js";
import { DIRECTOR_ROLE, allRoleIds } from "../roles/roles.js";
import { INSTANCE_ROLES, baseRoleOf } from "../roles/runner-ids.js";
import { isHarnessCodexConfigKey } from "../agent/codex/codex-args.js";
import { isJsonObject } from "../files/json-object.js";
import { expandHomeTilde } from "../files/files.js";
import os from "node:os";
import path from "node:path";
import { isNonBlankString, tooLongMessage } from "../text/text.js";
import { PREFILL_REASON } from "../text/phrases.js";
import { parseQuietHours } from "../scheduling/quiet-hours.js";
import { isBackendId } from "./model-selector.js";
import { TUMWATER_SOURCE } from "../events/events.js";
import {
  AT_LEAST_ONE,
  type NumberRule,
  checkBooleanField,
  checkKnownKeys,
  checkKnownRoleId,
  checkModelTripleField,
  checkNumberField,
  checkObjectSection,
  codexConfigKey,
  checkStringArrayField,
  checkStringField,
  NON_NEGATIVE,
  NON_NEGATIVE_OR_DISABLED,
  DOLLAR_CAP,
  MAX_DURATION_SECONDS,
  POSITIVE,
  POSITIVE_INTEGER,
  show,
  typeName,
} from "./config-field-checks.js";
import {
  checkEntryBackend,
  checkRetiredSelector,
  checkSelectorHalves,
} from "./config-selector-checks.js";
import { validateAgentsBlock } from "./config-validation-agents.js";
import {
  validateFallbackBlock,
  validateModelBlock,
} from "./config-validation-model.js";

/** Schema validation for tumwater.json: validateConfig, the gate every load and save passes
 * through (config.ts's load/save, config-write.ts's budget editing and
 * config-request.ts's director config requests), judged against the key allow-lists and
 * value shapes that live beside the types
 * they mirror in config-schema.ts. Split out of config.ts — which keeps defaultConfig and the
 * read side (load/save/cache, per-role views) — because this is a self-contained concern:
 * it depends only on the schema, the role catalog (allRoleIds), and message wording, not on
 * any persistence. The generic check machinery those rules share — message rendering, the
 * unknown-key and known-role guards, the NumberRule table, and the per-field type checkers —
 * lives in config-field-checks.ts; this module is the section-by-section rules plus the
 * cross-field checks, and the one export gate (validateConfig) for them. */

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

/** Validate tumwater.json values, so a typo fails fast with an actionable message instead
 * of misbehaving at runtime — e.g. a non-numeric runTimeoutSeconds becomes NaN and kills
 * every pi run instantly, a non-numeric logMaxBytes rotates the event log on every write, an
 * unknown role id (a misspelled entry under `roles`) spawns a phantom role that errors every
 * run, and an unknown key is silently ignored so the intended setting never takes effect.
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
export function validateConfig(raw: unknown, label = "tumwater.json", rawFile = false): void {
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
  // The window-reserve map validation shared by a backend's nested `windowReserve` (via
  // checkBackendConfig) and the top-level `claudeWindowReserve` legacy spelling, so their
  // object/empty-type/fraction messages cannot drift. `label` is the message path — the
  // `.windowReserve`-suffixed prefix for a backend, `claudeWindowReserve` at top level.
  const checkWindowReserve = (label: string, value: unknown): void => {
    if (!isJsonObject(value)) {
      problems.push(`${label} must be an object mapping window types to fractions (got ${show(value)})`);
      return;
    }
    for (const [type, v] of Object.entries(value)) {
      if (type.trim() === "") problems.push(`${label}.<empty> — a window type must not be empty`);
      else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1)
        problems.push(`${label}.${type} must be a fraction above 0 and at most 1 (got ${show(v)})`);
    }
  };

  // claude's and codex's per-backend config dir (plans/notes-command.md "Keeping funes out
  // of team runs" and plans/codex-backend.md §4): a leading `~` expands; the value must be an
  // absolute path after expansion, or claude would resolve a relative CLAUDE_CONFIG_DIR (and
  // codex a relative CODEX_HOME) from the run's cwd and write transcripts somewhere
  // unexpected. Only claude and codex accept the key, so it is inert nowhere else.
  const checkBackendConfig = (entry: Record<string, unknown>, prefix: string): void => {
    checkString(entry, `${prefix}.`, "configDir", false);
    if (typeof entry.configDir === "string" && entry.configDir !== "")
      if (!path.isAbsolute(expandHomeTilde(entry.configDir, os.homedir())))
        problems.push(
          `${prefix}.configDir must be an absolute path after ~ expansion (got ${show(entry.configDir)})`,
        );
    if (entry.windowReserve === undefined) return;
    checkWindowReserve(`${prefix}.windowReserve`, entry.windowReserve);
  };

  // codex's `-c <key>=…` / `--config <key>=…` passthrough (plans/codex-backend.md §2/§3): a
  // key tumwater sets on every run (HARNESS_CODEX_CONFIG_KEYS) — or one the write guard owns,
  // `hooks` / `hooks.<…>` (part 3/9) — is appended AFTER the harness's own `-c` and Codex's
  // parser is last-wins, so it would silently override the model, effort, sandbox mode,
  // telemetry or the write guard the harness resolved. The standalone-flag screen above
  // (reservedPassthroughFlag + checkReservedArgs) splits on `=` and cannot see a separate
  // `-c` token, so codex gets its own arity-aware scan of the key. Any other key is the
  // operator's own and passes.
  const checkCodexConfigKeys = (entry: Record<string, unknown>, prefix: string): void => {
    const args = entry.args as unknown[];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== "string") continue;
      const key = codexConfigKey(arg, typeof args[i + 1] === "string" ? (args[i + 1] as string) : undefined);
      if (key !== undefined && isHarnessCodexConfigKey(key))
        problems.push(
          `${prefix}.args[${i}] ${show(arg)} passes the config key ${key}, which tumwater manages — drop it or use another key`,
        );
    }
  };

  const r = raw; // Narrowed to an object by isJsonObject above.
  checkKnownKeys(r, TOP_LEVEL_KEYS, label, problems);
  // The top level's `model` may be a selector string or a map by tier (plans/model-tiers.md);
  // provider/thinking validate as before. A string selector that parses to an empty provider
  // or model half is reported separately (checkSelectorHalves).
  // The backend a selector with no `backend` of its own resolves to (retired-spelling checks).
  const topBackend = typeof r.backend === "string" ? r.backend : "pi";
  // The backend a tier's primary resolves to, which that tier's fallback steps inherit.
  const tierBackend = (tier: string): string => {
    // A tier left out of the map takes the `default` entry, as resolveTopTier does.
    const e = isJsonObject(r.model) ? (r.model[tier] ?? r.model.default) : undefined;
    return isJsonObject(e) && typeof e.backend === "string" ? e.backend : topBackend;
  };
  // A string or list `fallback` serves every tier, each inheriting its own tier's backend, so it
  // is checked against each distinct one; the same message from two backends is reported once.
  const eachTierBackend = (check: (backend: string, out: string[]) => void): void => {
    const out: string[] = [];
    for (const b of new Set(MODEL_TIERS.map(tierBackend))) check(b, out);
    for (const m of new Set(out)) problems.push(m);
  };
  // The retired spelling doubled a backend id as the provider namespace, so a `provider` that IS
  // a backend id other than `pi` on a section that otherwise runs on pi is the old back-compat
  // form: configForRole still resolves the section to pi and hands the bare provider name to
  // pi, which has no such provider — reject it with the edit the step check names (write the
  // backend beside the model, drop the provider). checkRetiredSelector covers the no-provider
  // spellings; this catches the pair a provider in scope used to make valid.
  const checkLegacyProvider = (provider: unknown, at: string, backend: string): void => {
    if (typeof provider === "string" && isBackendId(provider) && provider !== "pi" && backend === "pi")
      problems.push(
        `${at}provider "${provider}" is the retired backend namespace but this section runs on pi — write backend: "${provider}" beside the model and drop the provider`,
      );
  };
  validateModelBlock(r, problems, { checkModelTriple, checkString, topBackend, checkLegacyProvider });
  validateAgentsBlock(r, problems, rawFile, {
    checkString,
    checkStringArray,
    checkKnownKeys,
    checkBackendConfig,
    checkCodexConfigKeys,
  });
  checkNumber(r, "", "maxConcurrent", POSITIVE_INTEGER);
  checkNumber(r, "", "mergeBatchMax", POSITIVE_INTEGER);
  checkNumber(r, "", "maxConcurrentChecks", POSITIVE_INTEGER);
  checkNumber(r, "", "worktreeSlots", POSITIVE_INTEGER);
  checkNumber(r, "", "minRunIntervalSeconds", DURATION_NON_NEGATIVE);
  checkNumber(r, "", "runTimeoutSeconds", DURATION_POSITIVE);
  checkNumber(r, "", "quietTimeoutSeconds", DURATION_OR_DISABLED);
  checkNumber(r, "", "toolCallStallSeconds", DURATION_OR_DISABLED);
  checkNumber(r, "", "logMaxBytes", POSITIVE);
  checkNumber(r, "", "sessionRetentionDays", NON_NEGATIVE_OR_DISABLED);
  checkNumber(r, "", "maxDailyCostUsd", DOLLAR_CAP);
  // Work ratio 1a/4: the maintenance allowance ratio is a number of 0 or more (a larger value
  // effectively disables the cap, so there is no separate off switch).
  checkNumber(r, "", "maintenancePerWorkMerge", NON_NEGATIVE);
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

  // New-project bootstrap (plans/work-ratio.md, "New-project bootstrap"): an absent section
  // means no bootstrap. `untilPlansDone` is a count of plans that must reach `## Done`, so it is
  // an integer of at least 1 — 0 or a fraction can never be reached and would hold the
  // maintenance roles forever.
  checkObjectSection(r, "bootstrap", problems, (o) => {
    checkKnownKeys(o, BOOTSTRAP_KEYS, "bootstrap", problems);
    checkNumber(o, "bootstrap.", "untilPlansDone", POSITIVE_INTEGER);
  });

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
    // mergeCommand likewise: an absent key falls back to the gate command (Fast merge
    // "Defaults"), and a blank string means off, which runs the full check in the merge lock.
    checkString(o, "check.", "mergeCommand");
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
    checkStringArray(o, "review.", "afterMerge");
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
    checkEntryBackend(o, "review", problems);
    if ((o.provider ?? r.provider) === undefined)
      checkRetiredSelector("review.model", o.model, typeof o.backend === "string" ? o.backend : topBackend, problems);
    checkLegacyProvider(o.provider ?? r.provider, "review.", typeof o.backend === "string" ? o.backend : topBackend);
    checkNumber(o, "review.", "timeoutSeconds", DURATION_POSITIVE);
  });

  validateFallbackBlock(r, problems, {
    checkModelTriple,
    checkLegacyProvider,
    tierBackend,
    eachTierBackend,
  });

  // Custom roles (plans/user-defined-loops.md): names become worktree dirs and git refs, so
  // they are validated strictly — a colliding name would silently shadow a built-in's prompt
  // (roleById wins in runPrompt), validation makes that impossible instead of subtle. The
  // collected names feed the roles cross-check below: an id under `roles` is valid when it is
  // in the catalog OR listed as a customRoles name.
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
        checkEntryBackend(o, `roles.${id}`, problems);
        if ((o.provider ?? r.provider) === undefined)
          checkRetiredSelector(`roles.${id}.model`, o.model, typeof o.backend === "string" ? o.backend : topBackend, problems);
        checkLegacyProvider(o.provider ?? r.provider, `roles.${id}.`, typeof o.backend === "string" ? o.backend : topBackend);
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

  // review.afterMerge names roles, so a typo'd id would silently keep that role reviewed before
  // merging; the director is refused because its changes always merge on a review first.
  if (isJsonObject(r.review) && Array.isArray(r.review.afterMerge)) {
    r.review.afterMerge.forEach((id: unknown, i) => {
      if (typeof id !== "string" || id.trim() === "") return; // Already reported by checkStringArray.
      if (id === DIRECTOR_ROLE) problems.push(`review.afterMerge[${i}] must not be "${DIRECTOR_ROLE}" — its changes are always reviewed before merging`);
      else checkKnownRoleId("review.afterMerge", id, customNames, problems);
    });
  }

  // Per-role daily cost caps (src/gates/role-cap-gates.ts): each key must name a known role —
  // built-in or customRoles — because a typo'd id would silently no-op the cap, the exact
  // silent-ignore class the `roles.<id>` check exists to prevent (the customNames set above
  // is fully collected by this point, so a custom role can be capped). Each value is a
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
  // team-wide key takes), and the message names the key and the offending id/value verbatim.
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

  // Per-provider concurrency caps (plans/provider-concurrency.md §1): a map from provider
  // key to a positive integer. Unlike the per-role maps above, an unknown provider name is
  // NOT a validation error — providers live in pi's models.json, which validation does not
  // read, and a fallback's provider may only come into use later (doctor warns in part 5/5).
  // Each value must be a positive integer under a non-empty key.
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
