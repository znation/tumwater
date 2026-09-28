/** The daily cost budget gate (plans/daily-cost-budget.md, plans/fallback-model.md) and the
 * fallback config view it derives, as the orchestrator polls it each cycle. Extracted from
 * orchestrator.ts's poll loop: the spend check, the fallback breaker's re-key, the
 * edge-triggered budget_* events, and the fallback view derivation are one concern beside the
 * other fleet gates (src/pause-gates.ts, src/rate-limit-hold.ts's 429 hold) — the orchestrator
 * owns only the wiring (the demotion publish and the per-runner config assignment). */

import type { TumwaterConfig } from "./config-schema.js";
import {
  budgetGate,
  budgetPaused,
  type BudgetGate,
  type FallbackBreaker,
  fallbackServing,
  fleetDailyCost,
  IDLE_FALLBACK_BREAKER,
  rekeyFallbackBreaker,
} from "./budget.js";
import { applyFallbackModel, fallbackPair } from "./config-views.js";
import { logEvent } from "./events.js";
import { fallbackModelFree } from "./pi-models.js";
import type { LoopState } from "./types.js";

/** The budget gate's cross-poll memory: the previous gate value for edge-triggered events,
 * the fallback breaker, and the fallback view last derived from a live config. In memory
 * only — a restart re-trusts the fallback and re-trips it within failureLimit ticks. */
interface BudgetGateState {
  /** The previous poll's gate, for one-shot transition events. Three-valued since
   * plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
   * between two of them is worth exactly one event. */
  prevGate: BudgetGate;
  /** Whether the engaged fallback's backend is serving (src/budget.ts's FallbackBreaker,
   * BUGS.md 2026-09-20): folded from the outcomes of role ticks that ran on it, re-keyed by
   * every poll (and folded further by the orchestrator's tick bookkeeping). */
  breaker: FallbackBreaker;
  /** The live config the fallback view was last derived from; null until a fallback first
   * engages, so an unchanged config object is not re-derived every poll. */
  from: TumwaterConfig | null;
  /** The view role loops run under while a fallback is engaged (the fallback gate, or its
   * breaker-demoted pause): the free pair installed top-level and every per-role/reviewer
   * model override dropped, so no seam can reach a priced model. */
  fallbackConfig: TumwaterConfig;
}

export function newBudgetGateState(config: TumwaterConfig): BudgetGateState {
  return { prevGate: "open", breaker: IDLE_FALLBACK_BREAKER, from: null, fallbackConfig: config };
}

/** One poll's gate decision, handed back for the orchestrator's wiring: which gate holds this
 * poll, whether the fallback is engaged, and the config role loops run under (the fallback
 * view, or the live config unchanged). */
interface BudgetGatePoll {
  gate: BudgetGate;
  onFallback: boolean;
  roleConfig: TumwaterConfig;
}

/** Poll the daily cost budget gate: once the fleet's spend for the local day has reached
 * maxDailyCostUsd, role loops either switch to the configured cost-free fallback model and
 * keep working, or — with no usable one — start no new ticks at all (scheduled, main-moved
 * wake, or startup). The director is outside both: an explicit human prompt outranks the
 * autonomous-spend cap, so it keeps its budgeted model and keeps ticking. In-flight ticks
 * finish; only NEW ticks are gated. Resume is live — raising/disabling the cap (reloaded
 * live each poll), fixing the fallback, or crossing local midnight re-evaluates this on the
 * next poll — and the one piece of state, the fallback breaker, is re-keyed by the same
 * inputs, so nothing can get stuck. */
export function pollBudgetGate(
  state: BudgetGateState,
  ctx: { root: string; states: LoopState[]; liveConfig: TumwaterConfig; modelsPath: string },
): BudgetGatePoll {
  const { root, states, liveConfig, modelsPath } = ctx;
  const now = Date.now();
  const reached = budgetPaused(states, liveConfig, now);
  // Whether the fallback is usable is a live question too: models.json is stat-cached
  // inside pi-models.ts, so an unchanged catalog costs one stat per poll, and an operator
  // who fixes a mistyped model id sees the fleet switch over within a cycle.
  const fallbackReady = fallbackModelFree(liveConfig, modelsPath);
  const pair = fallbackPair(liveConfig);
  const pairName = `${pair?.provider ?? "?"}/${pair?.model ?? "?"}`;
  // Free is not enough: the breaker demotes a fallback whose ticks keep failing, and a
  // demoted gate is `paused`, exactly as with no fallback at all.
  state.breaker = rekeyFallbackBreaker(
    state.breaker,
    reached && fallbackReady ? pairName : null,
    liveConfig.maxDailyCostUsd,
  );
  const gate = budgetGate(reached, fallbackReady, fallbackServing(state.breaker));
  if (gate !== state.prevGate) {
    logEvent(root, {
      loop: "harness",
      type: gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused",
      spentUsd: fleetDailyCost(states, now),
      capUsd: liveConfig.maxDailyCostUsd,
      // On the way into a gate the fallback's identity is the operator's answer to "why
      // this and not the other one": which free pair took over, which configured pair was
      // refused because pi's definitions do not price it at zero, or which free pair the
      // breaker demoted after its ticks kept failing (and after how many).
      ...(gate === "fallback" ? { provider: pair?.provider, model: pair?.model } : {}),
      ...(gate === "paused" && pair
        ? fallbackReady
          ? { fallbackDemoted: pairName, failures: state.breaker.failures }
          : { fallbackRejected: pairName }
        : {}),
    });
    state.prevGate = gate;
  }
  // While the fallback holds, role loops run under the derived view — the free pair
  // installed top-level and every per-role/reviewer model override dropped, so no seam can
  // reach a priced model. A breaker-demoted fallback keeps the view too: its gate is
  // `paused`, but a tick parked in the semaphore when it tripped, the half-open probe, and
  // the landings must still run on the free pair — a demotion must never promote them to
  // the priced model the cap already spent.
  const onFallback = reached && fallbackReady;
  if (onFallback && state.from !== liveConfig) {
    state.from = liveConfig;
    state.fallbackConfig = applyFallbackModel(liveConfig);
  }
  return { gate, onFallback, roleConfig: onFallback ? state.fallbackConfig : liveConfig };
}
