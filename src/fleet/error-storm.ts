/** The fleet-wide error-storm warning (BUGS.md 2026-09-29): when three or more roles' ticks
 * are failing consecutively on one shared cause, only each role's own "consecutive tick
 * failures" warning fires — nothing fleet-wide names the shared cause. The 2026-09-22
 * meltdown (all 14 roles timing out at the 1800 s default for 8 hours) surfaced as 14
 * independent streak warnings; an operator scanning the feed saw a quiet fleet. POLICY, on
 * the shape of the fleet-wide hold (src/fleet/fleet-hold.ts): a pure reducer over the
 * observations the orchestrator collects each poll and the previous storm, so the rule is
 * unit-testable without a fleet and the orchestrator owns only the wiring (the warning
 * event). Like the hold it has memory — which storm is active is a fact about the past
 * no single poll's inputs carry — so it is a reducer rather than a stateless predicate. */

import { getOrCreate, rankByCount } from "../collections.js";
import { normalizeClusterKey, poolTimeoutKey, sortedRoles, TICK_TIMEOUT_KEY } from "../failure/failure-cluster.js";
import { ERROR_STREAK_WARN } from "../tick/tick-apply.js";

/** Distinct roles whose consecutive error streaks share one normalized cause that trip the
 * storm warning. Three, matching the per-role warn bar (ERROR_STREAK_WARN, src/tick/tick-apply.ts):
 * a role only reports a cause once it has failed that many times running, so three roles at or
 * past that bar on one normalized key is three independent voices agreeing — the same evidence
 * standard the 2026-09-22 storm's diagnosis needed. Two would cry wolf on a pair of roles that
 * happen to hit the same broken merge target; the per-role warnings already cover that pair. */
export const ERROR_STORM_ROLES = 3;

/** One role's error streak as the orchestrator reads it from the runner's persisted state
 * (LoopState.consecutiveErrors/lastError — the same fields the per-role warning reads). */
export interface ErrorStormObservation {
  role: string;
  /** The role's consecutive tick failures; 0 when it is healthy, and absent when a torn or
   * older state read omits it — the reducer reads a missing streak as healthy. */
  consecutiveErrors?: number;
  /** The last error's message, when the streak is live. */
  lastError?: string;
}

/** The storm's cross-poll state: the active storm's shared normalized cause and its roles, or
 * the quiet sentinel. In memory only — a restart mid-storm can re-log one warning. */
export interface ErrorStorm {
  /** The normalized cause every member shares (normalizeClusterKey of each lastError); null
   * while no storm is active. */
  key: string | null;
  /** The roles (sorted) in the active storm; empty while quiet. */
  roles: string[];
}

/** The fleet's starting state: no storm. */
export const ERROR_STORM_QUIET: ErrorStorm = { key: null, roles: [] };

/** The config knob a shared cause points at, when one is known. Only the timeout cause is
 * mapped: `timed out after <dur>` is the reducer's pooled rendering of the tick-timeout errors
 * (src/pi/pi.ts's two `timed out after ${tickTimeoutSeconds}s` shapes, pooled into one key by
 * poolTimeoutKey — src/failure/failure-cluster.ts owns the two shapes and their pooling), and a fleet-wide
 * run of it means the tick budget does not fit the serving model — the one cause with a knob
 * to name. Every other cause is left unmapped: the storm warning still names it, but inventing
 * a knob for a cause no setting controls would send an operator turning the wrong dial.
 * Exported for its unit tests. */
export function errorStormKnob(key: string): string | undefined {
  return key === TICK_TIMEOUT_KEY ? "tickTimeoutSeconds" : undefined;
}

/** Step the storm by one orchestrator poll: from `prev` and every role's current streak,
 * decide what is storming now. A role counts toward a cause once its streak has reached the
 * per-role warn bar (ERROR_STREAK_WARN) — the same depth at which it warns alone — and its
 * lastError normalizes to that cause; its own repeats add no weight, only distinct roles do.
 * The strongest qualifying cause (most roles, ties broken by key for determinism) is the
 * storm. Edge-triggered, like every warning: the quiet→active crossing returns the new storm
 * (the wiring logs exactly one event), a poll that still sees the same storm returns `prev`
 * itself so the caller can tell nothing changed, and a storm whose members drop below the
 * bar goes quiet and re-arms — a recurrence warns again. A storm on a different cause is a
 * new episode: the old cause no longer explains the fleet, so the new one names itself. */
export function errorStorm(prev: ErrorStorm, observations: readonly ErrorStormObservation[]): ErrorStorm {
  const rolesByKey = new Map<string, Set<string>>();
  for (const { role, consecutiveErrors, lastError } of observations) {
    if ((consecutiveErrors ?? 0) < ERROR_STREAK_WARN || !lastError) continue;
    const key = poolTimeoutKey(normalizeClusterKey(lastError));
    if (!key) continue;
    getOrCreate(rolesByKey, key, () => new Set<string>()).add(role);
  }
  const storms = rankByCount(
    [...rolesByKey].filter(([, roles]) => roles.size >= ERROR_STORM_ROLES),
    ([, roles]) => roles.size,
    ([key]) => key,
  );
  const top = storms[0];
  if (!top) return ERROR_STORM_QUIET;
  const [key, roles] = top;
  if (prev.key === key) return prev;
  return { key, roles: sortedRoles(roles) };
}
