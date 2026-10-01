/** The per-role daily cost cap (PLANS.md 2026-09-30, part 1/2): a loop whose local-day spend
 * has reached its own `maxDailyCostUsdPerRole` entry starts no new ticks until the next local
 * day or a live config edit — so one runaway role cannot eat the fleet-wide cap and starve
 * every other loop for the rest of the day. The fleet budget gate (src/budget-gates.ts)
 * bounds the SUM; this bounds each member. The stateless verdict follows that gate's own rule
 * (budgetPaused's doc: "resume is stateless, so … crossing midnight flips it on the next cycle
 * and nothing can get stuck"): the verdict is recomputed from the loop state every poll, no
 * marker is written, and local midnight lifts it by itself.
 *
 * Deliberate differences from the streak gate's shape (src/streak-gate.ts), stated in the plan
 * so no implementer re-litigates them:
 * - This gate writes NOTHING to the shared per-role pause marker (src/fleet-state.ts's
 *   pauseRole). The marker is anonymous — after a restart across midnight the harness could
 *   not tell a cap pause from an operator's, and would either refuse to lift the operator's
 *   pause or orphan it. The scheduler blocks the role through the poll's separate `capPaused`
 *   set instead, and `resume --role` has no marker to touch (none is needed: the lift is a
 *   config edit or midnight).
 * - An unknown role id in the caps map is a config-validation error (src/config-validation.ts,
 *   the `roles.<id>` idiom): explicit misconfiguration never silently no-ops a cap.
 *
 * Shape, like every gate in the family (src/gate-polls.ts): the pure verdict and the
 * edge-triggered bookkeeping live here so they are unit-testable without a fleet, and this
 * module owns the only event emission — the orchestrator's poll owns only the wiring. The
 * in-memory `prev` set is the whole cross-poll memory: a restart with a still-over-cap role
 * re-logs one `role_cap_paused` on the first poll (the durable-cause honest report the
 * streak-gate doc accepts). */

import type { LoopState } from "./loop-state.js";
import { dailyCost } from "./budget.js";
import { logEvent } from "./events.js";
import { DIRECTOR_ROLE } from "./roles.js";

/** A runner as the gate reads it — the role and the loop state whose daily window is judged. */
type CapObservation = {
  role: string;
  state: Pick<LoopState, "dayStamp" | "dayCostUsd">;
};

/** The stateless verdict: is this role over its own per-role cap as of `now`? True iff a cap
 * is configured, it is a finite number above zero (0 disables that role's cap, like the fleet
 * cap), and today's spend has reached it. The role→cap lookup stays with the caller
 * (`caps?.[role]`), so part 2/2's observers (src/status-data.ts) share this single definition
 * with the scheduler. */
export function roleCapPaused(
  state: Pick<LoopState, "dayStamp" | "dayCostUsd">,
  cap: number | undefined,
  now = Date.now(),
): boolean {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return false;
  return dailyCost(state, now) >= cap;
}

/** The gate's cross-poll memory: the roles logged as paused at the last poll. In memory only,
 * like every gate state. */
export interface RoleCapGateState {
  prev: Set<string>;
}

/** A fresh gate state: nothing seen yet, so an already-over-cap role logs exactly one
 * `role_cap_paused` on the first poll after a restart — the honest report of a durable cause. */
export function newRoleCapGateState(): RoleCapGateState {
  return { prev: new Set() };
}

/** Step the gate by one orchestrator poll. Per runner (the director exempt, like every
 * autonomous gate): judge `roleCapPaused` against its configured cap; on ENTER log one
 * `role_cap_paused` carrying the role, its spend, and its cap; on EXIT log one
 * `role_cap_resumed`. Returns the roles paused as of THIS poll, for the scheduler's
 * `capPaused` view — separate from the pause gates' `pausedRoles`, whose edge bookkeeping must
 * never see cap pauses (no marker is written; see the module doc). */
export function pollRoleCapGate(
  root: string,
  state: RoleCapGateState,
  runners: readonly CapObservation[],
  caps: Record<string, number> | undefined,
  now: number,
): ReadonlySet<string> {
  const paused = new Set<string>();
  for (const r of runners) {
    if (r.role === DIRECTOR_ROLE) continue;
    const cap = caps?.[r.role];
    const over = roleCapPaused(r.state, cap, now);
    const was = state.prev.has(r.role);
    if (over && !was) {
      logEvent(root, {
        loop: "harness",
        type: "role_cap_paused",
        role: r.role,
        spentUsd: dailyCost(r.state, now),
        capUsd: cap,
      });
    } else if (!over && was) {
      logEvent(root, { loop: "harness", type: "role_cap_resumed", role: r.role });
    }
    if (over) paused.add(r.role);
  }
  state.prev = paused;
  return paused;
}
