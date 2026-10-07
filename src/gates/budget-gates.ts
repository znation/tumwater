/** The daily cost budget gate (plans/daily-cost-budget.md, plans/fallback-model.md) and the
 * fallback config view it derives, as the orchestrator polls it each cycle. Extracted from
 * orchestrator.ts's poll loop: the spend check, the fallback breaker's re-key, the
 * edge-triggered budget_* events, and the fallback view derivation are one concern beside the
 * other fleet gates (src/gates/pause-gates.ts, src/fleet/fleet-hold.ts's fleet hold) — the orchestrator
 * owns only the wiring (the demotion publish and the per-runner config assignment). */

import { MODEL_TIERS, type FallbackModelConfig, type ModelTier, type TumwaterConfig } from "../config/config-schema.js";
import {
  budgetGate,
  budgetReached,
  budgetSpend,
  budgetWarning,
  modelPairName,
  type BudgetGate,
} from "../budget/budget.js";
import {
  type FallbackBreakerMap,
  fallbackServingPair,
  rekeyFallbackBreakers,
} from "../budget/fallback-breaker.js";
import {
  applyFallbackModel,
  fallbackPair,
  resolveTierFallbacks,
  tierFallbackLabels,
  tiersResolveDistinctPairs,
  type TierFallbackMap,
} from "../config/config-views.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { logEvent } from "../events/events.js";
import { pairFree, readPiProviders } from "../pi/pi-models.js";
import type { LoopState } from "../loop/loop-state.js";

/** The budget gate's cross-poll memory: the previous gate value for edge-triggered events,
 * the fallback breaker, and the fallback view last derived from a live config. In memory
 * only — a restart re-trusts the fallbacks and re-trips them within failureLimit ticks. */
export interface BudgetGateState {
  /** The previous poll's gate, for one-shot transition events. Three-valued since
   * plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
   * between two of them is worth exactly one event. */
  prevGate: BudgetGate;
  /** The fallback breakers, one per pair name (fallback-breaker.ts's FallbackBreakerMap,
   * part 5b/8): folded from the outcomes of role ticks that ran on each pair, re-keyed per
   * pair by every poll (and folded further by the orchestrator's tick bookkeeping). Tiers
   * sharing a fallback pair share one entry and one judgment. */
  breakers: FallbackBreakerMap;
  /** The pair name this poll's gate engaged (`"provider/model"`), or null when none — the
   * key the orchestrator's probe admission and tick evidence fold read and write under, and
   * the pair whose demotion the observers publish. */
  engaged: string | null;
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

/** A fresh budget-gate poll state: gate open, no fallback breakers yet, no fallback view cached
 * yet (so the first poll of an unchanged config logs nothing). */
export function newBudgetGateState(config: TumwaterConfig): BudgetGateState {
  return {
    prevGate: "open",
    breakers: {},
    engaged: null,
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
  /** The live config's fallback pairs (part 5c/8): every non-null pair the price-based
   * resolution hands a tier, so the reopen hands back the in-flight ticks running on ANY of
   * them — a per-tier fallback put different roles on different pairs, and one leftPair only
   * matched one of them. */
  pairs: FallbackModelConfig[];
  /** The price-based per-tier resolution (resolveTierFallbacks over the price check alone):
   * the pairs each tier WOULD run absent a demotion — what the probe's eligible roles are
   * computed from, since the probed pair is by definition not usable in the serving
   * resolution (part 5c/8). */
  priceResolved: TierFallbackMap;
  /** The demotion-aware per-tier resolution (resolveTierFallbacks over price AND breaker
   * serving): the per-tier pause sets the orchestrator's scheduling pass and the dashboards
   * read. A tier resolved to `pair: null` pauses its roles beside the per-role cap set. */
  servingResolved: TierFallbackMap;
  /** Whether the cap is reached this poll — the budget hold only ever holds while it is;
   * the per-role sets are empty when it is not. */
  budgetActive: boolean;
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
  const reviewOn = liveConfig.review.enabled;
  // Whether the fallback is usable is a live question too: models.json is stat-cached
  // inside pi-models.ts, so an unchanged catalog costs one stat per poll, and an operator
  // who fixes a mistyped model id sees the fleet switch over within a cycle. One snapshot
  // serves both the engaged pair's check and the per-tier resolution below.
  const providers = readPiProviders(modelsPath);
  // The usable predicate's two halves (part 5b/8): pi prices the pair at zero, and its
  // breaker entry holds no demotion — tiers sharing a pair share the verdict. The
  // resolution below deliberately prices alone (the map's keys are the pairs that would
  // run absent a demotion, so a demotion cannot churn them); part 5c/8 wires the full
  // predicate into the resolution so a demoted pair re-resolves only the tiers using it.
  const pairFreeAt = (p: FallbackModelConfig) => pairFree(providers, p.provider, p.model);
  const pair = fallbackPair(liveConfig);
  const fallbackReady = pair !== null && pairFreeAt(pair);
  const pairName = modelPairName(pair);
  // The breaker map is keyed by every pair the tiers would run on absent a demotion
  // (resolveTierFallbacks over the price check alone), re-keyed per pair each poll: a pair's
  // judgment survives while its subject (pair + cap) is unchanged, and a changed cap, a pair
  // leaving the resolution, or no fallback at all re-trusts or drops it (part 5b/8). The
  // engaged pair is always among the keys, so the gate's serving verdict has an entry. This
  // price-based resolution also drives the fallback view (below) and the handback pairs: the
  // view must keep the free pairs installed even while one of them is demoted — its probe tick
  // runs on it — and the paused tiers the demotion produces are held by the scheduler's
  // per-role set, so nobody but the probe ever reaches the demoted pair.
  const priceResolved = resolveTierFallbacks(liveConfig, pairFreeAt);
  const pairNames: string[] = [];
  for (const tier of MODEL_TIERS) {
    const p = priceResolved[tier as ModelTier].pair;
    if (p) {
      const n = modelPairName(p);
      if (!pairNames.includes(n)) pairNames.push(n);
    }
  }
  if (fallbackReady && pair !== null && !pairNames.includes(pairName)) pairNames.push(pairName);
  state.breakers = rekeyFallbackBreakers(state.breakers, pairNames, liveConfig.maxDailyCostUsd);
  state.engaged = reached && fallbackReady ? pairName : null;
  // The demotion-aware resolution (part 5c/8): the same engine over the FULL usable predicate —
  // priced at zero AND its breaker entry serving — so a demoted pair re-resolves only the tiers
  // that use it: a demoted strong pair holds the strong roles beside the per-role cap set while
  // small and default keep their own pairs, instead of the fleet-wide pause the single-pair
  // gate produced.
  const usable = (p: FallbackModelConfig) =>
    pairFreeAt(p) && fallbackServingPair(state.breakers, modelPairName(p));
  const servingResolved = resolveTierFallbacks(liveConfig, usable);
  // Free is not enough: the breaker demotes a fallback whose ticks keep failing, and a gate
  // whose `default` (or, with review on, `strong`) tier resolves to pause is `paused`, exactly
  // as with no fallback at all (budgetGate, part 5c/8).
  const gate = budgetGate(
    reached,
    { default: servingResolved.default.pair !== null, strong: servingResolved.strong.pair !== null },
    reviewOn,
  );
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
      ...(gate === "fallback"
        ? {
            provider: pair?.provider,
            model: pair?.model,
            // The per-tier story (part 7b/8): which pair each tier resolved to, borrowed
            // ones marked. Carried only when the tiers resolve to two or more distinct
            // pairs — a single fallback (its pair borrowed by the other tiers) keeps the
            // event tier-free, so today's single-pair readers keep today's text.
            ...(tiersResolveDistinctPairs(servingResolved)
              ? { tiers: tierFallbackLabels(servingResolved) }
              : {}),
          }
        : {}),
      // The pause's cause, named by the pair story that produced it: the default tier's own
      // pair demoted or refused (the legacy single-pair story), or — with review on — the
      // strong tier's price-resolved pair demoted (nothing could land), which is its own
      // demotion and must not masquerade as the default pair's.
      ...(gate === "paused" && pair && !fallbackReady
        ? { fallbackRejected: pairName }
        : gate === "paused" && pair
          ? { fallbackDemoted: pairName, failures: state.breakers[pairName]?.failures ?? 0 }
          : gate === "paused" && priceResolved.strong.pair !== null
            ? {
                fallbackDemoted: modelPairName(priceResolved.strong.pair),
                failures: state.breakers[modelPairName(priceResolved.strong.pair)]?.failures ?? 0,
              }
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
  const onFallback = reached && pairNames.length > 0;
  if (onFallback && state.from !== liveConfig) {
    state.from = liveConfig;
    state.fallbackConfig = applyFallbackModel(liveConfig, priceResolved);
  }
  return {
    gate,
    onFallback,
    roleConfig: onFallback ? state.fallbackConfig : liveConfig,
    spentUsd,
    capUsd,
    resumed,
    pairs: distinctPairs(priceResolved),
    priceResolved,
    servingResolved,
    budgetActive: reached,
  };
}

/** The distinct non-null fallback pairs a resolution hands out (tier order, first occurrence
 * first) — the handback match list: a reopen hands back every in-flight tick running on any of
 * them (part 5c/8's per-tier handback). */
function distinctPairs(resolved: TierFallbackMap): FallbackModelConfig[] {
  const out: FallbackModelConfig[] = [];
  for (const tier of MODEL_TIERS) {
    const p = resolved[tier].pair;
    if (p !== null && !out.some((q) => modelPairName(q) === modelPairName(p))) out.push(p);
  }
  return out;
}
