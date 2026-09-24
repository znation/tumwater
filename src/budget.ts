/** The daily-cost budget: a loop's and the fleet's local-day spend, and the gate those
 * figures drive (plans/daily-cost-budget.md, plans/fallback-model.md). Split out of state.ts,
 * which owns LoopState persistence and scheduling bookkeeping: the budget is POLICY both the
 * scheduler and every observer evaluate from the same definitions. Kept free of the scheduler
 * and of pi's model catalog (fallback readiness arrives as a plain boolean), so observers can
 * depend on it without importing either — the one-way rule that previously kept these
 * functions in state.ts. */

import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState } from "./types.js";
import { formatDate } from "./text.js";

/** The local calendar day as YYYY-MM-DD — the same local-time convention as every other
 * wall-clock display in the harness (lastTickCell). */
export function todayStamp(now = Date.now()): string {
  return formatDate(new Date(now));
}

/** This loop's spend for the local day (the daily cost budget window): $0 when its stamp is
 * stale or missing — a loop that hasn't ticked since yesterday reads as $0 today with no save
 * required, and spend recorded before this field existed is unknown. Reads never mutate.
 * See plans/daily-cost-budget.md. */
export function dailyCost(s: LoopState, now = Date.now()): number {
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
 * the snapshot's materialized budget field (status.ts) — which carries the object even while
 * disabled, so the capUsd > 0 term is what keeps a disabled fleet out of "budget paused".
 * The comparison cannot drift between what the scheduler enforces and what users see. */
export function budgetReached(budget: { spentUsd: number; capUsd: number } | null): boolean {
  return budget !== null && budget.capUsd > 0 && budget.spentUsd >= budget.capUsd;
}

/** True while the fleet's spend for the local day has reached `maxDailyCostUsd` (a cap of 0
 * disables the budget). The orchestrator re-evaluates this every poll from its runners' live
 * states and the freshly reloaded config — resume is stateless, so raising/disabling the cap
 * or crossing midnight flips it on the next cycle and nothing can get stuck. Lives here (not
 * in orchestrator.ts) because observers must not depend on the scheduler module. */
export function budgetPaused(states: LoopState[], config: TumwaterConfig, now = Date.now()): boolean {
  const cap = config.maxDailyCostUsd;
  return budgetReached(cap > 0 ? { spentUsd: fleetDailyCost(states, now), capUsd: cap } : null);
}

/** What the daily cost budget is doing to role loops right now (plans/fallback-model.md):
 * `open` while spend is under the cap, `fallback` once it is reached with a usable free model
 * configured — loops keep ticking, on that model — and `paused` once it is reached with none.
 * Three values instead of a boolean because "the cap is reached" and "the loops are stopped"
 * stopped being the same fact: only `paused` blocks a tick. */
export type BudgetGate = "open" | "fallback" | "paused";

/** The budget gate from its two inputs: whether spend has reached the cap (budgetReached for
 * observers, budgetPaused for the scheduler) and whether a cost-free fallback model is ready
 * to take over (src/pi-models.ts's fallbackModelFree — kept as a parameter so this module
 * stays free of pi's model catalog, the same one-way dependency rule that put budgetPaused
 * here). The single definition of the gate: the orchestrator enforces it and both dashboards
 * display it, so what an operator sees is what the scheduler is doing. */
export function budgetGate(reached: boolean, fallbackReady: boolean): BudgetGate {
  if (!reached) return "open";
  return fallbackReady ? "fallback" : "paused";
}
