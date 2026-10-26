/** The fallback config view the budget gate derives each poll, split out of pollBudgetGate's
 * event-and-verdict half (src/gates/budget-gates.ts) so the two halves each have a plain
 * function boundary and their own tests (the same split stage-path-checks.ts made of
 * stage-check.ts). This module owns everything pollBudgetGate does from its `onFallback` seam
 * through the end of the function: the seam/backends walk and used-up window moves
 * (`windowOut`, `movedBackends`, `windowMove`, `windowTiers`, `windowResumedBackends`,
 * `windowResumed`), the motion keys (`resolvedKey`, `movedKey`, `fromKey`), the two view
 * derivations (`fallbackConfig`/`directorConfig`), the `movedTiers`/`applyFallbackModel`
 * application, `chainInfo`, and the `pairs` handback list. Its one entry reads the inputs
 * pollBudgetGate's first half already resolved and returns the view fields `BudgetGatePoll`
 * carries, so pollBudgetGate keeps its call signature and src/gates/gate-polls.ts's
 * destructure of it is unchanged. The plan references the moved comments carry (part 5b/8,
 * part 5c/8, 6a/7) hold here. */

import {
  MODEL_TIERS,
  type ModelTier,
  type FallbackModelConfig,
  type TumwaterConfig,
} from "../config/config-schema.js";
import { modelPairName, pairDailyCost } from "../budget/budget.js";
import {
  type FallbackBreakerMap,
  fallbackServingPair,
} from "../budget/fallback-breaker.js";
import {
  applyFallbackModel,
  seamsInUse,
  tierChainSteps,
  tierFallbackLabels,
  type TierFallbackMap,
} from "../config/config-fallbacks.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { enabledRoleIds } from "../config/config.js";
import { formatModelSelector, seamAgent } from "../config/model-selector.js";
import {
  configForRole,
  isTierName,
  reviewConfig,
  roleSeamTier,
  withModelOverrides,
} from "../config/config-views.js";
import { piPairFree, seamFree, type PiModelDef } from "../pi/pi-models.js";
import type { OpencodeCatalogCache } from "../agent/opencode/opencode-catalog.js";
import type { SubscriptionAccount } from "../agent/subscription-account.js";
import type { ClaudeAccount, ClaudeWindow } from "../agent/claude/claude-account.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { ChainTierInfo } from "../team/orchestrator-info.js";
import { dayAt } from "../text/datetime.js";
import type { BudgetGateState } from "../gates/budget-gates.js";

/** Can the account not take extra usage: some window is rejected, or the newest non-reset
 * window's `overageStatus` is `rejected`. Shared with budget-gates.ts's verdict half (its
 * per-pair `pairFreeAt` reads the same overage refusal). */
export function claudeOverageRefused(account: ClaudeAccount): boolean {
  const live = Object.values(account.windows).filter((w) => w.status !== "reset");
  if (live.some((w) => w.status === "rejected")) return true;
  const newest = live.reduce<ClaudeWindow | null>((a, w) => (a === null || w.observedAt > a.observedAt ? w : a), null);
  return newest?.overageStatus === "rejected";
}

/** The subscription backend a fallback pair or model seam routes to, when that backend's
 * account reads subscription billing: a resolved seam's own routed agent, else a fallback
 * pair's `backend` (`x.backend`), whose account is `billing === "subscription"`, else null.
 * One backend can be a subscription while another bills by API, so a used-up window is judged
 * per backend. Exported for the gate-polls window loop (part 2e/9), which reads it per
 * backend in use. */
export function subscriptionBackendOf(
  x: FallbackModelConfig | { agent?: string },
  accounts: (backend: string) => SubscriptionAccount | null,
): string | null {
  const seam = x as { agent?: string; backend?: string };
  // A resolved seam carries its routed backend in `agent` (fallback pairs never do); a raw
  // fallback pair carries the backend in its own `backend` field.
  const id = seam.agent !== undefined ? seamAgent({ agent: seam.agent }) : seam.backend;
  if (id === undefined) return null;
  const account = accounts(id);
  return account?.billing === "subscription" ? id : null;
}

/** The view fields `BudgetGatePoll` carries that this module derives: the config roles run
 * under, the window/chain figures, and the handback pairs. The gate, spend/cap, resume, and
 * the resolved maps stay in pollBudgetGate's verdict half. */
interface BudgetFallbackView {
  onFallback: boolean;
  roleConfig: TumwaterConfig;
  pairs: FallbackModelConfig[];
  windowOut: Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>>;
  windowTiers: Partial<Record<ModelTier, string>>;
  windowResumed: boolean;
  windowResumedBackends: readonly string[];
  directorConfig: TumwaterConfig;
  chain: Partial<Record<ModelTier, ChainTierInfo>>;
}

/** The inputs `budgetFallbackView` and its phase helpers read: the verdict half's
 * already-resolved inputs (`priceResolved`, `servingResolved`, `chainPairs`, `pairNames`),
 * the `reached` flag, and the shared reads (`state`, `config`, `accounts`,
 * `windowOutFor`/`directorWindowOutFor`, `providers`, `catalog`). */
interface BudgetFallbackViewInput {
  state: BudgetGateState;
  config: TumwaterConfig;
  now: number;
  states: RunnerState[];
  providers: Map<string, PiModelDef[]> | null;
  catalog: OpencodeCatalogCache | null;
  accounts: (backend: string) => SubscriptionAccount | null;
  windowOutFor: (backend: string) => { type: string; resetsAt: number; reserve?: true } | null;
  directorWindowOutFor: (backend: string) => { type: string; resetsAt: number; reserve?: true } | null;
  priceResolved: TierFallbackMap;
  servingResolved: TierFallbackMap;
  chainPairs: FallbackModelConfig[];
  pairNames: string[];
  reached: boolean;
}

/** Resolve the window move: whether the fallback holds, which subscription backends' used-up
 * windows move, and the motion keys the view re-derives on. Read by every phase that needs
 * the move to decide what to install. Returns the move's facts; `movedKey` stays local. */
function resolveWindowMove(a: BudgetFallbackViewInput) {
  const {
    config: liveConfig,
    accounts,
    windowOutFor,
    priceResolved,
    pairNames,
    reached,
  } = a;
  // While the fallback holds, roles run under the derived view — the free pair installed
  // top-level and every per-role/reviewer model override dropped, so no seam can reach a priced
  // model. A breaker-demoted fallback keeps the view too: its gate is `paused`, but a run parked
  // in the semaphore when it tripped, the half-open probe, and the merges must still run on the
  // free pair — a demotion must never promote them to the priced model the cap already spent.
  const onFallback = reached && pairNames.length > 0;
  // A used-up window moves the subscription jobs of the backend whose window stands to their
  // tier's fallback below the cap too; with no fallback to move to, nothing changes and that
  // backend's hold applies. Every backend with a subscription seam in the config counts
  // (seamsInUse enumerates them: every enabled role, the reviewer, the resolver, the director,
  // and every tier fallback step), so a used-up window with no seam on that backend (or no
  // fallback) moves nothing.
  const seamBackends = new Set<string>();
  for (const seam of seamsInUse(liveConfig)) {
    if (seam.agent === undefined) continue;
    const acc = accounts(seam.agent);
    if (acc?.billing === "subscription") seamBackends.add(seam.agent);
  }
  // The used-up windows behind this poll's move, keyed by backend: a backend counts only when
  // a subscription seam of it is in the config, its own window is used up, and there is a
  // fallback pair to move to. `windowOut` names only those backends; a healthy or absent
  // backend's window is untouched.
  const windowOut: Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>> = {};
  const movedBackends = new Set<string>();
  for (const backend of seamBackends) {
    const win = windowOutFor(backend);
    if (win !== null && pairNames.length > 0) {
      windowOut[backend] = win;
      movedBackends.add(backend);
    }
  }
  const windowMove = movedBackends.size > 0;
  // The resolved pairs are part of the key: a priced step crossing its own daily cap changes
  // the resolution without a config or window change, and the view must follow it.
  const resolvedKey = MODEL_TIERS.map((t) => {
    const rp = priceResolved[t].pair;
    return rp ? modelPairName(rp) : "-";
  }).join(",");
  // The set of window-moved backends is part of the key too (not just the `w` flag): a second
  // backend's window can come or go while the move still stands, and the view must re-derive
  // for the roles it newly blocks or frees.
  const movedKey = [...movedBackends].sort().join("+");
  const fromKey = `${windowMove ? "w" : ""}${reached ? "c" : ""}|${movedKey}|${resolvedKey}`;
  return { onFallback, windowOut, movedBackends, windowMove, resolvedKey, fromKey };
}

/** Install `state.fallbackConfig` when the fallback or a window move changed the view key,
 * including the pinned-role and pinned-reviewer escapes. Read by the pinned loops. */
function installFallbackConfig(
  a: BudgetFallbackViewInput,
  o: {
    onFallback: boolean;
    windowMove: boolean;
    windowOut: Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>>;
    movedBackends: Set<string>;
    fromKey: string;
  },
) {
  const { state, config: liveConfig, accounts, providers, catalog, priceResolved, reached } = a;
  const { onFallback, windowMove, windowOut, movedBackends, fromKey } = o;
  if ((onFallback || windowMove) && (state.from !== liveConfig || state.fromKey !== fromKey)) {
    state.from = liveConfig;
    state.fromKey = fromKey;
    // A job keeps its own model while that model is available: below the cap every seam but a
    // subscription one whose own backend's window is used up; at the cap it must also be free.
    const seamBlocked = (seam: { agent?: string; provider?: string; model?: string }) => {
      const b = subscriptionBackendOf(seam, accounts);
      return b !== null && windowOut[b] !== undefined;
    };
    const available = (seam: { agent?: string; provider?: string; model?: string }) =>
      !seamBlocked(seam) && (!reached || seamFree(providers, seam, accounts, catalog));
    const view = applyFallbackModel(liveConfig, priceResolved, available);
    // A role pinned to a subscription backend under a tier of another backend has no tier pair
    // to fall onto — dropping its override would put it on the tier's priced primary — so it
    // keeps its pin and that backend's hold stops it, as before the window move.
    if (movedBackends.size > 0) {
      for (const role of enabledRoleIds(liveConfig)) {
        const tier = roleSeamTier(liveConfig, role);
        const pin = liveConfig.roles[role];
        const roleBackend = subscriptionBackendOf(configForRole(liveConfig, role), accounts);
        const tierBackend = subscriptionBackendOf(withModelOverrides(liveConfig, tier, {}), accounts);
        if (pin && roleBackend !== null && roleBackend !== tierBackend) view.roles[role] = pin;
      }
      // A reviewer pinned to a subscription backend under such a tier would likewise end up on
      // the tier's priced primary; it goes to the tier's fallback pair instead (a held reviewer
      // would park the roles a pre-merge review gates).
      const rm = liveConfig.review.model;
      const reviewTier: ModelTier = isTierName(rm) ? rm : "strong";
      const reviewPair = priceResolved[reviewTier].pair;
      const reviewBackend = subscriptionBackendOf(reviewConfig(liveConfig), accounts);
      const reviewTierBackend = subscriptionBackendOf(withModelOverrides(liveConfig, reviewTier, {}), accounts);
      // Only the reviewer's own backend's window counts: a reviewer on a healthy backend must
      // stay put even while another backend's window moves its tier.
      if (
        reviewPair &&
        reviewBackend !== null &&
        windowOut[reviewBackend] !== undefined &&
        reviewBackend !== reviewTierBackend
      )
        view.review = {
          ...view.review,
          backend: reviewPair.backend ?? "pi",
          provider: undefined,
          model: formatModelSelector({
            provider: reviewPair.backend === undefined ? reviewPair.provider : undefined,
            model: reviewPair.model ?? "",
            thinking: reviewPair.thinking,
          }),
          thinking: undefined,
        };
    }
    state.fallbackConfig = view;
  }
}

/** The tiers the window move put on a fallback pair: those whose own seam is a subscription
 * backend whose window stands. */
function deriveWindowTiers(
  a: BudgetFallbackViewInput,
  windowOut: Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>>,
  windowMove: boolean,
): Partial<Record<ModelTier, string>> {
  const { config: liveConfig, accounts, priceResolved } = a;
  // The tiers the window move put on a fallback pair: those whose own seam is a subscription
  // backend whose window stands.
  const windowTiers: Partial<Record<ModelTier, string>> = {};
  if (windowMove) {
    const moved = new Set<ModelTier>();
    for (const tier of MODEL_TIERS) {
      const b = subscriptionBackendOf(withModelOverrides(liveConfig, tier, {}), accounts);
      if (b !== null && windowOut[b] !== undefined) moved.add(tier);
    }
    const labels = tierFallbackLabels(priceResolved);
    for (const tier of MODEL_TIERS) if (moved.has(tier) && labels[tier] !== undefined) windowTiers[tier] = labels[tier];
  }
  return windowTiers;
}

/** Install the director's `state.directorFrom`/`directorKey`/`directorView` and return whether
 * the director moved. */
function installDirectorFallback(
  a: BudgetFallbackViewInput,
  resolvedKey: string,
  windowOut: Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>>,
): boolean {
  const { state, config: liveConfig, accounts, pairNames, directorWindowOutFor, priceResolved } = a;
  // The director follows availability, not the cap: while the window move stands and its own
  // model job is a subscription backend, its tier's resolved pair replaces the live config (only
  // subscription jobs of a used-up window are unavailable, so a priced director primary keeps
  // its model over the cap). With no fallback (windowMove false) it stays on the live config and
  // the scheduler holds it on that backend's hold.
  const directorBackend = subscriptionBackendOf(configForRole(liveConfig, DIRECTOR_ROLE), accounts);
  const directorMoved =
    directorBackend !== null && pairNames.length > 0 && directorWindowOutFor(directorBackend) !== null;
  if (!directorMoved) state.directorFrom = null;
  else if (state.directorFrom !== liveConfig || state.directorKey !== resolvedKey) {
    state.directorFrom = liveConfig;
    state.directorKey = resolvedKey;
    state.directorView = applyFallbackModel(
      liveConfig,
      priceResolved,
      (seam) => {
        const b = subscriptionBackendOf(seam, accounts);
        return b === null || windowOut[b] === undefined;
      },
    );
  }
  return directorMoved;
}

/** Fold `state.prevWindowMoved` into the resumed-backends signal and record the new move. */
function deriveWindowResumed(a: BudgetFallbackViewInput, movedBackends: Set<string>) {
  const { state } = a;
  const windowResumedBackends = [...state.prevWindowMoved].filter((b) => !movedBackends.has(b));
  const windowResumed = windowResumedBackends.length > 0;
  state.prevWindowMoved = movedBackends;
  return { windowResumed, windowResumedBackends };
}

/** The tiers `applyFallbackModel` moved: those whose own seam fails the `available` test above.
 * Feeds the `chain` block's `moved` set. */
function deriveMovedTiers(
  a: BudgetFallbackViewInput,
  windowOut: Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>>,
  windowMove: boolean,
): Set<ModelTier> {
  const { config: liveConfig, accounts, providers, catalog, reached } = a;
  const movedTiers = new Set<ModelTier>();
  // The tiers `applyFallbackModel` moved: those whose own seam fails the `available` test above.
  for (const tier of MODEL_TIERS) {
    const seam = withModelOverrides(liveConfig, tier, {});
    const b = subscriptionBackendOf(seam, accounts);
    const out = (windowMove && b !== null && windowOut[b] !== undefined) || (reached && !seamFree(providers, seam, accounts, catalog));
    if (out) movedTiers.add(tier);
  }
  return movedTiers;
}

/** Derive the fallback view for one poll from the verdict half's already-resolved inputs
 * (`priceResolved`, `servingResolved`, `chainPairs`, `pairNames`) and the `reached` flag
 * and the shared reads (`state`, `config`, `accounts`, `windowOutFor`/`directorWindowOutFor`,
 * `providers`, `catalog`), writing the cross-poll view state (`from`/`fromKey`/`fallbackConfig`,
 * `directorFrom`/`directorKey`/`directorView`, `prevWindowMoved`) and returning the view fields
 * pollBudgetGate hands back. */
export function budgetFallbackView(a: BudgetFallbackViewInput): BudgetFallbackView {
  const {
    state,
    config: liveConfig,
    now,
    states,
    providers,
    catalog,
    accounts,
    windowOutFor,
    priceResolved,
    servingResolved,
    chainPairs,
  } = a;
  const { onFallback, windowOut, movedBackends, windowMove, resolvedKey, fromKey } = resolveWindowMove(a);
  installFallbackConfig(a, { onFallback, windowMove, windowOut, movedBackends, fromKey });
  const windowTiers = deriveWindowTiers(a, windowOut, windowMove);
  const directorMoved = installDirectorFallback(a, resolvedKey, windowOut);
  const { windowResumed, windowResumedBackends } = deriveWindowResumed(a, movedBackends);
  const movedTiers = deriveMovedTiers(a, windowOut, windowMove);
  const chain = chainInfo({
    config: liveConfig,
    resolved: servingResolved,
    moved: movedTiers,
    breakers: state.breakers,
    states,
    now,
    windowOutFor,
    accounts,
    isPriced: (p) => !piPairFree(providers, p, accounts, catalog),
  });
  return {
    onFallback,
    chain,
    roleConfig: onFallback || windowMove ? state.fallbackConfig : liveConfig,
    pairs: distinctPairs(priceResolved, chainPairs),
    windowOut,
    windowTiers,
    windowResumed,
    windowResumedBackends,
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
  windowOutFor: (backend: string) => { resetsAt: number; reserve?: true } | null;
  accounts: (backend: string) => SubscriptionAccount | null;
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
    // The backend whose used-up window this tier's chain reads for the window/reserve reason:
    // the prior step's own backend when a prior step is subscription, else the primary's.
    const priorSub = prior ? subscriptionBackendOf(prior, a.accounts) : null;
    const primarySub = subscriptionBackendOf(withModelOverrides(a.config, tier, {}), a.accounts);
    const windowBackend = (prior !== null ? priorSub : null) ?? primarySub;
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
    } else if (windowBackend !== null && a.windowOutFor(windowBackend) !== null) {
      const win = a.windowOutFor(windowBackend)!;
      info.reason = win.reserve ? "reserve" : "window";
      info.returnsAt = win.resetsAt;
    } else if (
      prior &&
      subscriptionBackendOf(prior, a.accounts) !== null &&
      prior.extraUsage &&
      a.accounts("claude") &&
      claudeOverageRefused(a.accounts("claude")!)
    ) {
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
 * first) — the handback match list: a reopen hands back every in-flight run on any of
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
