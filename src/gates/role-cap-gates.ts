/** The per-role daily cost cap (PLANS.md 2026-09-30, part 1/2): a loop whose local-day spend
 * has reached its own `maxDailyCostUsdPerRole` entry starts no new ticks until the next local
 * day or a live config edit — so one runaway role cannot eat the fleet-wide cap and starve
 * every other loop for the rest of the day. The fleet budget gate (src/gates/budget-gates.ts)
 * bounds the SUM; this bounds each member. The stateless verdict follows that gate's own rule
 * (budgetPaused's doc: "resume is stateless, so … crossing midnight flips it on the next cycle
 * and nothing can get stuck"): the verdict is recomputed from the loop state every poll, no
 * marker is written, and local midnight lifts it by itself.
 *
 * Deliberate differences from the streak gate's shape (src/gates/streak-gate.ts), stated in
 * the plan so no implementer re-litigates them:
 * - This gate writes NOTHING to the shared per-role pause marker (src/fleet/fleet-state.ts's
 *   pauseRole). The marker is anonymous — after a restart across midnight the harness could
 *   not tell a cap pause from an operator's, and would either refuse to lift the operator's
 *   pause or orphan it. The scheduler blocks the role through the poll's separate `capPaused`
 *   set instead, and `resume --role` has no marker to touch (none is needed: the lift is a
 *   config edit or midnight).
 * - An unknown role id in the caps map is a config-validation error
 *   (src/config/config-validation.ts, the `roles.<id>` idiom): explicit misconfiguration
 *   never silently no-ops a cap.
 *
 * Shape, like every gate in the family (src/gates/gate-polls.ts): the pure verdict and the
 * edge-triggered bookkeeping live here so they are unit-testable without a fleet, and this
 * module owns the only event emission — the orchestrator's poll owns only the wiring. The
 * in-memory `prev` and `warned` sets are the whole cross-poll memory: a restart with a
 * still-over-cap role re-logs one `role_cap_paused` on the first poll, and a role already past
 * 80% re-logs one `role_cap_warning` (the durable-cause honest report the streak-gate doc
 * accepts). */

import type { LoopState } from "../loop/loop-state.js";
import { budgetWarning, dailyCost, todayStamp } from "../budget/budget.js";
import { logEventBestEffort } from "../events/events.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";

/** A runner as the gate reads it — the role and the loop state whose daily window is judged. */
type CapObservation = {
  role: string;
  state: Pick<LoopState, "dayStamp" | "dayCostUsd">;
};

/** The stateless verdict: is this role over its own per-role cap as of `now`? True iff a cap
 * is configured, it is a finite number above zero (0 disables that role's cap, like the fleet
 * cap), and today's spend has reached it. The role→cap lookup stays with the caller
 * (`caps?.[role]`), so part 2/2's observers (src/status/status-data.ts) share this single
 * definition with the scheduler. */
export function roleCapPaused(
  state: Pick<LoopState, "dayStamp" | "dayCostUsd">,
  cap: number | undefined,
  now = Date.now(),
): boolean {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return false;
  return dailyCost(state, now) >= cap;
}

/** One base role's grouped verdict: whether its summed spend has reached its cap, the summed
 * figure itself, and the loop ids the group holds. */
interface RoleCapVerdict {
  over: boolean;
  spentUsd: number;
  roleIds: string[];
}

/** The grouped, stateless per-role cap verdict — the single definition the scheduler's gate
 * (`pollRoleCapGate`) and the snapshot's `capPaused` observer (src/status/status-data.ts) both
 * fold, so the hold an operator sees cannot diverge from the one the scheduler enforces.
 * Instance loop ids share their base role's cap and its SUMMED spend (`feature` and `feature-2`
 * at $0.60 each cross a `maxDailyCostUsdPerRole.feature` cap of $1 together), and the director
 * is exempt. Keyed by base role in first-appearance order; each entry carries the group's loop
 * ids so a caller can log the base (the gate) or flatten the ids (the observer). */
export function roleCapVerdicts(
  runners: readonly CapObservation[],
  caps: Record<string, number> | undefined,
  now: number,
): Map<string, RoleCapVerdict> {
  const groups = new Map<string, CapObservation[]>();
  for (const r of runners) {
    const base = baseRoleOf(r.role);
    if (base === DIRECTOR_ROLE) continue;
    const members = groups.get(base);
    if (members) members.push(r);
    else groups.set(base, [r]);
  }
  const verdicts = new Map<string, RoleCapVerdict>();
  for (const [base, members] of groups) {
    const cap = caps?.[base];
    const spentUsd = members.reduce((sum, m) => sum + dailyCost(m.state, now), 0);
    // Stamp the summed figure as today so roleCapPaused applies its own cap comparison
    // unchanged — spent already counts only the members' current-day windows.
    const over = roleCapPaused({ dayCostUsd: spentUsd, dayStamp: todayStamp(now) }, cap, now);
    verdicts.set(base, { over, spentUsd, roleIds: members.map((m) => m.role) });
  }
  return verdicts;
}

/** The gate's cross-poll memory: the roles logged as paused at the last poll, and the base
 * roles already warned in the current 80% band. In memory only, like every gate state. */
export interface RoleCapGateState {
  prev: Set<string>;
  warned: Set<string>;
}

/** A fresh gate state: nothing seen yet, so an already-over-cap role logs exactly one
 * `role_cap_paused`, and an already-past-80% role one `role_cap_warning`, on the first poll
 * after a restart — the honest report of a durable cause. */
export function newRoleCapGateState(): RoleCapGateState {
  return { prev: new Set(), warned: new Set() };
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
  // Grouping and the verdict itself live in roleCapVerdicts, shared with the snapshot's
  // `capPaused` observer (src/status/status-data.ts) so the two cannot diverge. The returned
  // set holds the paused loop ids so the scheduler can keep checking `capPaused.has(runner.role)`
  // unchanged.
  const verdicts = roleCapVerdicts(runners, caps, now);
  const paused = new Set<string>();
  const overBases = new Set<string>();
  for (const [base, verdict] of verdicts) {
    const was = state.prev.has(base);
    if (verdict.over && !was) {
      logEventBestEffort(root, {
        loop: "harness",
        type: "role_cap_paused",
        role: base,
        spentUsd: verdict.spentUsd,
        capUsd: caps?.[base],
      });
    } else if (!verdict.over && was) {
      logEventBestEffort(root, { loop: "harness", type: "role_cap_resumed", role: base });
    }
    // The 80% early warning (PLANS.md 2026-10-09), the per-role twin of the fleet's
    // budget_warning and edge-triggered with the same reset-on-below: crossing the threshold
    // while still under the cap logs one role_cap_warning, a dip back under re-arms it. Warn
    // only while the cap is open — a poll that jumps straight to the cap already logs its own
    // role_cap_paused, so the warning never doubles the page on the poll the cap is reached.
    const cap = caps?.[base];
    const warn =
      !verdict.over && cap !== undefined && budgetWarning({ spentUsd: verdict.spentUsd, capUsd: cap });
    if (warn && !state.warned.has(base)) {
      logEventBestEffort(root, {
        loop: "harness",
        type: "role_cap_warning",
        role: base,
        spentUsd: verdict.spentUsd,
        capUsd: cap,
      });
      state.warned.add(base);
    } else if (!warn) {
      state.warned.delete(base);
    }
    if (verdict.over) {
      overBases.add(base);
      for (const id of verdict.roleIds) paused.add(id);
    }
  }
  state.prev = overBases;
  return paused;
}
