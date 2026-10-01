/** The daily-cost budget: a loop's and the fleet's local-day spend and the gate those figures
 * drive (plans/daily-cost-budget.md, plans/fallback-model.md). The circuit breaker that judges
 * whether the gate's fallback can actually serve lives beside it in fallback-breaker.ts. Split
 * out of loop-state.ts, which owns
 * LoopState persistence and scheduling bookkeeping: the budget is POLICY both the scheduler and
 * every observer evaluate from the same definitions. Kept free of the scheduler and of pi's
 * model catalog (fallback readiness arrives as plain booleans), so observers can depend on it
 * without importing either — the one-way rule that previously kept these functions in
 * loop-state.ts. */

import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState } from "./loop-state.js";
import { dayKey } from "./datetime.js";

/** The local calendar day as YYYY-MM-DD — the same local-time convention as every other
 * wall-clock display in the harness (lastTickCell). */
export function todayStamp(now = Date.now()): string {
  return dayKey(now);
}

/** This loop's spend for the local day (the daily cost budget window): $0 when its stamp is
 * stale or missing — a loop that hasn't ticked since yesterday reads as $0 today with no save
 * required, and spend recorded before this field existed is unknown. Reads never mutate.
 * See plans/daily-cost-budget.md. */
export function dailyCost(
  s: Pick<LoopState, "dayStamp" | "dayCostUsd">,
  now = Date.now(),
): number {
  return s.dayStamp === todayStamp(now) ? (s.dayCostUsd ?? 0) : 0;
}

/** Record a pi run's cost into the loop's daily window, rolling over at local midnight:
 * when `now` is on a different day than the recorded stamp the window resets first, so a tick
 * that crosses midnight attributes its spend to the correct day. Mutates `s` in place — like
 * applyTickOutcome and foldUsage's other counter updates, the caller's state object is
 * authoritative across an in-flight tick; the value persists at tick end with the rest of the
 * state. */
export function recordDailyCost(s: LoopState, usd: number, now = Date.now()): void {
  const stamp = todayStamp(now);
  if (s.dayStamp !== stamp) {
    s.dayStamp = stamp;
    s.dayCostUsd = 0;
  }
  s.dayCostUsd = (s.dayCostUsd ?? 0) + usd;
}

/** The fleet's spend for the local day: every loop's daily window summed. */
export function fleetDailyCost(states: LoopState[], now = Date.now()): number {
  return states.reduce((sum, s) => sum + dailyCost(s, now), 0);
}

/** True when today's spend has reached the daily cost budget — the view is non-null, its
 * cap is enabled (capUsd > 0; a cap of 0 disables the gate regardless of spend), and spend
 * sits at or above it. The single definition of "the budget gate is on": the orchestrator
 * evaluates it from live loop states via budgetPaused, and both dashboards evaluate it from
 * the snapshot's materialized budget field (status-data.ts) — which carries the object even while
 * disabled, so the capUsd > 0 term is what keeps a disabled fleet out of "budget paused".
 * The comparison cannot drift between what the scheduler enforces and what users see. */
export function budgetReached(budget: { spentUsd: number; capUsd: number } | null): boolean {
  return budget !== null && budget.capUsd > 0 && budget.spentUsd >= budget.capUsd;
}

/** The fixed fraction of the daily cap at which the fleet pages the operator that spend is
 * closing in on it (PLANS.md 2026-09-30): opinionated default, no config knob. */
export const BUDGET_WARNING_FRACTION = 0.8;

/** True when today's spend has crossed `BUDGET_WARNING_FRACTION` of the daily cap while the
 * budget gate is still open — the early heads-up beside budgetReached, which fires only once
 * the cap itself is reached and the fleet has already stopped (or demoted) its ticks. Same
 * guard terms as budgetReached (non-null view, a cap of 0 disables the budget), scaled by the
 * warning fraction, so the two views can never disagree about whether the budget is on. */
export function budgetWarning(budget: { spentUsd: number; capUsd: number } | null): boolean {
  return (
    budget !== null && budget.capUsd > 0 && budget.spentUsd >= budget.capUsd * BUDGET_WARNING_FRACTION
  );
}

/** True while the fleet's spend for the local day has reached `maxDailyCostUsd` (a cap of 0
 * disables the budget). The orchestrator re-evaluates this every poll from its runners' live
 * states and the freshly reloaded config — resume is stateless, so raising/disabling the cap
 * or crossing midnight flips it on the next cycle and nothing can get stuck. Lives here (not
 * in orchestrator.ts) because observers must not depend on the scheduler module. */
export function budgetPaused(states: LoopState[], config: TumwaterConfig, now = Date.now()): boolean {
  return budgetReached(budgetSpend(states, config, now));
}

/** The fleet's daily-budget figures from live loop states — the exact pair the gate evaluates:
 * today's summed spend and the configured cap (0 when disabled). budgetReached's own capUsd > 0
 * term makes a disabled cap read unreached, so the pair needs no null ceremony. Returning the
 * figures (not just the verdict) lets the scheduler publish WHAT it tripped on, not only THAT it
 * tripped — the one number every observer must show. */
export function budgetSpend(
  states: LoopState[],
  config: TumwaterConfig,
  now = Date.now(),
): { spentUsd: number; capUsd: number } {
  return { spentUsd: fleetDailyCost(states, now), capUsd: config.maxDailyCostUsd };
}

/** What the daily cost budget is doing to role loops right now (plans/fallback-model.md):
 * `open` while spend is under the cap, `fallback` once it is reached with a usable free model
 * configured — priced at zero AND serving — so loops keep ticking, on that model, and `paused`
 * once it is reached with none. Three values instead of a boolean because "the cap is reached"
 * and "the loops are stopped" stopped being the same fact: only `paused` blocks a tick. */
export type BudgetGate = "open" | "fallback" | "paused";

/** The budget gate from its three inputs: whether spend has reached the cap (budgetReached for
 * observers, budgetPaused for the scheduler), whether a cost-free fallback model is configured
 * to take over (src/pi-models.ts's fallbackModelFree — kept as a parameter so this module
 * stays free of pi's model catalog, the same one-way dependency rule that put budgetPaused
 * here), and whether that fallback's backend is serving (fallbackServing over
 * fallback-breaker.ts's breaker). A free pair that cannot serve is not a usable fallback: the
 * 2026-09-19 fleet ran an
 * hour of 33/33 failed ticks on one instead of the pause this gate already had for "nothing
 * usable to fall back to" (BUGS.md 2026-09-20). The single definition of the gate: the
 * orchestrator enforces it and both dashboards display it, so what an operator sees is what the
 * scheduler is doing. Observers pass no third argument — status-data.ts folds the running
 * orchestrator's published demotion into the snapshot's `fallback` field (null while demoted),
 * which is their second input. */
export function budgetGate(reached: boolean, fallbackReady: boolean, fallbackServing = true): BudgetGate {
  if (!reached) return "open";
  return fallbackReady && fallbackServing ? "fallback" : "paused";
}
