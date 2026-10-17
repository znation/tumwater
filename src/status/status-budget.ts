// vocabulary: plain
import {
  claudeWindowEntries,
  readClaudeAccount,
  type ClaudeAccount,
  type ClaudeWindowEntry,
} from "../agent/claude/claude-account.js";
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
import { fallbackModelFree, teamModelsFree, piPairFree, readPiProviders } from "../pi/pi-models.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { OrchestratorInfo } from "../team/orchestrator-info.js";
import type { StatusLoopRow } from "./status-roles.js";

type PiProviders = ReturnType<typeof readPiProviders>;

/** The spend/billing-shaped slice of a status snapshot: the daily budget object, the claude
 * subscription window, and the two per-role pause sets the budget verdicts drive. */
interface BudgetSlice {
  budget: {
    spentUsd: number;
    capUsd: number;
    capHitAt: number | null;
    free: boolean;
    backend?: string;
    fallback: { provider?: string; model?: string } | null;
    tiers?: Partial<Record<string, string>> | null;
  };
  claudeWindow:
    | {
        windows: ClaudeWindowEntry[];
        primary: ClaudeWindowEntry;
        only: boolean;
        heldUntil: number | null;
      }
    | undefined;
  budgetPausedRoles: string[];
  capPaused: string[];
}

/** The claude subscription-window block for a poll (see StatusSnapshot.claudeWindow): absent
 * unless the account reads subscription billing with at least one window AND a resolved seam
 * routes to claude. `only` is the free-ness classification the display needs: every paying seam
 * is a subscription claude seam exactly when no other seam is priced — a pi seam judged by
 * piPairFree, any other backend's billing unseen so it counts as paying too. The reviewer and
 * the strong-tier resolver are included, like teamModelsFree, since they can spend. The
 * account is the poll's single readClaudeAccount result, so the window and every piPairFree
 * verdict judge the same reading. */
function claudeWindowBlock(
  cfg: TumwaterConfig,
  providers: PiProviders,
  account: ClaudeAccount | null,
): BudgetSlice["claudeWindow"] {
  if (account?.billing !== "subscription") return undefined;
  const windows = claudeWindowEntries(account);
  if (windows.length === 0) return undefined;
  const seams = enabledRoleIds(cfg).map((role) => configForRole(cfg, role));
  if (cfg.review.enabled) seams.push(reviewConfig(cfg));
  if (seams.length > 0) seams.push(resolverConfig(cfg));
  if (!seams.some((s) => s.agent === "claude")) return undefined;
  const priced = seams.some((s) => {
    if (s.agent === undefined || s.agent === "pi") return !piPairFree(providers, s.provider, s.model);
    return s.agent !== "claude"; // a backend the account cannot bill is never subscription-paid
  });
  const heldUntil =
    windows
      .filter((w) => w.status === "rejected" && w.isUsingOverage !== true && typeof w.resetsAt === "number")
      .reduce((max, w) => Math.max(max, w.resetsAt as number), 0) || null;
  return { windows, primary: windows[0]!, only: !priced, heldUntil };
}

/** The spend/billing block for a poll: the one materialized `spentUsd` (the scheduler's own
 * published figure while running — BUGS.md 2026-09-30 — the persisted states' sum otherwise)
 * that the budget object, the burn-rate projection and `free`/`fallback`/`tiers` all read;
 * the per-tier pause set (part 5c/8) and the per-role daily-cap set, each the gate's own
 * verdict over the same last-known-good config and one `now`. Owns the price-aware pair logic
 * (piPairFree, fallbackModelFree, teamModelsFree, resolveTierFallbacks) so it has one home:
 * models.json is read once (readPiProviders) and the claude account once (readClaudeAccount,
 * on the snapshot's own pinned `now`), and every free-ness verdict and the window judge that
 * single reading. The director is exempt from both pause sets, exactly as the gates exempt it. */
export function collectBudget(
  root: string,
  cfg: TumwaterConfig,
  loops: StatusLoopRow[],
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
  const spentUsd = publishedSpend ?? teamDailyCost(loops, now);
  // The persisted billing answer (6a/7), read once for every free-ness verdict below: a
  // subscription claude seam is free, so the badge and the pause set judge it as such.
  const account = readClaudeAccount(root, now);
  const budgetReachedNow = budgetReached({ spentUsd, capUsd: cfg.maxDailyCostUsd });
  const providers = readPiProviders(modelsPath);
  const publishedDemotions = info?.fallbackDemotions ?? {};
  const usable = (p: { provider?: string; model?: string }) =>
    piPairFree(providers, p.provider, p.model, account) && !(modelPairName(p) in publishedDemotions);
  const servingResolved = resolveTierFallbacks(cfg, usable);
  // The subscription usage window (part 6d/7): one account read per poll serves the block.
  const claudeWindow = claudeWindowBlock(cfg, providers, account);
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
      loops.map((l) => ({ role: l.role, state: l })),
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
      free: teamModelsFree(cfg, modelsPath, account),
      backend: cfg.backend ?? "pi",
      // Null unless the gate could actually engage it (configured AND priced at zero AND not
      // demoted by the running orchestrator's breaker): a fallback the scheduler would refuse
      // must not be advertised as one that will save the team — and a demoted one is refused
      // until its probe serves, so the dashboards read `budget paused` exactly while the
      // scheduler is (BUGS.md 2026-09-20). The pair is the price-aware default tier's
      // resolution, so a map with no `default` entry names the pair the gate actually runs.
      fallback:
        fallbackModelFree(cfg, modelsPath, account) && !(running && info?.fallbackDemoted)
          ? (servingResolved.default.pair ?? null)
          : null,
      tiers:
        budgetReachedNow && tiersResolveDistinctPairs(servingResolved)
          ? tierFallbackLabels(servingResolved)
          : null,
    },
    claudeWindow,
    budgetPausedRoles,
    capPaused,
  };
}
