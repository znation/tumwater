/** The fallback config view the budget gate derives each poll, split out of pollBudgetGate's
 * event-and-verdict half (src/gates/budget-gates.ts) so the two halves each have a plain
 * function boundary and their own tests (the same split stage-path-checks.ts made of
 * stage-check.ts). This module owns everything pollBudgetGate does from its `onFallback` seam
 * through the end of the function: the seam/backends walk, the motion key (`resolvedKey`,
 * `fromKey`), the fallback view derivation (`fallbackConfig`), `chainInfo`, and the `pairs`
 * handback list. It no longer moves any tier for a used-up subscription window (part 5d/6): only
 * a spent `maxDailyCostUsd` triggers a move, so the view's one job is the cap's free-seam
 * install. Its one entry reads the inputs pollBudgetGate's first half already resolved and
 * returns the view fields `BudgetGatePoll` carries, so pollBudgetGate keeps its call signature
 * and src/gates/gate-polls.ts's destructure of it is unchanged. The plan references the moved
 * comments carry (part 5b/8, part 5c/8, 6a/7) hold here. */

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
  tierChainSteps,
  type TierFallbackMap,
} from "../config/config-fallbacks.js";
import { seamAgent } from "../config/config-model-selector.js";
import { withModelOverrides } from "../config/config-views.js";
import { piPairFree, seamFree, type PiModelDef } from "../pi/pi-models.js";
import type { OpencodeCatalogCache } from "../agent/opencode/opencode-catalog.js";
import type { SubscriptionAccount } from "../agent/subscription-account.js";
import type { ClaudeAccount, ClaudeWindow } from "../agent/claude/claude-account.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { ChainTierInfo } from "../team/team-orchestrator-info.js";
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
 * under, the director's config, the chain figures, and the handback pairs. The gate,
 * spend/cap, resume, and the resolved maps stay in pollBudgetGate's verdict half. */
interface BudgetFallbackView {
  onFallback: boolean;
  roleConfig: TumwaterConfig;
  pairs: FallbackModelConfig[];
  directorConfig: TumwaterConfig;
  chain: Partial<Record<ModelTier, ChainTierInfo>>;
}

/** The inputs `budgetFallbackView` and its phase helpers read: the verdict half's
 * already-resolved inputs (`priceResolved`, `servingResolved`, `chainPairs`, `pairNames`), the
 * `reached` flag, and the shared reads (`state`, `config`, `accounts`, `providers`,
 * `catalog`). */
interface BudgetFallbackViewInput {
  state: BudgetGateState;
  config: TumwaterConfig;
  now: number;
  states: RunnerState[];
  providers: Map<string, PiModelDef[]> | null;
  catalog: OpencodeCatalogCache | null;
  accounts: (backend: string) => SubscriptionAccount | null;
  priceResolved: TierFallbackMap;
  servingResolved: TierFallbackMap;
  chainPairs: FallbackModelConfig[];
  pairNames: string[];
  reached: boolean;
}

/** Install `state.fallbackConfig` when the fallback changed the view key: at the cap, the free
 * pair installed top-level and every per-role/reviewer model override dropped, so no seam can
 * reach a priced model. A breaker-demoted fallback keeps the view too: its gate is `paused`,
 * but a run parked in the semaphore when it tripped, the half-open probe, and the merges must
 * still run on the free pair — a demotion must never promote them to the priced model the cap
 * already spent. */
function installFallbackConfig(a: BudgetFallbackViewInput, fromKey: string): void {
  const { state, config: liveConfig, providers, catalog, accounts, priceResolved, reached } = a;
  if (reached && (state.from !== liveConfig || state.fromKey !== fromKey)) {
    state.from = liveConfig;
    state.fromKey = fromKey;
    // At the cap only free seams are available (a subscription claude seam is free money), so
    // every role/reviewer override that resolves to a priced seam drops to the fallback pair.
    const available = (seam: { agent?: string; provider?: string; model?: string }) =>
      seamFree(providers, seam, accounts, catalog);
    state.fallbackConfig = applyFallbackModel(liveConfig, priceResolved, available);
  }
}

/** The tiers `applyFallbackModel` moved at the cap: those whose own seam fails the `available`
 * test above (a priced seam under a spent cap). Feeds the `chain` block's `moved` set. */
function deriveMovedTiers(a: BudgetFallbackViewInput): Set<ModelTier> {
  const { config: liveConfig, providers, accounts, catalog, reached } = a;
  const movedTiers = new Set<ModelTier>();
  for (const tier of MODEL_TIERS) {
    const seam = withModelOverrides(liveConfig, tier, {});
    if (reached && !seamFree(providers, seam, accounts, catalog)) movedTiers.add(tier);
  }
  return movedTiers;
}

/** Derive the fallback view for one poll from the verdict half's already-resolved inputs
 * (`priceResolved`, `servingResolved`, `chainPairs`, `pairNames`) and the `reached` flag and
 * the shared reads (`state`, `config`, `accounts`, `providers`, `catalog`), writing the
 * cross-poll view state (`from`/`fromKey`/`fallbackConfig`) and returning the view fields
 * pollBudgetGate hands back. The director always keeps the live config (part 5d/6): with the
 * window move gone no input moves it, so `directorConfig` is the live config by construction. */
export function budgetFallbackView(a: BudgetFallbackViewInput): BudgetFallbackView {
  const { state, config: liveConfig, reached, priceResolved } = a;
  const onFallback = reached && a.pairNames.length > 0;
  // The resolved pairs are part of the key: a priced step crossing its own daily cap changes
  // the resolution without a config or window change, and the view must follow it.
  const resolvedKey = MODEL_TIERS.map((t) => {
    const rp = priceResolved[t].pair;
    return rp ? modelPairName(rp) : "-";
  }).join(",");
  const fromKey = `${reached ? "c" : ""}|${resolvedKey}`;
  installFallbackConfig(a, fromKey);
  const movedTiers = deriveMovedTiers(a);
  const chain = chainInfo({
    config: liveConfig,
    resolved: a.servingResolved,
    moved: movedTiers,
    breakers: state.breakers,
    states: a.states,
    now: a.now,
    accounts: a.accounts,
    isPriced: (p) => !piPairFree(a.providers, p, a.accounts, a.catalog),
  });
  return {
    onFallback,
    chain,
    roleConfig: onFallback ? state.fallbackConfig : liveConfig,
    pairs: distinctPairs(priceResolved, a.chainPairs),
    directorConfig: liveConfig,
  };
}

/** The `chain` block: for each tier this poll moved off its primary, the step it runs on and
 * why the position before it cannot run (plans/fallback-chain.md "Events and surfaces").
 * `moved` names the tiers the poll moved; a tier the gate pauses (`pair: null`) gets no entry.
 * The reason is read from the position just before the active step — the previous chain step,
 * or the tier's primary at step 0 — in the order demoted, step-cap, overage, cap. */
export function chainInfo(a: {
  config: TumwaterConfig;
  resolved: TierFallbackMap;
  moved: ReadonlySet<ModelTier>;
  breakers: FallbackBreakerMap;
  states: Pick<RunnerState, "dayStamp" | "dayCostByPair">[];
  now: number;
  accounts: (backend: string) => SubscriptionAccount | null;
  isPriced: (p: FallbackModelConfig) => boolean;
}): Partial<Record<ModelTier, ChainTierInfo>> {
  const out: Partial<Record<ModelTier, ChainTierInfo>> = {};
  const steps = tierChainSteps(a.config);
  const midnight = dayAt(-1, new Date(a.now)).getTime();
  for (const tier of MODEL_TIERS) {
    const r = a.resolved[tier];
    if (!a.moved.has(tier) || r.pair === null) continue;
    const position = movedTierPosition(steps, tier, r);
    const info: ChainTierInfo = {
      pair: modelPairName(r.pair),
      step: position.step,
      of: position.of,
      ...movedTierReason(a, position.prior, position.priorName, midnight),
    };
    Object.assign(info, movedTierSpend(a, r.pair));
    out[tier] = info;
  }
  return out;
}

/** The step a moved tier runs on and the pair just before it: the tier's own chain steps
 * (`steps.filter((s) => s.tier === (r.from ?? tier))`) resolved to their pairs, positioned at
 * `r.step ?? 0`, with the previous step's pair (or null at step 0). Answers "which step does
 * this moved tier run on, and which pair precedes it?" (plans/fallback-chain.md "Events and
 * surfaces"). */
function movedTierPosition(
  steps: ReturnType<typeof tierChainSteps>,
  tier: ModelTier,
  r: TierFallbackMap[ModelTier],
): { step: number; of: number; prior: FallbackModelConfig | null; priorName: string } {
  const own = steps.filter((s) => s.tier === (r.from ?? tier)).map((s) => s.pair);
  const idx = r.step ?? 0;
  const prior = idx > 0 ? own[idx - 1]! : null;
  return { step: idx + 1, of: own.length, prior, priorName: prior ? modelPairName(prior) : "" };
}

/** Why the position before the active step cannot run, in INV-BN1's fixed order (demoted,
 * step-cap, overage, cap). A demoted or overage result carries no `returnsAt`; a step-cap or
 * cap result pins it to `midnight` (INV-BN2: local midnight only for step-cap and cap).
 * Answers "why can't the position before the active step run, and when does it come back?". */
function movedTierReason(
  a: Parameters<typeof chainInfo>[0],
  prior: FallbackModelConfig | null,
  priorName: string,
  midnight: number,
): { reason: ChainTierInfo["reason"]; returnsAt?: number } {
  if (prior && a.breakers[priorName] !== undefined && !fallbackServingPair(a.breakers, priorName)) {
    return { reason: "demoted" };
  }
  if (prior?.maxDailyCostUsd !== undefined && pairDailyCost(a.states, priorName, a.now) >= prior.maxDailyCostUsd) {
    return { reason: "step-cap", returnsAt: midnight };
  }
  if (
    prior &&
    subscriptionBackendOf(prior, a.accounts) !== null &&
    prior.extraUsage &&
    a.accounts("claude") &&
    claudeOverageRefused(a.accounts("claude")!)
  ) {
    return { reason: "overage" };
  }
  return { reason: "cap", returnsAt: midnight };
}

/** What the active step has spent against its own cap: both keys absent unless the step is a
 * priced capped one (INV-BN2). Answers "what has the active step spent against its cap?". */
function movedTierSpend(
  a: Parameters<typeof chainInfo>[0],
  pair: FallbackModelConfig,
): Partial<Pick<ChainTierInfo, "spentUsd" | "capUsd">> {
  if (pair.maxDailyCostUsd === undefined || !a.isPriced(pair)) return {};
  return { spentUsd: pairDailyCost(a.states, modelPairName(pair), a.now), capUsd: pair.maxDailyCostUsd };
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
