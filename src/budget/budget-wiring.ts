/** The budget gate's wiring half (src/gates/budget-gates.ts owns the reads and the view
 * derivation, src/budget/fallback-breaker.ts the breakers; this module is
 * src/budget/budget-wiring.ts): the demotions publish, the
 * `fallback_switched` event, the per-runner config/cap flag assignment, the cap-reopen /
 * subscription-window hand-back (part 5c/8, part 2e/9), and the per-tier budget pause subject
 * sets. Moved out of src/gates/gate-polls.ts
 * so the whole budget concern lives under src/budget and the orchestrator's poll keeps only
 * the call. Mutates the `RoleRunner`s in place (`config`,
 * `handBackRun`) and the budget state's `prevChain`; returns nothing, because the block
 * reassigns no `pollTeamGates` local. */
import type {
  TumwaterConfig,
  FallbackModelConfig,
  ModelTier,
} from "../config/config-schema.js";
import { MODEL_TIERS } from "../config/config-schema.js";
import type { TierFallbackMap } from "../config/config-fallbacks.js";
import type { ChainTierInfo, OrchestratorInfo } from "../team/orchestrator-info.js";
import { publishInfoFields } from "../team/orchestrator-info.js";
import type { RoleRunner } from "../runner/runner.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { SubscriptionAccount } from "../agent/subscription-account.js";
import { fallbackDemotion, type FallbackDemotion } from "./fallback-breaker.js";
import {
  gateRoleConfig,
  runOnPair,
  subscriptionBackendOf,
  type BudgetGateState,
} from "../gates/budget-gates.js";
import { configForRole, roleSeamTier, withModelOverrides } from "../config/config-views.js";

/** The `pollBudgetGate` return fields this wiring reads (`spentUsd`/`capUsd` build the info
 * publish's `budget` pair). */
interface BudgetGateWiringView {
  roleConfig: TumwaterConfig;
  directorConfig: TumwaterConfig;
  onFallback: boolean;
  resumed: boolean;
  windowResumedBackends: readonly string[];
  windowTiers: Partial<Record<ModelTier, string>>;
  pairs: FallbackModelConfig[];
  priceResolved: TierFallbackMap;
  budgetActive: boolean;
  chain: Partial<Record<ModelTier, ChainTierInfo>>;
  spentUsd: number;
  capUsd: number;
}

interface BudgetGateWiringInput {
  root: string;
  /** Mutated in place: `config` every poll, `handBackRun` on a
   * reopen. */
  runners: readonly RoleRunner[];
  liveConfig: TumwaterConfig;
  info: OrchestratorInfo;
  accounts: (backend: string) => SubscriptionAccount | null;
  /** `states.budget` — the `breakers`/`engaged`/`prevChain` the publish and switch event
   * read and write. */
  budget: BudgetGateState;
  view: BudgetGateWiringView;
}

function publishBudgetWiring(
  root: string,
  info: OrchestratorInfo,
  budget: BudgetGateState,
  view: BudgetGateWiringView,
): void {
  // Publish what observers cannot derive themselves: every pair's demotion — a per-tier
  // fallback can demote a pair the legacy single `fallback` never names, and a dashboard that
  // only sees the engaged pair's verdict would show a tier's roles running while the
  // scheduler holds them (part 5c/8) — plus the engaged pair's own (the legacy
  // `fallbackDemoted` field, what `tumwater doctor` and the failure digest read) and the
  // gate's own spend/cap pair — summed over the runners' live states, which every
  // persisted-file reader lags by the in-flight runs' charges. Both rewritten only when they
  // change, like the build status; the exit removes the whole file, so no stale pair survives
  // a stop.
  const demotions: Record<string, FallbackDemotion> = {};
  for (const [name, b] of Object.entries(budget.breakers)) {
    const d = fallbackDemotion(b);
    if (d) demotions[name] = d;
  }
  const engagedDemotion = budget.engaged !== null ? demotions[budget.engaged] : undefined;
  const spend = { spentUsd: view.spentUsd, capUsd: view.capUsd };
  publishInfoFields(root, info, [
    ["fallbackDemotions", demotions],
    ["fallbackDemoted", engagedDemotion],
    ["budget", spend],
    ["chain", Object.keys(view.chain).length > 0 ? view.chain : undefined],
  ]);
  // One fallback_switched per poll in which a tier's pair or step changed (a return to the
  // primary reads `to: null`, reason "available").
  const switched: Record<string, { from: string | null; to: string | null; reason: string }> = {};
  const prevChain = budget.prevChain;
  for (const tier of MODEL_TIERS) {
    const was = prevChain[tier];
    const cur = view.chain[tier];
    if (was?.pair === cur?.pair && was?.step === cur?.step) continue;
    switched[tier] = {
      from: was?.pair ?? null,
      to: cur?.pair ?? null,
      reason: cur?.reason ?? "available",
    };
  }
  if (Object.keys(switched).length > 0)
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "fallback_switched",
      tiers: switched,
    });
  budget.prevChain = view.chain;
}

function assignRunnerBudgetConfig(
  runners: readonly RoleRunner[],
  liveConfig: TumwaterConfig,
  view: BudgetGateWiringView,
): void {
  // The director keeps the live config — an explicit human prompt outranks the
  // autonomous-spend cap (gateRoleConfig). Assigned every poll (not only on transitions)
  // so a runner created mid-gate, or one left behind by a broken-file poll that skipped
  // the reload, can never run on the wrong model.
  for (const r of runners) {
    r.config = gateRoleConfig(r.role, liveConfig, view.roleConfig, view.directorConfig);
  }
}

function handBackFallbackRuns(
  root: string,
  runners: readonly RoleRunner[],
  liveConfig: TumwaterConfig,
  accounts: (backend: string) => SubscriptionAccount | null,
  view: BudgetGateWiringView,
): void {
  // The budget reopened: a run that started on a fallback pair keeps it until it ends, so hand
  // those runs back — abort them resumably (session and worktree edits kept) and let their next
  // run continue the same session on the primary, whose config the assignment above already
  // installed (PLANS.md 2026-09-30). Per-tier fallbacks put different roles on different pairs
  // (part 5c/8), so the match runs over EVERY pair the price-based resolution hands out, not only
  // one. A run started on the primary keeps running, the director is exempt, and the merges (the
  // slot's own runs) are untouched. One event per pair names who was handed back, so the resulting
  // aborted runs read as the budget reopening, not as unexplained failures. The subscription
  // window reset (below the cap): the same hand-back for the pairs the window move used. A window
  // that resets while the cap still holds hands back nothing.
  const handBack = view.resumed || (view.windowResumedBackends.length > 0 && !view.budgetActive);
  // The window handback names the backend whose window resumed (the entry's goal) — not the
  // handed-back pair's own backend: for claude-only the fallback pair carries no backend (it would
  // read undefined), and with two subscription backends it would name the opposite one. A pair
  // belongs to those resumed backends whose tiers' price-resolved pair it is.
  const resumedBackendSet = new Set<string>(view.windowResumedBackends);
  const resumedBackendForPair = (leftPair: FallbackModelConfig): string | undefined => {
    for (const tier of MODEL_TIERS) {
      const p = view.priceResolved[tier]?.pair;
      if (p && p.provider === leftPair.provider && p.model === leftPair.model) {
        const b = subscriptionBackendOf(withModelOverrides(liveConfig, tier, {}), accounts);
        if (b !== null && resumedBackendSet.has(b)) return b;
      }
    }
    return undefined;
  };
  if (handBack && view.pairs.length > 0) {
    // A cap reopen while the window is still used up leaves the window's tiers on their
    // fallback pairs: handing those runs back would abort them to restart on the same pair.
    const stillMoved = (Object.keys(view.windowTiers) as (keyof typeof view.windowTiers)[]).flatMap(
      (t) => {
        const p = view.priceResolved[t].pair;
        return p ? [p] : [];
      },
    );
    for (const leftPair of view.pairs) {
      if (
        stillMoved.some((p) => p.provider === leftPair.provider && p.model === leftPair.model)
      )
        continue;
      const matching = runners.filter(
        (r) => r.role !== DIRECTOR_ROLE && runOnPair(r.runModelPair(), leftPair),
      );
      if (matching.length > 0) {
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "budget_handback",
          roles: matching.map((r) => r.role),
          provider: leftPair.provider,
          model: leftPair.model,
          ...(view.resumed
            ? {}
            : { reason: "window", backend: resumedBackendForPair(leftPair) }),
        });
        for (const r of matching) r.handBackRun();
      }
    }
  }
}

/** Perform the budget gate's wiring for one poll, exactly as `pollTeamGates` did inline:
 * publish the demotions and the switch/serve info fields, log the one `fallback_switched`
 * transition event per tier change, assign every runner's config and cap flag, and hand
 * in-flight fallback runs back on a cap reopen or window reset. */
export function applyBudgetGateWiring(input: BudgetGateWiringInput): void {
  const { root, runners, liveConfig, info, accounts, budget, view } = input;
  publishBudgetWiring(root, info, budget, view);
  assignRunnerBudgetConfig(runners, liveConfig, view);
  handBackFallbackRuns(root, runners, liveConfig, accounts, view);
}

/** The inputs `budgetPausedSubjects` reads: the poll's runners and the view fields the
 * per-tier budget pause (part 5c/8) loop folded in `pollTeamGates`. */
interface BudgetPausedSubjectsInput {
  /** Mutated in place per runner, matching `pollTeamGates`'s loop. */
  runners: readonly RoleRunner[];
  liveConfig: TumwaterConfig;
  accounts: (backend: string) => SubscriptionAccount | null;
  /** Whether the daily cap is reached — the pause's gate half (`budgetActive`). */
  budgetActive: boolean;
  /** The tiers' free-pair resolution the gate's value came from (`servingResolved`): a tier
   * resolved to `null` for its pair starts no new runs. */
  servingResolved: TierFallbackMap;
  /** The moved tiers, keyed by tier (a used-up window): a role on one whose own backend owns
   * the out window is moved off its pair. */
  windowTiers: Partial<Record<ModelTier, string>>;
}

/** The per-tier budget pause subject sets (part 5c/8), computed exactly as `pollTeamGates` did
 * inline: `budgetPausedRoles` holds every role whose model tier resolved to no usable free pair
 * while the cap is reached, and `windowMovedRoles` the role whose own subscription backend owns
 * a used-up window's moved tier. The director is exempt (as under every autonomous gate), a role
 * below the cap is held only when it was window-moved, and the demoted pair's probe pierces the
 * set for its own tier's roles only — probeRoles in the orchestrator's scheduling pass. */
export function budgetPausedSubjects(input: BudgetPausedSubjectsInput): {
  budgetPausedRoles: ReadonlySet<string>;
  windowMovedRoles: ReadonlySet<string>;
} {
  const { runners, liveConfig, accounts, budgetActive, servingResolved, windowTiers } = input;
  const budgetPausedRoles = new Set<string>();
  const windowMovedRoles = new Set<string>();
  const movedTiers = Object.keys(windowTiers);
  // The backend whose used-up window moved a given tier: the tier's own seam's backend — the same
  // read budget-gates made to put it in `windowTiers`. A role on a moved tier whose own backend is
  // DIFFERENT (a healthy backend riding the same tier) keeps its pair: only the role whose own
  // backend owns the out window is moved.
  const tierMovedBackend = (tier: ModelTier) =>
    subscriptionBackendOf(withModelOverrides(liveConfig, tier, {}), accounts);
  for (const r of runners) {
    if (r.role === DIRECTOR_ROLE) continue;
    const tier = roleSeamTier(liveConfig, r.role);
    // A role pinned to the moved tier's own subscription backend keeps it through the window move
    // (it is not on a pair); a role on the same tier pinning a healthy backend does not.
    if (
      movedTiers.includes(tier) &&
      subscriptionBackendOf(configForRole(liveConfig, r.role), accounts) === tierMovedBackend(tier)
    )
      windowMovedRoles.add(r.role);
    // Below the cap only a window-moved role can sit on a demoted fallback.
    if (!budgetActive && !windowMovedRoles.has(r.role)) continue;
    if (servingResolved[tier].pair === null) budgetPausedRoles.add(r.role);
  }
  return { budgetPausedRoles, windowMovedRoles };
}
