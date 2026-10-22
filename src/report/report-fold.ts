/** Event-log folding for the usage report: turn raw harness events (run_end/merged/…) into
 * per-day and whole-window `UsageFold` accumulators, memoizing the day-keyed read per
 * (root, fromKey) so a dashboard polling /api/report only folds appended lines instead of
 * re-reading the window. The two window collectors (collectReport / collectReportSince) in
 * src/report/report-data.ts fold through this one shared layer, so the aggregation rules the
 * --since and day windows present cannot drift apart; it lives here matching its own test
 * (test/report-fold-cache.test.ts). Zero incidental runtime dependencies: node built-ins and
 * the app's own modules only. */
import { sameStatIdentity, statIdentityOrZero, statOrNull } from "../files/files.js";
import { readWindowEvents } from "../events/event-window.js";
import { eventDayKey, eventRole, eventUsage, parseEventLine } from "../events/event-read.js";
import { readCompleteLines } from "../files/tail.js";
import { eventsLogPath } from "../paths.js";
import type { HarnessEvent } from "../events/events.js";
import { isPassingFullCheck, isRedFullCheck } from "../build/build-check-events.js";
import { addTo, memoSetLru } from "../collections.js";
import { asList } from "../text/text.js";
import { finiteNumber } from "../files/json-object.js";
import { OUTCOME_CLASS } from "../failure/time-spend.js";
import type { RunResult } from "../run/run-outcome.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { commitTier } from "../roles/roles.js";

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
  /** run_end events whose result is error-class under the digest's shared OUTCOME_CLASS —
   * runs that burned agent time and merged nothing without going through review. Split by role,
   * a parallel tally to runsByRole (never subtracted from it). */
  failedRunsByRole: Record<string, number>;
  /** model_fallback_started events per role id, so a role whose primary keeps failing is
   * visible beside its runs and cost. */
  fallbacksByRole: Record<string, number>;
  /** image_reroute events per role id, so a role whose model keeps being handed images it
   * can't read is visible beside its runs and cost. */
  imageReroutesByRole: Record<string, number>;
  tokensByRole: Record<string, number>;
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

/** Push a provider- or workspace-slot wait's ms into the accumulator list a median reads,
 * when the event carried a positive wait: a wait is only event-logged at or above the 30 s
 * threshold, so a 0 ms wait (a probe seam) or a pre-waitedMs event adds nothing and the two
 * wait medians reflect real blocked admissions only. */
function pushPositiveWaitedMs(list: number[], ev: HarnessEvent): void {
  const waited = finiteNumber(ev.waitedMs, 0);
  if (waited > 0) list.push(waited);
}

/** Fold one event into a usage accumulator: run_end events add a run (per role and, when
 * the target counts runs, in total), their output tokens, and their cost — zero-cost runs
 * contribute nothing, so they leave no costByRole key, keeping the render's "$0 roles are
 * omitted" rule true on the aggregation itself, not just at display time; merged events add
 * a commit; merge_done/merge_failed events add a merge run and
 * accumulate their tokens/cost into the merge fields only — costByRole stays a runs-only
 * breakdown, and the merge line is how the reviewer's share is named. Both collectors fold
 * through this one place, so the two windows' aggregation rules cannot drift apart. */
export function foldUsageEvent(target: UsageFold, ev: HarnessEvent): void {
  if (ev.type === "run_end") {
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
    const runMs = finiteNumber(ev.durationMs, 0);
    if (runMs > 0) target.runDurationsMs.push(runMs);
    addTo(target.tokensByRole, role, tokens);
    target.tokensOut += tokens;
    target.costUsd += costUsd;
    target.notionalCostUsd += notionalCostUsd;
    if (costUsd !== 0) addTo(target.costByRole, role, costUsd);
    if (notionalCostUsd !== 0) addTo(target.notionalByRole, role, notionalCostUsd);
    // The agent runs' per-provider spend (run-finalize.ts emits providerCost on run_end)
    // — folded per provider beside the per-role maps, so a mixed team's `Cost by provider`
    // line names the expensive seam.
    foldProviderCost(target, ev.providerCost);
  } else if (ev.type === "review_rejected") {
    // One rejection per event, on the day it happened, per role. Zero-means-absent: a role
    // that never rejected stays absent, like costByRole.
    addTo(target.rejectionsByRole, eventRole(ev), 1);
  } else if (ev.type === "revision") {
    // One rework round per event, on the day it happened, per role. Zero-means-absent: a role
    // that never reworked a rejected change stays absent, like rejectionsByRole.
    addTo(target.revisionsByRole, eventRole(ev), 1);
  } else if (isPassingFullCheck(ev)) {
    // The merge slot's passing full-suite checks, for the day report's check-time median.
    const durationMs = finiteNumber(ev.durationMs, 0);
    if (durationMs > 0) target.checkDurationsMs.push(durationMs);
  } else if (isRedFullCheck(ev)) {
    // The merge slot's red full-suite checks, for the day report's red-check count.
    target.checkFailures++;
  } else if (ev.type === "model_fallback_started") {
    // One episode per start event; durations are not summed (an episode can span the window edge).
    addTo(target.fallbacksByRole, eventRole(ev), 1);
  } else if (ev.type === "image_reroute") {
    // One reroute per event, preflight or after a blind read.
    addTo(target.imageReroutesByRole, eventRole(ev), 1);
  } else if (ev.type === "run_deferred") {
    // One deferral per event, a due maintenance run that stood down. Bucket by the raw
    // reason code ("backlog", "plans-full", else "no-work" for a missing/foreign/torn
    // reason — the same fallback deferredReasonText applies in the feed), so the collector
    // stays free of a presentation import and the render prints the code the event carried.
    // Team-only: a reason is not a role.
    const reason = ev.reason === "backlog" || ev.reason === "plans-full" ? ev.reason : "no-work";
    addTo(target.deferredByReason, reason, 1);
  } else if (ev.type === "merged") {
    target.commits++;
    // Work ratio 4/4: split merged commits by base role and by tier. Instance suffixes fold
    // into their role (`feature-2` counts as feature) so the split does not fragment.
    const role = baseRoleOf(eventRole(ev));
    addTo(target.commitsByRole, role, 1);
    const tier = commitTier(role);
    if (tier === "work") target.workCommits++;
    else if (tier === "maintenance") target.maintenanceCommits++;
  } else if (ev.type === "run_start") {
    // One tally per run start on a configured model: the same `model` field the CLI's
    // `run #N started on <model>` line prints, and the only event that carries a model
    // (run_end has none), so a run that started with no configured model contributes no key.
    const model = typeof ev.model === "string" && ev.model.length > 0 ? ev.model : null;
    if (model !== null) addTo(target.runsByModel, model, 1);
  } else if (ev.type === "provider_wait") {
    // The day report's provider-slot wait median, mirroring the slot_wait push: a wait only
    // event-logged at or above the 30 s threshold counts, so a 0 ms wait (a probe seam) adds
    // nothing and the median reflects real blocked admissions only.
    pushPositiveWaitedMs(target.providerWaitsMs, ev);
  } else if (ev.type === "slot_wait") {
    // The day report's workspace-slot wait median, mirroring the provider_wait push: a wait
    // only event-logged at or above the 30 s threshold counts, so a 0 ms wait (a probe seam)
    // or a pre-waitedMs event adds nothing.
    pushPositiveWaitedMs(target.slotWaitsMs, ev);
  } else if (ev.type === "check_wait") {
    // The day report's check-slot wait median, mirroring the slot_wait push: only waits logged
    // at or above the 30 s threshold count, so a 0 ms or pre-waitedMs event adds nothing.
    pushPositiveWaitedMs(target.checkWaitsMs, ev);
  } else if (ev.type === "merge_done" || ev.type === "merge_failed") {
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
      const waited = finiteNumber(ev.queuedMs, 0);
      if (waited > 0) target.mergeWaitsMs.push(waited);
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
    // The merge's per-provider spend (merge-slot.ts keys it to its reviewer seam), so a
    // merge's costs appear under the provider that ran the reviewer, matching the author
    // side's foldMergeUsage charge.
    foldProviderCost(target, ev.providerCost);
  }
}

/** One day's worth of folded events, the event-log half of a ReportDay: everything
 * foldUsageEvent accumulates for a single local day (runs are not tracked — the series
 * derives them from runsByRole). Cached across calls by foldWindowEvents so an appended
 * log line is folded once, not once per report request. */
interface DayFold {
  tokensOut: number;
  commits: number;
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
  costUsd: number;
  notionalCostUsd: number;
  runsByRole: Record<string, number>;
  rejectionsByRole: Record<string, number>;
  revisionsByRole: Record<string, number>;
  refusalsByRole: Record<string, number>;
  /** Wall-clock ms of each passing full-suite build_check that day, unsorted. */
  checkDurationsMs: number[];
  /** Count of failed full-suite build_check events that day (isRedFullCheck). */
  checkFailures: number;
  /** Enqueue-to-outcome ms of each merge_done that carries queuedMs, unsorted. */
  mergeWaitsMs: number[];
  /** ms of each that-day run_end that carried a positive durationMs, unsorted. */
  runDurationsMs: number[];
  /** ms of each that-day provider_wait event that carries positive waitedMs, unsorted. */
  providerWaitsMs: number[];
  /** ms of each that-day slot_wait event that carries positive waitedMs, unsorted. */
  slotWaitsMs: number[];
  /** ms of each that-day check_wait event that carries positive waitedMs, unsorted. */
  checkWaitsMs: number[];
  failedRunsByRole: Record<string, number>;
  fallbacksByRole: Record<string, number>;
  imageReroutesByRole: Record<string, number>;
  tokensByRole: Record<string, number>;
  costByRole: Record<string, number>;
  notionalByRole: Record<string, number>;
  mergeRuns: number;
  mergeTokens: number;
  mergeCostUsd: number;
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  mergedByRole: Record<string, number>;
  mergeFailedByRole: Record<string, number>;
  mergeFailedByReason: Record<string, number>;
  costByProvider: Record<string, number>;
  notionalByProvider: Record<string, number>;
  runsByModel: Record<string, number>;
  deferredByReason: Record<string, number>;
}

/** The event-log half of a windowed report, memoized per (root, fromKey). `offset` is how
 * many live-log bytes the folds already cover; the log is append-only (events.ts appends
 * whole lines, rotation replaces the file whole), so appends after `offset` are the only
 * bytes a repeat request has not folded. `fileCovers` is the day-keyed read's own coverage
 * proof (readWindowEvents's coversFullWindow) — a property of the retained bytes and the
 * fromKey, both of which the cache key pins, so it cannot go stale the way a proof carried
 * across window changes would. `hadEvents`/`firstEventTs` mirror raw.events[0]'s role in
 * eventWindowCovers: the first in-window event's ts (undefined when it has no numeric ts). */
interface ReportFoldEntry {
  root: string;
  fromKey: string;
  offset: number;
  mtimeMs: number;
  // The log file's identity. Size/mtime alone cannot tell a replaced file from a grown one:
  // rotation renames events.jsonl away and a fresh log grows in its place, and a fresh file
  // whose size already exceeds the cached offset would be read from that offset and fold a
  // different log's bytes into the old folds. The inode pins the file the folds cover.
  dev: number;
  ino: number;
  fileCovers: boolean;
  hadEvents: boolean;
  firstEventTs?: number;
  days: Map<string, DayFold>;
}

/** Bounded memo of window folds. Eight entries cover a dashboard flipping among a few day
 * counts plus the midnight rollover's new fromKey; oldest-insertion eviction (Map preserves
 * insertion order) keeps the memory bound to a handful of per-day accumulator maps. */
const reportFoldCache = new Map<string, ReportFoldEntry>();
const REPORT_FOLD_CACHE_MAX = 8;

/** The empty commit-family counters every accumulator starts from: the total and per-base-role
 * merged-commit count plus the work/maintenance split (Work ratio 4/4). Four shapes carry them —
 * DayFold, UsageFold, the ReportDay series slots, and the window totals — so the empty quartet
 * lives once here and a new commit counter is added in one place. */
export function zeroCommitCounts(): {
  commits: number;
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
} {
  return { commits: 0, commitsByRole: {}, workCommits: 0, maintenanceCommits: 0 };
}

/** The empty merge-run counters every accumulator starts from: the merge slot's run count
 * and its own token/cost share (foldUsageEvent's merge_done/merge_failed branch). Four shapes carry
 * them — DayFold, UsageFold, the scoped window totals, and the window totals — so the empty
 * triple lives once here and a new merge counter is added in one place. */
export function zeroMergeCounts(): {
  mergeRuns: number;
  mergeTokens: number;
  mergeCostUsd: number;
} {
  return { mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
}

/** The base roles a report scope names: undefined and an empty list mean no scope (the team
 * report); otherwise each id folded through `baseRoleOf`, deduplicated in first-seen order, so
 * `feature-2,feature` is one base. */
export function scopeBases(role: string | readonly string[] | undefined): string[] | undefined {
  if (role === undefined) return undefined;
  const ids = asList(role);
  if (ids.length === 0) return undefined;
  const out: string[] = [];
  for (const id of ids) {
    const base = baseRoleOf(id);
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** Sum a per-role-id count/cost map over the scoped base roles: instance keys (`feature-2`)
 * fold into their base (`feature`), so a scoped report aggregates a whole role group exactly
 * as the per-role cap's group does. Runs/tokens/cost are keyed by exact role id while commits are
 * already base-role keyed; running every key through `baseRoleOf` reads both shapes the same
 * and returns 0 when nothing matches. */
export function roleSum(record: Record<string, number>, bases: string | readonly string[]): number {
  const list = asList(bases);
  let sum = 0;
  for (const [key, n] of Object.entries(record)) {
    if (list.includes(baseRoleOf(key))) sum += n;
  }
  return sum;
}

/** Narrow a per-role-id count/cost map to the scoped base roles, one entry per base keyed by
 * that base; a role absent from the map (no runs, or no nonzero cost) yields no entry, never
 * a zero one — the same zero-means-absent rule the team render applies. Used by the
 * role-scoped collectors so a scoped series derives from the fold's per-role maps without
 * inventing entries. */
export function narrowToRole(
  record: Record<string, number>,
  bases: string | readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const base of asList(bases)) {
    const n = roleSum(record, base);
    if (n !== 0) out[base] = n;
  }
  return out;
}

/** A per-role map scoped to the base roles of a report: the full map as-is when no scope is
 * set (a team report), else the same map narrowed to `bases` — narrowToRole's zero-means-absent
 * rule, so a scoped report never invents a zero entry. The one home of the "keep everything,
 * or keep only the named base role" rule: the 13 per-role/pair fields of the `--since` report's
 * output all shape through it, so the scoping rule cannot drift between them. */
export function scopedByRole(
  record: Record<string, number>,
  bases: readonly string[] | undefined,
): Record<string, number> {
  return bases === undefined ? record : narrowToRole(record, bases);
}

function dayFoldFor(entry: ReportFoldEntry, dayKey: string): DayFold {
  let fold = entry.days.get(dayKey);
  if (!fold) {
    fold = {
      tokensOut: 0,
      ...zeroCommitCounts(),
      costUsd: 0,
      notionalCostUsd: 0,
      runsByRole: {},
      rejectionsByRole: {},
      revisionsByRole: {},
      refusalsByRole: {},
      checkDurationsMs: [],
      checkFailures: 0,
      mergeWaitsMs: [],
      runDurationsMs: [],
      providerWaitsMs: [],
      slotWaitsMs: [],
      checkWaitsMs: [],
      failedRunsByRole: {},
      fallbacksByRole: {},
      imageReroutesByRole: {},
      tokensByRole: {},
      costByRole: {},
      notionalByRole: {},
      ...zeroMergeCounts(),
      mergedByRole: {},
      mergeFailedByRole: {},
      mergeFailedByReason: {},
      costByProvider: {},
      notionalByProvider: {},
      runsByModel: {},
      deferredByReason: {},
    };
    entry.days.set(dayKey, fold);
  }
  return fold;
}

/** Fold one already-parsed event into a cache entry: only in-window events (a non-null day
 * on or after fromKey) count, matching readWindowEvents's event list; the first such event
 * seen takes firstEventTs. The one home of the fold body, shared by the incremental append
 * path (foldLineInto) and the full re-read path, so the two can never drift. */
function foldEventInto(entry: ReportFoldEntry, ev: HarnessEvent): void {
  const dayKey = eventDayKey(ev);
  if (dayKey === null || dayKey < entry.fromKey) return;
  if (!entry.hadEvents) {
    entry.hadEvents = true;
    entry.firstEventTs = typeof ev.ts === "number" ? ev.ts : undefined;
  }
  foldUsageEvent(dayFoldFor(entry, dayKey), ev);
}

/** Parse one appended log line and fold it; a torn or non-event line folds nothing. */
function foldLineInto(entry: ReportFoldEntry, line: string): void {
  const ev = parseEventLine(line);
  if (ev) foldEventInto(entry, ev);
}

/** The event-log half of collectReport, memoized: a dashboard re-fetching /api/report every
 * poll re-read and re-parsed the whole window's log bytes each time (~6.8 MB and tens of ms
 * on this repo's own day log, growing toward the 16 MB rotation cap). Now a request whose
 * log has not changed costs one stat; growth folds only the appended complete lines
 * (readCompleteLines holds back a torn trailing write, so it is folded whole next call).
 * Same size with a changed mtime, a shrunken file (rotation or rewrite), or a new fromKey
 * falls back to the full readWindowEvents pass — the fallback re-derives everything, so a
 * mis-fold can only come from the append assumption, and rotation's whole-file replace
 * always hits the shrink arm. The entry's coverage parts are pinned by the cache key:
 * fromKey and file bytes decide them, so an advancing window re-derives fresh instead of
 * carrying yesterday's proof forward. */
export function foldWindowEvents(root: string, fromKey: string): ReportFoldEntry {
  const key = `${root}\0${fromKey}`;
  const { size, mtimeMs, dev, ino } = statIdentityOrZero(statOrNull(eventsLogPath(root)));
  const cached = reportFoldCache.get(key);
  if (
    cached &&
    sameStatIdentity(
      { dev, ino, mtimeMs, size },
      { dev: cached.dev, ino: cached.ino, mtimeMs: cached.mtimeMs, size: cached.offset },
    )
  ) {
    memoSetLru(reportFoldCache, key, cached, REPORT_FOLD_CACHE_MAX);
    return cached;
  }
  if (cached && size > cached.offset && dev === cached.dev && ino === cached.ino) {
    const { lines, end } = readCompleteLines(eventsLogPath(root), cached.offset, size);
    if (end > cached.offset) {
      for (const line of lines) foldLineInto(cached, line);
      cached.offset = end;
      cached.mtimeMs = mtimeMs;
      return cached;
    }
    // Grown but no complete line yet (a torn write in flight): reuse the folds; the next
    // request sees the completed line and folds it then.
    return cached;
  }
  const raw = readWindowEvents(root, fromKey);
  const entry: ReportFoldEntry = {
    root,
    fromKey,
    // The scan's own end, not the outer `size`: an event appended between that stat and the
    // read is already folded, and seeding the offset from the stale size would fold it again
    // on the next append (readTailTextWithEnd's coveredEnd is exactly where the scan stopped).
    offset: raw.liveEnd,
    mtimeMs,
    dev,
    ino,
    fileCovers: raw.coversFullWindow,
    hadEvents: false,
    days: new Map(),
  };
  for (const ev of raw.events) foldEventInto(entry, ev);
  memoSetLru(reportFoldCache, key, entry, REPORT_FOLD_CACHE_MAX);
  return entry;
}
