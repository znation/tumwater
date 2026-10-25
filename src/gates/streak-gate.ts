/** The error-streak circuit breaker (PLANS.md 2026-09-30): a role whose runs keep failing
 * consecutively is warned at ERROR_STREAK_WARN (src/run/run-apply.ts) and named by the team-wide
 * storm alarms (src/team/error-storm.ts, src/team/failure-spread.ts), but both only talk — the
 * role keeps running on the error ladder's 600 s max backoff forever, burning a model slot and
 * spend on a role that cannot succeed. Past ERROR_STREAK_BREAKER consecutive failed runs this gate
 * pauses the role through the same per-role pause marker the operator's `tumwater pause --role
 * <id>` writes (src/team/team-state.ts's pauseRole — the marker, lock, and idempotence come
 * free), so the scheduler's existing pausedRolesSet skip blocks new runs with zero scheduler
 * changes. The director is NOT exempt: a failing director cannot process prompts anyway, and one
 * uniform rule needs no carve-out. `tumwater resume --role <id>` (or the dashboard's per-row
 * toggle) lifts it, as today.
 *
 * Shape, like every gate in the family (src/gates/gate-polls.ts): the pure trip bookkeeping lives
 * here so it is unit-testable without a team, and the module owns the only event emission — the
 * orchestrator's poll owns only the wiring.
 *
 * Ack bookkeeping. The marker is the ack carrier within a run, and the durable copy of the
 * ack lives in each runner's persisted `RunnerState.streakAcked`: every poll, each role present
 * in the paused set has its streak recorded in the in-memory `acked` cache (and flushed to the
 * runner's state), so after the operator resumes a breaker-paused role, re-tripping
 * requires ERROR_STREAK_BREAKER *more* consecutive failures, not one — the same grace an
 * operator-paused failing role gets (its streak is acked while the pause stands, so resuming
 * it does not instantly re-trip on the pre-pause streak). Because the ack is
 * persisted, a harness restart after a resume does NOT re-trip a role whose frozen streak
 * never ran down — the durable cause's first poll finds the persisted ack and leaves the role
 * alone (BUGS.md 2026-10-23: the old in-memory-only ack re-paused a resumed role on every
 * auto-redeploy). A streak that resets to 0 through the role's own success clears the ack
 * (from the cache and the runner's state): the next episode trips on its own fresh
 * ERROR_STREAK_BREAKER failures.
 *
 * Accepted behavior, stated here and not fixed in this change: the dashboards' "failing run after
 * run" alert (src/ui/team-alert-status.ts) reads consecutiveErrors regardless of pause, so it keeps
 * listing a breaker-paused role until the streak clears; the role cell's paused badge explains why
 * it is not running, and the role_streak_paused event tells the operator why. */

import { ERROR_STREAK_BREAKER } from "../run/run-apply.js";
import type { RunnerState } from "../runner/runner-state.js";
import { saveRunnerStateBestEffort } from "../runner/runner-state.js";
import { runnerPaused } from "../roles/runner-ids.js";
import { pauseRole } from "../team/team-state.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";

/** One runner's streak as the gate reads it, with the runner's full persisted state so the
 * gate can write the excused-streak ack back durably (the ack's cross-restart home is
 * `RunnerState.streakAcked`; the in-memory gate state is just this run's cache of it). */
interface StreakObservation {
  role: string;
  state: RunnerState;
}

/** The gate's cross-poll memory: per role, the streak level already accounted for at its
 * last trip or last ack-while-paused. The durable half lives in each runner's persisted
 * `RunnerState.streakAcked` (written by the gate when the ack changes); this map is only the
 * in-run cache of it, seeded from the persisted value on the first sight of a role so a
 * restart keeps the excused level. */
export interface StreakGateState {
  acked: Map<string, number>;
}

/** A fresh gate state: nothing cached yet, so the first poll of a runner whose persisted
 * `streakAcked` is set seeds it from there — a restart does NOT re-trip a role the breaker
 * already excused (the bug this state exists to fix). A runner with no persisted ack that
 * is at or past the breaker trips on the first poll, as before. */
export function newStreakGateState(): StreakGateState {
  return { acked: new Map() };
}

/** Step the gate by one orchestrator poll. For each runner whose consecutive error streak
 * has reached ERROR_STREAK_BREAKER plus what its ack already excused, and whose role is not
 * in `pausedRoles`: write the per-role pause marker and log one `role_streak_paused` event
 * carrying the role, the streak, and the last error. Returns the pause keys this poll wrote
 * (`pauseKey` maps a role id to its marker key; instance 1 of a multi-instance role pauses as
 * `<role>-1`), so the wiring can fold them into the poll's paused-roles view and the scheduler
 * blocks them on this very poll, not the next one.
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
  pauseKey: (role: string) => string = (r) => r,
): string[] {
  const tripped: string[] = [];
  for (const { role, state: s } of runners) {
    const streak = s.consecutiveErrors ?? 0;
    // Seed a fresh in-run ack cache from the persisted excused streak, so a restart keeps the
    // grace the breaker (and a later operator resume) relies on instead of re-pausing a role
    // whose frozen streak never ran down (BUGS.md 2026-10-23).
    if (!state.acked.has(role) && s.streakAcked !== undefined) {
      state.acked.set(role, s.streakAcked);
    }
    // Ack while paused: the marker is the ack carrier. The streak is frozen while a role is
    // paused (no new runs start), so recording it here is exactly the level the resume excuses.
    if (runnerPaused(pausedRoles, role)) {
      if ((state.acked.get(role) ?? 0) !== streak) {
        state.acked.set(role, streak);
        s.streakAcked = streak;
        saveRunnerStateBestEffort(root, s);
      }
      continue;
    }
    if (streak === 0) {
      // A streak that reset through the role's own success ends the excused episode: the
      // next one must climb a fresh ERROR_STREAK_BREAKER of its own, so drop the durable ack too.
      if (state.acked.get(role) !== undefined) {
        state.acked.delete(role);
        delete s.streakAcked;
        saveRunnerStateBestEffort(root, s);
      }
      continue;
    }
    const ack = state.acked.get(role) ?? 0;
    if (streak < ERROR_STREAK_BREAKER + ack) continue;
    // Ack at trip time, before the pause is observed: the bar for the next trip is
    // ERROR_STREAK_BREAKER more failures from this level, whether or not any poll sees the
    // role paused in between (an operator resume racing the next poll must not re-trip). The
    // durable copy is written only once the pause is confirmed below — a failed or crashed
    // pauseRole must not leave a permanent excused ack with no marker behind it.
    state.acked.set(role, streak);
    if (pauseRole(root, pauseKey(role))) {
      s.streakAcked = streak;
      saveRunnerStateBestEffort(root, s);
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "role_streak_paused",
        role: pauseKey(role),
        streak,
        ...(s.lastError ? { lastError: s.lastError } : {}),
      });
      tripped.push(pauseKey(role));
    }
  }
  return tripped;
}
