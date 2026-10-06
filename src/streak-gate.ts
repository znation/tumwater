/** The error-streak circuit breaker (PLANS.md 2026-09-30): a role whose ticks keep failing
 * consecutively is warned at ERROR_STREAK_WARN (src/tick/tick-apply.ts) and named by the
 * fleet-wide storm alarms (src/error-storm.ts, src/failure/failure-spread.ts), but both only talk —
 * the role keeps ticking on the error ladder's 600 s max backoff forever, burning a model
 * slot and spend on a loop that cannot succeed. Past ERROR_STREAK_BREAKER consecutive failed
 * ticks this gate pauses the role through the same per-role pause marker the operator's
 * `tumwater pause --role <id>` writes (src/fleet-state.ts's pauseRole — the marker, lock, and
 * idempotence come free), so the scheduler's existing pausedRolesSet skip blocks new ticks
 * with zero scheduler changes. The director is NOT exempt: a failing director cannot process
 * prompts anyway, and one uniform rule needs no carve-out. `tumwater resume --role <id>` (or
 * the dashboard's per-row toggle) lifts it, as today.
 *
 * Shape, like every gate in the family (src/gate-polls.ts): the pure trip bookkeeping lives
 * here so it is unit-testable without a fleet, and the module owns the only event emission —
 * the orchestrator's poll owns only the wiring.
 *
 * Ack bookkeeping. The marker itself is the ack carrier: every poll, each role present in
 * the paused set has its streak recorded in the in-memory `acked` map, so after the operator
 * resumes a breaker-paused role, re-tripping requires ERROR_STREAK_BREAKER *more* consecutive
 * failures, not one — the same grace an operator-paused failing role gets (its streak is
 * acked while the pause stands, so resuming it does not instantly re-trip on the pre-pause
 * streak), and the same durability a harness restart mid-pause gets (the in-memory state is
 * lost, but the standing marker freezes the ack on the first poll after the restart). If the
 * operator had already resumed before a restart, a still-live streak at or past the breaker
 * re-trips once — the cause is durable, and one event is the honest report. A streak that
 * resets to 0 through the role's own success clears the ack: the next episode trips on its
 * own fresh ERROR_STREAK_BREAKER failures.
 *
 * Accepted behavior, stated here and not fixed in this change: the dashboards' "failing tick
 * after tick" alert (src/ui/fleet-alerts.ts) reads consecutiveErrors regardless of pause, so
 * it keeps listing a breaker-paused role until the streak clears; the loop cell's paused
 * badge explains why it is not ticking, and the role_streak_paused event tells the operator
 * why. */

import { ERROR_STREAK_BREAKER } from "./tick/tick-apply.js";
import type { LoopState } from "./loop-state.js";
import { pauseRole } from "./fleet-state.js";
import { logEvent } from "./events/events.js";

/** One runner's streak as the gate reads it — the same Pick pollErrorStorm uses
 * (src/fleet-polls.ts): LoopState.consecutiveErrors and lastError. */
type StreakObservation = {
  role: string;
  state: Pick<LoopState, "consecutiveErrors" | "lastError">;
};

/** The gate's cross-poll memory: per role, the streak level already accounted for at its
 * last trip or last ack-while-paused. In memory only, like every gate state — the marker
 * carries the durable half (see the module doc). */
export interface StreakGateState {
  acked: Map<string, number>;
}

/** A fresh gate state: nothing acked, so a live streak at or past the breaker trips on the
 * first poll (the durable-cause case a restart after an operator resume relies on). */
export function newStreakGateState(): StreakGateState {
  return { acked: new Map() };
}

/** Step the gate by one orchestrator poll. For each runner whose consecutive error streak
 * has reached ERROR_STREAK_BREAKER plus what its ack already excused, and whose role is not
 * in `pausedRoles`: write the per-role pause marker and log one `role_streak_paused` event
 * carrying the role, the streak, and the last error. Returns the roles this poll paused, so
 * the wiring can fold them into the poll's paused-roles view and the scheduler blocks them
 * on this very poll, not the next one.
 *
 * Roles already paused are acked instead of tripped (the ack carrier is the marker itself,
 * per the module doc), a healthy streak clears its ack, and a streak below its bar leaves
 * the state untouched — so repeated polls while a breaker-paused role stays paused log
 * nothing more, and pauseRole's own idempotence backstops any race. */
export function pollStreakGate(
  root: string,
  state: StreakGateState,
  runners: readonly StreakObservation[],
  pausedRoles: ReadonlySet<string>,
): string[] {
  const tripped: string[] = [];
  for (const { role, state: s } of runners) {
    const streak = s.consecutiveErrors ?? 0;
    // Ack while paused: the marker is the ack carrier. The streak is frozen while a role is
    // paused (no ticks run), so recording it here is exactly the level the resume excuses.
    if (pausedRoles.has(role)) {
      state.acked.set(role, streak);
      continue;
    }
    if (streak === 0) {
      // A streak that reset through the role's own success ends the excused episode: the
      // next one must climb a fresh ERROR_STREAK_BREAKER of its own.
      state.acked.delete(role);
      continue;
    }
    const ack = state.acked.get(role) ?? 0;
    if (streak < ERROR_STREAK_BREAKER + ack) continue;
    // Ack at trip time, before the pause is observed: the bar for the next trip is
    // ERROR_STREAK_BREAKER more failures from this level, whether or not any poll sees the
    // role paused in between (an operator resume racing the next poll must not re-trip).
    state.acked.set(role, streak);
    if (pauseRole(root, role)) {
      logEvent(root, {
        loop: "harness",
        type: "role_streak_paused",
        role,
        streak,
        ...(s.lastError ? { lastError: s.lastError } : {}),
      });
      tripped.push(role);
    }
  }
  return tripped;
}
