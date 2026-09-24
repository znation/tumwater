import type { TickOutcome, TumwaterConfig } from "./types.js";
import type { OrchestratorInfo } from "./fleet-state.js";
import { applyFallbackModel, changedConfigKeys, enabledRoleIds, fallbackPair, loadConfigCached } from "./config.js";
import {
  deferTick,
  dueForPrune,
  fairOrder,
  isEligible,
} from "./scheduling.js";
import { isFleetPaused } from "./fleet-state.js";
import { budgetGate, budgetPaused, type BudgetGate, fleetDailyCost } from "./budget.js";
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
  orchestratorStatePath,
  sessionsRootDir,
  toolOutputDir,
} from "./paths.js";
import { p75TickDurationMs, type Redeployer } from "./redeploy.js";
import { WorkLandedCache } from "./work-landed-cache.js";

const POLL_MS = 2000;

/** Run one role tick under the concurrency semaphore and return how long the tick itself ran,
 * in ms — null when it never started (the harness is already stopping) or was cut off by an
 * abort. This is the restart drain's p75 sample (BUGS.md 2026-09-18). The clock starts only
 * once the permit is granted, so time a tick spends parked in the semaphore queue is not
 * counted as work: the drain waits on ticks that are already running, and folding queue wait
 * into the window would overstate how long they have left (the `tick_start`..`tick_end` span
 * the window was sized against excludes it too). Aborted ticks return null so their short
 * cut-off lengths cannot drag the window down. `now` is a test seam. */
export async function runTimedRoleTick(
  signal: AbortSignal,
  acquire: () => Promise<void>,
  release: () => void,
  tick: () => Promise<TickOutcome>,
  now: () => number = Date.now,
): Promise<number | null> {
  await acquire();
  try {
    if (signal.aborted) return null;
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
  const enabled = enabledRoleIds(config);
  // Name the fix, not just the failure: an operator who disabled the last role (or hand-edited
  // a roles map to all-false) gets the exact edit that unblocks `tumwater run`, and the
  // defaults they can fall back to.
  if (enabled.length === 0)
    throw new Error(
      'no roles enabled in tumwater.json — enable at least one role in its "roles" section (e.g. `"feature": { "enabled": true }`), or remove that section to restore every role\'s default',
    );

  // Runners and sleeps watch a combined signal: the caller's (Ctrl+C/SIGTERM) plus an internal
  // one the redeploy path fires when its drain of ROLE ticks runs out of patience — those
  // in-flight role ticks then end as `aborted` (resumable on the new build), exactly like a
  // shutdown. A director tick is never aborted this way: poll holds for it without a cap, so by
  // the time `restart` lands only role ticks can remain.
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
  // permit as role ticks) that graceful shutdown still awaits — an aborted landing keeps its ref
  // and drops its entry, recovering on next start.
  const roleInFlight = new Set<Promise<void>>();
  const directorInFlight = new Set<Promise<void>>();
  // The restart drain's window tracks the fleet's real tick duration (BUGS.md 2026-09-18): the
  // durations of recent COMPLETED role ticks feed a p75 that poll uses in place of the
  // cold-start constant. Bounded so a long-running fleet's memory stays flat; aborted ticks are
  // excluded — their short cut-off durations would drag the window down and cause more aborts.
  const ROLE_TICK_DURATION_SAMPLES = 50;
  const roleTickDurationsMs: number[] = [];
  let landingInFlight: InFlightLanding | null = null;

  // Live-reload bookkeeping: the last config error already warned about (a broken file must
  // warn once per distinct text, not every poll), and the previous cycle's enabled set (for
  // one-shot enable/disable transition warnings).
  let lastConfigError: string | null = null;
  let prevEnabled = new Set<string>(enabled);
  // The previous poll's budget gate, for one-shot transition events. Three-valued since
  // plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
  // between two of them is worth exactly one event.
  let prevGate: BudgetGate = "open";
  // The live config the last successful reload produced (last-known-good while the file is
  // broken) and, derived from it, the view role loops run under while the fallback gate holds
  // — recomputed only when the config object itself changes.
  let liveConfig = config;
  // The previous successful reload's config, for the one-shot config_changed event. Seeded from
  // the startup config, so the first poll of an unchanged file logs nothing.
  let prevLiveConfig = config;
  let fallbackFrom: TumwaterConfig | null = null;
  let fallbackConfig: TumwaterConfig = config;
  // Same bookkeeping for the operator pause (the marker file), so each pause/resume logs
  // exactly one event instead of once per ~2s poll.
  let prevUserPaused = false;
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

  try {
    while (!signal.aborted) {
      // Live-reload tumwater.json — the single reload point shared by all loops. A broken
      // file keeps the last-known-good config and warns once per distinct error text.
      // Unchanged files are served from a stat-keyed cache (one stat per poll, no read).
      const reloaded = loadConfigCached(root);
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
      // config (last-known-good while the file is broken) drives both checks, like the budget gate.
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
      // gated. Resume is live and stateless — raising/disabling the cap (live-reloaded above),
      // fixing the fallback, or crossing local midnight re-evaluates this on the next poll, so
      // nothing can get stuck.
      const states = runners.map((r) => r.state);
      // Whether the fallback is usable is a live question too: models.json is stat-cached
      // inside pi-models.ts, so an unchanged catalog costs one stat per poll, and an operator
      // who fixes a mistyped model id sees the fleet switch over within a cycle.
      const gate = budgetGate(budgetPaused(states, liveConfig, now), fallbackModelFree(liveConfig, modelsPath));
      if (gate !== prevGate) {
        const pair = fallbackPair(liveConfig);
        logEvent(root, {
          loop: "harness",
          type: gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused",
          spentUsd: fleetDailyCost(states, now),
          capUsd: liveConfig.maxDailyCostUsd,
          // On the way into a gate the fallback's identity is the operator's answer to "why
          // this and not the other one": which free pair took over, or which configured pair
          // was refused because pi's definitions do not price it at zero.
          ...(gate === "fallback" ? { provider: pair?.provider, model: pair?.model } : {}),
          ...(gate === "paused" && pair
            ? { fallbackRejected: `${pair.provider ?? "?"}/${pair.model ?? "?"}` }
            : {}),
        });
        prevGate = gate;
      }
      // While the fallback holds, every role loop runs under the derived view — the free pair
      // installed top-level and every per-role/reviewer model override dropped, so no seam can
      // reach a priced model. The director keeps the live config. Assigned every poll (not only
      // on transitions) so a runner created mid-gate, or one left behind by a broken-file poll
      // that skipped the reload, can never tick on the wrong model.
      if (gate === "fallback" && fallbackFrom !== liveConfig) {
        fallbackFrom = liveConfig;
        fallbackConfig = applyFallbackModel(liveConfig);
      }
      const roleConfig = gate === "fallback" ? fallbackConfig : liveConfig;
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

      // Self-redeploy (src/redeploy.ts): with main's head in hand, let the policy observe it.
      // `hold` starts no new ticks at all — director included; a restart lands within minutes
      // and its prompt waits in the inbox — while the green check/compile/drain run in the
      // background. `restart` means dist/ already holds the new build: stop scheduling, abort
      // whatever role ticks the drain gave up waiting for (they resume on the new build), and
      // return. A director tick can never be in flight here — poll only returns `restart` once
      // it has finished.
      let holdForRestart = false;
      if (redeploy) {
        const action = await redeploy.poll(
          mainHead,
          {
            roleInFlight: roleInFlight.size,
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
          if (roleInFlight.size > 0) internalStop.abort(); // the director is guaranteed finished by then
          break;
        }
        holdForRestart = action === "hold";
      }

      // Merge queue 3/5 — drain the durable land queue on the single landing slot, once the
      // slot is free and no restart is pending (the scheduler's WHEN; landing-drain.ts owns
      // the HOW — the queue-head dedupe and both landing paths).
      if (!holdForRestart && landingInFlight === null) {
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
      for (const runner of runners) {
        if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
        if ((gate === "paused" || userPaused) && runner.role !== DIRECTOR_ROLE)
          continue; // no new role ticks while either gate holds
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
        // no episode bookkeeping is needed (a landing implies the last result is not
        // no_change, so no deferral episode can be open), and skipping here saves that branch's
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
        const task = (async () => {
          durationMs = await runTimedRoleTick(
            signal,
            usesSlot
              ? async () => {
                  await semaphore.acquire(roleTier(runner.role));
                  // Permit granted: the tick is now an active, permit-holding state.
                  runner.state.parkedSince = undefined;
                }
              : async () => {},
            usesSlot ? () => semaphore.release() : () => {},
            () => runner.tick(),
          );
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
    // The in-flight landing is awaited too: graceful shutdown waits for it, and a shutdown
    // abort reaches its pi runs through the harness signal — the landing then ends "aborted",
    // keeps its ref, and drops its entry for next-start recovery. (The landing is one
    // reviewer run plus a bounded merge, not a fleet-wide drain.)
    await Promise.allSettled(
      landingInFlight ? [...roleInFlight, ...directorInFlight, landingInFlight.promise] : [...roleInFlight, ...directorInFlight],
    );
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    removeQuiet(infoFile);
  }
  return { restart };
}
