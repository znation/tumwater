// vocabulary: plain
/** The orchestrator's launch pass: the half of the per-poll runner sweep that admits due
 * roles to their runs. The decision half (isEligible, the pause/backoff/deferral gates,
 * once-mode settling) stays in runOrchestrator (src/orchestrator/orchestrator.ts) — it reads
 * the poll's gate verdicts and the backlog state; this module takes its output, the
 * `reasons` map of due runners, and turns each into a reserved, semaphore-gated, in-flight
 * run: the probe admission for the fallback breaker, the wake event, the
 * reservation/parking bookkeeping, runTimedRoleRun's wiring (slot acquisition, the start
 * gate, breaker evidence), and the in-flight-bucket bookkeeping the drain and the p75
 * duration sample read. Split out of orchestrator.ts — whose poll loop otherwise reads as
 * one decision after another — so the launch mechanics read as one step of that loop. The
 * shared in-flight state (buckets, permit holders, duration samples, gateStates) is passed
 * in and mutated in place, exactly as the inline version did: the drain's `finally` and the
 * redeployer read it between polls. */
import {
  abandonFallbackProbeAt,
  recordFallbackTickAt,
  startFallbackProbeAt,
  type FallbackBreakerPolicy,
} from "../budget/fallback-breaker.js";
import { seamHoldKey } from "../config/config-views.js"
import type { TeamGateStates } from "../gates/gate-polls.js";
import { logEventBestEffort, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import type { RoleRunner } from "../runner/runner.js";
import { fairOrder } from "../scheduling/scheduling.js";
import { modelPairName } from "../budget/budget.js";
import type { Semaphore } from "../concurrency/semaphore.js";
import { withProviderLease } from "../concurrency/provider-lease.js";
import { seamConcurrencyKey } from "../config/config-views.js";
import type { ModelSelector } from "../config/model-selector.js";
import { DIRECTOR_ROLE, roleTier } from "../roles/roles.js";
import { runTimedRoleRun } from "../run/run-timing.js";

/** How many recent work-bearing run durations the p75 sample keeps (drainInFlightWork's
 * HANDOFF_MERGE_WINDOW_MS input): the drain window tracks recent run pace, not all-time
 * pace, so the sample is a ring buffer. */
export const ROLE_RUN_DURATION_SAMPLES = 50;

/** The admission wait threshold below which a role run's semaphore wait logs no event — a
 * run that starts at once stays silent. Mirrors SLOT_WAIT_EVENT_MS in src/git/worktree-pool.ts:
 * the wait that signals maxConcurrentPerProvider (or maxConcurrent) caps the team. */
export const PROVIDER_WAIT_EVENT_MS = 30_000;

/** What the launch pass needs from the orchestrator: the poll's inputs and the team's
 * shared mutable state, passed by reference so updates arrive where the drain, the redeployer,
 * and the next poll read them. Not exported — callers pass an object literal and the
 * structural type is only this module's parameter shape. */
interface LaunchContext {
  /** The repo root, for the wake events. */
  root: string;
  /** The decision pass's output: the runner → due-reason map, in poll order. */
  reasons: ReadonlyMap<RoleRunner, string | undefined>;
  /** The role run signal (the full shutdown signal plus the role-only stop): a restart
   * cuts off permit holders through it. */
  signal: AbortSignal;
  /** The team gates' shared memory: the fallback breakers' probe and evidence bookkeeping
   * is reassigned onto gateStates.budget.breakers in place. */
  gateStates: TeamGateStates;
  /** The breaker's policy knobs (drain window and probe timing), fixed at startup. */
  breakerPolicy: FallbackBreakerPolicy;
  /** The fallback breaker's clock (default Date.now; see RunOptions.breakerNow): the evidence
   * fold stamps its cool-down deadline from this, never from the run's own wall clock. */
  breakerNow: () => number;
  /** The pair whose demoted fallback this poll admits a probe run for, or null when none
   * (the decision pass computed it from the breaker map). */
  probePair: string | null;
  /** The roles whose model tier resolves to the probed pair (part 5c/8): the ONLY runners
   * this pass may admit as the probe, one per poll. Continuing only these runners — never
   * the rest of the team — when none of them can carry the claim is what keeps a probe
   * whose tier has no due runner from deadlocking the pass (an objection to an earlier
   * draft, which continued every non-director runner). */
  probeRoles: ReadonlySet<string>;
  /** Whether the cap is reached this poll (gate-polls.ts's budgetActive): a budget hold puts
   * role runs on fallback pairs, so then a run's outcome folds as evidence into the breakers. */
  budgetActive: boolean;
  /** The roles a usage-window move put on a fallback pair (gate-polls.ts's windowMovedRoles):
   * their run outcomes fold into the breakers even below the cap. */
  windowMovedRoles: ReadonlySet<string>;
  /** The team's run semaphore; the director never queues behind it. */
  semaphore: Semaphore;
  /** pi's saved default model (the caller's stat-cached readPiDefaultModel result): the
   * fallback provider key for a pi seam that names no model (plans/provider-concurrency.md §2). */
  piDefault: ModelSelector | null;
  /** Role runs actually holding a permit — the redeployer's in-flight count and the
   * restart abort's target. */
  rolePermitHolders: Set<RoleRunner>;
  /** The two in-flight buckets: role runs (the drain awaits these) and director runs
   * (the drain waits for them to finish first). */
  roleInFlight: Set<Promise<void>>;
  directorInFlight: Set<Promise<void>>;
  /** The recent work-bearing role-run duration ring buffer the drain window samples. */
  roleRunDurationsMs: number[];
  /** The start gate a waiter meets at permit time: the restart hold plus the failure hold
   * for role runs (the director is exempt, as at scheduling). */
  /** The run semaphore's admission wait threshold (default PROVIDER_WAIT_EVENT_MS): a test
   * seam mirroring breakerNow — providerWaitMs: 0 forces every admission's wait to be logged. */
  providerWaitMs?: number;
  /** The start gate a waiter meets at permit time: the restart hold plus the failure hold
   * for role runs (the director is exempt, as at scheduling). */
  startHeld: (role: string) => boolean;
}

/** Launch one due runner's run: reserve it, park it in the semaphore, and start it under
 * runTimedRoleRun with the breaker-evidence wiring. Returns the task promise already added
 * to its in-flight bucket (its `finally` self-removes and folds the duration sample). */
export function launchDueRuns(ctx: LaunchContext): void {
  const {
    root,
    reasons,
    signal,
    gateStates,
    breakerPolicy,
    breakerNow,
    probePair,
    probeRoles,
    budgetActive,
    windowMovedRoles,
    semaphore,
    piDefault,
    rolePermitHolders,
    roleInFlight,
    directorInFlight,
    roleRunDurationsMs,
    startHeld,
  } = ctx;
  let admittedProbe = false;
  for (const runner of fairOrder([...reasons.keys()])) {
    if (signal.aborted) continue;
    let probe = false;
    // The probe goes to the first runner whose tier resolves to the probed pair (part 5c/8);
    // every other runner launches normally, and only a further eligible runner waits — the
    // probe claim is one per poll, so the rest of this pass skips just them.
    if (probePair !== null && probeRoles.has(runner.role)) {
      if (admittedProbe) continue; // this poll's claim is taken: the next eligible runner waits
      const b = gateStates.budget.breakers[probePair];
      if (b === undefined || b.probing) continue; // no entry, or a claim already in flight: waits
      gateStates.budget.breakers = startFallbackProbeAt(gateStates.budget.breakers, probePair);
      probe = true;
      admittedProbe = true;
    }
    const reason = reasons.get(runner);
    if (reason && reason !== "scheduled" && reason !== "startup") {
      logEventBestEffort(root, { source: runner.role, type: "wake", reason });
    }
    runner.state.running = true; // Reserve before the semaphore wait so we don't double-schedule.
    // The director never queues behind roles: a user prompt starts immediately,
    // even when maxConcurrent slots are busy. Parked waiters keep fairOrder's tier order
    // across polls too: a work-role arrival jumps ahead of maintenance runs that queued
    // in an earlier poll (in-flight runs always finish).
    const usesSlot = runner.role !== DIRECTOR_ROLE;
    // Mark the parked waiter while it waits: it holds no permit yet, so the dashboards
    // render `awaiting slot` (an inactive state) and the active rows keep tracking
    // maxConcurrent (BUGS.md 2026-09-24). Cleared the moment the permit is granted. The
    // director never queues, so it is never a parked waiter. Its provider key rides beside
    // `parkedSince` (provider-concurrency part 5/5): the key the admission lease will
    // acquire, computed from the same runConfig admission uses, so a waiter named by a
    // full key renders `awaiting <key> slot` on the dashboards.
    const parkKey = runner.role === DIRECTOR_ROLE ? null : runner.runConfig(Date.now());
    runner.state.parkedSince = usesSlot ? Date.now() : undefined;
    runner.state.parkedOn = usesSlot && parkKey ? seamConcurrencyKey(parkKey, piDefault) : undefined;
    // The run's own duration (null when it never started, was cut off, or ended without
    // work): the drain-window sample is taken only for a work-bearing run that finished
    // on its own (runTimedRoleRun; BUGS.md 2026-09-30).
    let durationMs: number | null = null;
    // Whether runner.run() was ever called — false when the start gate (or a shutdown)
    // turned the run away at its permit.
    let started = false;
    // The run's keyed semaphore lease (plans/provider-concurrency.md §4): acquired on the
    // authoring seam's provider key and released in place of the bare team release, so the
    // cap is real for role runs from part 2/5 on. The director never queues, so its lease is
    // never created here.
    let lease: Awaited<ReturnType<Semaphore["acquireLease"]>> | null = null;
    // The director's forced provider lease (plans/provider-concurrency.md §4): never queues and
    // never counts toward maxConcurrent, but DOES count toward its provider key while its run
    // runs — so a full provider admits no further grants until the director releases.
    let directorLease: Awaited<ReturnType<Semaphore["forceLease"]>> | null = null;
    const task = (async () => {
      durationMs = await runTimedRoleRun(
        signal,
        usesSlot
          ? async () => {
              // The key is the authoring seam's concurrency key, computed here at admission
              // (runConfig applies any budget or model-failure fallback already in force).
              const cfg = runner.role === DIRECTOR_ROLE ? null : runner.runConfig(Date.now());
              const key = cfg ? seamConcurrencyKey(cfg, piDefault) : undefined;
              const admittedAt = Date.now();
              // Which cap would hold the run, read once at park time (not revised if the caps
              // change mid-wait): the run's own provider cap when full, else the team total.
              const pool = semaphore.snapshot();
              const keyed = key !== undefined ? pool.byKey[key] : undefined;
              const providerFull = keyed?.limit !== undefined && keyed.inUse >= keyed.limit;
              const heldBy = providerFull
                ? { cap: "provider" as const, limit: keyed.limit }
                : { cap: "team" as const, limit: pool.limit };
              lease = await semaphore.acquireLease(roleTier(runner.role), key);
              // A wait of PROVIDER_WAIT_EVENT_MS or more for the provider/team slot is
              // provider contention worth surfacing: name it so `tumwater doctor`'s provider
              // contention row can sum it and the operator can size maxConcurrentPerProvider
              // (or maxConcurrent) from real waits. Best-effort like the launch pass's other
              // events, so an unwritable log never blocks a start; a run admitted at once
              // stays silent.
              if (Date.now() - admittedAt >= (ctx.providerWaitMs ?? PROVIDER_WAIT_EVENT_MS)) {
                logEventBestEffort(ctx.root, {
                  source: TUMWATER_SOURCE,
                  type: "provider_wait",
                  role: runner.role,
                  waitedMs: Date.now() - admittedAt,
                  ...(key !== undefined ? { key } : {}),
                  ...heldBy,
                });
              }
              // Permit granted: the run is now an active, permit-holding state until the
              // release below. A run the start gate turns away releases within the same
              // microtask chain, so no poll ever counts it as a permit holder.
              runner.state.parkedSince = undefined;
              runner.state.parkedOn = undefined;
              rolePermitHolders.add(runner);
            }
          : async () => {
              // The director wraps its run in a forced lease on its provider key, never
              // queuing behind roles: a user prompt starts at once even on a full provider,
              // and the key's in-use rises by one — overshooting by one — so no further grant on
              // that key happens until its release drains it back under the cap.
              const cfg = runner.runConfig(Date.now());
              directorLease = semaphore.forceLease(cfg ? seamConcurrencyKey(cfg, piDefault) : undefined);
            },
        usesSlot
          ? () => {
              rolePermitHolders.delete(runner);
              lease!.release();
            }
          : () => {
              directorLease!.release();
            },
        async () => {
          started = true;
          // A role run that starts while the budget holds uses the fallback pair its tier
          // resolved to (the gate's per-tier view was installed in its config), or — when a
          // model-fallback episode is active — on the tier's model-fallback pair, which can
          // differ from the budget pair. Its outcome is the evidence for the pair it ACTUALLY
          // ran on, so read it from runConfig (config + episode), never from configForRole
          // alone: a per-pair breaker fed a fallback run under the primary's name would
          // misprice a healthy pair and miss a dead one (PLANS.md "Model failure fallback,
          // part 1/2").
          const now = Date.now();
          const cfg = runner.role === DIRECTOR_ROLE ? null : runner.runConfig(now);
          // The breaker is keyed by the seam that ran (seamHoldKey), like the run pair and
          // the team-hold stamps (PLANS.md "Mixed claude + pi fleets, part 2/4"): a claude
          // fallback run demotes the `claude/<model>` breaker entry, never `?/…`.
          const ranPair =
            (budgetActive || windowMovedRoles.has(runner.role)) && cfg?.model !== undefined
              ? modelPairName({ provider: seamHoldKey(cfg), model: cfg.model })
              : null;
          const ranOn = ranPair !== null ? gateStates.budget.breakers[ranPair] : undefined;
          // The run's lease rides in the provider-lease store for the length of the run, so
          // every agent run it makes re-keys it to the provider that agent run actually uses
          // (plans/provider-concurrency.md §5) — a budget or model-failure switch that moves an
          // agent run to another provider mid-run moves the lease with it. The director's forced
          // lease re-keys the same way, and its rekey never waits.
          const outcome = await withProviderLease(
            runner.role === DIRECTOR_ROLE ? directorLease! : lease!,
            semaphore,
            () => runner.run(),
            { piDefault },
          );
          if (ranPair !== null && ranOn !== undefined) {
            const at = breakerNow();
            const evidence = outcome.recoveredLeftover ? "skipped" : outcome.result;
            gateStates.budget.breakers = recordFallbackTickAt(
              gateStates.budget.breakers,
              ranPair,
              ranOn,
              evidence,
              probe,
              at,
              breakerPolicy,
            );
          } else if (probe && probePair !== null) {
            // A probe whose run started on no engaged pair — the budget gate reopened
            // between admission and start (the cap raised, or midnight reset spend) — folds
            // no evidence, so its claim would hang on the pair's entry forever: probing
            // blocks both fallbackProbeDuePair and startFallbackProbeAt, and nothing but a
            // rekey clears it, so the demoted fallback could never earn another probe. Hand
            // the claim back exactly as the !started path below does for a run turned away
            // at its permit.
            gateStates.budget.breakers = abandonFallbackProbeAt(gateStates.budget.breakers, probePair);
          }
          return outcome;
        },
        Date.now,
        // The restart start gate, plus the failure hold for role runs (the director is
        // exempt, as at scheduling): a waiter granted its permit mid-storm must not start
        // into it.
        () => startHeld(runner.role),
      );
      // A reservation whose run never started hands itself back, so the role re-schedules
      // once the hold lifts (or on the new build) instead of sitting `running` forever with
      // nothing in flight. Memory only, on purpose: nothing started, so no state write and
      // no run_start/run_end — the persisted state still reads exactly as the last real
      // run left it, and the next generation schedules the role from that.
      if (!started) runner.state.running = false;
      // A probe turned away the same way answered nothing: hand its claim back (see
      // abandonFallbackProbeAt) so the next poll can admit a probe that actually runs.
      if (!started && probe && probePair !== null)
        gateStates.budget.breakers = abandonFallbackProbeAt(gateStates.budget.breakers, probePair);
    })();
    const bucket = runner.role === DIRECTOR_ROLE ? directorInFlight : roleInFlight;
    bucket.add(task);
    // A RoleRunner.run folds every failure it handles into an `error` outcome, so this task
    // should resolve. A throw outside that fold (a finalize-time file write, a runner bug)
    // rejects it instead; the drain awaits the bucket with allSettled, but chaining cleanup
    // off a bare `void task.finally(...)` would leave the derived promise's rejection
    // unhandled and take the whole team down. Surface it as a warning (warnEventBestEffort,
    // which keeps a failed warning write from becoming that unhandled rejection) and hand the
    // reservation back so the role can schedule again, exactly as the unstarted path above
    // does; the drain's allSettled is otherwise silent about the failure.
    void task
      .catch((err: unknown) => {
        runner.state.running = false;
        warnEventBestEffort(root, runner.role, `run task rejected: ${errorMessage(err)}`);
      })
      .finally(() => {
        bucket.delete(task);
        if (bucket === roleInFlight && durationMs !== null) {
          roleRunDurationsMs.push(durationMs);
          if (roleRunDurationsMs.length > ROLE_RUN_DURATION_SAMPLES) roleRunDurationsMs.shift();
        }
      });
  }
}
