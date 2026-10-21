/** Collection half of the usage report: read the harness's event log (through the shared
 * event-folding layer in src/report/report-fold.ts) and the backlog history over a window of
 * local calendar days and distill it into a `ReportData` / `SinceReport` — per-day
 * run/token/commit/cost counts plus features-done and bugs-fixed tallies from PLANS.md and
 * BUGS.md. The Markdown rendering of this data lives in src/report/report-render.ts, a pure
 * function of it; the split mirrors the failure report's (src/failure/failure-data.ts /
 * src/failure/failure-render.ts) and keeps "what happened" (window math, aggregation, bounds)
 * apart from "how it prints" (bars, cell wording), which change for different reasons — and
 * keeps core data collection out of the presentation layer, so a core consumer (as
 * /api/report already is) never forces a core→ui import. This file holds the two window
 * collectors and the report shapes they produce; the event-log folding and its memoized
 * per-window cache live in src/report/report-fold.ts (its own test, report-fold-cache). */
import { assertReportSinceMs, eventWindowCovers, readWindowEvents } from "../events/event-window.js";
import {
  DONE_DATE_RE,
  FIXED_DATE_RE,
  completionDate,
  finishedFiles,
  fixedBugEntries,
  sectionCompletionDates,
  sectionFilingDates,
} from "../backlog/backlog.js";
import { validationGapTag } from "../backlog/backlog-md.js";
import { dayAt, dayKey, dayWindow, formatDate } from "../text/datetime.js";
import { addTo, lowerMedian } from "../collections.js";
import { commitTier } from "../roles/roles.js";
import {
  foldUsageEvent,
  foldWindowEvents,
  narrowToRole,
  roleSum,
  scopeBases,
  scopedByRole,
  zeroCommitCounts,
  zeroMergeCounts,
  type UsageFold,
} from "./report-fold.js";

/** One day of a usage report: the local calendar day key plus what the team did on it.
 * `runsByRole` counts run_end events per role id (role ids — works for custom roles too);
 * tokensOut sums their `tokens`; commits counts `merged` events; costUsd sums `costUsd`.
 * `costByRole` splits that same costUsd per role id — sourced from the same run_end events
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
  /** Output tokens per role id, so the day report can break the day's token spend down by
   * role the way Runs/Cost do; absent only on hand-built fixtures (the collector always
   * sets it — zero uses leave it an empty map). */
  tokensByRole?: Record<string, number>;
  costByRole: Record<string, number>;
  /** review_rejected events per role id; absent when the day has none (zero means absent). */
  rejectionsByRole?: Record<string, number>;
  /** revision events per role id; absent when the day has none (zero means absent). */
  revisionsByRole?: Record<string, number>;
  /** run_end events per role id (its result is `refused` — a run that deliberately declined
   * its entry); absent when the day has none (zero means absent). */
  refusalsByRole?: Record<string, number>;
  /** Lower median of the day's passing full-suite check durations (ms); absent when the day
   * has none. */
  checkMedianMs?: number;
  /** Failed full-suite build_check events that day (isRedFullCheck); absent when the day has
   * none (zero means absent). */
  checkFailures?: number;
  /** Lower median of the day's merge waits (enqueue to merged on main, ms); absent when the
   * day has no merge that carried queuedMs. */
  mergeWaitMedianMs?: number;
  /** Lower median of the day's provider-slot waits (a role run's semaphore admission wait,
   * ms); absent when the day has no provider_wait that carried a positive waitedMs. */
  providerWaitMedianMs?: number;
  /** Lower median of the day's workspace-slot waits (a pooled workspace lease wait, ms);
   * absent when the day has no slot_wait that carried a positive waitedMs. */
  slotWaitMedianMs?: number;
  /** Lower median of the day's check-slot waits (a scoped check's wait for a maxConcurrentChecks
   * permit, ms); absent when the day has no check_wait that carried a positive waitedMs. */
  checkWaitMedianMs?: number;
  /** error-class run_end events per role id; absent when the day has none (zero means
   * absent, so a failure-free day keeps its exact pre-feature shape). */
  failedRunsByRole?: Record<string, number>;
  /** model_fallback_started events per role id; absent when the day has none (zero means
   * absent). */
  fallbacksByRole?: Record<string, number>;
  /** image_reroute events per role id; absent when the day has none (zero means absent). */
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
  /** Subscription spend by role id, never in costByRole; absent when the day has none. */
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
  /** run_deferred events per reason code (a maintenance run that stood down, bucketed by
   * why — "backlog", "no-work" or "plans-full"); team-only like runsByModel, because a
   * reason is not a role. Absent when the day had no deferral (zero means absent). */
  deferredByReason?: Record<string, number>;
  /** fixed bugs' `Validation gap` tags recorded this day, from BUGS.md's ## Fixed entries;
   * team-only like its window tally, because a tag has no role (absent when the day has
   * none, zero means absent). */
  validationGapsByTag?: Record<string, number>;
}

/** The window totals both reports surface — output tokens (the merge share included), the
 * run and commit counts, cost (the merge share included), and the merge share named for
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
  role?: string; // the scoped base roles, comma-joined; set by the role-scoped collector; absent on the team report
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
  untilMs?: number; // the --until bound; absent when the window ends now
  toIso?: string; // ISO string of the window end; set only with untilMs
  role?: string; // the scoped base roles, comma-joined; set by the role-scoped collector; absent on the team report
  totals: ReportTotals;
  runsByRole: Record<string, number>;
  costByRole: Record<string, number>; // zero-cost roles leave no key, as in collectReport
  /** review_rejected events per role id; empty when the window has none. */
  rejectionsByRole: Record<string, number>;
  /** revision events per role id; empty when the window has none. */
  revisionsByRole: Record<string, number>;
  /** run_end events per role id whose result is `refused` (a run that deliberately declined
   * its entry); empty when the window has none. */
  refusalsByRole: Record<string, number>;
  /** error-class run_end events per role id; empty when the window has none. */
  failedRunsByRole: Record<string, number>;
  /** model_fallback_started events per role id; empty when the window has none. */
  fallbacksByRole: Record<string, number>;
  /** image_reroute events per role id; empty when the window has none. */
  imageReroutesByRole: Record<string, number>;
  /** Output tokens per role id, so the --since render can break the window's token spend
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
  /** Subscription spend per role id, never in costByRole; absent when the window has none —
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
  /** run_deferred events per reason code (a maintenance run that stood down, bucketed by
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

/** Aggregate team usage over the trailing `sinceMs` window ending now (or `untilMs` ago, which
 * drops events at or after that end; `coversFullWindow` still judges the far edge
 * only), from the event log only (run_end/merged — see SinceReport for why the backlog files
 * are not read). Kept a
 * separate function rather than a `collectReport` variant flag: the day collector's
 * zero-filled series and backlog-file reads have no place in a window totals view. */
export function collectReportSince(
  root: string,
  sinceMs: number,
  role?: string | readonly string[],
  untilMs?: number,
): SinceReport {
  assertReportSinceMs(sinceMs);
  const now = Date.now();
  const cutoff = now - sinceMs;
  const end = untilMs === undefined ? now : now - untilMs;
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
    refusalsByRole: {},
    checkDurationsMs: [],
    checkFailures: 0,
    mergeWaitsMs: [],
    providerWaitsMs: [],
    slotWaitsMs: [],
    checkWaitsMs: [],
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
    if (typeof ev.ts !== "number" || ev.ts < cutoff || ev.ts > now || (untilMs !== undefined && ev.ts >= end)) continue;
    foldUsageEvent(acc, ev);
  }
  // The empty-window branch of the shared proof matters here: with no retained events nothing
  // can have rotated away, and printing a rotation note over a fresh install would claim a
  // history that never existed. When neither proof holds, the oldest retained event lies inside
  // the window and the render notes the possible truncation.
  const coversFullWindow = eventWindowCovers(raw, cutoff);
  // Role scope: every total derives from the fold's per-role maps for the named base roles alone
  // — merge usage (the merge slot's, not the role's) and the team-only fields stay out, so
  // a scoped --since report sums exactly the same events the scoped day report would. The scope
  // is the base roles, so instances (`feature-2`) aggregate into their group as the cap does.
  const bases = scopeBases(role);
  const scopedTotals: ReportTotals =
    bases === undefined
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
          const notional = roleSum(acc.notionalByRole, bases);
          return {
            tokensOut: roleSum(acc.tokensByRole, bases),
            runs: roleSum(acc.runsByRole, bases),
            commits: roleSum(acc.commitsByRole, bases),
            costUsd: roleSum(acc.costByRole, bases),
            ...(notional > 0 ? { notionalCostUsd: notional } : {}),
            ...zeroMergeCounts(),
          };
        })();
  // The --since render/JSON's Notional by role line is conditional on the window's own
  // notional spend, scoped to base when a role is given — the same conditional the day
  // collector applies to ReportDay.notionalByRole (line ~573), so a role-scoped window
  // whose role spent no notional carries no notionalByRole instead of an empty map.
  const notionalByRole = scopedByRole(acc.notionalByRole, bases);
  // Deferred runs are bucketed by a reason code (not a role), so a role-scoped window
  // carries no entries — the same team-only rule runsByModel follows. Only set when the
  // window actually deferred (zero means absent), so a deferral-free --since JSON omits it.
  const deferred = scopedByRole(acc.deferredByReason, bases);
  return {
    sinceMs,
    fromIso: new Date(cutoff).toISOString(),
    ...(untilMs === undefined ? {} : { untilMs, toIso: new Date(end).toISOString() }),
    ...(bases === undefined ? {} : { role: bases.join(",") }),
    totals: scopedTotals,
    runsByRole: scopedByRole(acc.runsByRole, bases),
    costByRole: scopedByRole(acc.costByRole, bases),
    rejectionsByRole: scopedByRole(acc.rejectionsByRole, bases),
    revisionsByRole: scopedByRole(acc.revisionsByRole, bases),
    refusalsByRole: scopedByRole(acc.refusalsByRole, bases),
    failedRunsByRole: scopedByRole(acc.failedRunsByRole, bases),
    fallbacksByRole: scopedByRole(acc.fallbacksByRole, bases),
    imageReroutesByRole: scopedByRole(acc.imageReroutesByRole, bases),
    tokensByRole: scopedByRole(acc.tokensByRole, bases),
    commitsByRole: scopedByRole(acc.commitsByRole, bases),
    mergedByRole: scopedByRole(acc.mergedByRole, bases),
    mergeFailedByRole: scopedByRole(acc.mergeFailedByRole, bases),
    // A result code is not a role, so a role-scoped window carries an empty map (a code
    // never baseRoleOf to the role) — the render gates the reason line to the team report.
    mergeFailedByReason: scopedByRole(acc.mergeFailedByReason, bases),
    ...(Object.keys(notionalByRole).length > 0 ? { notionalByRole } : {}),
    // Provider spend is a team attribution (a provider is not a role), so a role-scoped
    // window carries empty maps — providers never baseRoleOf to the role — and the render
    // gates the provider lines to the team report anyway. Always present, empty when none.
    costByProvider: scopedByRole(acc.costByProvider, bases),
    notionalByProvider: scopedByRole(acc.notionalByProvider, bases),
    // Model attribution is team-only (a model is not a role, so no model folds to the
    // scoped role), the same full-map-for-team / empty-for-scoped rule costByProvider
    // follows. Always present so the render can gate on the window's own events.
    runsByModel: scopedByRole(acc.runsByModel, bases),
    ...(Object.keys(deferred).length > 0 ? { deferredByReason: deferred } : {}),
    coversFullWindow,
  };
}

/** Aggregate team usage over exactly `days` local calendar days ending today, from the event
 * log (run_end/merged) and the backlog history (`## Done` in PLANS.md and PLANS-DONE.md,
 * `## Fixed` in BUGS.md and BUGS-FIXED.md). */
export function collectReport(root: string, days: number, role?: string | readonly string[]): ReportData {
  const bases = scopeBases(role);
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
    if (bases === undefined) {
      day.tokensOut = fold.tokensOut;
      day.runsByRole = fold.runsByRole;
      day.tokensByRole = fold.tokensByRole;
      day.costByRole = fold.costByRole;
      // Only set when nonzero, so a rejection-free day keeps its exact pre-feature shape.
      if (Object.keys(fold.rejectionsByRole).length > 0)
        day.rejectionsByRole = fold.rejectionsByRole;
      if (Object.keys(fold.revisionsByRole).length > 0)
        day.revisionsByRole = fold.revisionsByRole;
      if (Object.keys(fold.refusalsByRole).length > 0)
        day.refusalsByRole = fold.refusalsByRole;
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
      // A check permit is the team's, not a role's, so only the team series carries it.
      if (fold.checkWaitsMs.length > 0) day.checkWaitMedianMs = lowerMedian(fold.checkWaitsMs);
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
      // the named role's runs/tokens/cost and (base-role-keyed) commits. The scope is the
      // base role, so an instance id's usage and its siblings' commits fold into one group and
      // the numbers match the per-role cap, which is base-role keyed too. The merge fields
      // stay unset — merge runs are the merge slot's, not this role's — and the work /
      // maintenance split follows the base role's own tier rather than the day's whole split.
      const commits = roleSum(fold.commitsByRole, bases);
      day.tokensOut = roleSum(fold.tokensByRole, bases);
      day.runsByRole = narrowToRole(fold.runsByRole, bases);
      day.tokensByRole = narrowToRole(fold.tokensByRole, bases);
      day.costByRole = narrowToRole(fold.costByRole, bases);
      const rejs = narrowToRole(fold.rejectionsByRole, bases);
      if (Object.keys(rejs).length > 0) day.rejectionsByRole = rejs;
      const revs = narrowToRole(fold.revisionsByRole, bases);
      if (Object.keys(revs).length > 0) day.revisionsByRole = revs;
      const refusals = narrowToRole(fold.refusalsByRole, bases);
      if (Object.keys(refusals).length > 0) day.refusalsByRole = refusals;
      const fails = narrowToRole(fold.failedRunsByRole, bases);
      if (Object.keys(fails).length > 0) day.failedRunsByRole = fails;
      const falls = narrowToRole(fold.fallbacksByRole, bases);
      if (Object.keys(falls).length > 0) day.fallbacksByRole = falls;
      const reroutes = narrowToRole(fold.imageReroutesByRole, bases);
      if (Object.keys(reroutes).length > 0) day.imageReroutesByRole = reroutes;
      day.commits = commits;
      day.commitsByRole = narrowToRole(fold.commitsByRole, bases);
      const tierCommits = (tier: string): number =>
        bases.filter((b) => commitTier(b) === tier).reduce((n, b) => n + roleSum(fold.commitsByRole, b), 0);
      day.workCommits = tierCommits("work");
      day.maintenanceCommits = tierCommits("maintenance");
      day.costUsd = roleSum(fold.costByRole, bases);
      const notional = roleSum(fold.notionalByRole, bases);
      if (notional > 0) {
        day.notionalCostUsd = notional;
        day.notionalByRole = narrowToRole(fold.notionalByRole, bases);
      }
      // Merge runs belong to the merge slot, not this role, so the role-scoped series
      // keeps them unset (matching the merge-share fields) — the render omits the merge
      // line for a scoped report, so these are carried only for shape consistency.
      const mergeDone = narrowToRole(fold.mergedByRole, bases);
      if (Object.keys(mergeDone).length > 0) day.mergedByRole = mergeDone;
      const mergeDoneFailed = narrowToRole(fold.mergeFailedByRole, bases);
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
    // Finished entries sit in the live file's finished section and in its archive file
    // (plans/backlog-archive.md); each per-file read is stat-cached.
    for (const file of finishedFiles("PLANS.md")) {
      for (const d of sectionCompletionDates(root, file, "Done", DONE_DATE_RE)) countOn(d, "featuresDone");
    }
    for (const file of finishedFiles("BUGS.md")) {
      for (const d of sectionCompletionDates(root, file, "Fixed", FIXED_DATE_RE)) countOn(d, "bugsFixed");
    }
    // Fold the filing stamps too: plans/bugs that opened this day, over the same entry
    // detection `entryDates` applies to the completion reads, so an entry's opened and done
    // days are read the same way.
    for (const d of sectionFilingDates(root, "PLANS.md", "Planned")) countOn(d, "plansAdded");
    for (const file of finishedFiles("PLANS.md")) {
      for (const d of sectionFilingDates(root, file, "Done")) countOn(d, "plansAdded");
    }
    for (const d of sectionFilingDates(root, "BUGS.md", "Open")) countOn(d, "bugsFiled");
    for (const file of finishedFiles("BUGS.md")) {
      for (const d of sectionFilingDates(root, file, "Fixed")) countOn(d, "bugsFiled");
    }
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
      if (tag !== null) {
        addTo(validationGaps, tag, 1);
        addTo((byDate.get(date)!.validationGapsByTag ??= {}), tag, 1);
      }
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
    ...(bases === undefined ? {} : { role: bases.join(",") }),
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
