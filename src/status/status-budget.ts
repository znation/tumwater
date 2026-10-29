import { budgetReached, teamDailyCost, modelPairName, projectCapHit } from "../budget/budget.js";
import { roleCapVerdicts } from "../gates/role-cap-gates.js";
import { roleSeamTier } from "../config/config-views.js";
import { resolveTierFallbacks, tierFallbackLabels, tiersResolveDistinctPairs } from "../config/config-fallbacks.js";
import { fallbackModelFree, piPairFree, readPiProviders, teamModelsFree } from "../pi/pi-models.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { readAccount, type SubscriptionAccount } from "../agent/subscription-account.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { OrchestratorInfo } from "../team/team-orchestrator-info.js";
import type { StatusRoleRow } from "./status-roles.js";

/** The spend/billing-shaped slice of a status snapshot: the daily budget object, the
 * team-global free-ness answer, and the two per-role pause sets the budget verdicts drive. */
interface BudgetSlice {
  budget: {
    spentUsd: number;
    capUsd: number;
    capHitAt: number | null;
    free: boolean;
    fallback: { backend?: string; provider?: string; model?: string } | null;
    tiers?: Partial<Record<string, string>> | null;
  };
  budgetPausedRoles: string[];
  capPaused: string[];
}

/** The spend/billing block for a poll: the one materialized `spentUsd` (the scheduler's own
 * published figure while running — BUGS.md 2026-09-30 — the persisted states' sum otherwise)
 * that the budget object, the burn-rate projection and `free`/`fallback`/`tiers` all read;
 * the per-tier pause set (part 5c/8) and the per-role daily-cap set, each the gate's own
 * verdict over the same last-known-good config and one `now`. Owns the price-aware pair logic
 * (piPairFree, fallbackModelFree, teamModelsFree, resolveTierFallbacks) so it has one home:
 * models.json is read once (readPiProviders) and each subscription backend's account once
 * (readAccount, on the snapshot's own pinned `now`, via the per-poll memo), and every free-ness
 * verdict judges those same readings. The director is exempt from both
 * pause sets, exactly as the gates exempt it. */
export function collectBudget(
  root: string,
  cfg: TumwaterConfig,
  rows: StatusRoleRow[],
  roles: string[],
  running: boolean,
  info: OrchestratorInfo | null,
  modelsPath: string,
  now: number,
): BudgetSlice {
  // The running orchestrator's published gate figures (read once above, with the pid and the
  // demotion): the scheduler's own sum over its live runner states. Only while running — the
  // exit removes the info file, so a stale file beside a dead pid must not speak for a team
  // whose persisted files are final.
  const publishedSpend = running && info?.budget ? info.budget.spentUsd : null;
  // The one materialized spend the budget block renders and the burn-rate projection both
  // read — the scheduler's published figure while running, the persisted states' sum otherwise.
  const spentUsd = publishedSpend ?? teamDailyCost(rows, now);
  // The per-backend subscription accounts (part 3a/9), read lazily into a per-poll memo so a
  // backend in use is read once no matter how many free-ness verdicts and window blocks judge
  // it: today's one claude read for a claude-only team, plus one read per other backend in use.
  const accountReads = new Map<string, SubscriptionAccount | null>();
  const accounts = (backend: string): SubscriptionAccount | null => {
    let account = accountReads.get(backend);
    if (account === undefined) {
      account = readAccount(root, backend, now);
      accountReads.set(backend, account);
    }
    return account;
  };
  const budgetReachedNow = budgetReached({ spentUsd, capUsd: cfg.maxDailyCostUsd });
  const providers = readPiProviders(modelsPath);
  // The cached opencode models catalog (part 6b/7), seeded at the startup gate and read once per
  // poll so every free-ness verdict below prices opencode seams against the same snapshot.
  const catalog = readOpencodeCache(root);
  const publishedDemotions = info?.fallbackDemotions ?? {};
  const usable = (p: { provider?: string; model?: string }) =>
    piPairFree(providers, p, accounts, catalog) && !(modelPairName(p) in publishedDemotions);
  const servingResolved = resolveTierFallbacks(cfg, usable);
  // The per-tier budget pause set (part 5c/8): the same resolution the scheduler's gate folds,
  // over the SAME usable predicate an observer can re-derive — the price check, and the pair
  // not among the running orchestrator's published per-pair demotions. Computed only while the
  // cap is reached — the hold never stands under an open gate — and the director exempt.
  const budgetPausedRoles = budgetReachedNow
    ? roles.filter(
        (r) => r !== DIRECTOR_ROLE && servingResolved[roleSeamTier(cfg, r)].pair === null,
      )
    : [];
  const capPaused = [
    ...roleCapVerdicts(
      rows.map((l) => ({ role: l.role, state: l })),
      cfg.maxDailyCostUsdPerRole,
      now,
    ).values(),
  ]
    .filter((v) => v.over)
    .flatMap((v) => v.roleIds);
  return {
    budget: {
      spentUsd,
      capUsd: cfg.maxDailyCostUsd,
      // One projection per poll, from the same spend the field above renders: null exactly
      // when no forecast may be stated (no cap, no spend, cap reached, burn misses midnight).
      capHitAt: projectCapHit({ spentUsd, capUsd: cfg.maxDailyCostUsd }, now),
      free: teamModelsFree(cfg, modelsPath, accounts, catalog),
      // Null unless the gate could actually engage it (configured AND priced at zero AND not
      // demoted by the running orchestrator's breaker): a fallback the scheduler would refuse
      // must not be advertised as one that will save the team — and a demoted one is refused
      // until its probe serves, so the dashboards read `budget paused` exactly while the
      // scheduler is (BUGS.md 2026-09-20). The pair is the price-aware default tier's
      // resolution, so a map with no `default` entry names the pair the gate actually runs.
      fallback:
        fallbackModelFree(cfg, modelsPath, accounts, catalog) && !(running && info?.fallbackDemoted)
          ? (servingResolved.default.pair ?? null)
          : null,
      tiers:
        budgetReachedNow && tiersResolveDistinctPairs(servingResolved)
          ? tierFallbackLabels(servingResolved)
          : null,
    },
    budgetPausedRoles,
    capPaused,
  };
}
