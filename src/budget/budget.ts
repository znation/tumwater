/** The daily-cost budget: a role's and the team's local-day spend and the gate those figures
 * drive (plans/daily-cost-budget.md, plans/fallback-model.md). The circuit breaker that judges
 * whether the gate's fallback can actually serve lives beside it in fallback-breaker.ts. Split
 * out of runner-state.ts, which owns
 * RunnerState persistence and scheduling bookkeeping: the budget is POLICY both the scheduler and
 * every observer evaluate from the same definitions. Kept free of the scheduler and of pi's
 * model catalog (fallback readiness arrives as plain booleans), so observers can depend on it
 * without importing either — the one-way rule that previously kept these functions in
 * runner-state.ts. */

import { MODEL_TIERS, type TumwaterConfig } from "../config/config-schema.js";
import { nonNegativeNumber } from "../files/json-object.js";
import type { RunnerState } from "../runner/runner-state.js";
import { dayAt, dayKey } from "../text/datetime.js";

/** The local calendar day as YYYY-MM-DD — the same local-time convention as every other
 * wall-clock display in the harness (lastRunCell). */
export function todayStamp(now = Date.now()): string {
  return dayKey(now);
}

/** A spend figure is finite and non-negative (json-object.ts's nonNegativeNumber); a string,
 * NaN, ±Infinity, or a negative hand-edited value reads as $0. Negative spend is as poisonous
 * to the cap as NaN: it makes every `>= cap` comparison false — and drags the team sum down —
 * silently defeating the budget's safety valve. */
function spendNumber(value: unknown): number {
  return nonNegativeNumber(value, 0);
}

/** This role's spend for the local day (the daily cost budget window): $0 when its stamp is
 * stale or missing — a role that hasn't ran since yesterday reads as $0 today with no save
 * required, and spend recorded before this field existed is unknown. A non-number,
 * non-finite, or negative value reads as $0 too: `loadRunnerState` heals the field on read, but
 * this is the budget gate's own guard, and a hand-edited or torn `dayCostUsd` (or an in-memory
 * state) would otherwise concatenate into
 * teamDailyCost's sum (or make every `>= cap` comparison false) and silently defeat the cap,
 * the budget's safety valve. Reads never mutate. See plans/daily-cost-budget.md. */
export function dailyCost(
  s: Pick<RunnerState, "dayStamp" | "dayCostUsd">,
  now = Date.now(),
): number {
  return s.dayStamp === todayStamp(now) ? spendNumber(s.dayCostUsd) : 0;
}

/** Record a pi run's cost into the role's daily window, rolling over at local midnight:
 * when `now` is on a different day than the recorded stamp the window resets first, so a run
 * that crosses midnight attributes its spend to the correct day. Mutates `s` in place — like
 * applyRunOutcome and foldUsage's other counter updates, the caller's state object is
 * authoritative across an in-flight run; the value persists at run end with the rest of the
 * state. Both operands are guarded through spendNumber so a corrupt stored value or a
 * non-finite/negative run cost cannot poison the window with a string/NaN/negative sum. */
export function recordDailyCost(s: RunnerState, usd: number, now = Date.now(), pair?: string): void {
  const stamp = todayStamp(now);
  if (s.dayStamp !== stamp) {
    s.dayStamp = stamp;
    s.dayCostUsd = 0;
    s.dayCostByPair = {};
  }
  s.dayCostUsd = spendNumber(s.dayCostUsd) + spendNumber(usd);
  // The per-step split (a priced fallback step's own cap): folded under the run's pair name,
  // an own property so a `__proto__` pair cannot reach the prototype.
  if (pair !== undefined) {
    const by = (s.dayCostByPair ??= {});
    const sum = spendNumber(Object.hasOwn(by, pair) ? by[pair] : 0) + spendNumber(usd);
    Object.defineProperty(by, pair, { value: sum, enumerable: true, writable: true, configurable: true });
  }
}

/** One model pair's spend for the local day, summed over every role's per-pair window
 * (`dayCostByPair`): $0 for a stale day stamp or a pair no run has charged. */
export function pairDailyCost(
  states: Pick<RunnerState, "dayStamp" | "dayCostByPair">[],
  pair: string,
  now = Date.now(),
): number {
  const today = todayStamp(now);
  return states.reduce((sum, s) => {
    const by = s.dayStamp === today ? s.dayCostByPair : undefined;
    return sum + (by !== undefined && Object.hasOwn(by, pair) ? spendNumber(by[pair]) : 0);
  }, 0);
}

/** The team's spend for the local day: every role's daily window summed. */
export function teamDailyCost(states: RunnerState[], now = Date.now()): number {
  return states.reduce((sum, s) => sum + dailyCost(s, now), 0);
}

/** The roles that spent most today, highest first (ties by role name), at most `limit`; roles
 * with no spend today (zero or a stale day window) are left out. Each state is its own role, so
 * `feature` and `feature-2` are listed apart. */
export function topDailySpenders(
  states: RunnerState[],
  now = Date.now(),
  limit = 3,
): { role: string; spentUsd: number }[] {
  return states
    .map((s) => ({ role: s.role, spentUsd: dailyCost(s, now) }))
    .filter((r) => r.spentUsd > 0)
    .sort((a, b) => b.spentUsd - a.spentUsd || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
    .slice(0, limit);
}

/** True when today's spend has reached the daily cost budget — the view is non-null, its cap is
 * enabled (capUsd > 0; a cap of 0 disables the gate regardless of spend), and spend sits at or
 * above it. The single definition of "the budget gate is on": the orchestrator evaluates it from
 * live runner states via budgetPaused, and both dashboards evaluate it from the snapshot's
 * materialized budget field (status/status-data.ts) — which carries the object even while
 * disabled, so the capUsd > 0 term is what keeps a disabled team out of "budget paused". The
 * comparison cannot drift between what the scheduler enforces and what users see. */
export function budgetReached(budget: { spentUsd: number; capUsd: number } | null): boolean {
  return budget !== null && budget.capUsd > 0 && budget.spentUsd >= budget.capUsd;
}

/** The fixed fraction of the daily cap at which the team pages the operator that spend is
 * closing in on it (PLANS.md 2026-09-30): opinionated default, no config knob. */
export const BUDGET_WARNING_FRACTION = 0.8;

/** True when today's spend has crossed `BUDGET_WARNING_FRACTION` of the daily cap while the
 * budget gate is still open — the early heads-up beside budgetReached, which fires only once
 * the cap itself is reached and the team has already stopped (or demoted) its runs. Same
 * guard terms as budgetReached (non-null view, a cap of 0 disables the budget), scaled by the
 * warning fraction, so the two views can never disagree about whether the budget is on. */
export function budgetWarning(budget: { spentUsd: number; capUsd: number } | null): boolean {
  return (
    budget !== null && budget.capUsd > 0 && budget.spentUsd >= budget.capUsd * BUDGET_WARNING_FRACTION
  );
}

/** True while the team's spend for the local day has reached `maxDailyCostUsd` (a cap of 0
 * disables the budget). The orchestrator re-evaluates this every poll from its runners' live
 * states and the freshly reloaded config — resume is stateless, so raising/disabling the cap
 * or crossing midnight flips it on the next cycle and nothing can get stuck. Lives here (not
 * in orchestrator.ts) because observers must not depend on the scheduler module. */
export function budgetPaused(states: RunnerState[], config: TumwaterConfig, now = Date.now()): boolean {
  return budgetReached(budgetSpend(states, config, now));
}

/** The team's daily-budget figures from live runner states — the exact pair the gate evaluates:
 * today's summed spend and the configured cap (0 when disabled). budgetReached's own capUsd > 0
 * term makes a disabled cap read unreached, so the pair needs no null ceremony. Returning the
 * figures (not just the verdict) lets the scheduler publish WHAT it tripped on, not only THAT it
 * tripped — the one number every observer must show. */
export function budgetSpend(
  states: RunnerState[],
  config: TumwaterConfig,
  now = Date.now(),
): { spentUsd: number; capUsd: number } {
  return { spentUsd: teamDailyCost(states, now), capUsd: config.maxDailyCostUsd };
}

/** When today's burn will reach the cap, as a local-day epoch-ms instant — the budget badge's
 * `~cap at HH:MM` forecast — or null when no forecast may be stated: no cap (`capUsd <= 0`, the
 * gate is disabled), no burn to extrapolate (`spentUsd <= 0`), the cap already reached
 * (`spentUsd >= capUsd` — the gate's own open/fallback/paused states supersede a forecast;
 * budgetReached already names that moment), or a burn too slow to reach the cap by the next
 * local midnight (the daily window resets there, so a tomorrow figure would be a lie — silence
 * is the honest output). The rate is today's linear burn since local midnight (dayAt(0, ·)):
 * `rate = spentUsd / elapsedMs`, so `hitAt = midnight + capUsd / rate`. The `~` in the badge
 * marks it a forecast — the rate is linear over the whole day, so quiet hours make the morning
 * figure pessimistic about the remaining day, a stated simplification refreshed on every poll,
 * not a design question. Takes `now` explicitly (like dayAt) so a caller — and a test — can
 * pin the whole projection to one instant. */
export function projectCapHit(
  budget: { spentUsd: number; capUsd: number },
  now = Date.now(),
): number | null {
  if (budget.capUsd <= 0 || budget.spentUsd <= 0 || budget.spentUsd >= budget.capUsd) return null;
  const day = new Date(now);
  const midnight = dayAt(0, day).getTime();
  const elapsedMs = now - midnight;
  if (elapsedMs <= 0) return null; // at midnight itself there is no burn to extrapolate yet
  const hitAt = midnight + (budget.capUsd * elapsedMs) / budget.spentUsd;
  return hitAt < dayAt(-1, day).getTime() ? hitAt : null;
}

/** What the daily cost budget is doing to roles right now (plans/fallback-model.md):
 * `open` while spend is under the cap, `fallback` once it is reached with a usable free model
 * configured — priced at zero AND serving — so roles keep running, on that model, and `paused`
 * once it is reached with none. Three values instead of a boolean because "the cap is reached"
 * and "the roles are stopped" stopped being the same fact: only `paused` blocks a run. */
export type BudgetGate = "open" | "fallback" | "paused";

/** The name of a model pair as the fallback breaker map and the demotion publish key it
 * ("provider/model", "?" for an absent side) — the same string budget-gates.ts's rekey and
 * every per-pair lookup key on. Single-homed so a resolution's pair and a breaker entry can
 * never disagree about their name. */
export function modelPairName(p: { provider?: string; model?: string } | null): string {
  return `${p?.provider ?? "?"}/${p?.model ?? "?"}`;
}

/** The budget gate from the tiers' resolutions (part 5c/8): whether spend has reached the cap
 * (budgetReached for observers, budgetPaused for the scheduler), and whether the `default` and
 * `strong` tiers resolved to a usable free pair (resolveTierFallbacks over the full usable
 * predicate — price AND breaker serving) — plus whether the review gate is on. The gate is
 * `paused` when `default` resolves to pause (nothing for the team's bulk to run on), or when
 * review is on and `strong` does (nothing could merge, so every authoring run is wasted work);
 * `fallback` otherwise, with the tiers that did resolve running their pairs and the rest held
 * per role. The single definition of the gate: the orchestrator enforces it and both dashboards
 * display it, so what an operator sees is what the scheduler is doing. */
export function budgetGate(
  reached: boolean,
  tiers: { default: boolean; strong: boolean },
  reviewOn: boolean,
): BudgetGate {
  if (!reached) return "open";
  if (!tiers.default) return "paused";
  if (reviewOn && !tiers.strong) return "paused";
  return "fallback";
}

/** The configured fallback tier map as display entries: one `tier: pair` per set tier, in
 * MODEL_TIERS order (small, default, strong). The single home of the tier-list rendering
 * shared by the budget badge (src/ui/badges.ts), the fallback alert's detail
 * (src/ui/team-alerts.ts), and the budget_fallback event line
 * (src/events/event-format.ts), so the pair shape and the tier order cannot drift between
 * the three surfaces; each caller joins or length-tests the entries itself. A non-string
 * value is not a pair (the event reads a loosely typed field) and is left out; absent or
 * null tiers yield no entries. */
export function fallbackTierEntries(
  tiers: Record<string, unknown> | null | undefined,
): string[] {
  if (!tiers) return [];
  return MODEL_TIERS.filter((t) => typeof tiers[t] === "string").map((t) => `${t}: ${tiers[t]}`);
}
