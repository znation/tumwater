import fs from "node:fs";
import type { TumwaterConfig, RoleConfig } from "./types.js";
import { allRoleIds } from "./roles.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { configPath } from "./paths.js";
import { errorMessage } from "./text.js";
import { show, validateConfig } from "./config-validation.js";

/** Build the default TumwaterConfig: every role enabled (steward on its slow ~6 h tick, qa on
 * ~2 h, readme on 30 min, plan on 1 h), with defaults for concurrency, timeouts, log size,
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
    thrashTurns: 40,
    thrashMinutes: 60,
    idleBackoff: { initialSeconds: 120, factor: 2, maxSeconds: 3600 },
    // A self-hosting fleet redeploys itself onto a green main (src/redeploy.ts): the alternative
    // — a process that never reloads its own code — ran ten days stale in dogfood.
    autoRestart: true,
    // tumwater.json joins the default exemptions (plans/user-defined-loops.md): only the
    // director can ever produce a diff touching that file, so exempting it means "user-directed
    // config changes skip model review" — consistent with the md-only exemption's philosophy.
    // Without this an explicit user command could be silently discarded: a rejected director
    // tick does not re-queue its prompt. validateConfig is the safety net instead.
    review: { enabled: true, exemptPaths: ["*.md", "docs/**", "tumwater.json"] },
    customLoops: [],
    roles,
  };
}

/** Load tumwater.json, filling in defaults for anything missing. Throws an Error with an
 * actionable message when the file is malformed or holds invalid values (see validateConfig). */
export function loadConfig(root: string): TumwaterConfig {
  const file = configPath(root);
  const base = defaultConfig();
  if (!fs.existsSync(file)) return base;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`tumwater.json is not valid JSON: ${errorMessage(err)}`);
  }
  validateConfig(raw);
  const cfg = raw as Partial<TumwaterConfig>;
  const merged: TumwaterConfig = {
    ...base,
    ...cfg,
    idleBackoff: { ...base.idleBackoff, ...(cfg.idleBackoff ?? {}) },
    review: { ...base.review, ...(cfg.review ?? {}) },
    piArgs: cfg.piArgs ?? base.piArgs,
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
    customLoops: c.customLoops.map((cl) => ({ ...cl })),
    roles: Object.fromEntries(Object.entries(c.roles).map(([id, rc]) => [id, { ...rc }])),
  };
}

/** loadConfigSafe with a stat-keyed cache for unchanged files (see above): the same return
 * shape and last-known-good contract at the call sites, but a steady-state poll of an unedited
 * file costs one stat instead of a read + parse + validate. A successful load is cached; a
 * broken file is never cached — each poll retries it fresh so a torn live edit or a repair is
 * picked up on the next cycle, and a missing file still yields defaults without touching the
 * cache. */
export function loadConfigCached(root: string): { config?: TumwaterConfig; error?: string } {
  const file = configPath(root);
  try {
    const cfg = cachedByStat(configCache, root, file, () => loadConfig(root), cloneConfig);
    if (cfg) return { config: cfg };
    return { config: defaultConfig() }; // Missing — defaults, as loadConfig does.
  } catch (err) {
    return { error: errorMessage(err) }; // Broken — retry next poll.
  }
}

/** Persist a config after validating it, so an invalid tumwater.json can never be written. */
export function saveConfig(root: string, config: TumwaterConfig): void {
  validateConfig(config);
  fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

/** One definition of "a valid daily budget cap" (the TUI's Ctrl+B editor and the GUI's
 * /api/budget endpoint both run their input through it): a finite number of 0 or more —
 * 0 disables the gate, fractional dollars allowed (the badge renders cents). Returns an
 * actionable error message for anything else so both surfaces can flash it without
 * try/catch plumbing. */
export function checkDailyBudgetUsd(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return `maxDailyCostUsd must be a number of 0 or more, 0 disables (got ${show(value)})`;
  return null;
}

/** Set the daily cost budget cap in tumwater.json: fresh loadConfig (no stat cache — a
 * writer must see the latest file), validate the value, mutate ONLY that key, and write
 * atomically (tmp file + rename) because this is the first in-harness WRITER of the config
 * while readers poll it every ~2 s and two dashboards could save concurrently. A broken or
 * missing-on-disk config surfaces as an error string instead of throwing, so both UIs can
 * flash it; on any failure the file (and no tmp remnant) is left untouched. */
export function setDailyBudgetUsd(
  root: string,
  value: number,
): { ok: true } | { ok: false; error: string } {
  const problem = checkDailyBudgetUsd(value);
  if (problem) return { ok: false, error: problem };
  let cfg: TumwaterConfig;
  try {
    cfg = loadConfig(root); // fresh — bypasses the stat cache on purpose
  } catch (err) {
    return { ok: false, error: errorMessage(err) }; // broken file: never overwrite it with defaults
  }
  const file = configPath(root);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...cfg, maxDailyCostUsd: value }, null, 2) + "\n");
    fs.renameSync(tmp, file); // atomic on POSIX — readers never see a partial file
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: errorMessage(err) };
  }
  return { ok: true };
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
