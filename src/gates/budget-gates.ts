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
  applyFallbackModel,
  fallbackPair,
  resolveTierFallbacks,
  tierChainSteps,
  tierFallbackLabels,
  tiersResolveDistinctPairs,
  type TierFallbackMap,
} from "../config/config-fallbacks.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { enabledRoleIds } from "../config/config.js";
import { formatModelSelector, seamAgent } from "../config/model-selector.js";
import { configForRole, isTierName, reviewConfig, roleSeamTier, withModelOverrides } from "../config/config-views.js";
import { piPairFree, readPiProviders, seamFree } from "../pi/pi-models.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { claudeWindowUsedUp, readClaudeAccount, type ClaudeAccount, type ClaudeWindow } from "../agent/claude/claude-account.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { ChainTierInfo } from "../team/orchestrator-info.js";
import { dayAt } from "../text/datetime.js";

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
  /** The view roles run under while a fallback is engaged (the fallback gate, or its
   * breaker-demoted pause): the free pair installed top-level and every per-role/reviewer
   * model override dropped, so no seam can reach a priced model. */
  fallbackConfig: TumwaterConfig;
  /** The used-up subscription window and the cap flag the cached `fallbackConfig` was derived
   * under (`"<window?><cap?>"`): the view differs between a window move below the cap and a
   * cap episode, so a change in either re-derives it beside a changed live config. */
  fromKey: string;
  /** Whether the previous poll had the window move active (a used-up window with a fallback
   * to move to), for the one return-on-reset poll. */
  prevWindowMoved: boolean;
  /** The director's window view (directorWindowView) and the live config it was derived from;
   * `directorFrom` is null while the director keeps the live config. */
  directorFrom: TumwaterConfig | null;
  directorView: TumwaterConfig;
  /** The resolved-pairs key `directorView` was derived under, so a step crossing its own cap
   * re-derives it. */
  directorKey: string;
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
    prevWindowMoved: false,
    directorFrom: null,
    directorView: config,
    directorKey: "",
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
   * open): the orchestrator hands the in-flight ticks still running on the fallback back to
   * the primary (PLANS.md 2026-09-30) — new ticks are gated live, but a tick that started on
   * the fallback keeps it until it ends, so the reopen alone would leave the team's fresh
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
  /** The subscription window that is used up this poll (claudeWindowUsedUp), or null. */
  windowOut: { type: string; resetsAt: number; reserve?: true } | null;
  /** The tiers the window move put on a fallback pair, tier → label (tierFallbackLabels over
   * the moved tiers); empty when nothing moved. */
  windowTiers: Partial<Record<ModelTier, string>>;
  /** True on exactly the poll the window move ends (the window reset): the orchestrator hands
   * back the in-flight ticks still on the fallback pairs, unless the cap still holds. */
  windowResumed: boolean;
  /** The config the director runs under: the live config, except while the window move stands
   * and its own model job is subscription claude — then its tier's fallback pair
   * (gateRoleConfig's `directorConfig`). The cap never moves it. */
  directorConfig: TumwaterConfig;
  /** Where each tier this poll moved off its primary runs (chainInfo); empty when none moved. */
  chain: Partial<Record<ModelTier, ChainTierInfo>>;
}

/** Is this fallback pair a claude one (the agent namespace in the pair's provider)? */
function pairIsClaude(p: FallbackModelConfig): boolean {
  return p.provider === "claude";
}

/** Can the account not take extra usage: some window is rejected, or the newest non-reset
 * window's `overageStatus` is `rejected`. */
function claudeOverageRefused(account: ClaudeAccount): boolean {
  const live = Object.values(account.windows).filter((w) => w.status !== "reset");
  if (live.some((w) => w.status === "rejected")) return true;
  const newest = live.reduce<ClaudeWindow | null>((a, w) => (a === null || w.observedAt > a.observedAt ? w : a), null);
  return newest?.overageStatus === "rejected";
}

/** Does this model seam route to the claude backend? */
function seamIsClaude(seam: { agent?: string; provider?: string }): boolean {
  return seamAgent(seam) === "claude";
}

/** Does an in-flight tick's captured model pair (RoleRunner.runModelPair()) match the fallback
 * pair a reopening budget gate just left? The orchestrator hands back exactly those ticks
 * (PLANS.md 2026-09-30): both sides must be present — no fallback pair means no tick ran on
 * one, and an idle role's null means there is nothing to hand back — and the provider/model
 * fields must be equal, undefined matching undefined only when both sides truly lack them
 * (which cannot happen here: a null pair is rejected before the field comparison). */
export function tickOnPair(
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
 * an explicit human prompt outranks the autonomous-spend cap — except while a used-up window has
 * its own subscription claude model unable to run, when it takes `directorConfig` (pollBudgetGate's
 * view: the tier's fallback pair; omitted means the live config). Every other role takes the gate's
 * derived view (pollBudgetGate's returned `roleConfig`). Single home for the rule, so the
 * scheduler's per-poll assignment (src/gates/gate-polls.ts) and a throwaway merge author's
 * construction (src/merge/merge-verify.ts's resolveAuthor) cannot drift apart — say, an exemption
 * granted to one more role in one copy and not the other. */
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
  const account = readClaudeAccount(root);
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
  // A used-up subscription window (claudeWindowUsedUp, the rule the team hold reads too): while
  // it stands a subscription claude pair is no fallback — it would meet the same window.
  // `claudeWindowReserve` makes a window past its fraction count as used up for the team; the
  // director's own reading (directorWindowOut) ignores it, as it runs the operator's prompts.
  const windowOut = claudeWindowUsedUp(account, now, true, liveConfig.claudeWindowReserve);
  const directorWindowOut = claudeWindowUsedUp(account, now);
  // A priced step (one pi does not price at zero, or claude on API billing) is usable only
  // while the team is under its cap and the step is under its own `maxDailyCostUsd`, so no cap
  // can be passed; at the cap only free steps remain, as before.
  const pairFreeAt = (p: FallbackModelConfig) => {
    if (account?.billing === "subscription" && pairIsClaude(p)) {
      // The first Claude model runs on the subscription only; a later one (extraUsage) may
      // spend extra usage within its cap while no window is rejected or refuses overage.
      if (!p.extraUsage) return windowOut === null && piPairFree(providers, p.provider, p.model, account, catalog);
      // Past the reserve this step would spend the reserved quota before reaching extra usage:
      // it waits until a reading shows the account already spending overage.
      if (windowOut?.reserve === true && !Object.values(account.windows).some((w) => w.isUsingOverage === true))
        return false;
      return (
        !reached &&
        !claudeOverageRefused(account) &&
        (p.maxDailyCostUsd === undefined || pairDailyCost(states, modelPairName(p), now) < p.maxDailyCostUsd)
      );
    }
    if (piPairFree(providers, p.provider, p.model, account, catalog)) return !(windowOut !== null && pairIsClaude(p));
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
  // view must keep the free pairs installed even while one of them is demoted — its probe tick
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
    const topRoles = topDailySpenders(states, now);
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
  // While the fallback holds, roles run under the derived view — the free pair installed
  // top-level and every per-role/reviewer model override dropped, so no seam can reach a priced
  // model. A breaker-demoted fallback keeps the view too: its gate is `paused`, but a tick parked
  // in the semaphore when it tripped, the half-open probe, and the merges must still run on the
  // free pair — a demotion must never promote them to the priced model the cap already spent.
  const onFallback = reached && pairNames.length > 0;
  // A used-up window moves the subscription claude jobs to their tier's fallback below the cap
  // too; with no fallback to move to, nothing changes and the claude hold applies.
  const windowMove = windowOut !== null && pairNames.length > 0;
  // The resolved pairs are part of the key: a priced step crossing its own daily cap changes
  // the resolution without a config or window change, and the view must follow it.
  const resolvedKey = MODEL_TIERS.map((t) => {
    const rp = priceResolved[t].pair;
    return rp ? modelPairName(rp) : "-";
  }).join(",");
  const fromKey = `${windowMove ? "w" : ""}${reached ? "c" : ""}|${resolvedKey}`;
  if ((onFallback || windowMove) && (state.from !== liveConfig || state.fromKey !== fromKey)) {
    state.from = liveConfig;
    state.fromKey = fromKey;
    // A job keeps its own model while that model is available: below the cap every seam but a
    // subscription claude one during a used-up window; at the cap it must also be free.
    const available = (seam: { agent?: string; provider?: string; model?: string }) =>
      !(windowOut !== null && seamIsClaude(seam)) && (!reached || seamFree(providers, seam, account, catalog));
    const view = applyFallbackModel(liveConfig, priceResolved, available);
    // A role pinned to subscription claude under a tier that is not claude has no tier pair to fall
    // onto — dropping its override would put it on the tier's priced primary — so it keeps its
    // pin and the claude hold stops it, as before the window move.
    if (windowOut !== null) {
      for (const role of enabledRoleIds(liveConfig)) {
        const tier = roleSeamTier(liveConfig, role);
        const pin = liveConfig.roles[role];
        if (pin && seamIsClaude(configForRole(liveConfig, role)) && !seamIsClaude(withModelOverrides(liveConfig, tier, {})))
          view.roles[role] = pin;
      }
      // A reviewer pinned to subscription claude under such a tier would likewise end up on the
      // tier's priced primary; it goes to the tier's fallback pair instead (a held reviewer would
      // stop the whole team).
      const rm = liveConfig.review.model;
      const reviewTier: ModelTier = isTierName(rm) ? rm : "strong";
      const reviewPair = priceResolved[reviewTier].pair;
      if (
        reviewPair &&
        seamIsClaude(reviewConfig(liveConfig)) &&
        !seamIsClaude(withModelOverrides(liveConfig, reviewTier, {}))
      )
        view.review = {
          ...view.review,
          provider: undefined,
          model: formatModelSelector({
            provider: reviewPair.provider,
            model: reviewPair.model ?? "",
            thinking: reviewPair.thinking,
          }),
          thinking: undefined,
        };
    }
    state.fallbackConfig = view;
  }
  // The tiers the window move put on a fallback pair: those whose own seam is subscription claude.
  const windowTiers: Partial<Record<ModelTier, string>> = {};
  if (windowMove) {
    const moved = new Set<ModelTier>();
    for (const tier of MODEL_TIERS)
      if (seamIsClaude(withModelOverrides(liveConfig, tier, {}))) moved.add(tier);
    const labels = tierFallbackLabels(priceResolved);
    for (const tier of MODEL_TIERS) if (moved.has(tier) && labels[tier] !== undefined) windowTiers[tier] = labels[tier];
  }
  // The director follows availability, not the cap: while the window move stands and its own
  // model job is subscription claude, its tier's resolved pair replaces the live config (only
  // subscription claude jobs are unavailable, so a priced director primary keeps its model over
  // the cap). With no fallback (windowMove false) it stays on the live config and the scheduler
  // holds it on the claude hold.
  const directorMoved = directorWindowOut !== null && pairNames.length > 0 && seamIsClaude(configForRole(liveConfig, DIRECTOR_ROLE));
  if (!directorMoved) state.directorFrom = null;
  else if (state.directorFrom !== liveConfig || state.directorKey !== resolvedKey) {
    state.directorFrom = liveConfig;
    state.directorKey = resolvedKey;
    state.directorView = applyFallbackModel(liveConfig, priceResolved, (seam) => !seamIsClaude(seam));
  }
  const windowResumed = state.prevWindowMoved && !windowMove;
  state.prevWindowMoved = windowMove;
  const movedTiers = new Set<ModelTier>();
  // The tiers `applyFallbackModel` moved: those whose own seam fails the `available` test above.
  for (const tier of MODEL_TIERS) {
    const seam = withModelOverrides(liveConfig, tier, {});
    const out = (windowMove && seamIsClaude(seam)) || (reached && !seamFree(providers, seam, account, catalog));
    if (out) movedTiers.add(tier);
  }
  const chain = chainInfo({
    config: liveConfig,
    resolved: servingResolved,
    moved: movedTiers,
    breakers: state.breakers,
    states,
    now,
    windowOut,
    account,
    isPriced: (p) => !piPairFree(providers, p.provider, p.model, account, catalog),
  });
  return {
    gate,
    chain,
    onFallback,
    roleConfig: onFallback || windowMove ? state.fallbackConfig : liveConfig,
    spentUsd,
    capUsd,
    resumed,
    pairs: distinctPairs(priceResolved, chainPairs),
    priceResolved,
    servingResolved,
    budgetActive: reached,
    windowOut,
    windowTiers,
    windowResumed,
    directorConfig: directorMoved ? state.directorView : liveConfig,
  };
}

/** The `chain` block: for each tier this poll moved off its primary, the step it runs on and
 * why the position before it cannot run (plans/fallback-chain.md "Events and surfaces").
 * `moved` names the tiers the poll moved; a tier the gate pauses (`pair: null`) gets no entry.
 * The reason is read from the position just before the active step — the previous chain step,
 * or the tier's primary at step 0 — in the order demoted, step-cap, window/reserve, overage,
 * cap. */
export function chainInfo(a: {
  config: TumwaterConfig;
  resolved: TierFallbackMap;
  moved: ReadonlySet<ModelTier>;
  breakers: FallbackBreakerMap;
  states: Pick<RunnerState, "dayStamp" | "dayCostByPair">[];
  now: number;
  windowOut: { resetsAt: number; reserve?: true } | null;
  account: ClaudeAccount | null;
  isPriced: (p: FallbackModelConfig) => boolean;
}): Partial<Record<ModelTier, ChainTierInfo>> {
  const out: Partial<Record<ModelTier, ChainTierInfo>> = {};
  const steps = tierChainSteps(a.config);
  const midnight = dayAt(-1, new Date(a.now)).getTime();
  for (const tier of MODEL_TIERS) {
    const r = a.resolved[tier];
    if (!a.moved.has(tier) || r.pair === null) continue;
    const own = steps.filter((s) => s.tier === (r.from ?? tier)).map((s) => s.pair);
    const idx = r.step ?? 0;
    const prior = idx > 0 ? own[idx - 1]! : null;
    const primaryClaude = seamIsClaude(withModelOverrides(a.config, tier, {}));
    const info: ChainTierInfo = { pair: modelPairName(r.pair), step: idx + 1, of: own.length, reason: "cap" };
    const priorName = prior ? modelPairName(prior) : "";
    if (prior && a.breakers[priorName] !== undefined && !fallbackServingPair(a.breakers, priorName)) {
      info.reason = "demoted";
    } else if (
      prior?.maxDailyCostUsd !== undefined &&
      pairDailyCost(a.states, priorName, a.now) >= prior.maxDailyCostUsd
    ) {
      info.reason = "step-cap";
      info.returnsAt = midnight;
    } else if ((prior !== null && pairIsClaude(prior) || primaryClaude) && a.windowOut !== null) {
      info.reason = a.windowOut.reserve ? "reserve" : "window";
      info.returnsAt = a.windowOut.resetsAt;
    } else if (prior && pairIsClaude(prior) && prior.extraUsage && a.account && claudeOverageRefused(a.account)) {
      info.reason = "overage";
    } else {
      info.returnsAt = midnight;
    }
    if (r.pair.maxDailyCostUsd !== undefined && a.isPriced(r.pair)) {
      info.spentUsd = pairDailyCost(a.states, modelPairName(r.pair), a.now);
      info.capUsd = r.pair.maxDailyCostUsd;
    }
    out[tier] = info;
  }
  return out;
}

/** The distinct non-null fallback pairs a resolution hands out (tier order, first occurrence
 * first) — the handback match list: a reopen hands back every in-flight tick running on any of
 * them (part 5c/8's per-tier handback). */
function distinctPairs(resolved: TierFallbackMap, chainPairs: FallbackModelConfig[]): FallbackModelConfig[] {
  const out: FallbackModelConfig[] = [];
  // The resolved pairs first, then every other price-free chain step: a run can be on any step.
  const candidates = [...MODEL_TIERS.map((t) => resolved[t].pair), ...chainPairs];
  for (const p of candidates) {
    if (p !== null && !out.some((q) => modelPairName(q) === modelPairName(p))) out.push(p);
  }
  return out;
}
