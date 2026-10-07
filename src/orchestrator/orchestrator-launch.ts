/** The orchestrator's launch pass: the half of the per-poll runner sweep that admits due
 * roles to their ticks. The decision half (isEligible, the pause/backoff/deferral gates,
 * once-mode settling) stays in runOrchestrator (src/orchestrator/orchestrator.ts) — it reads the poll's
 * gate verdicts and the backlog state; this module takes its output, the `reasons` map of
 * due runners, and turns each into a reserved, semaphore-gated, in-flight tick: the probe
 * admission for the fallback breaker, the wake event, the reservation/parking bookkeeping,
 * runTimedRoleTick's wiring (slot acquisition, the start gate, breaker evidence), and the
 * in-flight-bucket bookkeeping the drain and the p75 duration sample read. Split out of
 * orchestrator.ts — whose poll loop otherwise reads as one decision after another — so the
 * launch mechanics read as one step of that loop. The shared in-flight state (buckets,
 * permit holders, duration samples, gateStates) is passed in and mutated in place, exactly
 * as the inline version did: the drain's `finally` and the redeployer read it between polls. */
import {
  abandonFallbackProbeAt,
  recordFallbackTickAt,
  startFallbackProbeAt,
  type FallbackBreakerPolicy,
} from "../budget/fallback-breaker.js";
import type { FleetGateStates } from "../gates/gate-polls.js";
import { logEvent } from "../events/events.js";
import type { LoopRunner } from "../loop/loop.js";
import { fairOrder } from "../scheduling/scheduling.js";
import { modelPairName } from "../budget/budget.js";
import type { Semaphore } from "../concurrency/semaphore.js";
import { DIRECTOR_ROLE, roleTier } from "../roles/roles.js";
import { runTimedRoleTick } from "../tick/tick-timing.js";

/** How many recent work-bearing tick durations the p75 sample keeps (drainInFlightWork's
 * HANDOFF_LANDING_WINDOW_MS input): the drain window tracks recent tick pace, not all-time
 * pace, so the sample is a ring buffer. */
export const ROLE_TICK_DURATION_SAMPLES = 50;

/** What the launch pass needs from the orchestrator: the poll's inputs and the fleet's
 * shared mutable state, passed by reference so updates land where the drain, the redeployer,
 * and the next poll read them. Not exported — callers pass an object literal and the
 * structural type is only this module's parameter shape. */
interface LaunchContext {
  /** The repo root, for the wake events. */
  root: string;
  /** The decision pass's output: the runner → due-reason map, in poll order. */
  reasons: ReadonlyMap<LoopRunner, string | undefined>;
  /** The role tick signal (the full shutdown signal plus the role-only stop): a restart
   * cuts off permit holders through it. */
  signal: AbortSignal;
  /** The fleet gates' shared memory: the fallback breakers' probe and evidence bookkeeping
   * is reassigned onto gateStates.budget.breakers in place. */
  gateStates: FleetGateStates;
  /** The breaker's policy knobs (drain window and probe timing), fixed at startup. */
  breakerPolicy: FallbackBreakerPolicy;
  /** The fallback breaker's clock (default Date.now; see RunOptions.breakerNow): the evidence
   * fold stamps its cool-down deadline from this, never from the tick's own wall clock. */
  breakerNow: () => number;
  /** The pair whose demoted fallback this poll admits a probe tick for, or null when none
   * (the decision pass computed it from the breaker map). */
  probePair: string | null;
  /** The roles whose model tier resolves to the probed pair (part 5c/8): the ONLY runners
   * this pass may admit as the probe, one per poll. Continuing only these runners — never
   * the rest of the fleet — when none of them can carry the claim is what keeps a probe
   * whose tier has no due runner from deadlocking the pass (an objection to an earlier
   * draft, which continued every non-director runner). */
  probeRoles: ReadonlySet<string>;
  /** Whether the cap is reached this poll (gate-polls.ts's budgetActive): only a budget
   * hold puts role ticks on fallback pairs, so only then does a tick's outcome fold as
   * evidence into the breakers. */
  budgetActive: boolean;
  /** The fleet's tick semaphore; the director never queues behind it. */
  semaphore: Semaphore;
  /** Role ticks actually holding a permit — the redeployer's in-flight count and the
   * restart abort's target. */
  rolePermitHolders: Set<LoopRunner>;
  /** The two in-flight buckets: role ticks (the drain awaits these) and director ticks
   * (the drain waits for them to finish first). */
  roleInFlight: Set<Promise<void>>;
  directorInFlight: Set<Promise<void>>;
  /** The recent work-bearing role-tick duration ring buffer the drain window samples. */
  roleTickDurationsMs: number[];
  /** The start gate a waiter meets at permit time: the restart hold plus the failure hold
   * for role ticks (the director is exempt, as at scheduling). */
  startHeld: (role: string) => boolean;
}

/** Launch one due runner's tick: reserve it, park it in the semaphore, and start it under
 * runTimedRoleTick with the breaker-evidence wiring. Returns the task promise already added
 * to its in-flight bucket (its `finally` self-removes and folds the duration sample). */
export function launchDueTicks(ctx: LaunchContext): void {
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
    semaphore,
    rolePermitHolders,
    roleInFlight,
    directorInFlight,
    roleTickDurationsMs,
    startHeld,
  } = ctx;
  let admittedProbe = false;
  for (const runner of fairOrder([...reasons.keys()])) {
    if (signal.aborted) continue;    // The probe goes to the first runner whose tier resolves to the probed pair (part 5c/8);
    // every other runner launches normally, and only a further eligible runner waits — the
    // probe claim is one per poll, so the rest of this pass skips just them.
    let probe = false;
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
    // The tick's own run time (null when it never ran, was cut off, or ended without
    // work): the drain-window sample is taken only for a work-bearing tick that finished
    // on its own (runTimedRoleTick; BUGS.md 2026-09-30).
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
          // A role tick that starts while the budget holds runs on the fallback pair its tier
          // resolved to (the gate's per-tier view was installed in its config), or — when a
          // model-fallback episode is active — on the tier's model-fallback pair, which can
          // differ from the budget pair. Its outcome is the evidence for the pair it ACTUALLY
          // ran on, so read it from runConfig (config + episode), never from configForRole
          // alone: a per-pair breaker fed a fallback tick under the primary's name would
          // misprice a healthy pair and miss a dead one (PLANS.md "Model failure fallback,
          // part 1/2").
          const now = Date.now();
          const cfg = runner.role === DIRECTOR_ROLE ? null : runner.runConfig(now);
          const ranPair =
            budgetActive && cfg !== null && cfg.model !== undefined
              ? modelPairName({ provider: cfg.provider, model: cfg.model })
              : null;
          const ranOn = ranPair !== null ? gateStates.budget.breakers[ranPair] : undefined;
          const outcome = await runner.tick();
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
            // A probe whose tick started on no engaged pair — the budget gate reopened
            // between admission and start (the cap raised, or midnight reset spend) — folds
            // no evidence, so its claim would hang on the pair's entry forever: probing
            // blocks both fallbackProbeDuePair and startFallbackProbeAt, and nothing but a
            // rekey clears it, so the demoted fallback could never earn another probe. Hand
            // the claim back exactly as the !started path below does for a tick turned away
            // at its permit.
            gateStates.budget.breakers = abandonFallbackProbeAt(gateStates.budget.breakers, probePair);
          }
          return outcome;
        },
        Date.now,
        // The restart start gate, plus the failure hold for role ticks (the director is
        // exempt, as at scheduling): a waiter granted its permit mid-storm must not start
        // into it.
        () => startHeld(runner.role),
      );
      // A reservation whose tick never started hands itself back, so the role re-schedules
      // once the hold lifts (or on the new build) instead of sitting `running` forever with
      // nothing in flight. Memory only, on purpose: nothing started, so no state write and
      // no tick_start/tick_end — the persisted state still reads exactly as the last real
      // tick left it, and the next generation schedules the role from that.
      if (!started) runner.state.running = false;
      // A probe turned away the same way answered nothing: hand its claim back (see
      // abandonFallbackProbeAt) so the next poll can admit a probe that actually runs.
      if (!started && probe && probePair !== null)
        gateStates.budget.breakers = abandonFallbackProbeAt(gateStates.budget.breakers, probePair);
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
}
