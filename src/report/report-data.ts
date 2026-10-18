// vocabulary: plain
/** Collection half of the usage report: read the harness's event log and backlog history over
 * a window of local calendar days and distill it into a `ReportData` — per-day tick/token/
 * commit/cost counts plus features-done and bugs-fixed tallies from PLANS.md and BUGS.md.
 * The Markdown rendering of this data lives in src/report/report-render.ts, a pure function
 * of it; the split mirrors the failure report's (src/failure/failure-data.ts /
 * src/failure/failure-render.ts) and keeps "what happened" (window math, aggregation, bounds)
 * apart from "how it prints" (bars, cell wording), which change for different reasons — and
 * keeps core data collection out of the presentation layer, so a core consumer (as
 * /api/report already is) never forces a core→ui import. */
import { sameStatIdentity, statOrNull } from "../files/files.js";
import { assertReportSinceMs, eventWindowCovers, readWindowEvents } from "../events/event-window.js";
import { eventDayKey, eventRole, eventUsage, parseEventLine } from "../events/event-read.js";
import { readCompleteLines } from "../files/tail.js";
import { eventsLogPath } from "../paths.js";
import type { HarnessEvent } from "../events/events.js";
import { isPassingFullCheck, isRedFullCheck } from "../build/build-check-events.js";
import {
  DONE_DATE_RE,
  FIXED_DATE_RE,
  completionDate,
  fixedBugEntries,
  sectionCompletionDates,
  sectionFilingDates,
} from "../backlog/backlog.js";
import { validationGapTag } from "../backlog/backlog-md.js";
import { dayAt, dayKey, dayWindow, formatDate } from "../text/datetime.js";
import { addTo, lowerMedian, memoSetLru } from "../collections.js";
import { finiteNumber } from "../files/json-object.js";
import { OUTCOME_CLASS } from "../failure/time-spend.js";
import type { TickResult } from "../tick/tick-outcome.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { commitTier } from "../roles/roles.js";

/** The fields both usage collectors fold events into: per-role tick counts, per-role cost,
 * and the totals each render prints. `ticks` is counted only where a consumer needs a window
 * total (the trailing-window report); the per-day series derives it later by summing
 * runsByRole, so a day carries no redundant counter. The merge fields mirror that split
 * for the merge slot's own pi runs (reviewer + conflict resolution): their tokens/cost
 * always accumulate into `mergeTokens`/`mergeCostUsd` — never into `tokensOut`/`costUsd`
 * here, so each collector decides once how the merge share joins its surfaced totals (the
 * budget charges these same events, so the totals must include it) — and `mergeRuns` counts
 * `merge_done`/`merge_failed` events on every target: unlike ticks there is no per-role map a day
 * could derive a run count from, so the day must fold it for the totals to sum. */
interface UsageFold {
  runs?: number;
  runsByRole: Record<string, number>;
  /** review_rejected events per loop id — the review gate's turn-backs, split by role so a
   * loop whose every change draws a new objection is visible alongside its ticks/cost. */
  rejectionsByRole: Record<string, number>;
  /** revision events per loop id — the rework rounds a rejected change is re-applied through,
   * split by role so a loop whose every iteration is a fresh rework is visible (the author-side
   * share of the rejection, where the reviewer's objection cost is the merge slot's). */
  revisionsByRole: Record<string, number>;
  /** Wall-clock ms of each passing full-suite build_check (isPassingFullCheck), unsorted. */
  checkDurationsMs: number[];
  /** Count of failed full-suite build_check events (isRedFullCheck), so a day whose checks went
   * red before passing is visible beside its passing-check median. */
  checkFailures: number;
  /** Enqueue-to-outcome ms of each merge_done that carries queuedMs, unsorted. */
  mergeWaitsMs: number[];
  /** ms of each provider_wait event that carries a positive waitedMs (a role tick whose
   * semaphore admission waited PROVIDER_WAIT_EVENT_MS or more for its provider/team slot),
   * unsorted. */
  providerWaitsMs: number[];
  /** ms of each slot_wait event that carries a positive waitedMs (a pooled workspace lease
   * that waited SLOT_WAIT_EVENT_MS or more for a free slot), unsorted. */
  slotWaitsMs: number[];
  /** run_end events whose result is error-class under the digest's shared OUTCOME_CLASS —
   * ticks that burned agent time and merged nothing without going through review. Split by role,
   * a parallel tally to runsByRole (never subtracted from it). */
  failedRunsByRole: Record<string, number>;
  /** model_fallback_started events per loop id, so a role whose primary keeps failing is
   * visible beside its runs and cost. */
  fallbacksByRole: Record<string, number>;
  /** image_reroute events per loop id, so a role whose model keeps being handed images it
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
  /** The merge_failed outcomes keyed by their event's `result` (the TickResult
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
  /** run_deferred events per reason code (a maintenance tick that stood down — `DeferReason`
   * in src/scheduling/scheduling.ts: "backlog", "no-work" or "plans-full"), so a day's
   * deferred maintenance ticks are tallied by why they stood down instead of reading as
   * idle. A missing, foreign or torn reason folds as "no-work" — the same fallback
   * deferredReasonText applies in the feed — so the tally and the feed agree. Team-only: a
   * reason is not a role, so a role-scoped report carries an empty map. */
  deferredByReason: Record<string, number>;
}

/** Fold one event's `providerCost` map (`Record<provider, {costUsd, notionalCostUsd}>` — the
 * shape tick-finalize.ts's run_end and merge-slot.ts's merge_done/merge_failed emit) into the
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

/** Fold one event into a usage accumulator: run_end events add a tick (per role and, when
 * the target counts ticks, in total), their output tokens, and their cost — zero-cost ticks
 * contribute nothing, so they leave no costByRole key, keeping the render's "$0 roles are
 * omitted" rule true on the aggregation itself, not just at display time; merged events add
 * a commit; merge_done/merge_failed events add a merge run and
 * accumulate their tokens/cost into the merge fields only — costByRole stays a ticks-only
 * breakdown, and the merge line is how the reviewer's share is named. Both collectors fold
 * through this one place, so the two windows' aggregation rules cannot drift apart. */
function foldUsageEvent(target: UsageFold, ev: HarnessEvent): void {
  if (ev.type === "run_end") {
    const role = eventRole(ev);
    addTo(target.runsByRole, role, 1);
    // Error-class ticks get their own parallel tally — the day report's ``Failed ticks by role``
    // line — reusing the digest's OUTCOME_CLASS so "failed" cannot drift from the failure
    // report's meaning. Never subtracted from runsByRole; the two are independent counts.
    if (OUTCOME_CLASS[ev.result as TickResult] === "error") addTo(target.failedRunsByRole, role, 1);
    if (target.runs !== undefined) target.runs++;
    const { tokens, costUsd, notionalCostUsd } = eventUsage(ev);
    addTo(target.tokensByRole, role, tokens);
    target.tokensOut += tokens;
    target.costUsd += costUsd;
    target.notionalCostUsd += notionalCostUsd;
    if (costUsd !== 0) addTo(target.costByRole, role, costUsd);
    if (notionalCostUsd !== 0) addTo(target.notionalByRole, role, notionalCostUsd);
    // The tick's own runs' per-provider spend (tick-finalize.ts emits providerCost on run_end)
    // — folded per provider beside the per-role maps, so a mixed team's `Cost by provider`
    // line names the expensive seam.
    foldProviderCost(target, ev.providerCost);
  } else if (ev.type === "review_rejected") {
    // One rejection per event, on the day it happened, per loop. Zero-means-absent: a role
    // that never rejected stays absent, like costByRole.
    addTo(target.rejectionsByRole, eventRole(ev), 1);
  } else if (ev.type === "revision") {
    // One rework round per event, on the day it happened, per loop. Zero-means-absent: a role
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
    // One deferral per event, a due maintenance tick that stood down. Bucket by the raw
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
  } else if (ev.type === "provider_wait" || ev.type === "slot_wait") {
    // The day report's provider/workspace-slot wait median (mirroring the merge_wait push):
    // only a positive wait counts, so a probe seam's 0 ms wait and a pre-waitedMs event add
    // nothing. A provider wait is the semaphore admission's; a slot wait the pooled lease's.
    pushPositiveWaitedMs(ev.type === "provider_wait" ? target.providerWaitsMs : target.slotWaitsMs, ev);
  } else if (ev.type === "merge_done" || ev.type === "merge_failed") { 
    target.mergeRuns = (target.mergeRuns ?? 0) + 1;
    if (ev.type === "merge_failed") target.mergeFailed = (target.mergeFailed ?? 0) + 1;
    // Attribute the outcome to the authoring role (writeMergeOutcome logs loop: entry.role)
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
      // The event's result (writeMergeOutcome's TickResult) names WHY the merge bounced
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
 * foldUsageEvent accumulates for a single local day (ticks are not tracked — the series
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
  /** Wall-clock ms of each passing full-suite build_check that day, unsorted. */
  checkDurationsMs: number[];
  /** Count of failed full-suite build_check events that day (isRedFullCheck). */
  checkFailures: number;
  /** Enqueue-to-outcome ms of each merge_done that carries queuedMs, unsorted. */
  mergeWaitsMs: number[];
  /** ms of each that-day provider_wait event that carries positive waitedMs, unsorted. */
  providerWaitsMs: number[];
  /** ms of each that-day slot_wait event that carries positive waitedMs, unsorted. */
  slotWaitsMs: number[];
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
function zeroCommitCounts(): {
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
function zeroMergeCounts(): {
  mergeRuns: number;
  mergeTokens: number;
  mergeCostUsd: number;
} {
  return { mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
}

/** Sum a per-loop-id count/cost map over one base role: instance keys (`feature-2`) fold into
 * their base (`feature`), so a scoped report aggregates a whole role group exactly as the
 * per-role cap's group does. Ticks/tokens/cost are keyed by exact loop id while commits are
 * already base-role keyed; running every key through `baseRoleOf` reads both shapes the same
 * and returns 0 when nothing matches. */
function roleSum(record: Record<string, number>, role: string): number {
  let sum = 0;
  for (const [key, n] of Object.entries(record)) {
    if (baseRoleOf(key) === role) sum += n;
  }
  return sum;
}

/** Narrow a per-loop-id count/cost map to one base role, keyed by the base role; a role absent
 * from the map (no ticks, or no nonzero cost) yields an empty map, never a zero entry — the
 * same zero-means-absent rule the team render applies. Used by the role-scoped collectors so a
 * scoped series derives from the fold's per-role maps without inventing entries. */
function narrowToRole(record: Record<string, number>, role: string): Record<string, number> {
  const n = roleSum(record, role);
  return n === 0 ? {} : { [role]: n };
}

/** A per-loop map scoped to one base role for a report: the full map as-is when no scope is
 * set (a team report), else the same map narrowed to `base` — narrowToRole's zero-means-absent
 * rule, so a scoped report never invents a zero entry. The one home of the "keep everything,
 * or keep only the named base role" rule: the 13 per-role/pair fields of the `--since` report's
 * output all shape through it, so the scoping rule cannot drift between them. */
function scopedByRole(record: Record<string, number>, base: string | undefined): Record<string, number> {
  return base === undefined ? record : narrowToRole(record, base);
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
      checkDurationsMs: [],
      checkFailures: 0,
      mergeWaitsMs: [],
      providerWaitsMs: [],
      slotWaitsMs: [],
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
function foldWindowEvents(root: string, fromKey: string): ReportFoldEntry {
  const key = `${root}\0${fromKey}`;
  const liveStat = statOrNull(eventsLogPath(root));
  const size = liveStat?.size ?? 0;
  const mtimeMs = liveStat?.mtimeMs ?? 0;
  const dev = liveStat?.dev ?? 0;
  const ino = liveStat?.ino ?? 0;
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

/** One day of a usage report: the local calendar day key plus what the team did on it.
 * `runsByRole` counts run_end events per loop id (role ids — works for custom loops too);
 * tokensOut sums their `tokens`; commits counts `merged` events; costUsd sums `costUsd`.
 * `costByRole` splits that same costUsd per loop id — sourced from the same run_end events
 * (never a second pass), so its per-day sum equals the day's costUsd by construction.
 * `notionalCostUsd`/`notionalByRole` carry subscription spend the same way, kept apart
 * because it never charges the cap (plans/agent-backends.md part 6a).
 * Merge usage (`merge_done`/`merge_failed`) is sparse: the merge fields are absent until the
 * day folds a merge event, and a day's tokensOut/costUsd already include the merge's
 * real-money share by the time they are read (the collector folds it in right after the event
 * pass), so the series keeps summing to the totals the budget also reports; a subscription
 * merge's notional share joins notionalCostUsd instead. */
export interface ReportDay {
  date: string; // "YYYY-MM-DD" local day key
  tokensOut: number;
  runsByRole: Record<string, number>;
  /** Output tokens per loop id, so the day report can break the day's token spend down by
   * role the way Ticks/Cost do; absent only on hand-built fixtures (the collector always
   * sets it — zero uses leave it an empty map). */
  tokensByRole?: Record<string, number>;
  costByRole: Record<string, number>;
  /** review_rejected events per loop id; absent when the day has none (zero means absent). */
  rejectionsByRole?: Record<string, number>;
  /** revision events per loop id; absent when the day has none (zero means absent). */
  revisionsByRole?: Record<string, number>;
  /** Lower median of the day's passing full-suite check durations (ms); absent when the day
   * has none. */
  checkMedianMs?: number;
  /** Failed full-suite build_check events that day (isRedFullCheck); absent when the day has
   * none (zero means absent). */
  checkFailures?: number;
  /** Lower median of the day's merge waits (enqueue to merged on main, ms); absent when the
   * day has no merge that carried queuedMs. */
  mergeWaitMedianMs?: number;
  /** Lower median of the day's provider-slot waits (a role tick's semaphore admission wait,
   * ms); absent when the day has no provider_wait that carried a positive waitedMs. */
  providerWaitMedianMs?: number;
  /** Lower median of the day's workspace-slot waits (a pooled workspace lease wait, ms);
   * absent when the day has no slot_wait that carried a positive waitedMs. */
  slotWaitMedianMs?: number;
  /** error-class run_end events per loop id; absent when the day has none (zero means
   * absent, so a failure-free day keeps its exact pre-feature shape). */
  failedRunsByRole?: Record<string, number>;
  /** model_fallback_started events per loop id; absent when the day has none (zero means
   * absent). */
  fallbacksByRole?: Record<string, number>;
  /** image_reroute events per loop id; absent when the day has none (zero means absent). */
  imageReroutesByRole?: Record<string, number>;
  commits: number;
  commitsByRole?: Record<string, number>; // merged commits by base role (Work ratio 4/4)
  workCommits?: number; // of those, feature/bugfix/director
  maintenanceCommits?: number; // of those, code-maintenance + readme
  costUsd: number;
  featuresDone: number;
  bugsFixed: number;
  plansAdded?: number; // PLANS.md `## Planned`+`## Done` filing stamps this day (absent when none)
  bugsFiled?: number; // BUGS.md `## Open`+`## Fixed` filing stamps this day (absent when none)
  mergeRuns?: number; // merge_done/merge_failed events this day folded (absent when none)
  mergeTokens?: number; // their output tokens, also included in tokensOut above
  mergeCostUsd?: number; // their cost, also included in costUsd above
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  /** merged outcomes by base role; absent when the day has none (zero means absent). */
  mergedByRole?: Record<string, number>;
  /** merge_failed outcomes by base role; absent when the day has none (zero means absent). */
  mergeFailedByRole?: Record<string, number>;
  /** merge_failed outcomes by their event's `result` code; absent when the day has none
   * (zero means absent). A result code is not a role, so only the team series carries it. */
  mergeFailedByReason?: Record<string, number>;
  notionalCostUsd?: number; // subscription spend, on its own notional line, never in costUsd
  /** Subscription spend by loop id, never in costByRole; absent when the day has none. */
  notionalByRole?: Record<string, number>;
  /** Per-provider real spend, parallel to costByRole but keyed by provider; absent when the
   * day had no provider spend (zero means absent, so a provider-free day keeps its exact
   * pre-feature shape). */
  costByProvider?: Record<string, number>;
  /** Per-provider notional spend, parallel to notionalByRole; absent when the day had none. */
  notionalByProvider?: Record<string, number>;
  /** run_start events per model selector, parallel to costByProvider's team-only rule: a
   * model is not a role, so only the team series carries it (absent when the day had no
   * modelled start, zero means absent). */
  runsByModel?: Record<string, number>;
  /** run_deferred events per reason code (a maintenance tick that stood down, bucketed by
   * why — "backlog", "no-work" or "plans-full"); team-only like runsByModel, because a
   * reason is not a role. Absent when the day had no deferral (zero means absent). */
  deferredByReason?: Record<string, number>;
}

/** The window totals both reports surface — output tokens (the merge share included), the
 * tick and commit counts, cost (the merge share included), and the merge share named for
 * itself. SinceReport carries it directly; ReportData adds the day-granular backlog tallies
 * on top. The single home of this shape, so report-render.ts's totalsLine/mergeShareLine
 * read exactly the fields the collectors produce. */
export interface ReportTotals {
  tokensOut: number; // includes merge spend — the same events the daily budget charges
  runs: number;
  commits: number;
  costUsd: number; // includes merge spend, so the report and the budget agree
  /** Subscription spend, API-equivalent: never in costUsd, shown on its own line
   * (plans/agent-backends.md part 6a). Optional so pre-feature test literals still typecheck. */
  notionalCostUsd?: number;
  mergeRuns: number; // the merge share of the above, named for itself
  mergeTokens: number;
  mergeCostUsd: number;
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  plansAdded?: number; // window filing-stamp count (absent when zero)
  bugsFiled?: number; // window filing-stamp count (absent when zero)
}

/** Team usage over a window of exactly `days` local calendar days ending today. */
export interface ReportData {
  days: number;
  from: string; // day key of the oldest day in the series
  to: string; // day key of today
  role?: string; // set by the role-scoped collector; absent on the team report
  series: ReportDay[]; // oldest → newest, zero-filled
  totals: ReportTotals & {
    featuresDone: number;
    bugsFixed: number;
    commitsByRole?: Record<string, number>;
    workCommits?: number;
    maintenanceCommits?: number;
    /** Fixed bugs' `Validation gap` tags over the window, by tag; team-only day-granular
     * backlog metadata, absent when zero like its siblings (a tag has no role, so a
     * role-scoped report never carries it). */
    validationGapsByTag?: Record<string, number>;
  };
  /** True when the report provably reflects every event the window could have contained:
   * the day-keyed read proved the log reaches back before the window's first day, or the
   * retained log holds no events at all — nothing ever existed that could have rotated away.
   * False means events were aggregated from a log whose oldest event lies inside the window
   * with no proof that older data was not rotated away (two or more 16 MB rotations inside a
   * long window outrun the one kept archive generation) — the renders say so, exactly as the
   * --since report and the failure digest already do. */
  coversFullWindow: boolean;
}

/** Team usage over a trailing window of `sinceMs` ending now: the same run_end/merged
 * aggregation as `collectReport` but keyed to a cutoff instant rather than whole local days.
 * Backlog tallies (features done / bugs fixed / plans added / bugs filed) are deliberately
 * absent: they are counted from PLANS.md/BUGS.md `planned`/`reported`/`found by` filing and
 * `done`/`fixed` completion dates, which are day-granular file metadata that cannot subdivide
 * a sub-day window — the render says so instead of showing a day-rounded number. */
export interface SinceReport {
  sinceMs: number; // the requested window length
  fromIso: string; // ISO string of the cutoff instant (window start)
  role?: string; // set by the role-scoped collector; absent on the team report
  totals: ReportTotals;
  runsByRole: Record<string, number>;
  costByRole: Record<string, number>; // zero-cost roles leave no key, as in collectReport
  /** review_rejected events per loop id; empty when the window has none. */
  rejectionsByRole: Record<string, number>;
  /** revision events per loop id; empty when the window has none. */
  revisionsByRole: Record<string, number>;
  /** error-class run_end events per loop id; empty when the window has none. */
  failedRunsByRole: Record<string, number>;
  /** model_fallback_started events per loop id; empty when the window has none. */
  fallbacksByRole: Record<string, number>;
  /** image_reroute events per loop id; empty when the window has none. */
  imageReroutesByRole: Record<string, number>;
  /** Output tokens per loop id, so the --since render can break the window's token spend
   * down by role the way the day report does. */
  tokensByRole: Record<string, number>;
  /** Merged commits per base role, so the --since render can print the day report's
   * `Commits by role` line; always present (the collector's accumulator is pre-filled by
   * zeroCommitCounts, so a commit-free window carries an empty map — the `-` render). */
  commitsByRole: Record<string, number>;
  /** merged outcomes by base role; always present (the collector pre-fills the empty map, so
   * a merge-free window renders `-` like the other lines). */
  mergedByRole: Record<string, number>;
  /** merge_failed outcomes by base role; always present (empty map when none), so the render
   * can gate its new failure line on the window's own merge_failed events. */
  mergeFailedByRole: Record<string, number>;
  /** merge_failed outcomes by their event's `result` code; always present (empty map when
   * none), so the render can gate its reason line on the window's own merge_failed events.
   * A result code is not a role, so a role-scoped window carries an empty map. */
  mergeFailedByReason: Record<string, number>;
  /** Subscription spend per loop id, never in costByRole; absent when the window has none —
   * the same conditional the day collector applies to ReportDay.notionalByRole, so a
   * --since JSON carries it only when nonzero. */
  notionalByRole?: Record<string, number>;
  /** Per-provider real spend from the window's providerCost maps; always present (empty map
   * when none, like failedRunsByRole and the other always-present maps), so the --since
   * render can gate its `Cost by provider` line on the window's own events. */
  costByProvider: Record<string, number>;
  /** Per-provider notional spend; always present (empty map when none). */
  notionalByProvider: Record<string, number>;
  /** run_start events per model selector; always present (empty map when none, like
   * costByProvider), so the --since render can gate its `Runs by model` line on the
   * window's own events. A model is not a role, so a scoped report carries an empty map. */
  runsByModel: Record<string, number>;
  /** run_deferred events per reason code (a maintenance tick that stood down, bucketed by
   * why — "backlog", "no-work" or "plans-full"); absent when the window has none — the
   * same conditional the day collector applies to ReportDay.deferredByReason, so a --since
   * JSON carries it only when nonzero. A reason is not a role, so a scoped window omits it. */
  deferredByReason?: Record<string, number>;
  /** True when the report provably reflects every event the window could have contained:
   * the day-keyed read proved the log reaches back before the cutoff's day, the log's oldest
   * retained event predates the cutoff instant (the same-day case a day key cannot decide),
   * or the retained log holds no events at all — nothing ever existed that could have rotated
   * away, so an empty or missing log must not read as a truncated history. False means events
   * were aggregated from a log whose oldest event lies inside the window with no proof that
   * older data was not rotated away — the render adds a note so a sparse window is never
   * mistaken for an idle team. */
  coversFullWindow: boolean;
}

/** Aggregate team usage over the trailing `sinceMs` window ending now, from the event log
 * only (run_end/merged — see SinceReport for why the backlog files are not read). Kept a
 * separate function rather than a `collectReport` variant flag: the day collector's
 * zero-filled series and backlog-file reads have no place in a window totals view. */
export function collectReportSince(root: string, sinceMs: number, role?: string): SinceReport {
  assertReportSinceMs(sinceMs);
  const now = Date.now();
  const cutoff = now - sinceMs;
  // The window key is the cutoff's local calendar day, from the shared dayKey helper
  // eventDayKey buckets events with, so the read's day keys cannot disagree with the ts
  // filter below; the day-keyed read may include earlier hours of that day, which the ts
  // filter removes (over-read is at most one day's events). Future-dated events are dropped
  // here too, matching collectReport (its day map only holds the window's days).
  const fromKey = dayKey(cutoff);
  const raw = readWindowEvents(root, fromKey);
  const acc: UsageFold = {
    runs: 0,
    runsByRole: {},
    rejectionsByRole: {},
    revisionsByRole: {},
    checkDurationsMs: [],
    checkFailures: 0,
    mergeWaitsMs: [],
    providerWaitsMs: [],
    slotWaitsMs: [],
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: {},
    costByRole: {},
    tokensOut: 0,
    ...zeroCommitCounts(),
    costUsd: 0,
    notionalCostUsd: 0,
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
  for (const ev of raw.events) {
    if (typeof ev.ts !== "number" || ev.ts < cutoff || ev.ts > now) continue;
    foldUsageEvent(acc, ev);
  }
  // The empty-window branch of the shared proof matters here: with no retained events nothing
  // can have rotated away, and printing a rotation note over a fresh install would claim a
  // history that never existed. When neither proof holds, the oldest retained event lies inside
  // the window and the render notes the possible truncation.
  const coversFullWindow = eventWindowCovers(raw, cutoff);
  // Role scope: every total derives from the fold's per-role maps for the named base role alone
  // — merge usage (the merge slot's, not the role's) and the team-only fields stay out, so
  // a scoped --since report sums exactly the same events the scoped day report would. The scope
  // is the base role, so instances (`feature-2`) aggregate into their group as the cap does.
  const base = role === undefined ? undefined : baseRoleOf(role);
  const scopedTotals: ReportTotals =
    base === undefined
      ? {
          tokensOut: acc.tokensOut + (acc.mergeTokens ?? 0),
          runs: acc.runs ?? 0,
          commits: acc.commits,
          costUsd: acc.costUsd + (acc.mergeCostUsd ?? 0),
          ...(acc.notionalCostUsd > 0 ? { notionalCostUsd: acc.notionalCostUsd } : {}),
          mergeRuns: acc.mergeRuns ?? 0,
          mergeTokens: acc.mergeTokens ?? 0,
          mergeCostUsd: acc.mergeCostUsd ?? 0,
          ...((acc.mergeFailed ?? 0) > 0 ? { mergeFailed: acc.mergeFailed } : {}),
        }
      : (() => {
          // The role's own notional spend, from its run_end events; the merge slot's
          // notional is team-wide and stays out like its cost.
          const notional = roleSum(acc.notionalByRole, base);
          return {
            tokensOut: roleSum(acc.tokensByRole, base),
            runs: roleSum(acc.runsByRole, base),
            commits: roleSum(acc.commitsByRole, base),
            costUsd: roleSum(acc.costByRole, base),
            ...(notional > 0 ? { notionalCostUsd: notional } : {}),
            ...zeroMergeCounts(),
          };
        })();
  // The --since render/JSON's Notional by role line is conditional on the window's own
  // notional spend, scoped to base when a role is given — the same conditional the day
  // collector applies to ReportDay.notionalByRole (line ~573), so a role-scoped window
  // whose role spent no notional carries no notionalByRole instead of an empty map.
  const notionalByRole = scopedByRole(acc.notionalByRole, base);
  // Deferred runs are bucketed by a reason code (not a role), so a role-scoped window
  // carries no entries — the same team-only rule runsByModel follows. Only set when the
  // window actually deferred (zero means absent), so a deferral-free --since JSON omits it.
  const deferred = scopedByRole(acc.deferredByReason, base);
  return {
    sinceMs,
    fromIso: new Date(cutoff).toISOString(),
    ...(base === undefined ? {} : { role: base }),
    totals: scopedTotals,
    runsByRole: scopedByRole(acc.runsByRole, base),
    costByRole: scopedByRole(acc.costByRole, base),
    rejectionsByRole: scopedByRole(acc.rejectionsByRole, base),
    revisionsByRole: scopedByRole(acc.revisionsByRole, base),
    failedRunsByRole: scopedByRole(acc.failedRunsByRole, base),
    fallbacksByRole: scopedByRole(acc.fallbacksByRole, base),
    imageReroutesByRole: scopedByRole(acc.imageReroutesByRole, base),
    tokensByRole: scopedByRole(acc.tokensByRole, base),
    commitsByRole: scopedByRole(acc.commitsByRole, base),
    mergedByRole: scopedByRole(acc.mergedByRole, base),
    mergeFailedByRole: scopedByRole(acc.mergeFailedByRole, base),
    // A result code is not a role, so a role-scoped window carries an empty map (a code
    // never baseRoleOf to the role) — the render gates the reason line to the team report.
    mergeFailedByReason: scopedByRole(acc.mergeFailedByReason, base),
    ...(Object.keys(notionalByRole).length > 0 ? { notionalByRole } : {}),
    // Provider spend is a team attribution (a provider is not a role), so a role-scoped
    // window carries empty maps — providers never baseRoleOf to the role — and the render
    // gates the provider lines to the team report anyway. Always present, empty when none.
    costByProvider: scopedByRole(acc.costByProvider, base),
    notionalByProvider: scopedByRole(acc.notionalByProvider, base),
    // Model attribution is team-only (a model is not a role, so no model folds to the
    // scoped role), the same full-map-for-team / empty-for-scoped rule costByProvider
    // follows. Always present so the render can gate on the window's own events.
    runsByModel: scopedByRole(acc.runsByModel, base),
    ...(Object.keys(deferred).length > 0 ? { deferredByReason: deferred } : {}),
    coversFullWindow,
  };
}

/** Aggregate team usage over exactly `days` local calendar days ending today, from the event
 * log (run_end/merged) and the backlog history files (PLANS.md ## Done, BUGS.md ## Fixed). */
export function collectReport(root: string, days: number, role?: string): ReportData {
  const now = new Date();
  // One captured instant for the whole window, so every day key derives from the same day.
  const { from, to } = dayWindow(days, now);

  const series: ReportDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    series.push({
      date: formatDate(dayAt(i, now)),
      tokensOut: 0,
      runsByRole: {},
      costByRole: {},
      ...zeroCommitCounts(),
      costUsd: 0,
      featuresDone: 0,
      bugsFixed: 0,
    });
  }
  const byDate = new Map<string, ReportDay>();
  for (const d of series) byDate.set(d.date, d);

  const foldEntry = foldWindowEvents(root, from);
  for (const [dayKey, fold] of foldEntry.days) {
    const day = byDate.get(dayKey);
    if (!day) continue; // Out-of-window day key (e.g. future-dated) — no series slot to fill.
    if (role === undefined) {
      day.tokensOut = fold.tokensOut;
      day.runsByRole = fold.runsByRole;
      day.tokensByRole = fold.tokensByRole;
      day.costByRole = fold.costByRole;
      // Only set when nonzero, so a rejection-free day keeps its exact pre-feature shape.
      if (Object.keys(fold.rejectionsByRole).length > 0)
        day.rejectionsByRole = fold.rejectionsByRole;
      if (Object.keys(fold.revisionsByRole).length > 0)
        day.revisionsByRole = fold.revisionsByRole;
      // Checks belong to the merge slot, so only the team series carries the median.
      if (fold.checkDurationsMs.length > 0) {
        day.checkMedianMs = lowerMedian(fold.checkDurationsMs);
      }
      if (fold.checkFailures > 0) day.checkFailures = fold.checkFailures;
      if (fold.mergeWaitsMs.length > 0) day.mergeWaitMedianMs = lowerMedian(fold.mergeWaitsMs);
      if (fold.providerWaitsMs.length > 0)
        day.providerWaitMedianMs = lowerMedian(fold.providerWaitsMs);
      // A workspace wait is the pool's, not a role's, so only the team series carries it.
      if (fold.slotWaitsMs.length > 0) day.slotWaitMedianMs = lowerMedian(fold.slotWaitsMs);
      // Only set when nonzero, so a failure-free day keeps its exact pre-feature shape.
      if (Object.keys(fold.failedRunsByRole).length > 0)
        day.failedRunsByRole = fold.failedRunsByRole;
      if (Object.keys(fold.fallbacksByRole).length > 0)
        day.fallbacksByRole = fold.fallbacksByRole;
      if (Object.keys(fold.imageReroutesByRole).length > 0)
        day.imageReroutesByRole = fold.imageReroutesByRole;
      day.commits = fold.commits;
      day.commitsByRole = fold.commitsByRole;
      day.workCommits = fold.workCommits;
      day.maintenanceCommits = fold.maintenanceCommits;
      day.costUsd = fold.costUsd;
      // Only set when nonzero, so zero-notional days keep their exact pre-feature shape.
      if (fold.notionalCostUsd > 0) day.notionalCostUsd = fold.notionalCostUsd;
      if (Object.keys(fold.notionalByRole).length > 0) day.notionalByRole = fold.notionalByRole;
      // Only set when a provider actually spent (zero means absent), so a provider-free day
      // keeps its exact pre-feature shape and `report --json` omits the maps when empty.
      if (Object.keys(fold.costByProvider).length > 0) day.costByProvider = fold.costByProvider;
      if (Object.keys(fold.notionalByProvider).length > 0)
        day.notionalByProvider = fold.notionalByProvider;
      // Models are a team attribution (a model is not a role), so only the team series
      // carries the map; only set when a modelled start happened (zero means absent), so a
      // model-less day keeps its exact pre-feature shape.
      if (Object.keys(fold.runsByModel).length > 0) day.runsByModel = fold.runsByModel;
      // Deferred runs are a team attribution (a reason is not a role), so only the team
      // series carries the map; only set when a day actually deferred (zero means absent),
      // so a deferral-free day keeps its exact pre-feature shape.
      if (Object.keys(fold.deferredByReason).length > 0)
        day.deferredByReason = fold.deferredByReason;
      day.mergeRuns = fold.mergeRuns;
      day.mergeTokens = fold.mergeTokens;
      day.mergeCostUsd = fold.mergeCostUsd;
      // Only set when nonzero, so a failure-free day keeps its exact pre-feature shape.
      if ((fold.mergeFailed ?? 0) > 0) day.mergeFailed = fold.mergeFailed;
      // Only set when a role actually merged/failed that day (zero means absent), so a
      // merge-free day keeps its exact pre-feature shape.
      if (Object.keys(fold.mergedByRole).length > 0) day.mergedByRole = fold.mergedByRole;
      if (Object.keys(fold.mergeFailedByRole).length > 0)
        day.mergeFailedByRole = fold.mergeFailedByRole;
      // Reason codes are a team attribution (a result is not a role), so only the team
      // series carries the map; only set when nonzero, so a failure-free day keeps its
      // exact pre-feature shape. The role branch below leaves it unset — merge runs are
      // the merge slot's.
      if (Object.keys(fold.mergeFailedByReason).length > 0)
        day.mergeFailedByReason = fold.mergeFailedByReason;
    } else {
      // Role scope: derive this day from the fold's per-role maps, so the series carries only
      // the named role's ticks/tokens/cost and (base-role-keyed) commits. The scope is the
      // base role, so an instance id's usage and its siblings' commits fold into one group and
      // the numbers match the per-role cap, which is base-role keyed too. The merge fields
      // stay unset — merge runs are the merge slot's, not this role's — and the work /
      // maintenance split follows the base role's own tier rather than the day's whole split.
      const base = baseRoleOf(role);
      const commits = roleSum(fold.commitsByRole, base);
      const tier = commitTier(base);
      day.tokensOut = roleSum(fold.tokensByRole, base);
      day.runsByRole = narrowToRole(fold.runsByRole, base);
      day.tokensByRole = narrowToRole(fold.tokensByRole, base);
      day.costByRole = narrowToRole(fold.costByRole, base);
      const rejs = narrowToRole(fold.rejectionsByRole, base);
      if (Object.keys(rejs).length > 0) day.rejectionsByRole = rejs;
      const revs = narrowToRole(fold.revisionsByRole, base);
      if (Object.keys(revs).length > 0) day.revisionsByRole = revs;
      const fails = narrowToRole(fold.failedRunsByRole, base);
      if (Object.keys(fails).length > 0) day.failedRunsByRole = fails;
      const falls = narrowToRole(fold.fallbacksByRole, base);
      if (Object.keys(falls).length > 0) day.fallbacksByRole = falls;
      const reroutes = narrowToRole(fold.imageReroutesByRole, base);
      if (Object.keys(reroutes).length > 0) day.imageReroutesByRole = reroutes;
      day.commits = commits;
      day.commitsByRole = narrowToRole(fold.commitsByRole, base);
      day.workCommits = tier === "work" ? commits : 0;
      day.maintenanceCommits = tier === "maintenance" ? commits : 0;
      day.costUsd = roleSum(fold.costByRole, base);
      const notional = roleSum(fold.notionalByRole, base);
      if (notional > 0) {
        day.notionalCostUsd = notional;
        day.notionalByRole = narrowToRole(fold.notionalByRole, base);
      }
      // Merge runs belong to the merge slot, not this role, so the role-scoped series
      // keeps them unset (matching the merge-share fields) — the render omits the merge
      // line for a scoped report, so these are carried only for shape consistency.
      const mergeDone = narrowToRole(fold.mergedByRole, base);
      if (Object.keys(mergeDone).length > 0) day.mergedByRole = mergeDone;
      const mergeDoneFailed = narrowToRole(fold.mergeFailedByRole, base);
      if (Object.keys(mergeDoneFailed).length > 0) day.mergeFailedByRole = mergeDoneFailed;
    }
  }

  // The merge share joins its day's tokensOut/costUsd (the budget charges these same
  // events, so the day series must sum to the totals the budget agrees with) while the
  // merge fields keep the reviewer's part of it visible on its own.
  for (const d of series) {
    d.tokensOut += d.mergeTokens ?? 0;
    d.costUsd += d.mergeCostUsd ?? 0;
  }

  const countOn = (
    date: string,
    field: "featuresDone" | "bugsFixed" | "plansAdded" | "bugsFiled",
  ): void => {
    const day = byDate.get(date);
    if (day) day[field] = (day[field] ?? 0) + 1; // Out-of-window dates drop out here.
  };
  // Role scope leaves the day-granular backlog tallies at zero: their dates are day-granular
  // file metadata with no role, so a scoped report cannot attribute a completion or a filing
  // (the render states the omission).
  if (role === undefined) {
    for (const d of sectionCompletionDates(root, "PLANS.md", "Done", DONE_DATE_RE))
      countOn(d, "featuresDone");
    for (const d of sectionCompletionDates(root, "BUGS.md", "Fixed", FIXED_DATE_RE))
      countOn(d, "bugsFixed");
    // Fold the filing stamps too: plans/bugs that opened this day, over the same entry
    // detection `entryDates` applies to the completion reads, so an entry's opened and done
    // days are read the same way.
    for (const d of sectionFilingDates(root, "PLANS.md", "Planned")) countOn(d, "plansAdded");
    for (const d of sectionFilingDates(root, "PLANS.md", "Done")) countOn(d, "plansAdded");
    for (const d of sectionFilingDates(root, "BUGS.md", "Open")) countOn(d, "bugsFiled");
    for (const d of sectionFilingDates(root, "BUGS.md", "Fixed")) countOn(d, "bugsFiled");
  }

  // Tally the fixed bugs' `Validation gap` tags over the window, so the team can see where
  // its own tests were weakest. An entry counts only when it is in the window (the same
  // out-of-window drop countOn applies: its completion date must be a key of byDate), and
  // only the team report carries the tally — a tag has no role (the render gates on the
  // same `role === undefined`). Zero-means-absent: a window with no tagged fixed bug spreads
  // no key, so the byte-for-byte assertions on pre-feature windows hold.
  const validationGaps: Record<string, number> = {};
  if (role === undefined) {
    for (const e of fixedBugEntries(root)) {
      const date = completionDate(e.title, FIXED_DATE_RE);
      if (date === null || !byDate.has(date)) continue;
      const tag = validationGapTag(e.body);
      if (tag !== null) addTo(validationGaps, tag, 1);
    }
  }

  const totals = {
    tokensOut: 0,
    runs: 0,
    ...zeroCommitCounts(),
    costUsd: 0,
    featuresDone: 0,
    bugsFixed: 0,
    ...zeroMergeCounts(),
  };
  // Notional spend is kept out of the totals object until it is nonzero, so a pre-feature
  // window's totals keep their exact shape. Merge failures likewise: a failure-free window
  // carries no mergeFailed (zero means absent, like the merge-share line's other fields
  // are folded in below).
  let notionalCostUsd = 0;
  let mergeFailed = 0;
  let plansAdded = 0;
  let bugsFiled = 0;
  for (const d of series) {
    totals.tokensOut += d.tokensOut;
    for (const n of Object.values(d.runsByRole)) totals.runs += n;
    totals.commits += d.commits;
    for (const [role, n] of Object.entries(d.commitsByRole ?? {})) addTo(totals.commitsByRole, role, n);
    totals.workCommits += d.workCommits ?? 0;
    totals.maintenanceCommits += d.maintenanceCommits ?? 0;
    totals.costUsd += d.costUsd;
    notionalCostUsd += d.notionalCostUsd ?? 0;
    totals.featuresDone += d.featuresDone;
    totals.bugsFixed += d.bugsFixed;
    plansAdded += d.plansAdded ?? 0;
    bugsFiled += d.bugsFiled ?? 0;
    totals.mergeRuns += d.mergeRuns ?? 0;
    totals.mergeTokens += d.mergeTokens ?? 0;
    totals.mergeCostUsd += d.mergeCostUsd ?? 0;
    mergeFailed += d.mergeFailed ?? 0;
  }

  // The shared coverage proof (event-window.ts), rebuilt from the memoized read's pinned
  // parts: the day-keyed proof (fileCovers — a property of the retained bytes and fromKey,
  // both in the cache key), the vacuous empty-log arm, and the oldest retained event's ts.
  // The window's first local midnight is the cutoff: an event at that instant is the
  // earliest the window could contain, so the same-day arm degenerates harmlessly. Without
  // this field the day report was the one windowed consumer that could undercount in
  // silence — the --since report and the failure digest both carry the note, and a silent
  // number invites an operator to trust a truncated window as an idle team.
  const cutoffMs = dayAt(days - 1, now).getTime();
  const coversFullWindow =
    foldEntry.fileCovers ||
    !foldEntry.hadEvents ||
    (foldEntry.firstEventTs !== undefined && foldEntry.firstEventTs <= cutoffMs);
  return {
    days,
    from,
    to,
    ...(role === undefined ? {} : { role: baseRoleOf(role) }),
    series,
    totals: {
      ...totals,
      ...(notionalCostUsd > 0 ? { notionalCostUsd } : {}),
      ...(mergeFailed > 0 ? { mergeFailed } : {}),
      ...(plansAdded > 0 ? { plansAdded } : {}),
      ...(bugsFiled > 0 ? { bugsFiled } : {}),
      ...(Object.keys(validationGaps).length > 0 ? { validationGapsByTag: validationGaps } : {}),
    },
    coversFullWindow,
  };
}
