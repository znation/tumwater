/** The daily cost budget gate (plans/daily-cost-budget.md, plans/fallback-model.md) and the
 * fallback config view it derives, as the orchestrator polls it each cycle. Extracted from
 * orchestrator.ts's poll loop: the spend check, the fallback breaker's re-key, the
 * edge-triggered budget_* events, and the fallback view derivation are one concern beside the
 * other fleet gates (src/gates/pause-gates.ts, src/fleet-hold.ts's fleet hold) — the orchestrator
 * owns only the wiring (the demotion publish and the per-runner config assignment). */

import type { TumwaterConfig } from "../config/config-schema.js";
import { budgetGate, budgetReached, budgetSpend, budgetWarning, type BudgetGate } from "../budget.js";
import {
  type FallbackBreaker,
  fallbackServing,
  IDLE_FALLBACK_BREAKER,
  rekeyFallbackBreaker,
} from "../fallback-breaker.js";
import { applyFallbackModel, fallbackPair } from "../config/config-views.js";
import { DIRECTOR_ROLE } from "../roles.js";
import type { FallbackModelConfig } from "../config/config-schema.js";
import { logEvent } from "../events/events.js";
import { fallbackModelFree } from "../pi/pi-models.js";
import type { LoopState } from "../loop-state.js";

/** The budget gate's cross-poll memory: the previous gate value for edge-triggered events,
 * the fallback breaker, and the fallback view last derived from a live config. In memory
 * only — a restart re-trusts the fallback and re-trips it within failureLimit ticks. */
export interface BudgetGateState {
  /** The previous poll's gate, for one-shot transition events. Three-valued since
   * plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
   * between two of them is worth exactly one event. */
  prevGate: BudgetGate;
  /** Whether the engaged fallback's backend is serving (fallback-breaker.ts's FallbackBreaker,
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
  /** Whether this episode's 80%-of-cap warning has fired (budgetWarning): edge-triggered like
   * the transitions — set when the warning logs, reset whenever spend falls back below the
   * threshold (midnight rollover, a cap raise), so the next crossing warns again. */
  warned: boolean;
}

/** A fresh budget-gate poll state: gate open, fallback breaker idle, no fallback view cached
 * yet (so the first poll of an unchanged config logs nothing). */
export function newBudgetGateState(config: TumwaterConfig): BudgetGateState {
  return {
    prevGate: "open",
    breaker: IDLE_FALLBACK_BREAKER,
    from: null,
    fallbackConfig: config,
    warned: false,
  };
}

/** One poll's gate decision, handed back for the orchestrator's wiring: which gate holds this
 * poll, whether the fallback is engaged, the config role loops run under (the fallback
 * view, or the live config unchanged), and the spend/cap pair the gate just evaluated — the
 * same figures the transition event below stamps, handed back so the orchestrator can publish
 * them for observers (the dashboards' persisted-file sum lags the scheduler's by every
 * in-flight run's charge, BUGS.md 2026-09-30). */
interface BudgetGatePoll {
  gate: BudgetGate;
  onFallback: boolean;
  roleConfig: TumwaterConfig;
  spentUsd: number;
  capUsd: number;
  /** True on exactly the poll whose transition logged `budget_resumed` (fallback or paused →
   * open): the orchestrator hands the in-flight ticks still running on the fallback back to
   * the primary (PLANS.md 2026-09-30) — new ticks are gated live, but a tick that started on
   * the fallback keeps it until it ends, so the reopen alone would leave the fleet's fresh
   * budget waiting on the slow local model. The fallback pair the gate just left (below)
   * identifies those ticks. */
  resumed: boolean;
  /** The live config's fallback pair (fallbackPair), for matching the in-flight ticks the
   * reopen should hand back: a tick whose captured model is this pair runs on the fallback. */
  fallbackPair: FallbackModelConfig | null;
}

/** Does an in-flight tick's captured model pair (LoopRunner.tickModel()) match the fallback
 * pair a reopening budget gate just left? The orchestrator hands back exactly those ticks
 * (PLANS.md 2026-09-30): both sides must be present — no fallback pair means no tick ran on
 * one, and an idle loop's null means there is nothing to hand back — and the provider/model
 * fields must be equal, undefined matching undefined only when both sides truly lack them
 * (which cannot happen here: a null pair is rejected before the field comparison). */
export function tickOnPair(
  tickModel: { provider?: string; model?: string } | null,
  pair: FallbackModelConfig | null,
): boolean {
  return (
    tickModel !== null &&
    pair !== null &&
    tickModel.provider === pair.provider &&
    tickModel.model === pair.model
  );
}

/** The config a runner runs on while the budget gate stands: the director keeps the live
 * config — an explicit human prompt outranks the autonomous-spend cap — and every other role
 * takes the gate's derived view (pollBudgetGate's returned `roleConfig`). Single home for the
 * rule, so the scheduler's per-poll assignment (src/gates/gate-polls.ts) and a throwaway landing
 * author's construction (src/landing/landing-vetting.ts's resolveAuthor) cannot drift apart — say, an
 * exemption granted to one more role in one copy and not the other. */
export function gateRoleConfig(
  role: string,
  liveConfig: TumwaterConfig,
  roleConfig: TumwaterConfig,
): TumwaterConfig {
  return role === DIRECTOR_ROLE ? liveConfig : roleConfig;
}

/** Poll the daily cost budget gate: once the fleet's spend for the local day has reached
 * maxDailyCostUsd, role loops either switch to the configured cost-free fallback model and
 * keep working, or — with no usable one — start no new ticks at all (scheduled, main-moved
 * wake, or startup). The director is outside both: an explicit human prompt outranks the
 * autonomous-spend cap, so it keeps its budgeted model and keeps ticking. In-flight ticks
 * finish; only NEW ticks are gated — and when the gate reopens, the orchestrator hands the
 * ticks still running on the fallback back to the primary (the `budget_handback` event).
 * Resume is live — raising/disabling the cap (reloaded
 * live each poll), fixing the fallback, or crossing local midnight re-evaluates this on the
 * next poll — and the one piece of state, the fallback breaker, is re-keyed by the same
 * inputs, so nothing can get stuck. */
export function pollBudgetGate(
  state: BudgetGateState,
  ctx: { root: string; states: LoopState[]; liveConfig: TumwaterConfig; modelsPath: string },
): BudgetGatePoll {
  const { root, states, liveConfig, modelsPath } = ctx;
  const now = Date.now();
  // One spend read serves the verdict, the transition event, and the returned figures: the
  // states are not mutated between, so all three are the same number by construction.
  const { spentUsd, capUsd } = budgetSpend(states, liveConfig, now);
  const reached = budgetReached({ spentUsd, capUsd });
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
  // Read before prevGate is advanced below: true on exactly the reopening transition.
  const resumed = gate === "open" && (state.prevGate === "fallback" || state.prevGate === "paused");
  // The 80% early warning (PLANS.md 2026-09-30), edge-triggered with reset-on-below — the
  // whole state machine: crossing the threshold while the gate is still open logs one
  // budget_warning, midnight or a cap raise drops spend back under and re-arms it, and a
  // second crossing the same day warns again. Warn only while the gate is open: a poll that
  // engages fallback/paused already logs its own transition event, so the warning never
  // doubles the page on the poll the cap itself is reached.
  const warn = gate === "open" && budgetWarning({ spentUsd, capUsd });
  if (warn && !state.warned) {
    logEvent(root, { loop: "harness", type: "budget_warning", spentUsd, capUsd });
    state.warned = true;
  } else if (!warn) {
    state.warned = false;
  }
  if (gate !== state.prevGate) {
    logEvent(root, {
      loop: "harness",
      type: gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused",
      spentUsd,
      capUsd,
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
  return {
    gate,
    onFallback,
    roleConfig: onFallback ? state.fallbackConfig : liveConfig,
    spentUsd,
    capUsd,
    resumed,
    fallbackPair: pair,
  };
}
