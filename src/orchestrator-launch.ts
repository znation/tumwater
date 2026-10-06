/** The orchestrator's launch pass: the half of the per-poll runner sweep that admits due
 * roles to their ticks. The decision half (isEligible, the pause/backoff/deferral gates,
 * once-mode settling) stays in runOrchestrator (src/orchestrator.ts) — it reads the poll's
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
  abandonFallbackProbe,
  recordFallbackTick,
  startFallbackProbe,
  type FallbackBreakerPolicy,
} from "./fallback-breaker.js";
import type { FleetGateStates } from "./gates/gate-polls.js";
import { logEvent } from "./events/events.js";
import type { LoopRunner } from "./loop.js";
import { fairOrder } from "./scheduling.js";
import type { Semaphore } from "./semaphore.js";
import { DIRECTOR_ROLE, roleTier } from "./roles.js";
import { runTimedRoleTick } from "./tick/tick-timing.js";

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
  /** The fleet gates' shared memory: the fallback breaker's probe and evidence bookkeeping
   * is reassigned onto gateStates.budget.breaker in place. */
  gateStates: FleetGateStates;
  /** The breaker's policy knobs (drain window and probe timing), fixed at startup. */
  breakerPolicy: FallbackBreakerPolicy;
  /** Whether this poll admits a fallback probe (the decision pass computed it). */
  probeDue: boolean;
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
    probeDue,
    semaphore,
    rolePermitHolders,
    roleInFlight,
    directorInFlight,
    roleTickDurationsMs,
    startHeld,
  } = ctx;
  for (const runner of fairOrder([...reasons.keys()])) {
    if (signal.aborted) continue;
    // The probe goes to the first role fairOrder admits; every other due role waits for its
    // verdict (startFallbackProbe marks it in flight, so the rest of this pass skips).
    let probe = false;
    if (probeDue && runner.role !== DIRECTOR_ROLE) {
      if (gateStates.budget.breaker.probing) continue;
      gateStates.budget.breaker = startFallbackProbe(gateStates.budget.breaker);
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
          // A role tick that starts while a fallback is engaged runs on it (the config and
          // the breaker are updated in the same synchronous poll step), so its outcome is
          // the breaker's evidence. Read at tick start, not at admission: a tick parked in
          // the semaphore starts on whatever the gate says by then. A tick that ended on
          // leftover recovery ran no model, so it folds as `skipped` — no evidence either way.
          const ranOn = runner.role === DIRECTOR_ROLE ? null : gateStates.budget.breaker;
          const outcome = await runner.tick();
          if (ranOn?.pair) {
            const at = Date.now();
            const evidence = outcome.recoveredLeftover ? "skipped" : outcome.result;
            gateStates.budget.breaker = recordFallbackTick(
              gateStates.budget.breaker,
              ranOn,
              evidence,
              probe,
              at,
              breakerPolicy,
            );
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
      // abandonFallbackProbe) so the next poll can admit a probe that actually runs.
      if (!started && probe) gateStates.budget.breaker = abandonFallbackProbe(gateStates.budget.breaker);
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