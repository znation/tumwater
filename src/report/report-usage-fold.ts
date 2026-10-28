/** The single-event folding core of the usage report: fold one harness event into a
 * `UsageFold` accumulator (`foldUsageEvent`), with one named helper per event family
 * (run_end, review_rejected, merge_done/merge_failed, …). This is the pure per-event rule,
 * shared by the since-window collector and the per-day window fold — the latter lives in
 * src/report/report-fold.ts, which reads and memoizes the event log (`foldWindowEvents`)
 * and delegates each parsed event here, so the two windows' aggregation rules cannot drift
 * apart. Zero incidental runtime dependencies: node built-ins and the app's own modules
 * only. */
import { addTo } from "../collections.js";
import { isPassingFullCheck, isRedFullCheck } from "../build/build-check-events.js";
import { eventRole, eventUsage } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { finiteNumber, nonNegativeNumber } from "../files/json-object.js";
import { OUTCOME_CLASS } from "../failure/failure-time-spend.js";
import type { RunResult } from "../run/run-outcome.js";
import { commitTier } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
/** The fields both usage collectors fold events into: per-role run counts, per-role cost,
 * and the totals each render prints. `runs` is counted only where a consumer needs a window
 * total (the trailing-window report); the per-day series derives it later by summing
 * runsByRole, so a day carries no redundant counter. The merge fields mirror that split
 * for the merge slot's own pi runs (reviewer + conflict resolution): their tokens/cost
 * always accumulate into `mergeTokens`/`mergeCostUsd` — never into `tokensOut`/`costUsd`
 * here, so each collector decides once how the merge share joins its surfaced totals (the
 * budget charges these same events, so the totals must include it) — and `mergeRuns` counts
 * `merge_done`/`merge_failed` events on every target: unlike runs there is no per-role map a day
 * could derive a run count from, so the day must fold it for the totals to sum. */
export interface UsageFold {
  runs?: number;
  runsByRole: Record<string, number>;
  /** review_rejected events per role id — the review gate's turn-backs, split by role so a
   * role whose every change draws a new objection is visible alongside its runs/cost. */
  rejectionsByRole: Record<string, number>;
  /** The `review_rejected` events whose `afterMerge` is true, per role id — a subset of
   * `rejectionsByRole`, kept apart because a post-merge rejection turns back an already-merged
   * commit (one that must come off main, unlike a rejection of a change the gate held). */
  postMergeRejectionsByRole: Record<string, number>;
  /** revision events per role id — the rework rounds a rejected change is re-applied through,
   * split by role so a role whose every iteration is a fresh rework is visible (the author-side
   * share of the rejection, where the reviewer's objection cost is the merge slot's). */
  revisionsByRole: Record<string, number>;
  /** run_end events per role id whose result is `refused` — runs that deliberately declined
   * their entry and merged nothing. The one deliberate per-role outcome the report used to
   * leave out, counted on the same already-computed role as the other usage lines, a parallel
   * tally never subtracted from runsByRole. `refused` is not error-class, so this is an
   * explicit check, not OUTCOME_CLASS. */
  refusalsByRole: Record<string, number>;
  /** Wall-clock ms of each passing full-suite build_check (isPassingFullCheck), unsorted. */
  checkDurationsMs: number[];
  /** Count of failed full-suite build_check events (isRedFullCheck), so a day whose checks went
   * red before passing is visible beside its passing-check median. */
  checkFailures: number;
  /** Enqueue-to-outcome ms of each merge_done that carries queuedMs, unsorted. */
  mergeWaitsMs: number[];
  /** Verification-start-to-outcome ms of each merge_done that carries positive durationMs
   * (writeMergeOutcome), unsorted — how long the merge slot itself held each change it landed,
   * the day report's merge-slot median beside its merge-wait median. */
  mergeDurationsMs: number[];
  /** ms of each run_end that carried a positive durationMs, unsorted — the day report's
   * run-duration median beside its merge-wait median. */
  runDurationsMs: number[];
  /** ms of each provider_wait event that carries a positive waitedMs (a role run whose
   * semaphore admission waited PROVIDER_WAIT_EVENT_MS or more for its provider/team slot),
   * unsorted. */
  providerWaitsMs: number[];
  /** ms of each slot_wait event that carries a positive waitedMs (a pooled workspace lease
   * that waited SLOT_WAIT_EVENT_MS or more for a free slot), unsorted. */
  slotWaitsMs: number[];
  /** ms of each check_wait event that carries a positive waitedMs (a scoped check's wait for a
   * check permit), unsorted. */
  checkWaitsMs: number[];
  /** ms of each reviewer run that reached a verdict that day (a `review_verdict` approval or a
   * `review_rejected` that carried a positive durationMs — the times the review gate actually
   * ran), unsorted. */
  reviewDurationsMs: number[];
  /** run_end events whose result is error-class under the digest's shared OUTCOME_CLASS —
   * runs that burned agent time and merged nothing without going through review. Split by role,
   * a parallel tally to runsByRole (never subtracted from it). */
  failedRunsByRole: Record<string, number>;
  /** image_reroute events per role id, so a role whose model keeps being handed images it
   * can't read is visible beside its runs and cost. */
  imageReroutesByRole: Record<string, number>;
  tokensByRole: Record<string, number>;
  /** Prompt tokens per role id — the input side of the bill `tokensByRole` (output tokens)
   * hides, so the same report that says who burned output tokens also says whose prompts a
   * backend served. Zero-means-absent like tokensByRole: a role whose runs never reported a
   * prompt leaves no key. */
  promptTokensByRole: Record<string, number>;
  /** The per-role subset of `promptTokensByRole` its backend served from cache (the
   * `run_end.cacheReadTokens` share run-finalize.ts rides), so an operator sees whose prompts
   * are cached and whose are not. Never larger than the prompt total (foldUsageEvent clamps
   * it), zero-means-absent like its sibling. */
  cacheReadTokensByRole: Record<string, number>;
  costByRole: Record<string, number>;
  tokensOut: number;
  commits: number;
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
  costUsd: number;
  /** Subscription spend (plans/agent-backends.md part 6a): API-equivalent, never in costUsd. */
  notionalCostUsd: number;
  /** The notional share per role, so a role-scoped report can carry a role's own
   * subscription spend (the merge slot's notional is team-wide like its cost). */
  notionalByRole: Record<string, number>;
  mergeRuns?: number;
  mergeTokens?: number;
  mergeCostUsd?: number;
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  /** The merged outcomes keyed by base authoring role, so a report can name which roles'
   * changes reach main through the merge slot (the same base-role keying as commitsByRole,
   * so `feature-2` aggregates into `feature`). A parallel tally, never subtracted from the
   * team totals. */
  mergedByRole: Record<string, number>;
  /** The merge_failed outcomes keyed by base authoring role — the changes that bounced off
   * the merge gate (review rejection, under-cap review, a conflict, a blocked fast-forward,
   * a shutdown abort), so an operator can see whether gate failures concentrate in one role. */
  mergeFailedByRole: Record<string, number>;
  /** The merge_failed outcomes keyed by their event's `result` (the RunResult
   * writeMergeOutcome logs — `rejected` for a review rejection, `merge_conflict`, a
   * `merge_blocked` failed fast-forward, an `aborted` shutdown, …), so a report can say
   * WHY a day's merges failed (fix the change vs rebase vs capacity), not just how many and
   * by which role. A legacy event with no `result` folds under `unknown`. A parallel tally,
   * never subtracted from mergeFailedByRole or mergeFailed. */
  mergeFailedByReason: Record<string, number>;
  /** Per-provider spend folded from the events' `providerCost` maps (run_end's own runs and
   * merge_done/merge_failed's reviewer seam): real cost per provider, a parallel tally to
   * costByRole that is never subtracted from it or from costUsd. A provider with no real
   * spend leaves no key. */
  costByProvider: Record<string, number>;
  /** The notional share per provider (a subscription seam's API-equivalent spend), the same
   * parallel age as costByProvider but on the notional line. */
  notionalByProvider: Record<string, number>;
  /** The notional share per backend (a subscription seam's API-equivalent spend), keyed by
   * the run_end event's `agent` — the backend whose runs spent it — the same parallel age as
   * notionalByProvider but on the notional line. Team-only like a provider: a backend is not
   * a role. Absent when empty. */
  notionalByBackend: Record<string, number>;
  /** run_start events per model selector (the agent-qualified name every run starts on —
   * `run #N started on <model>`), a parallel tally to runsByRole keyed by model instead of
   * role. A run_start whose `model` is absent or empty contributes no key. Team-only: a
   * model is not a role, so a role-scoped report carries an empty map. */
  runsByModel: Record<string, number>;
  /** run_deferred events per reason code (a maintenance run that stood down — `DeferReason`
   * in src/scheduling/scheduling.ts: "backlog", "no-work" or "plans-full"), so a day's
   * deferred maintenance runs are tallied by why they stood down instead of reading as
   * idle. A missing, foreign or torn reason folds as "no-work" — the same fallback
   * deferredReasonText applies in the feed — so the tally and the feed agree. Team-only: a
   * reason is not a role, so a role-scoped report carries an empty map. */
  deferredByReason: Record<string, number>;
}

/** Fold one event's `providerCost` map (`Record<provider, {costUsd, notionalCostUsd}>` — the
 * shape run-finalize.ts's run_end and merge-slot.ts's merge_done/merge_failed emit) into the
 * per-provider tallies, one addTo per provider per nonzero figure so zero stays absent. A
 * missing, foreign, or empty map folds nothing, so old logs render byte-identically. */
function foldProviderCost(target: UsageFold, providerCost: unknown): void {
  if (typeof providerCost !== "object" || providerCost === null) return;
  for (const [provider, c] of Object.entries(providerCost as Record<string, unknown>)) {
    if (typeof c !== "object" || c === null) continue;
    const entry = c as Record<string, unknown>;
    const costUsd = finiteNumber(entry.costUsd, 0);
    const notionalCostUsd = finiteNumber(entry.notionalCostUsd, 0);
    if (costUsd !== 0) addTo(target.costByProvider, provider, costUsd);
    if (notionalCostUsd !== 0) addTo(target.notionalByProvider, provider, notionalCostUsd);
  }
}

/** Push `ms` into the accumulator list a day median reads, when it is positive: the event
 * fields that feed these medians are missing or 0 for the same event kinds (short runs, build
 * pre-checks, precedent legacy events, probe-seam waits), and those contribute nothing — a
 * median over only real durations/wait times. Every median list folds through here, so the
 * "positive-only" rule cannot drift between fields. */
function pushPositiveMs(list: number[], ms: number): void {
  if (ms > 0) list.push(ms);
}

/** Fold a run_end into the accumulator: a run (per role and, when the target counts runs, in
 * total), its output/prompt/cache tokens, its cost, and its notional backend share. */
function foldRunEnd(target: UsageFold, ev: HarnessEvent): void {
  const role = eventRole(ev);
  addTo(target.runsByRole, role, 1);
  // Error-class runs get their own parallel tally — the day report's ``Failed runs by role``
  // line — reusing the digest's OUTCOME_CLASS so "failed" cannot drift from the failure
  // report's meaning. Never subtracted from runsByRole; the two are independent counts.
  if (OUTCOME_CLASS[ev.result as RunResult] === "error") addTo(target.failedRunsByRole, role, 1);
  // A refusal is its own deliberate outcome (src/verdict/refusal.ts), not error-class, so
  // it needs an explicit result check: the one per-role rejection-without-review count a
  // day report should surface beside rejections, revisions and falls. Never subtracted from
  // runsByRole; a refused run still counts as a run.
  if (ev.result === "refused") addTo(target.refusalsByRole, role, 1);
  if (target.runs !== undefined) target.runs++;
  const { tokens, costUsd, notionalCostUsd } = eventUsage(ev);
  pushPositiveMs(target.runDurationsMs, finiteNumber(ev.durationMs, 0));
  addTo(target.tokensByRole, role, tokens);
  // The prompt side of the same run's bill: how many prompt tokens each role sent and how
  // much of that its backend served from cache (run-finalize.ts rides both on run_end, each
  // omitted when zero). Zero-means-absent like tokensByRole. The finite guard is the failure
  // digest's promptStatsFor rule, and the Math.min clamp keeps a torn log's cache share from
  // ever exceeding the prompt total — together they pin a rendered share to <= 100% and keep
  // a non-finite reading (1e999 → Infinity) out of the maps as absent, not NaN.
  const prompt = nonNegativeNumber(ev.promptTokens, 0);
  const cacheRead = Math.min(nonNegativeNumber(ev.cacheReadTokens, 0), prompt);
  if (prompt > 0) addTo(target.promptTokensByRole, role, prompt);
  if (cacheRead > 0) addTo(target.cacheReadTokensByRole, role, cacheRead);
  target.tokensOut += tokens;
  target.costUsd += costUsd;
  target.notionalCostUsd += notionalCostUsd;
  if (costUsd !== 0) addTo(target.costByRole, role, costUsd);
  if (notionalCostUsd !== 0) addTo(target.notionalByRole, role, notionalCostUsd);
  // The notional spend's backend (plans/codex-backend.md part 3d/9): the subscription seam
  // whose runs made the run's API-equivalent cost, from the run_end's `agent` (run-finalize
  // carries it when the run reported billing/rate windows) — falling back to "claude" when
  // a legacy window event (no agent, subscription billing) attributed its spend, so the old
  // default stays the report's only backend. A run with no backend and no subscription
  // billing is unattributed and adds no key, so the render keeps its generic line for it.
  const notionalBackend =
    typeof ev.agent === "string" && ev.agent !== ""
      ? ev.agent
      : ev.billing === "subscription"
        ? "claude"
        : undefined;
  if (notionalBackend !== undefined && notionalCostUsd !== 0)
    addTo(target.notionalByBackend, notionalBackend, notionalCostUsd);
  // The agent runs' per-provider spend (run-finalize.ts emits providerCost on run_end)
  // — folded per provider beside the per-role maps, so a mixed team's `Cost by provider`
  // line names the expensive seam.
  foldProviderCost(target, ev.providerCost);
}

/** Fold a review_rejected: one rejection per event, on the day it happened, per role, with
 * the post-merge subset and a review-duration entry when the rejection carried one. */
function foldReviewRejected(target: UsageFold, ev: HarnessEvent): void {
  // One rejection per event, on the day it happened, per role. Zero-means-absent: a role
  // that never rejected stays absent, like costByRole.
  addTo(target.rejectionsByRole, eventRole(ev), 1);
  // A rejection that carried afterMerge: true is a post-merge one — the commit had already
  // landed, so the reviewer's turn-back reaches the revert path off main. Kept as its own
  // subset of rejectionsByRole because it is a different, costlier kind of rejection.
  if (ev.afterMerge === true) addTo(target.postMergeRejectionsByRole, eventRole(ev), 1);
  // A rejection that carried a positive durationMs means a reviewer actually ran the gate
  // and reached a verdict (post-merge rejections do; the build pre-check contributes no
  // duration), so it joins the review-duration median beside approvals. durationMs: 0 and
  // a duration-less event contribute nothing.
  pushPositiveMs(target.reviewDurationsMs, finiteNumber(ev.durationMs, 0));
}

/** Fold a review_verdict approval into the review-duration median. */
function foldReviewVerdict(target: UsageFold, ev: HarnessEvent): void {
  // An approval that reached a verdict. Every reviewer run that reached a verdict, approval
  // or rejection, is one entry in the review-duration median; review_failed stays out — it
  // has no verdict. Mirrors the rejection branch above, on the same-day count.
  pushPositiveMs(target.reviewDurationsMs, finiteNumber(ev.durationMs, 0));
}

/** Fold a revision: one rework round per event, on the day it happened, per role. */
function foldRevision(target: UsageFold, ev: HarnessEvent): void {
  // One rework round per event, on the day it happened, per role. Zero-means-absent: a role
  // that never reworked a rejected change stays absent, like rejectionsByRole.
  addTo(target.revisionsByRole, eventRole(ev), 1);
}

/** Fold a passing full-suite check into the day report's check-time median. */
function foldPassingCheck(target: UsageFold, ev: HarnessEvent): void {
  // The merge slot's passing full-suite checks, for the day report's check-time median.
  pushPositiveMs(target.checkDurationsMs, finiteNumber(ev.durationMs, 0));
}

/** Fold a red full-suite check into the day report's red-check count. */
function foldRedCheck(target: UsageFold, _ev: HarnessEvent): void {
  // The merge slot's red full-suite checks, for the day report's red-check count.
  target.checkFailures++;
}

/** Fold an image_reroute: one reroute per event, preflight or after a blind read. */
function foldImageReroute(target: UsageFold, ev: HarnessEvent): void {
  // One reroute per event, preflight or after a blind read.
  addTo(target.imageReroutesByRole, eventRole(ev), 1);
}

/** Fold a run_deferred: one deferral per event, bucketed by the raw reason code (team-only). */
function foldDeferred(target: UsageFold, ev: HarnessEvent): void {
  // One deferral per event, a due maintenance run that stood down. Bucket by the raw
  // reason code ("backlog", "plans-full", else "no-work" for a missing/foreign/torn
  // reason — the same fallback deferredReasonText applies in the feed), so the collector
  // stays free of a presentation import and the render prints the code the event carried.
  // Team-only: a reason is not a role.
  const reason = ev.reason === "backlog" || ev.reason === "plans-full" ? ev.reason : "no-work";
  addTo(target.deferredByReason, reason, 1);
}

/** Fold a merged commit: one commit split by base role and tier (Work ratio 4/4). */
function foldMerged(target: UsageFold, ev: HarnessEvent): void {
  target.commits++;
  // Work ratio 4/4: split merged commits by base role and by tier. Instance suffixes fold
  // into their role (`feature-2` counts as feature) so the split does not fragment.
  const role = baseRoleOf(eventRole(ev));
  addTo(target.commitsByRole, role, 1);
  const tier = commitTier(role);
  if (tier === "work") target.workCommits++;
  else if (tier === "maintenance") target.maintenanceCommits++;
}

/** Fold a run_start: one tally per run start on a configured model. */
function foldRunStarted(target: UsageFold, ev: HarnessEvent): void {
  // One tally per run start on a configured model: the same `model` field the CLI's
  // `run #N started on <model>` line prints, and the only event that carries a model
  // (run_end has none), so a run that started with no configured model contributes no key.
  const model = typeof ev.model === "string" && ev.model.length > 0 ? ev.model : null;
  if (model !== null) addTo(target.runsByModel, model, 1);
}

/** Fold a provider_wait into the provider-slot wait median. */
function foldProviderWait(target: UsageFold, ev: HarnessEvent): void {
  // The day report's provider-slot wait median, mirroring the slot_wait push: a wait only
  // event-logged at or above the 30 s threshold counts, so a 0 ms wait (a probe seam) adds
  // nothing and the median reflects real blocked admissions only.
  pushPositiveMs(target.providerWaitsMs, finiteNumber(ev.waitedMs, 0));
}

/** Fold a slot_wait into the workspace-slot wait median. */
function foldSlotWait(target: UsageFold, ev: HarnessEvent): void {
  // The day report's workspace-slot wait median, mirroring the provider_wait push: a wait
  // only event-logged at or above the 30 s threshold counts, so a 0 ms wait (a probe seam)
  // or a pre-waitedMs event adds nothing.
  pushPositiveMs(target.slotWaitsMs, finiteNumber(ev.waitedMs, 0));
}

/** Fold a check_wait into the check-slot wait median. */
function foldCheckWait(target: UsageFold, ev: HarnessEvent): void {
  // The day report's check-slot wait median, mirroring the slot_wait push: only waits logged
  // at or above the 30 s threshold count, so a 0 ms or pre-waitedMs event adds nothing.
  pushPositiveMs(target.checkWaitsMs, finiteNumber(ev.waitedMs, 0));
}

/** Fold a merge_done/merge_failed outcome: its run count, its accumulation into the merge
 * fields only (costByRole stays a runs-only breakdown), and its notional/provider shares. */
function foldMergeOutcome(target: UsageFold, ev: HarnessEvent): void {
  target.mergeRuns = (target.mergeRuns ?? 0) + 1;
  if (ev.type === "merge_failed") target.mergeFailed = (target.mergeFailed ?? 0) + 1;
  // Attribute the outcome to the authoring role (writeMergeOutcome logs role: entry.role)
  // folded to base role, the same normalization the merged branch uses, so `feature-2`
  // aggregates into `feature`. A parallel tally beside the team run counts, never
  // subtracted from mergeRuns/mergeFailed.
  const role = baseRoleOf(eventRole(ev));
  if (ev.type === "merge_done") {
    addTo(target.mergedByRole, role, 1);
    // Events logged before queuedMs existed carry none: skipped, not counted as zero.
    pushPositiveMs(target.mergeWaitsMs, finiteNumber(ev.queuedMs, 0));
    // How long the merge slot itself held the change, from the verification's start to the
    // outcome. Like mergeWaitsMs, only a landed merge feeds it, and a pre-durationMs event
    // (or 0) contributes nothing.
    pushPositiveMs(target.mergeDurationsMs, finiteNumber(ev.durationMs, 0));
  } else {
    addTo(target.mergeFailedByRole, role, 1);
    // The event's result (writeMergeOutcome's RunResult) names WHY the merge bounced
    // off the gate — rejected/merge_conflict/merge_blocked/aborted. A legacy event with
    // no result folds under `unknown`, so the reason buckets always sum to mergeFailed.
    const reason = typeof ev.result === "string" && ev.result.length > 0 ? ev.result : "unknown";
    addTo(target.mergeFailedByReason, reason, 1);
  }
  const { tokens, costUsd, notionalCostUsd } = eventUsage(ev);
  target.mergeTokens = (target.mergeTokens ?? 0) + tokens;
  target.mergeCostUsd = (target.mergeCostUsd ?? 0) + costUsd;
  // A subscription merge's API-equivalent spend joins the notional line, never the
  // budgeted cost totals (plans/agent-backends.md part 6a).
  target.notionalCostUsd += notionalCostUsd;
  // The merge's notional spend per backend (merge-slot.ts emits it on the event, keyed by
  // each subscription run's agent) — folded beside the run-end per-backend map, so a codex
  // merge's subscription spend names codex instead of falling back to the generic line.
  for (const [backend, c] of Object.entries(ev.notionalByBackend ?? {})) {
    const amt = finiteNumber(c, 0);
    if (amt !== 0) addTo(target.notionalByBackend, backend, amt);
  }
  // The merge's per-provider spend (merge-slot.ts keys it to its reviewer seam), so a
  // merge's costs appear under the provider that ran the reviewer, matching the author
  // side's foldMergeUsage charge.
  foldProviderCost(target, ev.providerCost);
}

/** Fold one event into a usage accumulator by dispatching to a per-family builder —
 * foldRunEnd, foldReviewRejected, foldReviewVerdict, foldRevision, foldPassingCheck,
 * foldRedCheck, foldImageReroute, foldDeferred, foldMerged,
 * foldRunStarted, foldProviderWait, foldSlotWait, foldCheckWait or foldMergeOutcome — each
 * named for the family it folds, so how a family folds is found by name. The dispatch holds
 * no accumulation of its own. All behavior lives in the builders: run_end events add a run
 * (per role and, when the target counts runs, in total), their output tokens, and their
 * cost — zero-cost runs contribute nothing, so they leave no costByRole key, keeping the
 * render's "$0 roles are omitted" rule true on the aggregation itself, not just at display
 * time; merged events add a commit; merge_done/merge_failed events add a merge run and
 * accumulate their tokens/cost into the merge fields only — costByRole stays a runs-only
 * breakdown, and the merge line is how the reviewer's share is named. Both collectors fold
 * through this one place, so the two windows' aggregation rules cannot drift apart. */
export function foldUsageEvent(target: UsageFold, ev: HarnessEvent): void {
  if (ev.type === "run_end") foldRunEnd(target, ev);
  else if (ev.type === "review_rejected") foldReviewRejected(target, ev);
  else if (ev.type === "review_verdict") foldReviewVerdict(target, ev);
  else if (ev.type === "revision") foldRevision(target, ev);
  else if (isPassingFullCheck(ev)) foldPassingCheck(target, ev);
  else if (isRedFullCheck(ev)) foldRedCheck(target, ev);
  else if (ev.type === "image_reroute") foldImageReroute(target, ev);
  else if (ev.type === "run_deferred") foldDeferred(target, ev);
  else if (ev.type === "merged") foldMerged(target, ev);
  else if (ev.type === "run_start") foldRunStarted(target, ev);
  else if (ev.type === "provider_wait") foldProviderWait(target, ev);
  else if (ev.type === "slot_wait") foldSlotWait(target, ev);
  else if (ev.type === "check_wait") foldCheckWait(target, ev);
  else if (ev.type === "merge_done" || ev.type === "merge_failed") foldMergeOutcome(target, ev);
}
