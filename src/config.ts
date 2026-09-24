import fs from "node:fs";
import type { FallbackModelConfig, TumwaterConfig, RoleConfig } from "./config-schema.js";
import { allRoleIds } from "./roles.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { CONFIG_BASENAME, configPath, EXAMPLE_CONFIG_BASENAME, exampleConfigPath } from "./paths.js";
import { errorMessage } from "./text.js";
import { isJsonObject } from "./json-object.js";
import { validateConfig } from "./config-validation.js";

/** Read and parse one of the config JSON files, phrasing a parse failure as
 * `<basename> is not valid JSON: <reason>` — the one wording every consumer of these files
 * surfaces (loadConfig throws it, exampleConfigProblem returns it, seedConfig/exampleDrift
 * fall back on it). `problem` is set exactly when parsing failed; `raw` is the parsed value
 * otherwise (never null on failure paths, so callers need no separate existence check). */
function parseJsonConfig(
  file: string,
  basename: string,
): { raw?: unknown; problem?: string } {
  try {
    return { raw: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { problem: `${basename} is not valid JSON: ${errorMessage(err)}` };
  }
}

/** Build the default TumwaterConfig: every role enabled (steward on its slow ~6 h tick, qa and
 * telemetry on ~2 h, readme on 30 min, plan on 1 h), with defaults for concurrency, timeouts, log size,
 * retention, thrash detection, idle backoff, self-redeploy, and review settings. */
export function defaultConfig(): TumwaterConfig {
  const roles: Record<string, RoleConfig> = {};
  for (const id of allRoleIds()) roles[id] = { enabled: true };
  // The steward works on a slow clock (~6 h): whole-system curation, not shipping work.
  // Assign the full entry rather than mutating `roles.steward`: under
  // noUncheckedIndexedAccess that index access is `RoleConfig | undefined`.
  roles.steward = { enabled: true, minTickIntervalSeconds: 21600 };
  // QA exercises the product like a user on a ~2 h clock: user flows change slower than code.
  roles.qa = { enabled: true, minTickIntervalSeconds: 7200 };
  // Telemetry reads the event log on the same slow clock: the digest is a windowed view, so a
  // tick a couple of hours apart reads a new window rather than re-filing the same cluster.
  roles.telemetry = { enabled: true, minTickIntervalSeconds: 7200 };
  // The bookkeeping roles run on slower clocks too. In dogfood readme (95 commits, 82 of them
  // status syncs) and plan (80, 44 of them refine/re-audit notes) were 30% of every commit and
  // 20% of every tick: readme woke on every merge to restamp one line, and plan re-audited plans
  // nobody had touched. A 30 min readme clock batches a burst of landings into one sync; a 1 h
  // plan clock leaves the slots to the loops that ship. Both still wake early when main moves —
  // the clock only bounds how often.
  roles.readme = { enabled: true, minTickIntervalSeconds: 1800 };
  roles.plan = { enabled: true, minTickIntervalSeconds: 3600 };
  return {
    piArgs: [],
    maxConcurrent: 6,
    // Three is the fleet's realistic concurrent-role count: a busy queue coalesces the
    // common case (a few roles land in the same poll) while the worst case stays bounded.
    landBatchMax: 3,
    minTickIntervalSeconds: 20,
    tickTimeoutSeconds: 1800,
    quietTimeoutSeconds: 1800,
    // Five minutes of command silence is well past any legitimate prefill or slow scan, and
    // lands long before the quiet watchdog's kill — the warning names what is hung while there
    // is still time to see it (BUGS.md 2026-09-13: stalled tool calls were invisible until the
    // kill).
    toolCallStallSeconds: 300,
    logMaxBytes: 16 * 1024 * 1024,
    sessionRetentionDays: 7,
    // An unattended fleet must not spend unbounded (plans/daily-cost-budget.md): $50/day is
    // generous for a normal day of autonomous work on mid-tier API models and low enough to
    // catch a runaway. Local-model fleets report $0 cost, so the cap never fires for them.
    maxDailyCostUsd: 50,
    // Friction is flagged only when a changed tick burns BOTH thresholds (src/loop.ts): the
    // absolute turn count alone measures model speed, so a fast model's ordinary 40+ turn /
    // few-minute tick stays unflagged, while a genuinely hard tick that burned 40+ turns over
    // half an hour or more still is (BUGS.md 2026-09-19). Tuned for the ~27B local model at
    // 24-35 tok/s, where 40 turns is half an hour of work.
    thrashTurns: 40,
    thrashMinutes: 30,
    idleBackoff: { initialSeconds: 120, factor: 2, maxSeconds: 3600 },
    // A self-hosting fleet redeploys itself onto a green main (src/redeploy.ts): the alternative
    // — a process that never reloads its own code — ran ten days stale in dogfood.
    autoRestart: true,
    // Config changes no longer ride the commit path (plans/portability.md §3/7): the director
    // writes a request file the harness applies to the live config before any commit, so no
    // diff can ever touch tumwater.json and the exemption — once the only thing keeping an
    // explicit user instruction from being discarded by a rejected review — has nothing left
    // to exempt. Removing it also closes the path where a director tick could land a mixed
    // doc-plus-config diff unreviewed.
    review: { enabled: true, exemptPaths: ["*.md", "docs/**"] },
    customLoops: [],
    roles,
  };
}

/** Overlay a partial config's top-level keys over `base`, merging the sub-objects the way the
 * file loader always has: shared by loadConfig and init's seeding (plans/portability.md §4a/7)
 * so a seeded config behaves exactly like the equivalent hand-written one. Owns its result — a
 * caller mutating what comes back cannot reach back into the parsed input. */
function overlayDefaults(base: TumwaterConfig, cfg: Partial<TumwaterConfig>): TumwaterConfig {
  const merged: TumwaterConfig = {
    ...base,
    ...cfg,
    idleBackoff: { ...base.idleBackoff, ...(cfg.idleBackoff ?? {}) },
    review: { ...base.review, ...(cfg.review ?? {}) },
    piArgs: cfg.piArgs ?? base.piArgs,
    // Absent stays absent: no fallback = today's pause behavior.
    ...(cfg.fallbackModel ? { fallbackModel: { ...cfg.fallbackModel } } : {}),
    customLoops: (cfg.customLoops ?? []).map((c) => ({ ...c })),
    roles: { ...base.roles },
  };
  // Seed each user-defined loop into roles BEFORE the overlay loop so a file's `roles` section
  // overrides per-key for a custom exactly like for built-ins (enabled, instructions,
  // tickInterval, provider/model); seeding after would silently ignore those overrides.
  // A custom absent from `roles` stays enabled. Insertion order = built-ins then customs in
  // array order — the display and startup tie-break order.
  for (const c of merged.customLoops) {
    if (!merged.roles[c.name]) merged.roles[c.name] = { enabled: true };
  }
  for (const [id, rc] of Object.entries(cfg.roles ?? {})) {
    merged.roles[id] = { ...(merged.roles[id] ?? { enabled: true }), ...rc };
  }
  return merged;
}

/** Build the config `init` seeds a fresh tumwater.json with (plans/portability.md §4a/7): the
 * tracked tumwater.example.json overlaid on the defaults when the project ships one, the bare
 * defaults when it does not. Never throws: an unparseable or invalid template falls back to the
 * defaults, because init must not die on a bad template — the user's own tumwater.json is what
 * validation protects. */
export function seedConfig(root: string): TumwaterConfig {
  const base = defaultConfig();
  const file = exampleConfigPath(root);
  // Absent and broken both seed the bare defaults: no template, or one that cannot serve.
  if (!fs.existsSync(file) || exampleConfigProblem(root) !== null) return base;
  // The template already passed exampleConfigProblem's read; reparse here instead of threading
  // the earlier raw through, so a file torn between the two reads seeds the bare defaults.
  const { raw, problem } = parseJsonConfig(file, EXAMPLE_CONFIG_BASENAME);
  if (problem !== undefined) return base;
  return overlayDefaults(base, raw as Partial<TumwaterConfig>);
}

/** Why tumwater.example.json cannot serve as a seed template, or null when it can: null when
 * the file is absent or parses and validates, a human message naming the file when it exists
 * but is unparseable or holds invalid values. This is the only signal a broken template ever
 * gets — seedConfig falls back to the bare defaults and exampleDrift reports no drift, so
 * without it the operator's template intent (their roles/intervals baseline for fresh clones)
 * is ignored with nothing anywhere saying so. doctor's init check surfaces the message. */
export function exampleConfigProblem(root: string): string | null {
  const file = exampleConfigPath(root);
  if (!fs.existsSync(file)) return null;
  const { raw, problem } = parseJsonConfig(file, EXAMPLE_CONFIG_BASENAME);
  if (problem !== undefined) return problem;
  try {
    validateConfig(raw, EXAMPLE_CONFIG_BASENAME);
  } catch (err) {
    return errorMessage(err);
  }
  return null;
}

/** Top-level keys the tracked template sets that the local tumwater.json lacks
 * (plans/portability.md §4a/7): what doctor's init check reports as template drift. Whole-key
 * only — sub-objects are reported as units, and a key present in both files is the local file's
 * business even when the values differ (deep diffing is a bigger design than this needs). []
 * when either file is missing or unparseable: with no template there is nothing to drift from,
 * and a broken local file is checkInit's fail, not a drift line. */
export function exampleDrift(root: string): string[] {
  const example = exampleConfigPath(root);
  const config = configPath(root);
  if (!fs.existsSync(example) || !fs.existsSync(config)) return [];
  const template = parseJsonConfig(example, EXAMPLE_CONFIG_BASENAME);
  const local = parseJsonConfig(config, CONFIG_BASENAME);
  if (template.problem !== undefined || local.problem !== undefined) return [];
  if (!isJsonObject(template.raw) || !isJsonObject(local.raw)) return [];
  return Object.keys(template.raw).filter((k) => !(k in (local.raw as object)));
}

/** Load tumwater.json, filling in defaults for anything missing. Throws an Error with an
 * actionable message when the file is malformed or holds invalid values (see validateConfig).
 * An absent file is the bare defaults — the startup and one-shot view; the live-reload poll
 * goes through loadConfigCached instead, where an absent file is an incident, not defaults. */
export function loadConfig(root: string): TumwaterConfig {
  const file = configPath(root);
  if (!fs.existsSync(file)) return defaultConfig();
  return loadPresentConfig(file);
}

/** loadConfig past its existence check: parse, validate, and default-fill a file the caller
 * has already seen. Split out so loadConfigCached's stat stays its ONE presence check — a file
 * deleted between that stat and this read throws (a broken file for that one poll, so
 * last-known-good holds) instead of re-checking existence and coming back as the defaults. */
function loadPresentConfig(file: string): TumwaterConfig {
  const { raw, problem } = parseJsonConfig(file, CONFIG_BASENAME);
  if (problem !== undefined) throw new Error(problem);
  validateConfig(raw);
  return overlayDefaults(defaultConfig(), raw as Partial<TumwaterConfig>);
}

/** Load tumwater.json without throwing: either the validated config or the error message.
 * Used by the orchestrator's live-reload poll, where a broken file must not stop the fleet —
 * callers keep their last-known-good config and surface `error` as a warning. */
export function loadConfigSafe(root: string): { config?: TumwaterConfig; error?: string } {
  try {
    return { config: loadConfig(root) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// Per-poll config cache (stat-cache.cachedByStat): the orchestrator live-reloads tumwater.json
// every ~2 s and both dashboards poll snapshot() every second, but the file changes only when
// a user edits it — between edits it sits unchanged for hours. Serve an unchanged file from
// this stat-keyed cache: one stat syscall per root per poll instead of re-reading, re-parsing,
// and re-validating on every poll (validation cost grows with config size, so the saving
// widens as role instructions grow). Any write invalidates via dev/ino/mtime/size — the same
// freshness check as tail.ts's incremental log readers. Keyed by root so distinct projects in
// one process never collide; capped inside cachedByStat so many short-lived roots in tests
// cannot grow it unbounded.
const configCache = new Map<string, StatKeyedValue<TumwaterConfig>>();

/** Clone a loaded config so each caller owns its data: mutating one result (a role entry's
 * enabled flag, the piArgs array) must not poison later polls — the same contract as every
 * other cachedByStat consumer. */
function cloneConfig(c: TumwaterConfig): TumwaterConfig {
  return {
    ...c,
    piArgs: [...c.piArgs],
    idleBackoff: { ...c.idleBackoff },
    review: { ...c.review },
    ...(c.fallbackModel ? { fallbackModel: { ...c.fallbackModel } } : {}),
    customLoops: c.customLoops.map((cl) => ({ ...cl })),
    roles: Object.fromEntries(Object.entries(c.roles).map(([id, rc]) => [id, { ...rc }])),
  };
}

/** loadConfigSafe with a stat-keyed cache for unchanged files (see above): the same
 * last-known-good contract at the call sites, but a steady-state poll of an unedited file costs
 * one stat instead of a read + parse + validate. A successful load is cached; a broken file is
 * never cached — each poll retries it fresh so a torn live edit or a repair is picked up on the
 * next cycle. A missing file is `missing` — neither a config nor an error — and never the
 * defaults: once a fleet has loaded its config, the file vanishing is an incident, not a
 * reconfiguration (BUGS.md 2026-09-23: a landing's fast-forward deleted it and the fleet ran
 * 8.6 h on defaults), so callers keep their last-known-good exactly as for a broken file, or
 * fall back to defaults only when they never saw one. Startup's "missing ⇒ not initialized"
 * gate (cli.ts) and loadConfig's first-run defaults are unaffected. */
export function loadConfigCached(root: string): { config?: TumwaterConfig; error?: string; missing?: true } {
  const file = configPath(root);
  try {
    const cfg = cachedByStat(configCache, root, file, () => loadPresentConfig(file), cloneConfig);
    return cfg ? { config: cfg } : { missing: true }; // null only when the stat found no file.
  } catch (err) {
    return { error: errorMessage(err) }; // Broken — retry next poll.
  }
}

/** Persist a config after validating it, so an invalid tumwater.json can never be written. */
export function saveConfig(root: string, config: TumwaterConfig): void {
  validateConfig(config);
  fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

/** Canonical serialization for config comparison: object keys are sorted recursively so a mere
 * reordering of the same content never looks like a change; arrays keep their order (order is
 * meaningful for `piArgs` and `customLoops`). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Sorted names of the config settings whose value differs between two loaded configs, for the
 * orchestrator's live-reload event. `maxConcurrent` and `sessionRetentionDays` are skipped: each
 * already has its own, more informative event. The `roles` map is never reported whole — only
 * each differing `roles.<id>` — so a `customLoops` add/remove names both the section and the
 * affected role. */
export function changedConfigKeys(prev: TumwaterConfig, next: TumwaterConfig): string[] {
  const skip = new Set(["maxConcurrent", "sessionRetentionDays", "roles"]);
  const keys: string[] = [];
  const prevRecord = prev as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])) {
    if (skip.has(key)) continue;
    if (stableJson(prevRecord[key]) !== stableJson(nextRecord[key])) keys.push(key);
  }
  for (const id of new Set([...Object.keys(prev.roles), ...Object.keys(next.roles)])) {
    if (stableJson(prev.roles[id]) !== stableJson(next.roles[id])) keys.push(`roles.${id}`);
  }
  return keys.sort();
}

/** The names of the user-defined loops, in array order (plans/user-defined-loops.md).
 * One source of truth for "which ids are user-defined" so consumers cannot drift. */
export function customLoopNames(config: TumwaterConfig): string[] {
  return config.customLoops.map((c) => c.name);
}

/** True when `id` is a user-defined loop rather than a catalog role. */
export function isCustomRole(config: TumwaterConfig, id: string): boolean {
  return config.customLoops.some((c) => c.name === id);
}

/** Every valid role id — the catalog plus the user-defined loops (the one answer for "which
 * ids exist", so consumers cannot drift from each other). */
export function knownRoleIds(config: TumwaterConfig): string[] {
  return [...allRoleIds(), ...customLoopNames(config)];
}

/** Ids of the enabled roles, in config.roles order (catalog order for known ids). */
export function enabledRoleIds(config: TumwaterConfig): string[] {
  return Object.entries(config.roles)
    .filter(([, rc]) => rc.enabled)
    .map(([id]) => id);
}

/** Apply a sub-config's optional provider/model/thinking overrides over the top-level
 * values — the one place that fallback lives, so adding an override field touches only
 * this. */
function withModelOverrides(
  config: TumwaterConfig,
  o: { provider?: string; model?: string; thinking?: string },
): TumwaterConfig {
  return {
    ...config,
    provider: o.provider ?? config.provider,
    model: o.model ?? config.model,
    thinking: o.thinking ?? config.thinking,
  };
}

/** The config as seen by one role: role-level provider/model/thinking overrides applied
 * over the top-level values, plus the per-role minTickIntervalSeconds (a slow clock for
 * roles that should act rarely) falling back to the global value when unset. */
export function configForRole(config: TumwaterConfig, role: string): TumwaterConfig {
  const rc = config.roles[role];
  if (!rc) return config;
  return {
    ...withModelOverrides(config, rc),
    minTickIntervalSeconds: rc.minTickIntervalSeconds ?? config.minTickIntervalSeconds,
  };
}

/** The config as seen by the review gate's pi runs: the top-level `review` section's
 * optional provider/model/thinking overrides applied over the top-level values — so a
 * strong model can review what the cheap model wrote. Reads its own `review` section on
 * purpose (not via configForRole): a pseudo-role entry under `roles` would fail validation
 * (unknown role id) and, if accepted, spawn a runner with no catalog prompt. */
export function reviewConfig(config: TumwaterConfig): TumwaterConfig {
  return withModelOverrides(config, config.review);
}

/** Hard wall-clock cap on the review gate's build-fix run (src/review.ts). The run holds the
 * landing slot the whole queue waits on, so it never gets the tick's budget — 54 000 s in the
 * live tumwater.json, under which two fix runs held the slot for 1 h 52 m and 4 h 35 m while
 * load-testing the shared host to reproduce a flake (BUGS.md 2026-09-23). Sized from what a real
 * fix needs: the full suite takes ~2.5 min on an unloaded host (the gate's own checks log
 * 70–170 s under fleet load; the harness allows one 300 s, BUILD_CHECK_TIMEOUT_MS), and a fix is
 * reading the failure, an edit, a few incremental builds and targeted runs of the failing test
 * file, then ONE full run of the check — ~5 min of commands plus ten-odd model turns, well
 * inside 20 min even on a slow model. The fleet's genuine fixes (a compile error, a missing
 * fixture) finished in 3–5 min; every fix run on record past 25 min was hunting a load flake. */
export const BUILD_FIX_TIMEOUT_S = 1200;

/** The build-fix run's quiet-watchdog cap: two full-suite budgets. A full run piped through
 * `tail` reports progress only when its tool call ends, so one silent full run of the check
 * (≤ 300 s) never trips it, while a hung tool call dies at 10 min instead of idling out the
 * whole BUILD_FIX_TIMEOUT_S. */
export const BUILD_FIX_QUIET_S = 600;

/** The config as seen by the gate's build-fix run: the reviewer's model wiring (reviewConfig)
 * with BUILD_FIX_*'s hard caps overriding the tick's budget — the same shape as the SUMMARY
 * follow-up's caps in src/loop-pi.ts. A smaller configured value still wins, and a disabled
 * quiet watchdog (0) is armed at the cap: the fix run's bound must not hang on an operator
 * setting tuned for hours-long authoring runs. */
export function buildFixConfig(config: TumwaterConfig): TumwaterConfig {
  const cfg = reviewConfig(config);
  return {
    ...cfg,
    tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, BUILD_FIX_TIMEOUT_S),
    quietTimeoutSeconds:
      cfg.quietTimeoutSeconds > 0 ? Math.min(cfg.quietTimeoutSeconds, BUILD_FIX_QUIET_S) : BUILD_FIX_QUIET_S,
  };
}

/** Default wall-clock budget for one reviewer run (`review.timeoutSeconds`). The reviewer holds
 * the landing slot the whole queue waits on, and its only other limits were the tick's budget
 * and the quiet watchdog: reviews measured 2026-09-22/23 ran 2.3 min median, 9.2 min p90 and
 * 24.6 min max, while earlier days had 1.5–3.5 h reviews. 15 min clears the ordinary review and
 * kills a wedged one in minutes instead of the tick's hours. */
export const REVIEW_TIMEOUT_S = 900;

/** The config as seen by the gate's reviewer run: the reviewer's model wiring (reviewConfig)
 * with its own time budget — `review.timeoutSeconds`, default REVIEW_TIMEOUT_S — overriding
 * the tick's, the same shape as buildFixConfig above. A smaller tickTimeoutSeconds still wins. */
export function reviewRunConfig(config: TumwaterConfig): TumwaterConfig {
  const cfg = reviewConfig(config);
  return {
    ...cfg,
    tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S),
  };
}

/** The provider/model pair a configured fallback resolves to — its own fields over the
 * top-level ones, the same precedence every other override section uses — or null when no
 * fallback is configured. One definition so the freeness check (src/pi-models.ts), the
 * dashboards' badge, and applyFallbackModel below cannot disagree about WHICH model the
 * budget gate would engage. */
export function fallbackPair(config: TumwaterConfig): FallbackModelConfig | null {
  const fb = config.fallbackModel;
  if (!fb) return null;
  return {
    ...(fb.provider ?? config.provider ? { provider: fb.provider ?? config.provider } : {}),
    ...(fb.model ?? config.model ? { model: fb.model ?? config.model } : {}),
    ...(fb.thinking ?? config.thinking ? { thinking: fb.thinking ?? config.thinking } : {}),
  };
}

/** The config as seen by a role loop running on the free fallback model
 * (plans/fallback-model.md): the fallback's provider/model/thinking installed as the top-level
 * values AND every per-role and reviewer model override dropped, so that EVERY seam that could
 * otherwise reach a priced model — an author run, its reviewer, a conflict resolver — resolves
 * to the one free pair. Dropping the overrides is the point: a role pinned to a paid model in
 * tumwater.json must not keep spending after the cap is reached. Everything else (intervals,
 * thresholds, exempt paths, the cap itself) is untouched, so the gate keeps re-evaluating
 * against the same numbers. Returns `config` unchanged when no fallback is configured. */
export function applyFallbackModel(config: TumwaterConfig): TumwaterConfig {
  const pair = fallbackPair(config);
  if (!pair) return config;
  const stripModel = <T extends { provider?: string; model?: string; thinking?: string }>(o: T): T => {
    const { provider: _p, model: _m, thinking: _t, ...rest } = o;
    return rest as T;
  };
  return {
    ...config,
    provider: pair.provider,
    model: pair.model,
    thinking: pair.thinking,
    review: stripModel(config.review),
    roles: Object.fromEntries(Object.entries(config.roles).map(([id, rc]) => [id, stripModel(rc)])),
  };
}
