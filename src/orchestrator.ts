import type { TumwaterConfig } from "./config-schema.js";
import type { TickOutcome } from "./types.js";
import type { OrchestratorInfo } from "./fleet-state.js";
import { applyFallbackModel, changedConfigKeys, enabledRoleIds, fallbackPair, loadConfigCached } from "./config.js";
import {
  deferTick,
  dueForPrune,
  fairOrder,
  isEligible,
} from "./scheduling.js";
import { isFleetPaused } from "./fleet-state.js";
import {
  budgetGate,
  budgetPaused,
  type BudgetGate,
  FALLBACK_BREAKER_POLICY,
  type FallbackBreaker,
  type FallbackBreakerPolicy,
  fallbackDemotion,
  fallbackProbeDue,
  fallbackServing,
  fleetDailyCost,
  IDLE_FALLBACK_BREAKER,
  abandonFallbackProbe,
  recordFallbackTick,
  rekeyFallbackBreaker,
  startFallbackProbe,
} from "./budget.js";
import { RATE_LIMIT_OPEN, rateLimitHold, type RateLimitHold } from "./rate-limit-hold.js";
import { DIRECTOR_ROLE, roleTier } from "./roles.js";
import { openBugs, plannedPlans } from "./backlog.js";
import { LoopRunner } from "./loop.js";
import { branchHead, currentBranch } from "./git.js";
import { queuedLandingFiles } from "./land-queue.js";
import { drainLandingQueue, type InFlightLanding } from "./landing-drain.js";
import { logEvent, warnEvent } from "./events.js";
import { pruneOldFiles, removeQuiet } from "./files.js";
import { writeJsonFile } from "./json-files.js";
import { inboxSize } from "./inbox.js";
import {
  consumeAbortRequests,
  consumeResetRequest,
  consumeWakeRequest,
} from "./operator-requests.js";
import { fallbackModelFree, piModelsPath } from "./pi-models.js";
import { Semaphore } from "./semaphore.js";
import {
  configPath,
  landingStatePath,
  orchestratorStatePath,
  sessionsRootDir,
  toolOutputDir,
} from "./paths.js";
import { p75TickDurationMs, type Redeployer } from "./redeploy.js";
import { WorkLandedCache } from "./work-landed-cache.js";
import { BUILD_CHECK_TIMEOUT_MS } from "./build-check.js";

const POLL_MS = 2000;

/** How long a restart's hand-off waits on an in-flight landing, per phase: one window for it to
 * finish on its own, then — having aborted it — one more for the step it was in to end
 * (awaitLandingForHandoff; BUGS.md 2026-09-23). By the time a restart reaches its `finally` the
 * new build is already in dist/ and every role tick is done or aborted, so the landing is all
 * the fleet is still running: each minute spent on it is a minute nothing else ticks. A
 * landing's unbounded part is model work — its reviewer run (and, until 2026-09-24, a gate
 * build-fix run: the 2026-09-23 one held the slot for 4 h 35 m and that day's hand-off sat
 * through 97 minutes of it). Its deterministic part is bounded: at most one build check (BUILD_CHECK_TIMEOUT_MS) plus
 * git steps. So a check's bound plus a minute lets a landing already past its model runs — in
 * its last check and fast-forward — land, and gives an aborted landing's current step (a check,
 * which no abort reaches) time to end, so the hand-off does not leave a check running in a
 * lander worktree the next generation is about to reset. Not the drain's window: that is the
 * p75 of whole role ticks (over an hour on this fleet) — the very lag this bounds. */
const HANDOFF_LANDING_WINDOW_MS = BUILD_CHECK_TIMEOUT_MS + 60_000;

/** Run one role tick under the concurrency semaphore and return how long the tick itself ran,
 * in ms — null when it never started (the harness is already stopping, or `held`) or was cut
 * off by an abort. This is the restart drain's p75 sample (BUGS.md 2026-09-18). The clock starts
 * only once the permit is granted, so time a tick spends parked in the semaphore queue is not
 * counted as work: the drain waits on ticks that are already running, and folding queue wait
 * into the window would overstate how long they have left (the `tick_start`..`tick_end` span
 * the window was sized against excludes it too). Aborted ticks return null so their short
 * cut-off lengths cannot drag the window down. `now` is a test seam.
 *
 * `held` is the fleet-wide hold on new ticks (today the restart drain's), re-checked at the one
 * moment a reserved tick actually begins: when its permit is granted. A tick scheduled before
 * the hold may have parked in the semaphore queue long before it; checking the hold only at
 * scheduling let every such waiter start a fresh pi run mid-drain as slots freed — the very
 * ticks the restart then aborted (BUGS.md 2026-09-23). A held tick releases its permit without
 * calling `tick`, so it writes no state and logs no tick_start/tick_end; the caller hands its
 * reservation back. */
export async function runTimedRoleTick(
  signal: AbortSignal,
  acquire: () => Promise<void>,
  release: () => void,
  tick: () => Promise<TickOutcome>,
  now: () => number = Date.now,
  held: () => boolean = () => false,
): Promise<number | null> {
  await acquire();
  try {
    if (signal.aborted || held()) return null;
    const startedAt = now();
    const outcome = await tick();
    if (outcome.result === "aborted" || outcome.result === "user_aborted") return null;
    return now() - startedAt;
  } finally {
    release();
  }
}

/** Sleep up to ms, but wake immediately when `signal` aborts — so shutdown (SIGTERM →
 * abort) is prompt instead of waiting out the current poll cycle. The listener is removed
 * on either exit path so long-running orchestrators don't accumulate one per poll. An
 * ALREADY-aborted signal returns synchronously: addEventListener alone would never fire
 * (the abort event has come and gone), leaving shutdown to wait out a full poll. Exported
 * as a unit-test seam, like runTimedRoleTick above. */
export function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One poll of the fleet-wide 429 hold (src/rate-limit-hold.ts): gather each runner's latest
 * run that ended on a provider 429 (LoopRunner.lastRateLimit — every role's, the director's
 * included, since its 429s are the same provider's evidence), step the pure gate, and log
 * exactly one event per crossing, like the budget gate's: `rate_limit_hold` on the way in
 * (which roles tripped it, for how long, and how many relapses deep it is) and
 * `rate_limit_resumed` when it re-opens at its own deadline. Returns the new hold for the
 * caller to keep. Exported as a unit-test seam, like runTimedRoleTick above. */
export function pollRateLimitHold(
  root: string,
  prev: RateLimitHold,
  runners: readonly Pick<LoopRunner, "role" | "lastRateLimit">[],
  now: number,
): RateLimitHold {
  const observations = runners.flatMap((r) => (r.lastRateLimit ? [{ role: r.role, ...r.lastRateLimit }] : []));
  const next = rateLimitHold(prev, observations, now);
  if (prev.until === null && next.until !== null) {
    logEvent(root, {
      loop: "harness",
      type: "rate_limit_hold",
      roles: next.roles,
      holdMs: next.until - now,
      escalation: next.escalation,
    });
  } else if (prev.until !== null && next.until === null) {
    logEvent(root, { loop: "harness", type: "rate_limit_resumed" });
  }
  return next;
}

/** Wait for `promise` to settle, for at most `ms`: true when it settled in time (fulfilled or
 * rejected alike — the caller only needs to know it is over), false when the deadline lapsed
 * first. The timer is cleared on settle, so a prompt settle leaves nothing behind to hold the
 * process open. Never rejects. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

/** How the restart hand-off's wait on the in-flight landing ended: it finished inside the first
 * window, it settled once aborted, or it was still running a window after the abort and the
 * hand-off went ahead without it. */
type HandoffLandingOutcome = "finished" | "aborted" | "abandoned";

/** The restart hand-off's bounded wait on the in-flight landing (BUGS.md 2026-09-23): the
 * shutdown `finally`'s landing await when this process is about to exit for the next
 * generation. A batched landing re-enters review and build check once per change, so an
 * unbounded await here is a fleet-wide drain in disguise — the 2026-09-23 hand-off lagged its
 * own swap by 97 minutes, in silence. The wait is announced as it starts (one warning naming
 * the landing's roles), so the feed says why `restarting onto build …` is not yet followed by
 * `orchestrator stopped`. Past `windowMs` the landing is stopped the way the drain gives up on
 * role ticks: `abort` fires the harness's internal stop, which kills its pi runs at once and
 * makes it stop at its next step boundary (lander.ts and land-batch.ts check the signal before
 * every gate, every approved landing, and each of a batch's check attempts), and a warning
 * names what was still awaited.
 * An aborted landing records `aborted` like any shutdown abort — pins kept, entries dropped,
 * marker removed — for its roles' leftover recovery on the new build. One still running a
 * window after the abort (a step wedged past its own bound) is left behind: its 4/5 marker is
 * cleared here, since this process exits the moment the hand-off returns, and its entries and
 * pins survive exactly as a crash leaves them — the next generation's first drain re-lands
 * them. Exported as a unit-test seam, like runTimedRoleTick. */
export async function awaitLandingForHandoff(
  root: string,
  landing: Pick<InFlightLanding, "promise" | "roles">,
  windowMs: number,
  abort: () => void,
): Promise<HandoffLandingOutcome> {
  const roles = landing.roles.join(", ");
  const deadline = `${windowMs / 1000}s`;
  warnEvent(
    root,
    "harness",
    `restart hand-off waiting on the in-flight landing of ${roles} (deadline ${deadline})`,
  );
  if (await settlesWithin(landing.promise, windowMs)) return "finished";
  abort();
  warnEvent(
    root,
    "harness",
    `restart hand-off: the landing of ${roles} outlived its ${deadline} deadline — aborted; its pinned commits survive for the next generation`,
  );
  if (await settlesWithin(landing.promise, windowMs)) return "aborted";
  removeQuiet(landingStatePath(root));
  warnEvent(
    root,
    "harness",
    `restart hand-off: the aborted landing of ${roles} was still running ${deadline} later — handing off without it; its queue entries and pinned commits survive for the next generation`,
  );
  return "abandoned";
}

interface RunOptions {
  root: string;
  config: TumwaterConfig;
  mainBranch: string;
  signal: AbortSignal;
  /** Poll interval in ms (default POLL_MS). Tests pass a short value so multi-cycle behavior
   * resolves quickly; production callers omit it and keep the real cadence. */
  pollMs?: number;
  /** Self-redeploy policy (src/redeploy.ts) for a self-hosting fleet; null/absent when the
   * running dist carries no build stamp. Consulted every poll with main's head. */
  redeploy?: Redeployer | null;
  /** pi's model definitions (default ~/.pi/agent/models.json), read to decide whether the
   * configured fallback model is actually cost-free — a test seam, like status.ts's. */
  modelsPath?: string;
  /** The fallback breaker's thresholds (src/budget.ts, default FALLBACK_BREAKER_POLICY) — a
   * test seam, like pollMs: e2e tests shrink the cool-down so a probe fits in a test. */
  fallbackBreakerPolicy?: FallbackBreakerPolicy;
  /** The restart hand-off's per-phase wait on an in-flight landing (default
   * HANDOFF_LANDING_WINDOW_MS) — a test seam, like pollMs: tests pass a short window so the
   * deadline path resolves quickly. */
  handoffLandingWindowMs?: number;
}

/** How runOrchestrator ended: `restart` means dist/ now holds a newer build and the caller should
 * exit RESTART_EXIT_CODE so the supervisor respawns onto it; otherwise the stop signal fired. */
interface OrchestratorExit {
  restart: boolean;
}

/** Run all enabled loops until the signal aborts — or until a pending self-redeploy has drained
 * the fleet and swapped the new build into dist/ (then `restart` is true). */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorExit> {
  const { root, config, mainBranch, signal: externalSignal } = opts;
  const pollMs = opts.pollMs ?? POLL_MS;
  const modelsPath = opts.modelsPath ?? piModelsPath();
  const breakerPolicy = opts.fallbackBreakerPolicy ?? FALLBACK_BREAKER_POLICY;
  const enabled = enabledRoleIds(config);
  // Name the fix, not just the failure: an operator who disabled the last role (or hand-edited
  // a roles map to all-false) gets the exact edit that unblocks `tumwater run`, and the
  // defaults they can fall back to.
  if (enabled.length === 0)
    throw new Error(
      'no roles enabled in tumwater.json — enable at least one role in its "roles" section (e.g. `"feature": { "enabled": true }`), or remove that section to restore every role\'s default',
    );

  // Runners and sleeps watch a combined signal: the caller's (Ctrl+C/SIGTERM) plus an internal
  // one the restart path fires when it runs out of patience — the drain, with permit-holding
  // ROLE ticks still in flight (they then end as `aborted`, resumable on the new build, exactly
  // like a shutdown), and the hand-off, with a landing still in flight (awaitLandingForHandoff). A
  // director tick is never aborted this way: poll holds for it without a cap, so by the time
  // `restart` lands only role ticks and the landing can remain.
  const internalStop = new AbortController();
  const signal = AbortSignal.any([externalSignal, internalStop.signal]);
  const redeploy = opts.redeploy ?? null;
  let restart = false;

  let runners = enabled.map((role) => new LoopRunner(root, role, config, mainBranch, signal));
  // The shared concurrency cap: role ticks and the landing slot's pi runs (landing-drain.ts)
  // both hold a permit — see its LandingDrainContext for why the landing is not exempt.
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrent));

  const infoFile = orchestratorStatePath(root);
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: enabled };
  if (redeploy) info.build = redeploy.status();
  writeJsonFile(infoFile, info);
  logEvent(root, {
    loop: "harness",
    type: "orchestrator_start",
    pid: process.pid,
    roles: enabled,
    ...(redeploy ? { build: redeploy.build.sha } : {}),
  });

  // 0 disables pruning — the same convention as quietTimeoutSeconds. (With a positive N,
  // pruneOldFiles deletes everything older than N days; JSON has no "keep forever" value, so
  // 0 is the off switch rather than "delete all sessions now".)
  if (config.sessionRetentionDays > 0) {
    const pruned =
      pruneOldFiles(sessionsRootDir(root), config.sessionRetentionDays) +
      pruneOldFiles(toolOutputDir(root), config.sessionRetentionDays);
    if (pruned > 0) {
      warnEvent(root, "harness", `pruned ${pruned} old pi session/tool-output file(s)`);
    }
  }

  // In-flight tasks, split by who requested them: the redeploy drain caps role ticks at its
  // window but waits for a director tick without one — an explicit human prompt outranks the
  // self-redeploy (BUGS.md 2026-09-08). The landing slot is deliberately OUTSIDE this split:
  // it is a single in-process task (one at a time, since 2026-09-18 under the same maxConcurrent
  // permit as role ticks) that shutdown still awaits — to the end on an operator stop, and for a
  // bounded hand-off on a restart (the `finally` below) — an aborted landing keeps its ref and
  // drops its entry, recovering on next start. roleInFlight holds every RESERVED role tick
  // (permit holders and waiters parked in the semaphore queue alike), since shutdown awaits
  // both; what the restart drain waits on, aborts, and reports as abortedTicks is only
  // rolePermitHolders, the role ticks actually holding a permit. A parked waiter has nothing to
  // drain — the start gate (tickStartHeld below) keeps it from starting while a restart is
  // pending — and counting it held drains open for ticks that had not begun and inflated
  // abortedTicks (12 reported against 3 aborted tick_ends on 2026-09-21; BUGS.md 2026-09-23).
  const roleInFlight = new Set<Promise<void>>();
  const rolePermitHolders = new Set<LoopRunner>();
  const directorInFlight = new Set<Promise<void>>();
  // The restart drain's window tracks the fleet's real tick duration (BUGS.md 2026-09-18): the
  // durations of recent COMPLETED role ticks feed a p75 that poll uses in place of the
  // cold-start constant. Bounded so a long-running fleet's memory stays flat; aborted ticks are
  // excluded — their short cut-off durations would drag the window down and cause more aborts.
  const ROLE_TICK_DURATION_SAMPLES = 50;
  const roleTickDurationsMs: number[] = [];
  let landingInFlight: InFlightLanding | null = null;

  // Live-reload bookkeeping: the last config error already warned about (a broken file must
  // warn once per distinct text, not every poll), whether the file is currently missing (one
  // warning per vanish, one line when it reappears), and the previous cycle's enabled set (for
  // one-shot enable/disable transition warnings).
  let lastConfigError: string | null = null;
  let configMissing = false;
  let prevEnabled = new Set<string>(enabled);
  // The previous poll's budget gate, for one-shot transition events. Three-valued since
  // plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
  // between two of them is worth exactly one event.
  let prevGate: BudgetGate = "open";
  // Whether the engaged fallback's backend is serving (src/budget.ts's FallbackBreaker, BUGS.md
  // 2026-09-20): folded from the outcomes of role ticks that ran on it, re-keyed every poll.
  // In memory only — a restart re-trusts the fallback and re-trips it within failureLimit ticks.
  let fallbackBreaker: FallbackBreaker = IDLE_FALLBACK_BREAKER;
  // The live config the last successful reload produced (last-known-good while the file is
  // broken or missing) and, derived from it, the view role loops run under while a fallback is
  // engaged (the fallback gate, or its breaker-demoted pause) — recomputed only when the config
  // object itself changes.
  let liveConfig = config;
  // The previous successful reload's config, for the one-shot config_changed event. Seeded from
  // the startup config, so the first poll of an unchanged file logs nothing.
  let prevLiveConfig = config;
  let fallbackFrom: TumwaterConfig | null = null;
  let fallbackConfig: TumwaterConfig = config;
  // Same bookkeeping for the operator pause (the marker file), so each pause/resume logs
  // exactly one event instead of once per ~2s poll.
  let prevUserPaused = false;
  // The fleet-wide 429 hold's state across polls (src/rate-limit-hold.ts) — unlike the
  // budget gate's prevGate it is the gate's own memory (deadline, relapse count), not just the
  // last value for edge-triggered events. In memory only: a restart starts open.
  let rateHold: RateLimitHold = RATE_LIMIT_OPEN;
  // The cap last applied to the semaphore (live-resized on each reload), so a change logs
  // exactly one event per distinct value — not once per ~2s poll.
  let lastMaxConcurrent = Math.max(1, config.maxConcurrent);
  // Live session-retention bookkeeping: the window last applied and when we last pruned —
  // both seeded from the startup prune above, so a mid-run edit re-prunes immediately while
  // an unchanged fleet prunes at most once per day (dueForPrune).
  let lastRetention = config.sessionRetentionDays;
  let lastPruneAt: number | null = config.sessionRetentionDays > 0 ? Date.now() : null;
  // The primary checkout's branch, for the edge-triggered divergence warning: the fleet
  // resolved its target branch at startup, and a human checking out something else mid-run
  // must not silently change what the fleet merges into — every role worktree is based on
  // the resolved branch. One warning per episode, re-armed when the checkout returns.
  let warnedBranchDivergence = false;

  // Need-based deferral (PLANS.md "Prioritize loops by need"): whether qualifying work has
  // landed since a role's last-seen main head, cached per head (see work-landed-cache.ts).
  const workLandedSince = new WorkLandedCache(root, mainBranch);
  // Per-role deferred-due state for one-shot tick_deferred events: the previous poll's
  // deferral per role (like prevBudgetPaused/prevUserPaused, but per role), so each episode
  // logs exactly once — on the transition in, never while merely not-due and never on exit.
  // In-memory only: a restart mid-episode can re-log at most one event.
  const deferredDue = new Map<string, boolean>();

  // Whether the last poll found a self-redeploy pending (`hold`). Hoisted out of the poll loop
  // because it is read at two points: at scheduling (no new tick is reserved) and — through
  // tickStartHeld — whenever a parked waiter is granted its permit, which happens between polls.
  let holdForRestart = false;
  // The start gate every reserved tick passes the moment its permit is granted
  // (runTimedRoleTick's `held`): closed while a restart is pending, and after one is decided so
  // no waiter the shutdown hands a permit to starts on the build being replaced. One predicate,
  // so another fleet-wide hold on new ticks can close the same gate point.
  const tickStartHeld = () => holdForRestart || restart;

  try {
    while (!signal.aborted) {
      // Live-reload tumwater.json — the single reload point shared by all loops. A broken
      // file keeps the last-known-good config and warns once per distinct error text.
      // Unchanged files are served from a stat-keyed cache (one stat per poll, no read).
      const reloaded = loadConfigCached(root);
      // A missing file keeps the last-known-good config too, and never reloads as defaults: the
      // fleet was started on a real file (startup refuses to run without one), so its vanishing
      // mid-run is an incident — a landing's fast-forward deleted it on 2026-09-22 and the fleet
      // silently ran 8.6 h on defaults (BUGS.md 2026-09-23). One warning per vanish, not per
      // poll; its return logs one line, then the normal reload below diffs it against the
      // retained config — so config_changed names only what the returned file really changed.
      if (reloaded.missing) {
        if (!configMissing) {
          warnEvent(root, "harness", `tumwater.json missing — keeping current config until it returns (${configPath(root)})`);
          configMissing = true;
          lastConfigError = null; // Whatever state it returns in is stated afresh.
        }
      } else if (configMissing) {
        warnEvent(root, "harness", "tumwater.json reappeared — reloading it");
        configMissing = false;
      }
      if (reloaded.config) {
        liveConfig = reloaded.config;
        // A live edit that changes behavior elsewhere logs one event naming the settings that
        // changed (maxConcurrent and sessionRetentionDays have their own events above/below).
        const changedKeys = changedConfigKeys(prevLiveConfig, reloaded.config);
        if (changedKeys.length > 0)
          logEvent(root, { loop: "harness", type: "config_changed", keys: changedKeys });
        prevLiveConfig = reloaded.config;
        for (const r of runners) r.config = reloaded.config;
        // Live-resize the concurrency cap: a mid-run edit changes how many pi runs execute
        // concurrently within this poll — no restart. Growing admits already-queued ticks;
        // shrinking never preempts in-flight work, it only caps future grants.
        const newMaxConcurrent = Math.max(1, reloaded.config.maxConcurrent);
        if (newMaxConcurrent !== lastMaxConcurrent) {
          semaphore.setCapacity(newMaxConcurrent);
          logEvent(root, { loop: "harness", type: "max_concurrent_changed", from: lastMaxConcurrent, to: newMaxConcurrent });
          lastMaxConcurrent = newMaxConcurrent;
        }
        const nowEnabled = enabledRoleIds(reloaded.config);
        // Enabling a role mid-run starts it: create its runner (its persisted state survives).
        for (const role of nowEnabled) {
          if (!runners.some((r) => r.role === role))
            runners.push(new LoopRunner(root, role, reloaded.config, mainBranch, signal));
        }
        for (const role of prevEnabled)
          if (!nowEnabled.includes(role))
            warnEvent(root, "harness", `role ${role} disabled — stopping ticks`);
        for (const role of nowEnabled)
          if (!prevEnabled.has(role))
            warnEvent(root, "harness", `role ${role} enabled — starting ticks`);
        prevEnabled = new Set(nowEnabled);
        lastConfigError = null;
      } else if (reloaded.error && reloaded.error !== lastConfigError) {
        warnEvent(root, "harness", `tumwater.json invalid — keeping current config: ${reloaded.error}`);
        lastConfigError = reloaded.error;
      }

      // Live session retention (the last restart-only setting): a mid-run edit to the window
      // re-prunes immediately; independently of edits, an unchanged fleet prunes at most once
      // per day so a never-restarted fleet still honors its window. Both paths log the startup
      // warning shape only when files were actually deleted — quiet polls stay silent. The live
      // config (last-known-good while the file is broken or missing) drives both checks, like the
      // budget gate.
      const retention = liveConfig.sessionRetentionDays;
      if (retention !== lastRetention || dueForPrune(lastPruneAt, Date.now(), retention)) {
        // A change to a positive window prunes immediately even inside the daily window — an
        // operator tightening the window wants it applied now, not at tomorrow's pass. Every
        // distinct value change logs one event (like its maxConcurrent sibling) so live edits
        // are visible in logs/TUI/GUI even when nothing was pruned; pruning itself still runs
        // only for a positive window.
        if (retention !== lastRetention) {
          logEvent(root, { loop: "harness", type: "retention_changed", from: lastRetention, to: retention });
        }
        const pruneNow = Date.now();
        if (retention > 0) {
          const pruned =
            pruneOldFiles(sessionsRootDir(root), retention) + pruneOldFiles(toolOutputDir(root), retention);
          if (pruned > 0) warnEvent(root, "harness", `pruned ${pruned} old pi session/tool-output file(s)`);
          lastPruneAt = pruneNow;
        }
        lastRetention = retention;
      }

      // Consume CLI request markers: a reset-counters request, a wake request, and per-role
      // abort requests.
      consumeResetRequest(root, runners);
      consumeWakeRequest(root, runners);
      consumeAbortRequests(root, runners, landingInFlight);

      // branchHead reads the ref files first (microsecond-scale; this runs every poll) and
      // spawns `git rev-parse` only when they cannot resolve it. "" means main does not exist
      // yet — isEligible treats an empty head as "no wake".
      const mainHead = (await branchHead(root, mainBranch)) ?? "";
      // Branch-divergence watch, once per poll (see warnedBranchDivergence above): the
      // fleet keeps fast-forwarding the branch it resolved at startup — the safe behavior,
      // since role worktrees are based on it — and one warning names the divergence
      // instead of leaving it mysterious. Back on the target branch re-arms the check.
      const liveBranch = await currentBranch(root);
      if (liveBranch !== null && liveBranch !== mainBranch) {
        if (!warnedBranchDivergence) {
          warnedBranchDivergence = true;
          warnEvent(
            root,
            "harness",
            `primary checkout moved to ${liveBranch} — the fleet keeps merging into ${mainBranch}`,
          );
        }
      } else {
        warnedBranchDivergence = false;
      }
      const inboxCount = inboxSize(root);
      const now = Date.now();

      // Daily cost budget gate (plans/daily-cost-budget.md, plans/fallback-model.md): once the
      // fleet's spend for the local day has reached maxDailyCostUsd, role loops either switch
      // to the configured cost-free fallback model and keep working, or — with no usable one —
      // start no new ticks at all (scheduled, main-moved wake, or startup). The director is
      // outside both: an explicit human prompt outranks the autonomous-spend cap, so it keeps
      // its budgeted model and keeps ticking. In-flight ticks finish; only NEW ticks are
      // gated. Resume is live — raising/disabling the cap (live-reloaded above), fixing the
      // fallback, or crossing local midnight re-evaluates this on the next poll — and the one
      // piece of state, the fallback breaker, is re-keyed by the same inputs, so nothing can
      // get stuck.
      const states = runners.map((r) => r.state);
      const reached = budgetPaused(states, liveConfig, now);
      // Whether the fallback is usable is a live question too: models.json is stat-cached
      // inside pi-models.ts, so an unchanged catalog costs one stat per poll, and an operator
      // who fixes a mistyped model id sees the fleet switch over within a cycle.
      const fallbackReady = fallbackModelFree(liveConfig, modelsPath);
      const pair = fallbackPair(liveConfig);
      const pairName = `${pair?.provider ?? "?"}/${pair?.model ?? "?"}`;
      // Free is not enough: the breaker demotes a fallback whose ticks keep failing, and a
      // demoted gate is `paused`, exactly as with no fallback at all.
      fallbackBreaker = rekeyFallbackBreaker(
        fallbackBreaker,
        reached && fallbackReady ? pairName : null,
        liveConfig.maxDailyCostUsd,
      );
      const gate = budgetGate(reached, fallbackReady, fallbackServing(fallbackBreaker));
      if (gate !== prevGate) {
        logEvent(root, {
          loop: "harness",
          type: gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused",
          spentUsd: fleetDailyCost(states, now),
          capUsd: liveConfig.maxDailyCostUsd,
          // On the way into a gate the fallback's identity is the operator's answer to "why
          // this and not the other one": which free pair took over, which configured pair was
          // refused because pi's definitions do not price it at zero, or which free pair the
          // breaker demoted after its ticks kept failing (and after how many).
          ...(gate === "fallback" ? { provider: pair?.provider, model: pair?.model } : {}),
          ...(gate === "paused" && pair
            ? fallbackReady
              ? { fallbackDemoted: pairName, failures: fallbackBreaker.failures }
              : { fallbackRejected: pairName }
            : {}),
        });
        prevGate = gate;
      }
      // Publish the demotion for observers (the dashboards' gate and `tumwater doctor` would
      // otherwise read the price alone and advertise a dead fallback); rewritten only when it
      // changes, like the build status below.
      const demotion = fallbackDemotion(fallbackBreaker);
      if (JSON.stringify(demotion) !== JSON.stringify(info.fallbackDemoted)) {
        info.fallbackDemoted = demotion;
        writeJsonFile(infoFile, info);
      }
      // While the fallback holds, every role loop runs under the derived view — the free pair
      // installed top-level and every per-role/reviewer model override dropped, so no seam can
      // reach a priced model. The director keeps the live config. Assigned every poll (not only
      // on transitions) so a runner created mid-gate, or one left behind by a broken-file poll
      // that skipped the reload, can never tick on the wrong model. A breaker-demoted fallback
      // keeps the view too: its gate is `paused`, but a tick parked in the semaphore when it
      // tripped, the half-open probe, and the landing slot must still run on the free pair —
      // a demotion must never promote them to the priced model the cap already spent.
      const onFallback = reached && fallbackReady;
      if (onFallback && fallbackFrom !== liveConfig) {
        fallbackFrom = liveConfig;
        fallbackConfig = applyFallbackModel(liveConfig);
      }
      const roleConfig = onFallback ? fallbackConfig : liveConfig;
      for (const r of runners) r.config = r.role === DIRECTOR_ROLE ? liveConfig : roleConfig;

      // Operator pause (`tumwater pause`): the budget gate's sibling with a different trigger —
      // human intent instead of spend. The marker is persistent state (presence means paused
      // until `resume` removes it), so one existsSync per cycle reads it fresh: pausing before
      // startup starts an already-paused fleet, and removing the marker mid-run unblocks roles
      // on their next eligibility without a restart. The director is exempt for the same reason
      // as under the budget gate — a human typing prompts outranks an operator gate (queued
      // prompts simply wait in the inbox if full silence is wanted). In-flight ticks finish;
      // only NEW ticks are blocked, because the gate sits before isEligible.
      const userPaused = isFleetPaused(root);
      if (userPaused !== prevUserPaused) {
        logEvent(root, { loop: "harness", type: userPaused ? "fleet_paused" : "fleet_resumed" });
        prevUserPaused = userPaused;
      }

      // Fleet-wide 429 hold (src/rate-limit-hold.ts): once several roles' runs have ended on a
      // provider 429 within a short window, role loops start no new ticks — and the landing
      // slot starts no new landing (the director's included), whose reviewer run has no retry
      // and would spend a review strike on the storm — until the hold re-opens at its own
      // deadline (Retry-After honoured, doubling on a relapse, capped). The director's ticks
      // are exempt, as under the budget gate and the operator pause: an explicit human prompt
      // outranks an autonomous gate, one director run is not the concurrency that sustains a
      // storm, its runs keep the per-run 429 retry, and a prompt its tick fails to fulfil goes
      // back to the inbox. In-flight ticks finish; NEW ticks are gated at scheduling like both
      // siblings, and a role tick already parked in the semaphore meets the same hold at its
      // permit (the start gate below) and hands its reservation back instead of starting into
      // the storm.
      rateHold = pollRateLimitHold(root, rateHold, runners, now);
      const rateHeld = rateHold.until !== null;

      // Self-redeploy (src/redeploy.ts): with main's head in hand, let the policy observe it.
      // `hold` starts no new ticks at all — director included; a restart lands within the drain's
      // window plus a bounded landing hand-off, and its prompt waits in the inbox for the new
      // build — while the green check/compile/drain run in the background. That covers ticks
      // reserved before the hold too: a waiter parked in the semaphore queue that is granted a
      // permit mid-drain meets the closed start gate (tickStartHeld), releases the permit, and
      // hands its reservation back so it re-schedules once the hold lifts or on the new build.
      // `restart` means dist/ already holds the new
      // build: stop scheduling, abort whatever role ticks the drain gave up waiting for — the
      // permit holders; they resume on the new build — and return. A director tick can never be
      // in flight here — poll only returns `restart` once it has finished. (holdForRestart keeps
      // the previous poll's verdict until this one's is in: resetting it before the await
      // would open the gate for a waiter granted a permit while poll runs.)
      if (redeploy) {
        const action = await redeploy.poll(
          mainHead,
          {
            roleInFlight: rolePermitHolders.size,
            directorInFlight: directorInFlight.size,
            roleTickP75Ms: p75TickDurationMs(roleTickDurationsMs),
          },
          liveConfig.autoRestart,
          now,
        );
        const build = redeploy.status(now);
        if (JSON.stringify(build) !== JSON.stringify(info.build)) {
          info.build = build;
          writeJsonFile(infoFile, info);
        }
        if (action === "restart") {
          restart = true;
          // Only permit holders have a pi run to cut off (the director is guaranteed finished by
          // then): a parked waiter meets the closed start gate whenever the shutdown hands it a
          // permit, so it needs no abort — and aborting for it alone would also cut off an
          // in-flight landing that no permit-holding tick put at stake.
          if (rolePermitHolders.size > 0) internalStop.abort();
          break;
        }
        holdForRestart = action === "hold";
      }

      // Merge queue 3/5 — drain the durable land queue on the single landing slot, once the
      // slot is free and neither a restart nor a 429 hold is pending (the scheduler's WHEN;
      // landing-drain.ts owns the HOW — the queue-head dedupe and both landing paths).
      if (!holdForRestart && !rateHeld && landingInFlight === null) {
        landingInFlight = await drainLandingQueue({
          root,
          mainBranch,
          signal,
          semaphore,
          runners,
          liveConfig,
          roleConfig,
          onSlotCleared: () => {
            landingInFlight = null;
          },
        });
      }

      // Backlog-aware deferral: while PLANS.md `## Planned` or BUGS.md `## Open` on main is
      // non-empty, idle maintenance ticks stay deferred — queued feature/bugfix work outranks
      // them regardless of what landed. Stat-cached reads (backlog.ts): one stat per file per
      // poll while the files are unchanged.
      const workBacklogOpen = plannedPlans(root).length > 0 || openBugs(root).length > 0;

      const reasons = new Map<LoopRunner, string | undefined>();
      // Merge-queue interlock data, listed ONCE per poll (was once per runner per poll — each
      // landingFor() re-listed the land-queue directory and re-statted every queued entry): the
      // check below only asks whether the runner's role has a queued entry. The queue changes
      // only when a landing completes or a tick enqueues — both asynchronous events this pass
      // observes on its next poll — so one snapshot is as fresh as per-runner reads, and a
      // landing that completes mid-pass just keeps its role blocked one extra poll (conservative).
      const queuedLandingRoles = new Set(queuedLandingFiles(root).map((q) => q.entry.role));
      // A demoted fallback's half-open window: its role ticks may pass the `paused` budget gate
      // here, and the start pass below admits exactly one of them as the probe. Never past an
      // operator pause — human intent outranks the breaker's curiosity.
      const probeDue = fallbackProbeDue(fallbackBreaker, now);
      for (const runner of runners) {
        if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
        if ((userPaused || (gate === "paused" && !probeDue)) && runner.role !== DIRECTOR_ROLE)
          continue; // no new role ticks while either gate holds
        if (rateHeld && runner.role !== DIRECTOR_ROLE) continue; // nor while a 429 storm holds
        const { run, reason } = isEligible(runner, now, mainHead, inboxCount);
        if (!run) {
          // Not due this poll: any deferral episode has ended (or never started). No event —
          // the tick's own events cover it.
          if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
          continue;
        }
        // Merge queue 3/5 interlock (invariant 3): a role with a QUEUED or IN-FLIGHT landing
        // never starts a tick — the entry stays in the queue until its landing completes, so
        // one check covers both. Uniform over every role, director included: its prompt is not
        // finished until it lands. Placed before the need-based deferral block on purpose —
        // no episode bookkeeping is needed (the tick that queued the landing ran, which closed
        // any deferral episode; its `queued` can leave a prior no_change in lastResult — state.ts
        // records only completed results — but the landing's outcome replaces it before the
        // interlock lets the role back into this pass), and skipping here saves that branch's
        // workLandedSince git-range query for the skipped role.
        if (queuedLandingRoles.has(runner.role)) continue;
        // Need-based deferral: a due maintenance tick (scheduled or main-moved wake) whose last
        // tick did nothing stays deferred while the feature/bugfix backlog is open or no new
        // work has landed to react to — nextRunAt is left untouched, so it re-checks every poll
        // until the backlog drains and qualifying work lands. Resume wakes precede this check in
        // isEligible, the director's "inbox" reason skips it, and work roles are not in
        // DEFERRABLE_ROLES. Sitting before reasons.set also keeps a deferred role out of the
        // wake-event pass below.
        if (reason === "scheduled" || reason === "main moved") {
          const s = runner.state;
          // The git range is only consulted when the other conditions already hold — a
          // never-ticked role or a tick with pending business runs without paying for it, and an
          // open backlog defers regardless of what landed.
          const landed =
            !workBacklogOpen && s.lastMainHead !== ""
              ? await workLandedSince.since(s.lastMainHead, mainHead)
              : true;
          const deferredNow = deferTick(s, runner.role, landed, workBacklogOpen, now);
          if (deferredNow !== (deferredDue.get(runner.role) ?? false)) {
            if (deferredNow)
              logEvent(root, { loop: runner.role, type: "tick_deferred" });
            deferredDue.set(runner.role, deferredNow);
          }
          if (deferredNow) continue;
        } else if (deferredDue.get(runner.role)) {
          deferredDue.set(runner.role, false); // an inbox/resume run ends the episode
        }
        reasons.set(runner, reason);
      }
      for (const runner of fairOrder([...reasons.keys()])) {
        if (signal.aborted) continue;
        // The probe goes to the first role fairOrder admits; every other due role waits for its
        // verdict (startFallbackProbe marks it in flight, so the rest of this pass skips).
        let probe = false;
        if (probeDue && runner.role !== DIRECTOR_ROLE) {
          if (fallbackBreaker.probing) continue;
          fallbackBreaker = startFallbackProbe(fallbackBreaker);
          probe = true;
        }
        const reason = reasons.get(runner);
        if (reason && reason !== "scheduled" && reason !== "startup") {
          logEvent(root, { loop: runner.role, type: "wake", reason });
        }
        runner.state.running = true; // Reserve before the semaphore wait so we don't double-schedule.
        // The director never queues behind role loops: a user prompt starts immediately,
        // even when maxConcurrent slots are busy. Parked waiters keep fairOrder's tier order
        // across polls too: a work-role arrival jumps ahead of maintenance ticks that queued
        // in an earlier poll (in-flight ticks always run to completion).
        const usesSlot = runner.role !== DIRECTOR_ROLE;
        // Mark the parked waiter while it waits: it holds no permit yet, so the dashboards
        // render `awaiting slot` (an inactive state) and the active rows keep tracking
        // maxConcurrent (BUGS.md 2026-09-24). Cleared the moment the permit is granted. The
        // director never queues, so it is never a parked waiter.
        runner.state.parkedSince = usesSlot ? Date.now() : undefined;
        // The tick's own run time (null when it never ran or was cut off): the drain-window
        // sample is taken only for a tick that finished on its own.
        let durationMs: number | null = null;
        // Whether runner.tick() was ever called — false when the start gate (or a shutdown)
        // turned the tick away at its permit.
        let started = false;
        const task = (async () => {
          durationMs = await runTimedRoleTick(
            signal,
            usesSlot
              ? async () => {
                  await semaphore.acquire(roleTier(runner.role));
                  // Permit granted: the tick is now an active, permit-holding state until the
                  // release below. A tick the start gate turns away releases within the same
                  // microtask chain, so no poll ever counts it as a permit holder.
                  runner.state.parkedSince = undefined;
                  rolePermitHolders.add(runner);
                }
              : async () => {},
            usesSlot
              ? () => {
                  rolePermitHolders.delete(runner);
                  semaphore.release();
                }
              : () => {},
            async () => {
              started = true;
              // A role tick that starts while a fallback is engaged runs on it (the config and
              // the breaker are updated in the same synchronous poll step), so its outcome is
              // the breaker's evidence. Read at tick start, not at admission: a tick parked in
              // the semaphore starts on whatever the gate says by then. A tick that ended on
              // leftover recovery ran no model, so it folds as `skipped` — no evidence either way.
              const ranOn = runner.role === DIRECTOR_ROLE ? null : fallbackBreaker;
              const outcome = await runner.tick();
              if (ranOn?.pair) {
                const at = Date.now();
                const evidence = outcome.recoveredLeftover ? "skipped" : outcome.result;
                fallbackBreaker = recordFallbackTick(fallbackBreaker, ranOn, evidence, probe, at, breakerPolicy);
              }
              return outcome;
            },
            Date.now,
            // The restart start gate, plus the 429 hold for role ticks (the director is exempt,
            // as at scheduling): a waiter granted its permit mid-storm must not start into it.
            () => tickStartHeld() || (usesSlot && rateHold.until !== null),
          );
          // A reservation whose tick never started hands itself back, so the role re-schedules
          // once the hold lifts (or on the new build) instead of sitting `running` forever with
          // nothing in flight. Memory only, on purpose: nothing started, so no state write and
          // no tick_start/tick_end — the persisted state still reads exactly as the last real
          // tick left it, and the next generation schedules the role from that.
          if (!started) runner.state.running = false;
          // A probe turned away the same way answered nothing: hand its claim back (see
          // abandonFallbackProbe) so the next poll can admit a probe that actually runs.
          if (!started && probe) fallbackBreaker = abandonFallbackProbe(fallbackBreaker);
        })();
        const bucket = runner.role === DIRECTOR_ROLE ? directorInFlight : roleInFlight;
        bucket.add(task);
        void task.finally(() => {
          bucket.delete(task);
          if (bucket === roleInFlight && durationMs !== null) {
            roleTickDurationsMs.push(durationMs);
            if (roleTickDurationsMs.length > ROLE_TICK_DURATION_SAMPLES) roleTickDurationsMs.shift();
          }
        });
      }

      await sleepInterruptible(pollMs, signal);
    }
  } finally {
    // The in-flight landing is awaited beside the ticks, and how depends on what comes next.
    // On an operator stop the harness signal has already aborted it — its pi runs die and it
    // stops at its next step boundary, ending "aborted" with its ref kept and its entry dropped
    // for next-start recovery — and it is waited out: returning early would remove
    // orchestrator.json while this process still lands, letting a second `tumwater run` start
    // a concurrent lander (a second Ctrl+C still forces the exit). On a restart the caller exits
    // for the next generation the moment this returns, and a landing is not bounded by one
    // reviewer run — a batch re-enters review and build check once per change — so the wait is
    // a bounded hand-off that announces itself (awaitLandingForHandoff; BUGS.md 2026-09-23).
    const ticks = Promise.allSettled([...roleInFlight, ...directorInFlight]);
    const landing = landingInFlight;
    if (landing && restart) {
      // The abort is the internal stop, not just the landing's own controller: startLanding
      // wires the harness signal to that controller, and a conflict-resolution run watches the
      // harness signal alone (runLandingPi). Nothing else it reaches can start work here — the
      // director has finished, permit holders were aborted at the restart, and a parked waiter
      // meets the closed start gate (tickStartHeld) whenever it is granted a permit.
      const outcome = await awaitLandingForHandoff(
        root,
        landing,
        opts.handoffLandingWindowMs ?? HANDOFF_LANDING_WINDOW_MS,
        () => internalStop.abort(),
      );
      // An abandoned landing still holds its permit, so a waiter parked behind it would never be
      // granted one and never settle. The ticks have had both windows beside the hand-off, so
      // whatever is still reserved then started nothing (or is wedged like the landing): the
      // hand-off goes ahead without it too.
      if (outcome !== "abandoned") await ticks;
    } else {
      if (landing) warnEvent(root, "harness", `shutdown waiting on the in-flight landing of ${landing.roles.join(", ")}`);
      await Promise.allSettled([ticks, landing?.promise]);
    }
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    removeQuiet(infoFile);
  }
  return { restart };
}
