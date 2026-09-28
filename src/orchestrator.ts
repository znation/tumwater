import type { TumwaterConfig } from "./config-schema.js";
import type { OrchestratorInfo } from "./fleet-state.js";
import { enabledRoleIds } from "./config.js";
import { applyFallbackModel, fallbackPair } from "./config-views.js";
import { newLiveConfigReload } from "./config-live.js";
import {
  deferTick,
  fairOrder,
  isEligible,
} from "./scheduling.js";
import { isFleetPaused, pausedRoles } from "./fleet-state.js";
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
import { RATE_LIMIT_OPEN, type RateLimitHold } from "./rate-limit-hold.js";
import { DIRECTOR_ROLE, roleTier } from "./roles.js";
import { openBugs, plannedPlans } from "./backlog.js";
import { LoopRunner } from "./loop.js";
import { branchHead, currentBranch } from "./git.js";
import { queuedLandingFiles } from "./landing-queue.js";
import {
  abortableLandings,
  drainLandings,
  landingTasks,
  newLandingPipeline,
  settleAbortedVetted,
} from "./landing-drain.js";
import { logEvent, warnEvent } from "./events.js";
import { removeQuiet } from "./files.js";
import { writeJsonFile } from "./json-files.js";
import { inboxSize } from "./inbox.js";
import { OnceRound } from "./once-round.js";
import {
  consumeAbortRequests,
  consumeResetRequest,
  consumeWakeRequest,
} from "./operator-requests.js";
import { fallbackModelFree, piModelsPath } from "./pi-models.js";
import { Semaphore } from "./semaphore.js";
import { orchestratorStatePath } from "./paths.js";
import { type Redeployer } from "./redeploy.js";
import type { LaunchServicesWatch } from "./launchservices.js";
import { RetentionPruner } from "./retention.js";
import { WorkLandedCache } from "./work-landed-cache.js";
import {
  drainInFlightWork,
  HANDOFF_LANDING_WINDOW_MS,
  p75TickDurationMs,
  pollRateLimitHold,
  runTimedRoleTick,
  sleepInterruptible,
} from "./tick-timing.js";

const POLL_MS = 2000;

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
  /** launchservicesd's port watch (src/launchservices.ts), stepped every poll; null/absent runs
   * without one — a `--once` round, and every in-process test, so none reads the real Mac. */
  launchServicesWatch?: LaunchServicesWatch | null;
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
  /** Once mode (`tumwater run --once`): give every enabled role at most one tick, wait for
   * every landing that round produced to merge, then fire the internal stop — the same
   * graceful-shutdown path an operator's Ctrl+C takes, so drainInFlightWork drains exactly
   * as it always does. Never self-redeploys: the hand-off machinery stays daemon-only. */
  once?: boolean;
  /** Scope the whole round to this one role (`run --once --role <id>`): the runners map
   * starts with just it, the director never runs, and a mid-round config edit that enables
   * another role does not widen the round (config-live skips runners past the filter). The
   * land queue still drains fully before exit. cmdRun validates the id against the enabled
   * set before booting, so an unreachable-without-filter guard upstream is not re-checked. */
  roleFilter?: string;
}

/** How runOrchestrator ended: `restart` means dist/ now holds a newer build and the caller should
 * exit RESTART_EXIT_CODE so the supervisor respawns onto it; otherwise the stop signal fired.
 * Once mode (`run --once`) also hands back the per-role settle reasons it recorded — the skip
 * half of the round's answer, which the caller's summary reports verbatim instead of re-deriving
 * a lookalike from persisted state (a deferred role's nextRunAt is untouched, so state says
 * "idle" exactly when the truth is "due and set aside"). Undefined outside once mode. */
interface OrchestratorExit {
  restart: boolean;
  settled?: ReadonlyMap<string, string>;
  /** Per-role ticks this round ran (OnceRound's own snapshot deltas): a role enabled
   * mid-round is in no caller-side snapshot, so the summary counts it from here instead of
   * mistaking its whole persisted history for this round's work. Once mode only. */
  ticksRun?: ReadonlyMap<string, number>;
}

/** Run all enabled loops until the signal aborts — or until a pending self-redeploy has drained
 * the fleet and swapped the new build into dist/ (then `restart` is true). */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorExit> {
  const { root, config, mainBranch, signal: externalSignal } = opts;
  const pollMs = opts.pollMs ?? POLL_MS;
  const modelsPath = opts.modelsPath ?? piModelsPath();
  const breakerPolicy = opts.fallbackBreakerPolicy ?? FALLBACK_BREAKER_POLICY;
  const enabled = opts.roleFilter !== undefined ? [opts.roleFilter] : enabledRoleIds(config);
  // Name the fix, not just the failure: an operator who disabled the last role (or hand-edited
  // a roles map to all-false) gets the exact edit that unblocks `tumwater run`, and the
  // defaults they can fall back to. With a role filter this is unreachable — cmdRun validated
  // the id against the enabled set before booting — but the guard stays for in-process callers.
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
  // A once round is a one-shot by definition: it never self-redeploys, and the hand-off
  // machinery stays daemon-only. Forcing null here keeps the whole poll loop's redeploy
  // branches inert no matter what a caller passes.
  const redeploy = opts.once ? null : (opts.redeploy ?? null);
  const launchServicesWatch = opts.once ? null : (opts.launchServicesWatch ?? null);
  let restart = false;

  let runners = enabled.map((role) => new LoopRunner(root, role, config, mainBranch, signal));
  // The shared concurrency cap: role ticks and the landings (each vet, and the merge's conflict
  // resolver — landing-drain.ts) all hold a permit; see its LandingPipelineContext for why a
  // landing is not exempt.
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

  // Session retention (src/retention.ts owns the whole concern): construction runs the
  // startup prune, seeding the once-per-day gate so an unchanged fleet prunes at most once
  // per day — and 0 disables pruning, the same convention as quietTimeoutSeconds.
  const retentionPruner = new RetentionPruner(root, config.sessionRetentionDays);

  // In-flight tasks, split by who requested them: the redeploy drain caps role ticks at its
  // window but waits for a director tick without one — an explicit human prompt outranks the
  // self-redeploy (BUGS.md 2026-09-08). The landing tasks are deliberately OUTSIDE this split:
  // in-process tasks (the vets and the one merge, since 2026-09-18 under the same maxConcurrent
  // permits as role ticks) that shutdown still awaits — to the end on an operator stop, and for a
  // bounded hand-off on a restart (drainInFlightWork) — an aborted landing keeps its ref and
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
  // Every landing task (landing-drain.ts's LandingPipeline): the vetting stage's tasks, the
  // changes they vetted, and the merge slot.
  const landings = newLandingPipeline();

  // Once-mode bookkeeping (`tumwater run --once`) — the tick-count snapshot, the per-role
  // settle reasons, and the quiet-poll exit rule — lives in src/once-round.ts.
  const once = new OnceRound(runners, opts.once === true);

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
  // object itself changes. The reload bookkeeping itself lives in src/config-live.ts.
  const liveReload = newLiveConfigReload({ root, config, mainBranch, signal, runners, semaphore, roleFilter: opts.roleFilter });
  let fallbackFrom: TumwaterConfig | null = null;
  let fallbackConfig: TumwaterConfig = config;
  // Same bookkeeping for the operator pause (the marker file), so each pause/resume logs
  // exactly one event instead of once per ~2s poll.
  let prevUserPaused = false;
  // The same bookkeeping for the per-role pause (`tumwater pause --role <id>`): the previous
  // poll's paused set, so each pause/resume crossing logs exactly one event per role instead
  // of once per ~2s poll. In memory only: a restart mid-pause logs one event on the first
  // poll after it, and the marker keeps gating regardless.
  let prevPausedRoles = new Set<string>();
  // The fleet-wide 429 hold's state across polls (src/rate-limit-hold.ts) — unlike the
  // budget gate's prevGate it is the gate's own memory (deadline, relapse count), not just the
  // last value for edge-triggered events. In memory only: a restart starts open.
  let rateHold: RateLimitHold = RATE_LIMIT_OPEN;
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
      // Live-reload tumwater.json — the single reload point shared by all loops (src/config-live.ts
      // owns the last-known-good retention and the edge-triggered warnings/events around it).
      const liveConfig = liveReload.poll();

      // Live session retention (the last restart-only setting): the edge-triggered
      // retention_changed event, the once-per-day gate, and the prune itself live in
      // src/retention.ts. The live config (last-known-good while the file is broken or
      // missing) drives the check, like the budget gate.
      retentionPruner.poll(root, liveConfig.sessionRetentionDays);

      // launchservicesd's Mach-port budget (src/launchservices.ts owns it): a background sample
      // at most every 15 minutes, and a warning days before the kernel kills the daemon and
      // wedges the Mac's GUI session. Never awaited — a poll does not wait on `top`.
      void launchServicesWatch?.poll();

      // Consume CLI request markers: a reset-counters request, a wake request, and per-role
      // abort requests.
      consumeResetRequest(root, runners);
      consumeWakeRequest(root, runners);
      consumeAbortRequests(root, runners, abortableLandings(landings));
      await settleAbortedVetted(root, landings);

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
      // tripped, the half-open probe, and the landings must still run on the free pair —
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

      // Per-role pause (`tumwater pause --role <id>`): the operator pause's narrower sibling —
      // the same persistent marker read fresh per cycle, but one named loop instead of the
      // fleet. Unlike the fleet pause the director is NOT exempt: the operator named the role
      // deliberately, and its queued prompts simply wait in the inbox (the same effect the
      // fleet pause has on the director). In-flight ticks finish; only NEW ticks are blocked
      // (the gate sits before isEligible, exactly where userPaused skips roles below).
      const pausedRolesNow = pausedRoles(root);
      const pausedRolesSet = new Set(pausedRolesNow);
      for (const r of pausedRolesNow)
        if (!prevPausedRoles.has(r)) logEvent(root, { loop: "harness", type: "role_paused", role: r });
      for (const r of prevPausedRoles)
        if (!pausedRolesSet.has(r)) logEvent(root, { loop: "harness", type: "role_resumed", role: r });
      prevPausedRoles = pausedRolesSet;

      // Fleet-wide 429 hold (src/rate-limit-hold.ts): once several roles' runs have ended on a
      // provider 429 within a short window, role loops start no new ticks — and the land queue
      // starts no new vet (the director's included), whose reviewer run has no retry
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

      // Merge queue 3/5 — drain the durable land queue while neither a restart nor a 429 hold
      // is pending (the scheduler's WHEN; landing-drain.ts owns the HOW — the vetting stage, its
      // merge slot, and the dedupe against main). A held poll starts no vet and no merge,
      // exactly as it starts no tick; what is already in flight runs on, and a vet parked for
      // its permit meets the same start gate as a parked tick when the permit comes.
      if (!holdForRestart && !rateHeld) {
        await drainLandings(
          {
            root,
            mainBranch,
            signal,
            semaphore,
            runners,
            liveConfig,
            roleConfig,
            startHeld: () => tickStartHeld() || rateHold.until !== null,
          },
          landings,
        );
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
        // Once mode: a paused role runs no tick this round and must be reported as skipped,
        // so it settles here — before the gates that would otherwise skip it silently (a
        // once round has to end even when a pause marker is left over; a later resume within
        // the same round cannot un-settle it, which is the at-most-one-tick contract).
        if (
          once.active &&
          !once.isSettled(runner) &&
          !runner.state.running &&
          (pausedRolesSet.has(runner.role) ||
            ((userPaused || (gate === "paused" && !probeDue)) && runner.role !== DIRECTOR_ROLE))
        ) {
          once.settle(runner.role, "paused");
        }
        // Once mode's at-most-one-tick contract (src/once-round.ts): a role that already ran
        // its tick — or was settled with a skip reason — runs nothing further this round, even
        // when its backoff has expired or the clock override would admit it again. Without this
        // gate the one-tick guarantee held only for deferrable built-ins (their deferral
        // settles them); a custom loop or work role with a short backoff re-qualified every
        // poll and the round never ended.
        if (once.active && !runner.state.running && once.isSettled(runner)) continue;
        if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
        // The per-role pause gates BEFORE the fleet check and exempts nothing — the director
        // included (the operator named that one loop deliberately).
        if (pausedRolesSet.has(runner.role)) continue;
        if ((userPaused || (gate === "paused" && !probeDue)) && runner.role !== DIRECTOR_ROLE)
          continue; // no new role ticks while either gate holds
        if (rateHeld && runner.role !== DIRECTOR_ROLE) continue; // nor while a 429 storm holds
        // The loop's OWN queue decides inbox due-ness: the director counts its historical
        // inbox, every other loop its per-role queue (tumwater prompt --role <id>) — so a
        // queued prompt makes its loop due by itself, no wake marker needed (isEligible).
        const { run, reason } = isEligible(runner, now, mainHead, inboxSize(root, runner.role), {
          once: once.active,
        });
        if (!run) {
          // Not due this poll: any deferral episode has ended (or never started). No event —
          // the tick's own events cover it.
          if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
          // Once mode: idle and not due — settleSkipped records the skip reason (the caller's
          // summary reports it).
          if (once.active && !runner.state.running) once.settleSkipped(runner);
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
        // isEligible, the director's "inbox" reason skips it, work roles are not in
        // DEFERRABLE_ROLES, and a fresh operator wake overrides it (deferTick's woken check —
        // an explicit "try again now" is a demand, not idle maintenance). Sitting before
        // reasons.set also keeps a deferred role out of the wake-event pass below.
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
          if (deferredNow) {
            // Once mode: a deferred maintenance tick decided not to run — its once-round
            // answer, so it settles instead of holding the round open for DEFER_MAX_MS.
            if (once.active) once.settle(runner.role, "deferred");
            continue;
          }
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

      // Once mode's exit: every enabled role settled, no tick in flight, and the land queue
      // empty with no landing in flight for one full poll cycle — then fire the internal
      // stop, the same graceful shutdown the restart drain uses (the `finally` awaits
      // in-flight landing tasks to the end). The one-poll-cycle requirement is the guard
      // against dropping a queued-but-not-yet-started landing: a stop that lands during the
      // shutdown drain drops the queue entry, so the slot gets its poll to pick the entry up
      // before the stop is trusted.
      if (
        once.exitReady({
          roleTicks: roleInFlight.size,
          directorTicks: directorInFlight.size,
          landings: landingTasks(landings).length,
          queuedLandings: queuedLandingFiles(root).length,
        })
      ) {
        internalStop.abort();
        break;
      }

      await sleepInterruptible(pollMs, signal);
    }
  } finally {
    await drainInFlightWork(
      root,
      roleInFlight,
      directorInFlight,
      landingTasks(landings),
      restart,
      opts.handoffLandingWindowMs ?? HANDOFF_LANDING_WINDOW_MS,
      () => internalStop.abort(),
    );
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    removeQuiet(infoFile);
  }
  // Only once mode carries the settle reasons and the per-role ticks-run: the daemon return
  // keeps its exact shape (an e2e test deep-equals it), and a daemon caller has no summary to
  // feed.
  return once.active
    ? {
        restart,
        settled: once.reasons,
        ticksRun: new Map(runners.map((r) => [r.role, once.ticksRun(r)] as const)),
      }
    : { restart };
}
