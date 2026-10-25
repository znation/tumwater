import {
  MODEL_TIERS,
  BACKOFF_KEYS,
  BOOTSTRAP_KEYS,
  CHECK_KEYS,
  REVIEW_KEYS,
  TOP_LEVEL_KEYS,
} from "./config-schema.js";
import { isHarnessCodexConfigKey } from "../agent/codex/codex-args.js";
import { isJsonObject } from "../files/json-object.js";
import { expandHomeTilde } from "../files/files.js";
import os from "node:os";
import path from "node:path";
import { isNonBlankString, tooLongMessage } from "../text/text.js";
import { PREFILL_REASON } from "../text/phrases.js";
import { parseQuietHours } from "../scheduling/quiet-hours.js";
import { isBackendId } from "./model-selector.js";
import {
  AT_LEAST_ONE,
  type NumberRule,
  checkBooleanField,
  checkKnownKeys,
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
import { validateRolesAndCrossField } from "./config-validation-roles.js";

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
  // The prefill-capped prompt length check shared by a custom role's `task` and a role's
  // `instructions`: both ride into every run's prefill, so both are capped with the same
  // tooLongMessage shape and PREFILL_REASON and cannot drift. A non-string never trips it —
  // the blank/empty validity is the caller's concern (isNonBlankString for task, checkString
  // for instructions). `max` is the field's own cap constant.
  const checkPromptLength = (label: string, value: unknown, max: number): void => {
    if (typeof value === "string" && value.length > max)
      problems.push(tooLongMessage(label, value.length, max, PREFILL_REASON));
  };
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
  // unexpected. Only claude and codex accept the key, so it is inert nowhere else. The nested
  // reserve spelling (part 2b/9): the same 0 < f ≤ 1 rule the top-level `claudeWindowReserve`
  // map gets, so a bad entry can never silently no-op a reserve.
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
  // A section that carries its own model/backend pair — `review` and a custom role's entry —
  // runs the same five checks: the model-triple shape, the empty-selector-half screen
  // (checkSelectorHalves), the entry's backend resolution (checkEntryBackend), and the
  // retired-spelling plus legacy-provider pair checks against the resolved provider/backend.
  // The two blocks differ only in their config label (`at`, with a trailing dot, and `atBase`,
  // without one), so they share this one sequence and the problem order cannot drift.
  const checkModelTripleEntry = (o: Record<string, unknown>, at: string, atBase: string): void => {
    checkModelTriple(o, at, "tier-name");
    checkSelectorHalves(o, at, "model", o.provider ?? r.provider, problems);
    checkEntryBackend(o, atBase, problems);
    if ((o.provider ?? r.provider) === undefined)
      checkRetiredSelector(`${atBase}.model`, o.model, typeof o.backend === "string" ? o.backend : topBackend, problems);
    checkLegacyProvider(o.provider ?? r.provider, at, typeof o.backend === "string" ? o.backend : topBackend);
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
    checkModelTripleEntry(o, "review.", "review");
    checkNumber(o, "review.", "timeoutSeconds", DURATION_POSITIVE);
  });

  validateFallbackBlock(r, problems, {
    checkModelTriple,
    checkLegacyProvider,
    tierBackend,
    eachTierBackend,
  });

  validateRolesAndCrossField(r, problems, {
    checkString,
    checkBoolean,
    checkNumber,
    checkPromptLength,
    checkModelTripleEntry,
    checkWindowReserve,
  });

  if (problems.length > 0) {
    throw new Error(`invalid ${label}:\n  - ${problems.join("\n  - ")}`);
  }
}
