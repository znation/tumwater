/** The daily cost budget gate (plans/daily-cost-budget.md, plans/fallback-model.md) and the
 * fallback config view it derives, as the orchestrator polls it each cycle. Extracted from
 * orchestrator.ts's poll loop: the spend check, the fallback breaker's re-key, the
 * edge-triggered budget_* events, and the fallback view derivation are one concern beside the
 * other team gates (src/gates/pause-gates.ts, src/team/team-hold.ts's team hold) — the
 * orchestrator owns only the wiring (the demotion publish and the per-runner config assignment). */

import { MODEL_TIERS, type ModelTier, type FallbackModelConfig, type TumwaterConfig } from "../config/config-schema.js";
import {
  budgetGate,
  budgetReached,
  budgetSpend,
  budgetWarning,
  modelPairName,
  pairDailyCost,
  topDailySpenders,
  type BudgetGate,
} from "../budget/budget.js";
import {
  type FallbackBreakerMap,
  fallbackServingPair,
  rekeyFallbackBreakers,
} from "../budget/fallback-breaker.js";
import {
  fallbackPair,
  resolveTierFallbacks,
  tierChainSteps,
  tierFallbackLabels,
  tiersResolveDistinctPairs,
  type TierFallbackMap,
} from "../config/config-fallbacks.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { piPairFree, readPiProviders } from "../pi/pi-models.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { readAccount } from "../agent/subscription-account.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { ChainTierInfo } from "../team/team-orchestrator-info.js";
import {
  budgetFallbackView,
  chainInfo,
  claudeOverageRefused,
  subscriptionBackendOf,
} from "../budget/budget-fallback-view.js";
// Re-export the names moved into budget-fallback-view.ts so no importer's import changes
// (gate-polls.ts reads subscriptionBackendOf; budget-chain-info.test.ts reads chainInfo).
export { chainInfo, subscriptionBackendOf };

/** The budget gate's cross-poll memory: the previous gate value for edge-triggered events,
 * the fallback breaker, and the fallback view last derived from a live config. In memory
 * only — a restart re-trusts the fallbacks and re-trips them within failureLimit runs. */
export interface BudgetGateState {
  /** The previous poll's gate, for one-shot transition events. Three-valued since
   * plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
   * between two of them is worth exactly one event. */
  prevGate: BudgetGate;
  /** The fallback breakers, one per pair name (fallback-breaker.ts's FallbackBreakerMap,
   * part 5b/8): folded from the outcomes of role runs that ran on each pair, re-keyed per
   * pair by every poll (and folded further by the orchestrator's run bookkeeping). Tiers
   * sharing a fallback pair share one entry and one judgment. */
  breakers: FallbackBreakerMap;
  /** The pair name this poll's gate engaged (`"provider/model"`), or null when none — the
   * key the orchestrator's probe admission and run evidence fold read and write under, and
   * the pair whose demotion the observers publish. */
  engaged: string | null;
  /** The live config the fallback view was last derived from; null until a fallback first
   * engages, so an unchanged config object is not re-derived every poll. */
  from: TumwaterConfig | null;
  /** The view roles run under while a fallback is engaged (the fallback gate, or its
   * breaker-demoted pause): the free pair installed top-level and every per-role/reviewer
   * model override dropped, so no seam can reach a priced model. */
  fallbackConfig: TumwaterConfig;
  /** The used-up window and the cap flag the cached `fallbackConfig` was derived under
   * (`""`/`"c"`): the view differs between a window move below the cap and a cap episode, so a
   * change in either re-derives it beside a changed live config. With the window move gone
   * (part 5d/6) only the cap flag remains, kept in the same key slot so the view re-derives on
   * a cap crossing beside a changed live config. */
  fromKey: string;
  /** Whether this episode's 80%-of-cap warning has fired (budgetWarning): edge-triggered like
   * the transitions — set when the warning logs, reset whenever spend falls back below the
   * threshold (midnight rollover, a cap raise), so the next crossing warns again. */
  warned: boolean;
  /** The previous poll's `chain` block, for the one `fallback_switched` event per change. */
  prevChain: Partial<Record<ModelTier, ChainTierInfo>>;
}

/** A fresh budget-gate poll state: gate open, no fallback breakers yet, no fallback view cached
 * yet (so the first poll of an unchanged config logs nothing). */
export function newBudgetGateState(config: TumwaterConfig): BudgetGateState {
  return {
    prevGate: "open",
    breakers: {},
    engaged: null,
    from: null,
    fromKey: "",
    fallbackConfig: config,
    warned: false,
    prevChain: {},
  };
}

/** One poll's gate decision, handed back for the orchestrator's wiring: which gate holds this
 * poll, whether the fallback is engaged, the config roles run under (the fallback
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
   * open): the orchestrator hands the in-flight runs still running on the fallback back to
   * the primary (PLANS.md 2026-09-30) — new runs are gated live, but a run that started on
   * the fallback keeps it until it ends, so the reopen alone would leave the team's fresh
   * budget waiting on the slow local model. The fallback pair the gate just left (below)
   * identifies those runs. */
  resumed: boolean;
  /** The live config's fallback pairs (part 5c/8): every non-null pair the price-based
   * resolution hands a tier, so the reopen hands back the in-flight runs on ANY of
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
  /** The config the director runs under: always the live config — an explicit human prompt
   * outranks the autonomous-spend cap (gateRoleConfig's `directorConfig`), and (part 5d/6) no
   * usage window moves it either. */
  directorConfig: TumwaterConfig;
  /** Where each tier this poll moved off its primary runs (chainInfo); empty when none moved. */
  chain: Partial<Record<ModelTier, ChainTierInfo>>;
}

/** The inputs the warning-and-transition half of the budget gate logs from: everything
 * `logBudgetGateEvents` reads off one argument, so the helper's locals have a single named
 * source instead of scattering through pollBudgetGate's body. */
interface BudgetGateEventInput {
  root: string;
  state: BudgetGateState;
  states: RunnerState[];
  now: number;
  gate: BudgetGate;
  spentUsd: number;
  capUsd: number;
  pair: FallbackModelConfig | null;
  pairName: string;
  rejectedPair: FallbackModelConfig | null;
  priceResolved: TierFallbackMap;
  servingResolved: TierFallbackMap;
}

/** The budget gate's warning-and-transition half (split out of pollBudgetGate so a
 * budget_warning event field or an edge-trigger rule is found by name): edge-triggers the
 * 80%-of-cap warning into one budget_warning, computes the top spenders for whichever event
 * fires, logs exactly one budget_resumed/budget_fallback/budget_paused on a gate crossing
 * with the per-tier story and the pause cause, and advances state.prevGate. */
function logBudgetGateEvents(input: BudgetGateEventInput): void {
  const {
    root,
    state,
    states,
    now,
    gate,
    spentUsd,
    capUsd,
    pair,
    pairName,
    rejectedPair,
    priceResolved,
    servingResolved,
  } = input;
  // The 80% early warning (PLANS.md 2026-09-30), edge-triggered with reset-on-below — the
  // whole state machine: crossing the threshold while the gate is still open logs one
  // budget_warning, midnight or a cap raise drops spend back under and re-arms it, and a
  // second crossing the same day warns again. Warn only while the gate is open: a poll that
  // engages fallback/paused already logs its own transition event, so the warning never
  // doubles the page on the poll the cap itself is reached.
  const warn = gate === "open" && budgetWarning({ spentUsd, capUsd });
  // Who spent the most today, read once for whichever of the warning or a transition fires.
  const topRoles = (warn && !state.warned) || gate !== state.prevGate ? topDailySpenders(states, now) : [];
  if (warn && !state.warned) {
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "budget_warning",
      spentUsd,
      capUsd,
      ...(topRoles.length > 0 ? { topRoles } : {}),
    });
    state.warned = true;
  } else if (!warn) {
    state.warned = false;
  }
  if (gate !== state.prevGate) {
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused",
      spentUsd,
      capUsd,
      // The cap pages say where the money went, since a poll can jump past the cap with no
      // warning first; a resume does not (midnight reads zero spend, a cap raise is the
      // operator's own act).
      ...(gate !== "open" && topRoles.length > 0 ? { topRoles } : {}),
      // On the way into a gate the fallback's identity is the operator's answer to "why
      // this and not the other one": which free pair took over, which configured pair was
      // refused because pi's definitions do not price it at zero, or which free pair the
      // breaker demoted after its runs kept failing (and after how many).
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
      // The pause's cause, named by the pair story that produced it. The default tier is the
      // cause only when it failed to serve: a price-free default the breaker dropped is its
      // own demotion (with the failure count), and a default with no price-free pair at all
      // names the declared pair the price check refused. When the default serves, the
      // review-on pause is the strong tier's: name its price-free pair when the breaker
      // demoted it, and leave the cause unset when strong simply had no pair to borrow.
      ...(gate === "paused" && servingResolved.default.pair === null && pair
        ? { fallbackDemoted: pairName, failures: state.breakers[pairName]?.failures ?? 0 }
        : gate === "paused" && servingResolved.default.pair === null && rejectedPair
          ? { fallbackRejected: modelPairName(rejectedPair) }
          : gate === "paused" && priceResolved.strong.pair !== null
            ? {
                fallbackDemoted: modelPairName(priceResolved.strong.pair),
                failures: state.breakers[modelPairName(priceResolved.strong.pair)]?.failures ?? 0,
              }
            : {}),
    });
    state.prevGate = gate;
  }
}

/** Does an in-flight run's captured model pair (RoleRunner.runModelPair()) match the fallback
 * pair a reopening budget gate just left? The orchestrator hands back exactly those runs
 * (PLANS.md 2026-09-30): both sides must be present — no fallback pair means no run is on
 * one, and an idle role's null means there is nothing to hand back — and the provider/model
 * fields must be equal, undefined matching undefined only when both sides truly lack them
 * (which cannot happen here: a null pair is rejected before the field comparison). */
export function runOnPair(
  runModelPair: { provider?: string; model?: string } | null,
  pair: FallbackModelConfig | null,
): boolean {
  return (
    runModelPair !== null &&
    pair !== null &&
    runModelPair.provider === pair.provider &&
    runModelPair.model === pair.model
  );
}

/** The config a runner runs on while the budget gate stands: the director keeps the live config —
 * an explicit human prompt outranks the autonomous-spend cap (and, part 5d/6, no usage window
 * moves it either) — so it takes `directorConfig` (always the live config; omitted means the live
 * config). Every other role takes the gate's derived view (pollBudgetGate's returned `roleConfig`).
 * Single home for the rule, so the scheduler's per-poll assignment (src/budget/budget-wiring.ts)
 * and a throwaway merge author's construction (src/merge/merge-verify.ts's resolveAuthor) cannot
 * drift apart — say, an exemption granted to one more role in one copy and not the other. */
export function gateRoleConfig(
  role: string,
  liveConfig: TumwaterConfig,
  roleConfig: TumwaterConfig,
  directorConfig: TumwaterConfig = liveConfig,
): TumwaterConfig {
  return role === DIRECTOR_ROLE ? directorConfig : roleConfig;
}

/** Poll the daily cost budget gate: once the team's spend for the local day has reached
 * maxDailyCostUsd, roles either switch to the configured cost-free fallback model and
 * keep working, or — with no usable one — start no new runs at all (scheduled, main-moved
 * wake, or startup). The director is outside both: an explicit human prompt outranks the
 * autonomous-spend cap, so it keeps its budgeted model and keeps running. In-flight runs
 * finish; only NEW runs are gated — and when the gate reopens, the orchestrator hands the
 * runs still running on the fallback back to the primary (the `budget_handback` event).
 * Resume is live — raising/disabling the cap (reloaded
 * live each poll), fixing the fallback, or crossing local midnight re-evaluates this on the
 * next poll — and the one piece of state, the fallback breaker, is re-keyed by the same
 * inputs, so nothing can get stuck. */
export function pollBudgetGate(
  state: BudgetGateState,
  ctx: { root: string; states: RunnerState[]; liveConfig: TumwaterConfig; modelsPath: string },
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
  // who fixes a mistyped model id sees the team switch over within a cycle. One snapshot
  // serves both the engaged pair's check and the per-tier resolution below.
  const providers = readPiProviders(modelsPath);
  // The persisted billing answer (6a/7): a subscription claude seam is free money, so the
  // predicates below never move it to a fallback and accept a subscription claude pair as a
  // budget fallback. One read per poll; an absent file reads as "no subscription".
  // The free-ness predicates judge a seam by its own backend's subscription account (part
  // 2a/9): today only claude asks, and this lookup returns claude's account for "claude" and
  // null otherwise. The used-up-window and overage logic below reads it per backend, so a
  // second backend's window and overage are judged from its own account.
  const accounts = (backend: string) => readAccount(root, backend);
  // The cached opencode models catalog (part 6b/7), seeded at the startup gate and read once
  // per poll so every free-ness verdict below prices opencode seams against the same snapshot.
  // Absent (no cache yet), an opencode seam reads NOT free — the safe direction until the
  // startup seed fills the file in.
  const catalog = readOpencodeCache(root);
  // The usable predicate's two halves (part 5b/8): pi prices the pair at zero — a pair
  // routed to a non-pi backend (e.g. `claude/<id>`) is never free, the same predicate the
  // badge uses — and its breaker entry holds no demotion, tiers sharing a pair share the
  // verdict. The resolution below deliberately prices alone (the map's keys are the pairs
  // that would run absent a demotion, so a demotion cannot churn them); part 5c/8 wires the
  // full predicate into the resolution so a demoted pair re-resolves only the tiers using it.
  // A used-up subscription window no longer moves a tier to its fallback (part 5d/6): only a
  // spent maxDailyCostUsd does, so the free-ness predicate below is purely the cap rule.
  // A priced step (one pi does not price at zero, or claude on API billing) is usable only
  // while the team is under its cap and the step is under its own `maxDailyCostUsd`, so no cap
  // can be passed; at the cap only free steps remain, as before.
  const pairFreeAt = (p: FallbackModelConfig) => {
    const subBackend = subscriptionBackendOf(p, accounts);
    if (subBackend !== null) {
      // The first model of a subscription backend runs on the subscription only; a later one
      // (extraUsage, claude-only) may spend extra usage within its cap while no window is
      // rejected or refuses overage.
      if (!p.extraUsage) return piPairFree(providers, p, accounts, catalog);
      const subAccount = accounts(subBackend)!;
      return (
        !reached &&
        !claudeOverageRefused(subAccount) &&
        (p.maxDailyCostUsd === undefined || pairDailyCost(states, modelPairName(p), now) < p.maxDailyCostUsd)
      );
    }
    // The subscription rule lives entirely in the branch above (it returns early for
    // any subscription pair); below that branch a pair is never a subscription, so only the
    // free-ness and cap rules apply.
    if (piPairFree(providers, p, accounts, catalog)) return true;
    if (reached) return false;
    return (
      p.maxDailyCostUsd === undefined ||
      pairDailyCost(states, modelPairName(p), now) < p.maxDailyCostUsd
    );
  };
  // The breaker map is keyed by every pair the tiers would run on absent a demotion
  // (resolveTierFallbacks over the price check alone), re-keyed per pair each poll: a pair's
  // judgment survives while its subject (pair + cap) is unchanged, and a changed cap, a pair
  // leaving the resolution, or no fallback at all re-trusts or drops it (part 5b/8). The
  // engaged pair is always among the keys, so the gate's serving verdict has an entry. This
  // price-based resolution also drives the fallback view (below) and the handback pairs: the
  // view must keep the free pairs installed even while one of them is demoted — its probe run
  // runs on it — and the paused tiers the demotion produces are held by the scheduler's
  // per-role set, so nobody but the probe ever reaches the demoted pair.
  const priceResolved = resolveTierFallbacks(liveConfig, pairFreeAt);
  // The team-level engagement is the price-resolved `default` tier's pair: a map with no
  // `default` entry still reports the free pair the tier borrows, so state.engaged and the
  // budget_fallback event name what the gate actually engages instead of reading null while
  // the team runs one. fallbackReady is exactly a non-null resolved default. rejectedPair is
  // the default tier's own declared pair (fallbackPair's borrow order included) — the pair
  // the operator asked for when the price check refused it, named by the pause event.
  const pair = priceResolved.default.pair;
  const fallbackReady = pair !== null;
  const pairName = modelPairName(pair);
  const rejectedPair = fallbackPair(liveConfig);

  const pairNames: string[] = [];
  for (const tier of MODEL_TIERS) {
    const p = priceResolved[tier].pair;
    if (p) {
      const n = modelPairName(p);
      if (!pairNames.includes(n)) pairNames.push(n);
    }
  }
  // Every price-free step of every tier's chain gets a breaker entry too: a demoted step's
  // successor must have one, or fallbackServingPair would read it as not serving.
  const chainPairs = tierChainSteps(liveConfig)
    .map((s) => s.pair)
    .filter(pairFreeAt);
  for (const p of chainPairs) {
    const n = modelPairName(p);
    if (!pairNames.includes(n)) pairNames.push(n);
  }
  state.breakers = rekeyFallbackBreakers(state.breakers, pairNames, liveConfig.maxDailyCostUsd);
  state.engaged = reached && fallbackReady ? pairName : null;
  // The demotion-aware resolution (part 5c/8): the same engine over the FULL usable predicate —
  // priced at zero AND its breaker entry serving — so a demoted pair re-resolves only the tiers
  // that use it: a demoted strong pair holds the strong roles beside the per-role cap set while
  // small and default keep their own pairs, instead of the team-wide pause the single-pair
  // gate produced.
  const usable = (p: FallbackModelConfig) =>
    pairFreeAt(p) && fallbackServingPair(state.breakers, modelPairName(p));
  const servingResolved = resolveTierFallbacks(liveConfig, usable);
  // Free is not enough: the breaker demotes a fallback whose runs keep failing, and a gate
  // whose `default` (or, with review on, `strong`) tier resolves to pause is `paused`, exactly
  // as with no fallback at all (budgetGate, part 5c/8).
  const gate = budgetGate(
    reached,
    { default: servingResolved.default.pair !== null, strong: servingResolved.strong.pair !== null },
    reviewOn,
  );
  // Read before prevGate is advanced below: true on exactly the reopening transition.
  const resumed = gate === "open" && (state.prevGate === "fallback" || state.prevGate === "paused");
  logBudgetGateEvents({
    root,
    state,
    states,
    now,
    gate,
    spentUsd,
    capUsd,
    pair,
    pairName,
    rejectedPair,
    priceResolved,
    servingResolved,
  });
  // The fallback config view — the derived config roles run under, the chain block, and the
  // handback pairs — lives in src/budget/budget-fallback-view.ts (the view half, plan's parts
  // 5b/8, 5c/8, 6a/7): it reads these verdict half's resolved inputs and writes the cross-poll
  // view state, and pollBudgetGate keeps this call signature so gate-polls.ts's destructure is
  // unchanged.
  const view = budgetFallbackView({
    state,
    config: liveConfig,
    now,
    states,
    providers,
    catalog,
    accounts,
    priceResolved,
    servingResolved,
    chainPairs,
    pairNames,
    reached,
  });
  return {
    gate,
    resumed,
    spentUsd,
    capUsd,
    priceResolved,
    servingResolved,
    budgetActive: reached,
    ...view,
  };
}
