import { budgetReached, teamDailyCost, modelPairName, projectCapHit } from "../budget/budget.js";
import { roleCapVerdicts } from "../gates/role-cap-gates.js";
import {
  configForRole,
  resolverConfig,
  reviewConfig,
  roleSeamTier,
} from "../config/config-views.js";
import { resolveTierFallbacks, tierFallbackLabels, tiersResolveDistinctPairs } from "../config/config-fallbacks.js";
import { enabledRoleIds } from "../config/config.js";
import { fallbackModelFree, piPairFree, readPiProviders, seamFree, teamModelsFree } from "../pi/pi-models.js";
import { readOpencodeCache, type OpencodeCatalogCache } from "../agent/opencode/opencode-catalog.js";
import { backendDisplayName } from "../agent/backend-traits.js";
import {
  compareWindowEntries,
  readAccount,
  windowEntries,
  type SubscriptionAccount,
  type SubscriptionWindowBlock,
} from "../agent/subscription-account.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { OrchestratorInfo } from "../team/team-orchestrator-info.js";
import type { StatusRoleRow } from "./status-roles.js";

type PiProviders = ReturnType<typeof readPiProviders>;

/** The spend/billing-shaped slice of a status snapshot: the daily budget object, one
 * subscription-window block per subscription backend in use plus the team-global free-ness
 * answer, and the two per-role pause sets the budget verdicts drive. */
interface BudgetSlice {
  budget: {
    spentUsd: number;
    capUsd: number;
    capHitAt: number | null;
    free: boolean;
    fallback: { backend?: string; provider?: string; model?: string } | null;
    tiers?: Partial<Record<string, string>> | null;
  };
  subscriptionWindows: SubscriptionWindowBlock[];
  /** True when every paying seam is a subscription seam — the windows replace the daily-spend
   * badge rather than just joining it (see StatusSnapshot.subscriptionWindows). */
  subscriptionOnly: boolean;
  budgetPausedRoles: string[];
  capPaused: string[];
}

/** The subscription-window blocks and the team-global free-ness answer for a poll (see
 * StatusSnapshot.subscriptionWindows / subscriptionOnly): one `SubscriptionWindowBlock` per
 * distinct non-`pi` subscription backend the enabled seams (roles, review, resolver) route to
 * whose `accounts(backend)` reads subscription billing with at least one window. `only` is true
 * exactly when every paying seam is free (judged by its own backend's account or pi pair
 * price), so the display knows whether the windows replace or merely join the daily spend. The
 * blocks sort most-constrained-first by the same comparator windowEntries uses for one
 * account's windows (then backend), so a team's tightest window always leads. For a claude-only
 * team this is one claude block whose fields match the old claudeWindow block's, aside from the
 * added backend/label. The reviewer and the strong-tier resolver are included, like
 * teamModelsFree, since they can spend. */
function windowBlocks(
  cfg: TumwaterConfig,
  providers: PiProviders,
  accounts: (backend: string) => SubscriptionAccount | null,
  catalog: OpencodeCatalogCache | null,
): { blocks: SubscriptionWindowBlock[]; only: boolean } {
  const seams = enabledRoleIds(cfg).map((role) => configForRole(cfg, role));
  if (cfg.review.enabled) seams.push(reviewConfig(cfg));
  if (seams.length > 0) seams.push(resolverConfig(cfg));
  const blocks: SubscriptionWindowBlock[] = [];
  for (const backend of new Set(
    seams.map((s) => s.agent).filter((b): b is string => b !== undefined && b !== "pi"),
  )) {
    const account = accounts(backend);
    if (account?.billing !== "subscription") continue;
    const windows = windowEntries(account);
    if (windows.length === 0) continue;
    const heldUntil =
      windows
        .filter(
          (w) => w.status === "rejected" && w.isUsingOverage !== true && typeof w.resetsAt === "number",
        )
        .reduce((max, w) => Math.max(max, w.resetsAt as number), 0) || null;
    blocks.push({ backend, label: backendDisplayName(backend), windows, primary: windows[0]!, heldUntil });
  }
  blocks.sort((a, b) => compareWindowEntries(a.primary, b.primary) || a.backend.localeCompare(b.backend));
  return { blocks, only: !seams.some((s) => !seamFree(providers, s, accounts, catalog)) };
}

/** The spend/billing block for a poll: the one materialized `spentUsd` (the scheduler's own
 * published figure while running — BUGS.md 2026-09-30 — the persisted states' sum otherwise)
 * that the budget object, the burn-rate projection and `free`/`fallback`/`tiers` all read;
 * the per-tier pause set (part 5c/8) and the per-role daily-cap set, each the gate's own
 * verdict over the same last-known-good config and one `now`. Owns the price-aware pair logic
 * (piPairFree, fallbackModelFree, teamModelsFree, resolveTierFallbacks) so it has one home:
 * models.json is read once (readPiProviders) and each subscription backend's account once
 * (readAccount, on the snapshot's own pinned `now`, via the per-poll memo), and every free-ness
 * verdict and the window blocks judge those same readings. The director is exempt from both
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
  // The subscription usage windows (part 3a/9): one block per subscription backend in use.
  const { blocks: subscriptionWindows, only: subscriptionOnly } = windowBlocks(cfg, providers, accounts, catalog);
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
    subscriptionWindows,
    subscriptionOnly,
    budgetPausedRoles,
    capPaused,
  };
}
