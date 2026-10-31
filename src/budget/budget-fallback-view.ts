/** The fallback config view the budget gate derives each poll, split out of pollBudgetGate's
 * event-and-verdict half (src/gates/budget-gates.ts) so the two halves each have a plain
 * function boundary and their own tests (the same split stage-path-checks.ts made of
 * stage-check.ts). This module owns everything pollBudgetGate does from its `onFallback` seam
 * through the end of the function: the seam/backends walk, the motion key (`resolvedKey`,
 * `fromKey`), the fallback view derivation (`fallbackConfig`), `chainInfo`, and the `pairs`
 * handback list. It no longer moves any tier for a used-up subscription window (part 5d/6): a
 * spent `maxDailyCostUsd` moves every priced tier to its free seam, and, at any spend, a tier
 * whose own primary failed its model check moves to a verified step of its chain
 * (plans/model-check.md "Fallback"). Its one entry reads the inputs pollBudgetGate's first half
 * already resolved and returns the view fields `BudgetGatePoll` carries, so pollBudgetGate keeps
 * its call signature and src/gates/gate-polls.ts's destructure of it is unchanged. The plan
 * references the moved comments carry (part 5b/8, part 5c/8, 6a/7) hold here. */

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
import { seamPairName, withModelOverrides } from "../config/config-views.js";
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
 * under, the director's config, the chain figures, the handback pairs, and the tiers the model
 * check moved. The gate, spend/cap, resume, and the resolved maps stay in pollBudgetGate's
 * verdict half. */
interface BudgetFallbackView {
  onFallback: boolean;
  roleConfig: TumwaterConfig;
  pairs: FallbackModelConfig[];
  directorConfig: TumwaterConfig;
  chain: Partial<Record<ModelTier, ChainTierInfo>>;
  checkMoved: ReadonlySet<ModelTier>;
}

/** The inputs `budgetFallbackView` and its phase helpers read: the verdict half's
 * already-resolved inputs (`priceResolved`, `servingResolved`, `chainPairs`, `pairNames`), the
 * `reached` flag, the shared reads (`state`, `config`, `accounts`, `providers`, `catalog`), and
 * the model check's verdicts with the verified-only resolution (`checkResolved`), the cap
 * view's check-aware resolution (`checkFreeResolved`), all absent while the check is off. */
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
  checkResolved?: TierFallbackMap;
  /** The cap view's check-aware resolution (plans/model-check.md "Fallback"): the price
   * resolution stepped past the pairs that failed their model check, so the installed config
   * of a cap-moved tier lands on the first free step that answered, exactly as the `chain`
   * block and the pause set resolve it. Unlike the serving resolution it never reads the
   * breaker, so a breaker-demoted cap pair stays installed for its half-open probe and a run
   * parked on it. Absent while the check is off, when `priceResolved` is the cap's view. */
  checkFreeResolved?: TierFallbackMap;
  checkFailed?: (pair: string) => boolean;
  checkVerified?: (pair: string) => boolean;
  chainPairs: FallbackModelConfig[];
  pairNames: string[];
  reached: boolean;
}

/** The pair a tier's own primary resolves to under the live config — the name the model check
 * keys it by. */
function tierPrimaryPair(config: TumwaterConfig, tier: ModelTier): string {
  return seamPairName(withModelOverrides(config, tier, {}));
}

/** `base` with each check-moved tier's entry replaced by its verified step. */
function withCheckMoves(
  base: TierFallbackMap,
  checkResolved: TierFallbackMap | undefined,
  checkMoved: ReadonlySet<ModelTier>,
): TierFallbackMap {
  const out = { ...base };
  for (const tier of checkMoved) out[tier] = checkResolved![tier];
  return out;
}

/** Install `state.fallbackConfig` when the fallback changed the view key: at the cap, the free
 * pair installed top-level and every per-role/reviewer model override dropped, so no seam can
 * reach a priced model. A breaker-demoted fallback keeps the view too: its gate is `paused`,
 * but a run parked in the semaphore when it tripped, the half-open probe, and the merges must
 * still run on the free pair — a demotion must never promote them to the priced model the cap
 * already spent. A tier the model check moved (deriveCheckMovedTiers) installs its verified
 * step at any spend, and only its own primary seams move: every other tier, and a role or
 * reviewer pinned to some other pair, keeps its model. */
function installFallbackConfig(a: BudgetFallbackViewInput, fromKey: string, checkMoved: ReadonlySet<ModelTier>): void {
  const { state, config: liveConfig, providers, catalog, accounts, priceResolved, reached } = a;
  if ((reached || checkMoved.size > 0) && (state.from !== liveConfig || state.fromKey !== fromKey)) {
    state.from = liveConfig;
    state.fromKey = fromKey;
    const primaries = new Map([...checkMoved].map((t) => [t, tierPrimaryPair(liveConfig, t)]));
    const checkKeeps = (seam: { agent?: string; provider?: string; model?: string }, tier: ModelTier) =>
      primaries.get(tier) !== seamPairName(seam);
    // At the cap only free seams are available (a subscription claude seam is free money), so
    // every role/reviewer override that resolves to a priced seam drops to the fallback pair.
    const keeps = reached
      ? (seam: { agent?: string; provider?: string; model?: string }, tier: ModelTier) =>
          seamFree(providers, seam, accounts, catalog) && checkKeeps(seam, tier)
      : checkKeeps;
    // The cap's base view is the check-aware resolution while the check is on (a cap-moved
    // tier's failed step stays out of the config its roles run under), else the price view.
    state.fallbackConfig = applyFallbackModel(
      liveConfig,
      withCheckMoves(a.checkFreeResolved ?? priceResolved, a.checkResolved, checkMoved),
      keeps,
    );
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

/** The tiers the model check moves (plans/model-check.md "Fallback"): a tier still on its own
 * primary — every tier below the cap, at it only one the cap leaves in place (`capMoved` holds
 * the rest) — whose primary failed its check while the tier's verified-only resolution has a
 * step to run on. A tier whose primary failed with no verified step stays held on it. */
function deriveCheckMovedTiers(a: BudgetFallbackViewInput, capMoved: ReadonlySet<ModelTier>): Set<ModelTier> {
  const moved = new Set<ModelTier>();
  if (a.checkResolved === undefined || a.checkFailed === undefined) return moved;
  for (const tier of MODEL_TIERS) {
    if (capMoved.has(tier) || a.checkResolved[tier].pair === null) continue;
    if (a.checkFailed(tierPrimaryPair(a.config, tier))) moved.add(tier);
  }
  return moved;
}

/** Derive the fallback view for one poll from the verdict half's already-resolved inputs
 * (`priceResolved`, `servingResolved`, `checkResolved`, `checkFreeResolved`, `chainPairs`,
 * `pairNames`) and the `reached` flag and the shared reads (`state`, `config`, `accounts`,
 * `providers`, `catalog`), writing the cross-poll view state (`from`/`fromKey`/
 * `fallbackConfig`) and returning the view
 * fields pollBudgetGate hands back. The view is installed at the cap, and below it while a tier
 * the model check moved runs on its verified step; `onFallback` (the image-reroute regime) stays
 * the cap's alone. The director always keeps the live config (part 5d/6): with the window move
 * gone no input moves it, so `directorConfig` is the live config by construction. */
export function budgetFallbackView(a: BudgetFallbackViewInput): BudgetFallbackView {
  const { state, config: liveConfig, reached, priceResolved } = a;
  const onFallback = reached && a.pairNames.length > 0;
  const movedTiers = deriveMovedTiers(a);
  const checkMoved = deriveCheckMovedTiers(a, movedTiers);
  // The resolved pairs are part of the key: a priced step crossing its own daily cap changes
  // the resolution without a config or window change, and the view must follow it. So are the
  // model check's moves, appended only while there are some.
  const resolvedKey = MODEL_TIERS.map((t) => {
    const rp = priceResolved[t].pair;
    return rp ? modelPairName(rp) : "-";
  }).join(",");
  const checkKey = MODEL_TIERS.map((t) => (checkMoved.has(t) ? modelPairName(a.checkResolved![t].pair) : "-")).join(",");
  // The cap view's check-aware pairs follow the price pairs when present: a check verdict
  // failing or clearing a step changes the installed config without a price change, so the
  // view must re-install on the next poll. Absent while the check is off, so the key is
  // unchanged then.
  const checkFreeKey = a.checkFreeResolved
    ? "|" +
      MODEL_TIERS.map((t) => {
        const rp = a.checkFreeResolved![t].pair;
        return rp ? modelPairName(rp) : "-";
      }).join(",")
    : "";
  const fromKey = `${reached ? "c" : ""}|${resolvedKey}${checkMoved.size > 0 ? `|${checkKey}` : ""}${checkFreeKey}`;
  installFallbackConfig(a, fromKey, checkMoved);
  const chain = chainInfo({
    config: liveConfig,
    resolved: withCheckMoves(a.servingResolved, a.checkResolved, checkMoved),
    moved: new Set([...movedTiers, ...checkMoved]),
    checkMoved,
    ...(a.checkFailed !== undefined ? { modelCheckFailed: a.checkFailed } : {}),
    ...(a.checkVerified !== undefined ? { modelCheckVerified: a.checkVerified } : {}),
    breakers: state.breakers,
    states: a.states,
    now: a.now,
    accounts: a.accounts,
    isPriced: (p) => !piPairFree(a.providers, p, a.accounts, a.catalog),
  });
  return {
    onFallback,
    chain,
    roleConfig: onFallback || checkMoved.size > 0 ? state.fallbackConfig : liveConfig,
    pairs: distinctPairs(priceResolved, a.chainPairs),
    directorConfig: liveConfig,
    checkMoved,
  };
}

/** The `chain` block: for each tier this poll moved off its primary, the step it runs on and
 * why the position before it cannot run (plans/fallback-chain.md "Events and surfaces").
 * `moved` names the tiers the poll moved; a tier the gate pauses (`pair: null`) gets no entry.
 * The reason is read from the position just before the active step — the previous chain step,
 * or the tier's primary at step 0 — in the order demoted, step-cap, overage, model-check, cap.
 * `checkMoved` names the moved tiers whose primary failed its model check rather than the cap
 * moving them; the model check's verdicts say whether a previous step failed (or, for such a
 * tier, which moves only to verified steps, has not answered yet). */
export function chainInfo(a: {
  config: TumwaterConfig;
  resolved: TierFallbackMap;
  moved: ReadonlySet<ModelTier>;
  checkMoved?: ReadonlySet<ModelTier>;
  modelCheckFailed?: (pair: string) => boolean;
  modelCheckVerified?: (pair: string) => boolean;
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
      ...movedTierReason(a, tier, position.prior, position.priorName, midnight),
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
 * step-cap, overage, model-check, cap). A demoted, overage or model-check result carries no
 * `returnsAt` (a model check lifts when a re-check answers, not at a clock time); a step-cap or
 * cap result pins it to `midnight` (INV-BN2: local midnight only for step-cap and cap).
 * Answers "why can't the position before the active step run, and when does it come back?". */
function movedTierReason(
  a: Parameters<typeof chainInfo>[0],
  tier: ModelTier,
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
  const checkMoved = a.checkMoved?.has(tier) === true;
  const priorChecked =
    prior === null
      ? checkMoved
      : a.modelCheckFailed?.(priorName) === true || (checkMoved && a.modelCheckVerified?.(priorName) !== true);
  if (priorChecked) return { reason: "model-check" };
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
