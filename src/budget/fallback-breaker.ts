/** The fallback's circuit breaker (BUGS.md 2026-09-20): whether the engaged free fallback can
 * actually SERVE. Split out of budget.ts, which keeps the daily-cost figures and the gate they
 * drive; the breaker is a self-contained pure state machine — no scheduler, no pi model
 * catalog, no persistence — that depends on nothing but the TickResult vocabulary, so the
 * orchestrator can hold it in memory and fold tick outcomes into it without importing the
 * budget. The gate reads its verdict through fallbackServing (budget.ts's budgetGate). */

import type { TickResult } from "../tick/tick-outcome.js";

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

/** failureLimit 3 is a single loop's failing-streak threshold (tick-apply.ts ERROR_STREAK_WARN)
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
 * (the model had answered before the stall — a tool call or the stream stopped), and the
 * landing results (`merge_conflict`, `merge_blocked`, `review_error`) — a tick no longer
 * returns them since leftover recovery queues its pin instead of landing it, and they would
 * not say whether the backend was involved. */
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

/** Fold one finished role tick that ran on the fallback into the breaker. `ranOn` is the breaker as
 * the tick started under it — evidence about a subject that is no longer engaged is dropped —
 * and `probe` says whether the orchestrator admitted it as the half-open probe. A served tick
 * closes the breaker from any state (the backend demonstrably works). A failed probe re-opens it
 * with the cool-down doubled up to maxCooldownMs; a failed tick while closed counts toward
 * failureLimit and trips the breaker at it; a failed straggler that started before the trip leaves
 * the running cool-down alone. A probe with no evidence frees the probe slot, so the next due role
 * probes instead. */
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

/** What orchestrator.json publishes while the breaker holds the fallback demoted
 * (fleet/orchestrator-info.ts's OrchestratorInfo.fallbackDemoted). Observers need it because the
 * price check alone would advertise the demoted pair as a working fallback —
 * status/status-data.ts nulls the snapshot's `fallback` from it and `tumwater doctor` names it.
 * Undefined while the fallback is trusted or not engaged. */
export function fallbackDemotion(b: FallbackBreaker): FallbackDemotion | undefined {
  return b.pair !== null && b.probeAt !== null
    ? { pair: b.pair, failures: b.failures, probeAt: b.probeAt }
    : undefined;
}

/** The breaker state the budget gate holds (part 5b/8): one FallbackBreaker per pair name the
 * tiers resolve to, keyed by that pair name. Tiers sharing a fallback pair share one entry —
 * and therefore one judgment — and each entry is re-keyed per pair by every poll, so a
 * demotion sticks to its pair while the pair stays engaged and clears when the pair, its cap,
 * or the resolution changes. The per-tier budget gates share this one map, so every resolved
 * pair carries its own judgment without a second breaker. */
export type FallbackBreakerMap = Record<string, FallbackBreaker>;

/** Re-key the whole map per pair: every pair in `pairs` keeps its running judgment while its
 * subject (the pair name plus the cap it engaged under) is unchanged and gains a fresh trusted
 * entry otherwise; entries whose pair left the resolution are dropped, exactly as re-keying the
 * single breaker to null cleared it — a pair that returns later starts trusted. */
export function rekeyFallbackBreakers(
  map: FallbackBreakerMap,
  pairs: readonly string[],
  capUsd: number,
): FallbackBreakerMap {
  const next: FallbackBreakerMap = {};
  for (const pair of pairs) {
    next[pair] = rekeyFallbackBreaker(map[pair] ?? { ...IDLE_FALLBACK_BREAKER, pair, capUsd }, pair, capUsd);
  }
  return next;
}

/** Whether the pair named `pair` is serving: it must have an entry (a pair the resolution
 * dropped has no judgment to consult) and that entry must hold no demotion. */
export function fallbackServingPair(map: FallbackBreakerMap, pair: string | null): boolean {
  const b = pair !== null ? map[pair] : undefined;
  return b !== undefined && fallbackServing(b);
}

/** The pair whose half-open window is due, or null when none is. Several pairs can carry a
 * demotion at once (one per resolved tier), so the walk returns the first due entry in map
 * order and the caller probes that single pair this tick. */
export function fallbackProbeDuePair(map: FallbackBreakerMap, now: number): string | null {
  for (const [pair, b] of Object.entries(map)) {
    if (fallbackProbeDue(b, now)) return pair;
  }
  return null;
}

/** Apply `f` to the pair's entry when the map holds one, else return the map unchanged — the
 * shape shared by the map-scoped breaker transitions below (claim/hand back a probe, fold a
 * tick): a pair the resolution dropped has no judgment to touch. */
function withPair(
  map: FallbackBreakerMap,
  pair: string,
  f: (b: FallbackBreaker) => FallbackBreaker,
): FallbackBreakerMap {
  const b = map[pair];
  return b === undefined ? map : { ...map, [pair]: f(b) };
}

/** Admit the half-open probe on the pair named `pair`: marks its entry probing until the
 * evidence fold hears back. An absent entry is left alone (nothing to probe). */
export function startFallbackProbeAt(map: FallbackBreakerMap, pair: string): FallbackBreakerMap {
  return withPair(map, pair, startFallbackProbe);
}

/** Hand an admitted probe's claim back on the pair named `pair` — it never ran (see
 * abandonFallbackProbe). An absent entry is left alone. */
export function abandonFallbackProbeAt(map: FallbackBreakerMap, pair: string): FallbackBreakerMap {
  return withPair(map, pair, abandonFallbackProbe);
}

/** Fold one finished role tick into the pair named `pair`'s entry (recordFallbackTick's
 * semantics, scoped to the map): an absent entry has no judgment to fold into and is left
 * alone. */
export function recordFallbackTickAt(
  map: FallbackBreakerMap,
  pair: string,
  ranOn: FallbackBreaker,
  result: TickResult,
  probe: boolean,
  now: number,
  policy: FallbackBreakerPolicy = FALLBACK_BREAKER_POLICY,
): FallbackBreakerMap {
  return withPair(map, pair, (b) => recordFallbackTick(b, ranOn, result, probe, now, policy));
}
