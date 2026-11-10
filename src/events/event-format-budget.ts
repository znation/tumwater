import type { HarnessEvent } from "./events.js";
import { budgetPhrase, rolesPhrase } from "../text/phrases.js";
import { usd } from "../text/format.js";
import { textOr } from "../text/text.js";
import { finiteNumber, isJsonObject } from "../files/json-object.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { mostByPhrase, providerModelPair } from "./event-format-fragments.js";

/** The daily-cap line builders: budget_warning (the early page beside budget_paused),
 * budget_paused (the spent-cap pause and its demoted/refused fallback suffix) and
 * budget_resumed (its lift). Each names the spend against the cap and, for the
 * pause, the lift paths: a raised or removed cap, or the local day rolling over. */

function budgetCapEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "budget_warning":
      // The early page beside budget_paused: the cap is not reached yet, so say so — the
      // operator still has room to raise it or fix the fallback before the team stops.
      return `budget warning — ${budgetPhrase(e.spentUsd, e.capUsd)} of the daily cap spent${mostByPhrase(e.topRoles)}; runs still start`;
    case "budget_paused": {
      // Routine state change, like counters_reset — no warning prefix. A configured fallback
      // the gate refused is named here: it is the whole reason the team stopped instead of
      // switching over, and an operator reading the feed must be able to act on it. So is a
      // free fallback the breaker demoted because its runs kept failing (BUGS.md 2026-09-20):
      // the backend, not the price, is what to fix, and the team retries it on its own.
      // Like role_cap_paused, the line names the lift paths: a raised or removed cap, or the
      // local day rolling over (the demoted branch's cool-down retry is the automatic third).
      const refused = e.fallbackRejected
        ? ` (over-cap model ${textOr(e.fallbackRejected)} is not a cost n/a model in pi's models.json)`
        : e.fallbackDemoted
          ? ` (over-cap model ${textOr(e.fallbackDemoted)} is not serving — ${textOr(e.failures)} runs failed in a row on it; one trial run retries it after a cool-down)`
          : "";
      return `budget paused — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached${mostByPhrase(e.topRoles)}${refused}; roles start no new runs until maxDailyCostUsd is raised or removed in tumwater.json or the local day rolls over`;
    }
    case "budget_resumed":
      return `budget resumed (${budgetPhrase(e.spentUsd, e.capUsd)} today)`;
    default: return textOr(e.type);
  }
}

/** The over-cap fallback line builders: budget_fallback names the free model the team
 * switched to once the cap is spent (listing each tier's pair when the event carries
 * two or more, else the single pair), and fallback_switched is the poll's one line
 * for the per-tier switch changes. */

function budgetFallbackEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "budget_fallback": {
      // The cap is spent but the team keeps working: name the free model it switched to, the
      // one fact that distinguishes this from a pause. When the event carries the per-tier
      // map (tiers, part 7b/8 — only emitted when the tiers resolve to two or more distinct
      // pairs), list each tier's pair and let the borrowed ones' `(from …)` suffixes show a
      // strong-tier borrow at a glance; a tier-free event keeps today's single-pair text.
      const tierEntries = fallbackTierEntries(isJsonObject(e.tiers) ? e.tiers : undefined);
      if (tierEntries.length >= 2)
        return `over-cap model — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached${mostByPhrase(e.topRoles)}; roles continue on ${tierEntries.join(", ")} (cost n/a)`;
      return `over-cap model — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached${mostByPhrase(e.topRoles)}; roles continue on ${providerModelPair(e, "pi's default provider", "pi's default model")} (cost n/a)`;
    }
    case "fallback_switched": {
      // One line for the poll's changes: `<tier> → <pair> (<reason>)`, the primary as "primary".
      const tiers = isJsonObject(e.tiers) ? e.tiers : {};
      const parts = Object.entries(tiers).map(([tier, v]) => {
        const t = isJsonObject(v) ? v : {};
        return `${tier} → ${typeof t.to === "string" ? t.to : "primary"} (${textOr(t.reason)})`;
      });
      return `fallback: ${parts.join("; ")}`;
    }
    default: return textOr(e.type);
  }
}

/** The budget-handback line: which roles were handed back to the primary (or to claude
 * after a subscription-window reset) when the budget reopened. */

function budgetHandbackEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "budget_handback": {
      // Which runs were handed back: the roles still running on the fallback when the budget
      // reopened. Their runs end `aborted` and resume promptly on the primary, so an operator
      // reading the feed can connect the aborted runs to this one line.
      const roles = rolesPhrase(e.roles, "?");
      if (e.reason === "window") return `claude subscription window reset: handed ${roles} back to claude`;
      return `budget reopened: handed ${roles} back to the primary`;
    }
    default: return textOr(e.type);
  }
}

/** The opencode free-model billing line: a run billed what the catalog called free, so
 * the team prices that model as paid from here on — the demotion is the harness
 * handling the spend. */

function opencodeBillingEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "opencode_free_model_billed":
      // The promotion ended (plans/opencode-backend.md §7, part 6c/7): a run billed what the
      // catalog called free, so the team now prices that model as paid from here on. No warning
      // prefix — the demotion is the harness handling the spend — but it names the model and the
      // cost so the operator sees why a badge stopped saying "cost n/a".
      return `opencode ${textOr(e.model, "model")} billed ${usd(finiteNumber(e.costUsd, 0))} — demoted from free to priced`;
    default: return textOr(e.type);
  }
}

export function budgetEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "budget_warning":
      return budgetCapEventMessage(e);
    case "budget_paused":
      return budgetCapEventMessage(e);
    case "budget_fallback":
      return budgetFallbackEventMessage(e);
    case "budget_resumed":
      return budgetCapEventMessage(e);
    case "budget_handback":
      return budgetHandbackEventMessage(e);
    case "fallback_switched":
      return budgetFallbackEventMessage(e);
    case "opencode_free_model_billed":
      return opencodeBillingEventMessage(e);
    default: return textOr(e.type);
  }
}
