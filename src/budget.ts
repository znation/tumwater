/** The daily-cost budget: a loop's and the fleet's local-day spend, the gate those figures
 * drive (plans/daily-cost-budget.md, plans/fallback-model.md), and the circuit breaker that
 * judges whether the gate's fallback can actually serve. Split out of state.ts, which owns
 * LoopState persistence and scheduling bookkeeping: the budget is POLICY both the scheduler and
 * every observer evaluate from the same definitions. Kept free of the scheduler and of pi's
 * model catalog (fallback readiness arrives as plain booleans), so observers can depend on it
 * without importing either — the one-way rule that previously kept these functions in
 * state.ts. */

import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, TickResult } from "./types.js";
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
 * configured — priced at zero AND serving — so loops keep ticking, on that model, and `paused`
 * once it is reached with none. Three values instead of a boolean because "the cap is reached"
 * and "the loops are stopped" stopped being the same fact: only `paused` blocks a tick. */
export type BudgetGate = "open" | "fallback" | "paused";

/** The budget gate from its three inputs: whether spend has reached the cap (budgetReached for
 * observers, budgetPaused for the scheduler), whether a cost-free fallback model is configured
 * to take over (src/pi-models.ts's fallbackModelFree — kept as a parameter so this module
 * stays free of pi's model catalog, the same one-way dependency rule that put budgetPaused
 * here), and whether that fallback's backend is serving (fallbackServing over the breaker
 * below). A free pair that cannot serve is not a usable fallback: the 2026-09-19 fleet ran an
 * hour of 33/33 failed ticks on one instead of the pause this gate already had for "nothing
 * usable to fall back to" (BUGS.md 2026-09-20). The single definition of the gate: the
 * orchestrator enforces it and both dashboards display it, so what an operator sees is what the
 * scheduler is doing. Observers pass no third argument — status.ts folds the running
 * orchestrator's published demotion into the snapshot's `fallback` field (null while demoted),
 * which is their second input. */
export function budgetGate(reached: boolean, fallbackReady: boolean, fallbackServing = true): BudgetGate {
  if (!reached) return "open";
  return fallbackReady && fallbackServing ? "fallback" : "paused";
}

/** How the fallback breaker trips and retries. A test seam (the orchestrator's RunOptions
 * accepts an override, like pollMs); production uses FALLBACK_BREAKER_POLICY. */
export interface FallbackBreakerPolicy {
  /** Consecutive failed fallback ticks, fleet-wide, that demote the fallback to `paused`. */
  failureLimit: number;
  /** The first cool-down before a demoted fallback gets its probe tick. */
  cooldownMs: number;
  /** The cap each failed probe's doubling stops at. */
  maxCooldownMs: number;
}

/** failureLimit 3 is a single loop's failing-streak threshold (state.ts ERROR_STREAK_WARN)
 * applied fleet-wide: consecutive across every role, so any tick that served in between resets
 * it — a healthy backend with one flaky tick never trips it, while a dead one trips on its
 * first three ticks (on 2026-09-19 the third failure landed 24 minutes into the hour; the 30
 * ticks after it were the waste). A 5-minute first cool-down because a failed probe costs one
 * tick — about half of that hour's failures came back in under 10 s, the rest ran minutes
 * before the 400 — which is cheap next to idling until midnight; doubling to at most 30 minutes
 * bounds how long an operator who fixed the backend waits for the fleet to notice (editing the
 * cap or the pair re-trusts it at once — see rekeyFallbackBreaker). */
export const FALLBACK_BREAKER_POLICY: FallbackBreakerPolicy = {
  failureLimit: 3,
  cooldownMs: 5 * 60_000,
  maxCooldownMs: 30 * 60_000,
};

/** The budget fallback's circuit breaker (BUGS.md 2026-09-20): whether the engaged free
 * fallback can SERVE — the question fallbackModelFree's price check cannot answer. A pair pi's
 * models.json prices at zero can sit behind a backend that rejects every prompt, and a network
 * probe would not have caught the case that happened: oMLX was up (a GET /models would have
 * succeeded) but pinned at its Metal ceiling, 400-ing prompts as small as kv_len=1152. So the
 * breaker judges from the only evidence that means "serves" — the fallback's own role ticks:
 * `failureLimit` consecutive failures demote it (the gate reads `paused`); after a cool-down ONE
 * probe tick is let through, and served closes the breaker while failed re-opens it with a
 * doubled, capped cool-down. Nothing is stuck: the probe keeps asking, and a change of subject
 * (the cap edited, the pair changed, or the gate leaving the fallback — local midnight's
 * `budget_resumed`) starts a fresh, trusted breaker. Pure data with pure transitions; the
 * orchestrator holds the value in memory, so a restart re-trusts the fallback and re-trips
 * within failureLimit ticks if it is still dead. */
export interface FallbackBreaker {
  /** The engaged fallback pair (`provider/model`) the judgment is about; null while no fallback
   * is engaged (the cap is not reached, or the configured pair is not free). */
  pair: string | null;
  /** The cap the fallback engaged under. Part of the subject with `pair`: an edit to either is
   * the operator re-deciding the budget, and deserves a fresh judgment instead of a stale one. */
  capUsd: number;
  /** Consecutive failed fallback ticks since the last one that served. */
  failures: number;
  /** Null while the fallback is trusted (closed). While demoted: the epoch ms from which one
   * probe tick may start. */
  probeAt: number | null;
  /** The cool-down that set probeAt (0 while closed); each failed probe doubles it. */
  cooldownMs: number;
  /** The probe tick is in flight: no second role tick starts until it reports. */
  probing: boolean;
}

/** A breaker with no fallback engaged — the orchestrator's starting value. */
export const IDLE_FALLBACK_BREAKER: FallbackBreaker = {
  pair: null,
  capUsd: 0,
  failures: 0,
  probeAt: null,
  cooldownMs: 0,
  probing: false,
};

/** This poll's breaker for the fallback the gate would engage (`pair` null when it would engage
 * none): the same judgment while the subject is unchanged, a fresh trusted one otherwise — so
 * raising the cap, pointing `fallbackModel` somewhere else, or crossing midnight (the cap is no
 * longer reached, so no pair is engaged) clears a demotion on the next poll. */
export function rekeyFallbackBreaker(b: FallbackBreaker, pair: string | null, capUsd: number): FallbackBreaker {
  if (b.pair === pair && (pair === null || b.capUsd === capUsd)) return b;
  return { ...IDLE_FALLBACK_BREAKER, pair, capUsd: pair === null ? 0 : capUsd };
}

/** The gate's third input: false while the breaker holds the fallback demoted — including the
 * half-open window and the probe itself, which run under a `paused` gate, so the dashboards read
 * `budget paused` until the probe has actually served. */
export function fallbackServing(b: FallbackBreaker): boolean {
  return b.probeAt === null;
}

/** Half-open: the demoted fallback's cool-down has elapsed and no probe is in flight, so one role
 * tick may start on it despite the `paused` gate. */
export function fallbackProbeDue(b: FallbackBreaker, now: number): boolean {
  return b.pair !== null && b.probeAt !== null && !b.probing && now >= b.probeAt;
}

/** The breaker once the probe tick has been admitted: probing until recordFallbackTick hears
 * back, so every other due role waits for its verdict — one tick's evidence per cool-down, not
 * a whole maxConcurrent wave of failures. */
export function startFallbackProbe(b: FallbackBreaker): FallbackBreaker {
  return { ...b, probing: true };
}

/** The breaker when an admitted probe never ran — turned away at its permit by the restart
 * hold's start gate: no evidence either way, so the claim is handed back and the probe is due
 * again at the next poll. Without this the breaker would wait on a verdict no tick will ever
 * deliver, and the demoted pause could only clear on a rekey. */
export function abandonFallbackProbe(b: FallbackBreaker): FallbackBreaker {
  return { ...b, probing: false };
}

/** What one role tick that ran on the fallback says about its backend. `failed` is `error`
 * alone: every way a backend cannot serve — an HTTP 4xx/5xx like oMLX's prefill guard, a
 * refused connection, a request that never returns (the tick timeout) — ends a tick as `error`,
 * and 33 of 33 did on 2026-09-19. (An `error` can also be local, e.g. a worktree that will not
 * reset; failureLimit of those in a row fleet-wide is still a fleet that cannot work, and the
 * probe wins the pause back.) `served` is a result only a model reply produces: a change bound
 * for landing (`queued`, `changed`), an explicit decision (`no_change`, `refused`), or a
 * reviewer's rejection. Everything else is no evidence: harness and operator kills (`aborted`,
 * `user_aborted`), ticks that never reached the model (`skipped`, `main_red`), a quiet kill
 * (the model had answered before the stall — a tool call or the stream stopped), and a
 * leftover recovery's landing failures (`merge_conflict`, `merge_blocked`, `review_error`),
 * whose result does not say whether the backend was involved. */
export function fallbackEvidence(result: TickResult): "served" | "failed" | "none" {
  switch (result) {
    case "error":
      return "failed";
    case "queued":
    case "changed":
    case "no_change":
    case "refused":
    case "rejected":
      return "served";
    default:
      return "none";
  }
}

/** Fold one finished role tick that ran on the fallback into the breaker. `ranOn` is the breaker
 * as the tick started under it — evidence about a subject that is no longer engaged is dropped —
 * and `probe` says whether the orchestrator admitted it as the half-open probe. A served tick
 * closes the breaker from any state (the backend demonstrably works). A failed probe re-opens it
 * with the cool-down doubled up to maxCooldownMs; a failed tick while closed counts toward
 * failureLimit and trips the breaker at it; a failed straggler that started before the trip
 * leaves the running cool-down alone. A probe with no evidence frees the probe slot, so the next
 * due role probes instead. */
export function recordFallbackTick(
  b: FallbackBreaker,
  ranOn: FallbackBreaker,
  result: TickResult,
  probe: boolean,
  now: number,
  policy: FallbackBreakerPolicy = FALLBACK_BREAKER_POLICY,
): FallbackBreaker {
  if (ranOn.pair === null || ranOn.pair !== b.pair || ranOn.capUsd !== b.capUsd) return b;
  const isProbe = probe && b.probing;
  const evidence = fallbackEvidence(result);
  if (evidence === "served") return { ...IDLE_FALLBACK_BREAKER, pair: b.pair, capUsd: b.capUsd };
  if (evidence === "none") return isProbe ? { ...b, probing: false } : b;
  const failures = b.failures + 1;
  if (isProbe) {
    const cooldownMs = Math.min(b.cooldownMs * 2, policy.maxCooldownMs);
    return { ...b, failures, probeAt: now + cooldownMs, cooldownMs, probing: false };
  }
  if (b.probeAt !== null || failures < policy.failureLimit) return { ...b, failures };
  return { ...b, failures, probeAt: now + policy.cooldownMs, cooldownMs: policy.cooldownMs, probing: false };
}

/** A demoted fallback as observers see it: the pair, the consecutive failures that demoted it,
 * and the epoch ms from which the next probe tick may start. */
export interface FallbackDemotion {
  pair: string;
  failures: number;
  probeAt: number;
}

/** What orchestrator.json publishes while the breaker holds the fallback demoted (fleet-state.ts's
 * OrchestratorInfo.fallbackDemoted). Observers need it because the price check alone would
 * advertise the demoted pair as a working fallback — status.ts nulls the snapshot's `fallback`
 * from it and `tumwater doctor` names it. Undefined while the fallback is trusted or not
 * engaged. */
export function fallbackDemotion(b: FallbackBreaker): FallbackDemotion | undefined {
  return b.pair !== null && b.probeAt !== null
    ? { pair: b.pair, failures: b.failures, probeAt: b.probeAt }
    : undefined;
}
