import fs from "node:fs";
import type { TumwaterConfig, RoleConfig } from "./config-schema.js";
import type { ResolvedModelConfig } from "./config-views.js";
import { allRoleIds } from "../roles/roles.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { CONFIG_BASENAME, configPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { isJsonObject } from "../files/json-object.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { validateConfig } from "./config-validation.js";

/** Read and parse one of the config JSON files, phrasing a parse failure as
 * `<basename> is not valid JSON: <reason>` — the one wording every consumer of these files
 * surfaces (loadConfig throws it, config-example.ts's exampleConfigProblem returns it,
 * seedConfig/exampleDrift fall back on it). `problem` is set exactly when parsing failed; `raw` is the parsed value
 * otherwise (never null on failure paths, so callers need no separate existence check). */
export function parseJsonConfig(
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
 * telemetry on ~2 h, readme on 30 min, plan and organize on 1 h), with defaults for concurrency,
 * timeouts, log size, retention, thrash detection, idle backoff, self-redeploy, and review
 * settings. The return type is the resolved view (config-views.ts): a freshly defaulted config
 * has no model map to resolve — only a loaded file can carry one — so every call site that hands
 * a default into a pi run (pi.ts, tests) satisfies ResolvedModelConfig directly. */
export function defaultConfig(): ResolvedModelConfig {
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
  // Organize on a 1 h clock: at the global 20 s clock it landed 45 of 86 commits in four hours
  // (2026-10-05/06), a whole-tree reorg one directory at a time, each move conflicting with
  // every in-flight branch. Restructuring pays off at a slower rate than code changes, and
  // fewer, better-considered runs suit its larger changes (its scope is not the others').
  roles.organize = { enabled: true, minTickIntervalSeconds: 3600 };
  return {
    piArgs: [],
    maxConcurrent: 6,
    // Three is the fleet's realistic concurrent-role count: a busy queue coalesces the
    // common case (a few roles land in the same poll) while the worst case stays bounded.
    landBatchMax: 3,
    // Two suites at once: one landing can verify while the next author's gate check runs,
    // without a burst stacking every check on the host beside the authors' own test runs.
    maxConcurrentChecks: 2,
    minTickIntervalSeconds: 20,
    // Four hours: the largest tick a hosted model legitimately took and still landed work
    // measured 185 minutes (BUGS.md 2026-09-29), so 30 minutes discarded real work and burned
    // every resume before the task could finish. A run that stops making progress is still
    // bounded earlier by the quiet watchdog, not by this cap.
    tickTimeoutSeconds: 4 * 60 * 60,
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
    // Disk floor (plans/disk-floor.md, part 1/4): when the volume the worktrees live on drops
    // below this many GB free, the fleet holds new work until it climbs 5 GB back above it.
    // 10 GB leaves room for an in-flight tick to finish and a state write to land. 0 disables.
    diskHoldGB: 10,
    // Pressure reclaim (plans/disk-floor.md, part 2/4): below this many GB free, a background
    // pass deletes gitignored build outputs from idle worktrees before the 10 GB hold engages.
    // 40 GB leaves room for a build-heavy fleet to keep working; 0 disables reclaim.
    diskReclaimGB: 40,
    // Friction is flagged only when a changed tick burns BOTH thresholds (src/loop/loop.ts): the
    // absolute turn count alone measures model speed, so a fast model's ordinary 40+ turn /
    // few-minute tick stays unflagged, while a genuinely hard tick that burned 40+ turns over
    // half an hour or more still is (BUGS.md 2026-09-19). Tuned for the ~27B local model at
    // 24-35 tok/s, where 40 turns is half an hour of work.
    thrashTurns: 40,
    thrashMinutes: 30,
    idleBackoff: { initialSeconds: 120, factor: 2, maxSeconds: 3600 },
    // A self-hosting fleet redeploys itself onto a green main (src/redeploy/redeploy.ts): the alternative
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
export function overlayDefaults(base: TumwaterConfig, cfg: Partial<TumwaterConfig>): TumwaterConfig {
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
 * last-known-good holds) instead of re-checking existence and coming back as the defaults.
 *
 * Two validation passes, so load enforces exactly what saveConfig and applyConfigRequest do
 * (they gate the fully merged shape): the raw file first, so its own errors keep their precise
 * messages — a whole-section wrong type degrades or crashes under overlaying (a string where
 * `customLoops` belongs makes the merge itself throw) — then the merged result, so cross-field
 * rules that depend on defaults catch the shape the file actually produces: a file naming only
 * `idleBackoff.maxSeconds` is judged against the default initialSeconds here, not waved
 * through to be rejected by the next save or silently clamped at runtime. */
function loadPresentConfig(file: string): TumwaterConfig {
  const { raw, problem } = parseJsonConfig(file, CONFIG_BASENAME);
  if (problem !== undefined) throw new Error(problem);
  validateConfig(raw);
  const merged = overlayDefaults(defaultConfig(), raw as Partial<TumwaterConfig>);
  validateConfig(merged);
  return merged;
}

/** Load tumwater.json without throwing: either the validated config or the error message
 * that replaced it — never both, never neither. The `error?: undefined` discriminants let a
 * destructured `config`/`error` pair narrow each other, so a caller that checks
 * `config === undefined` sees `error` as a plain string. Used by every caller that must
 * degrade on a broken tumwater.json instead of throwing (the orchestrator's live-reload
 * poll, the doctor checks, the startup gate, `tumwater config`), where a broken file must
 * not stop the caller — callers keep their last-known-good config and surface `error`. */
export function loadConfigSafe(
  root: string,
): { config: TumwaterConfig; error?: undefined } | { config?: undefined; error: string } {
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
// freshness check as files/tail.ts's incremental log readers. Keyed by root so distinct projects in
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
 * gate (startup-gate.ts) and loadConfig's first-run defaults are unaffected. */
export function loadConfigCached(root: string): { config?: TumwaterConfig; error?: string; missing?: true } {
  const file = configPath(root);
  try {
    const cfg = cachedByStat(configCache, root, file, () => loadPresentConfig(file), cloneConfig);
    return cfg ? { config: cfg } : { missing: true }; // null only when the stat found no file.
  } catch (err) {
    return { error: errorMessage(err) }; // Broken — retry next poll.
  }
}

/** The live resolved config for `root`: the stat-cached read (loadConfigCached) with a broken
 * or vanished file degrading to the defaults — the one home of that fallback, shared by every
 * mid-run reader that must keep working when tumwater.json is briefly broken (the baseline
 * check's per-call config, the red-main gate, the stall threshold), so a change to the policy
 * (what degrades, what logs) cannot drift between them. Missing is degraded here too, unlike
 * loadConfigCached's own contract — callers of this helper want A config, never an incident. */
export function liveConfig(root: string): TumwaterConfig {
  return loadConfigCached(root).config ?? defaultConfig();
}

/** Persist a config after validating it, so an invalid tumwater.json can never be written.
 * Written atomically (writeJsonAtomic, trailing newline — the POSIX-newline convention here
 * and at config-write.ts, the file's other writers): the config-live poller re-reads the file
 * every ~2 s, so a plain overwrite could hand it a torn read mid-write. */
export function saveConfig(root: string, config: TumwaterConfig): void {
  validateConfig(config);
  writeJsonAtomic(configPath(root), config, true);
}

/** Canonical serialization for config comparison: object keys are sorted recursively so a mere
 * reordering of the same content never looks like a change; arrays keep their order (order is
 * meaningful for `piArgs` and `customLoops`). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isJsonObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
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

/** Every valid role id a READ-ONLY surface accepts: the catalog plus the user-defined loops,
 * read through loadConfigCached (which never throws), so a transiently broken tumwater.json
 * falls back to the built-in catalog instead of taking the view down or refusing every id.
 * The one home of that fallback rule — parseRoleScope, gui/gui-endpoint-commands'
 * validRoleIds, and
 * prompt-commands.ts's cmdPrompt --list mode all resolve their id set through it, so they
 * cannot drift. (Read-
 * only deliberately: state-changing commands resolve ids through loadConfig and fail loudly,
 * because the operator is owed the config error before a write.) */
export function knownRoleIdsCached(root: string): string[] {
  const { config } = loadConfigCached(root);
  return config ? knownRoleIds(config) : allRoleIds();
}

/** Ids of the enabled roles, in config.roles order (catalog order for known ids). */
export function enabledRoleIds(config: TumwaterConfig): string[] {
  return Object.entries(config.roles)
    .filter(([, rc]) => rc.enabled)
    .map(([id]) => id);
}
