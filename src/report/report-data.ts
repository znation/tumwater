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
 * collectors; the report shapes they produce live in src/report/report-types.ts, and the
 * event-log folding and its memoized per-window cache in src/report/report-fold.ts (its own
 * test, report-fold-cache). */
import { assertReportSinceMs, eventWindowCovers, readWindowEvents, sinceWindowTiming } from "../events/event-window.js";
import {
  DONE_DATE_RE,
  FIXED_DATE_RE,
  completionDate,
  finishedFiles,
  fixedBugEntries,
  sectionCompletionDates,
  sectionCompletionLags,
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
import { mainRedMinutesByDay } from "./report-main-red.js";
import type { ReportData, ReportDay, ReportTotals, SinceReport } from "./report-types.js";

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
  const { now, cutoff, end, slice } = sinceWindowTiming(sinceMs, untilMs);
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
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    revertsByRole: {},
    checkDurationsMs: [],
    checkFailures: 0,
    mergeWaitsMs: [],
    mergeDurationsMs: [],
    runDurationsMs: [],
    providerWaitsMs: [],
    slotWaitsMs: [],
    checkWaitsMs: [],
    reviewDurationsMs: [],
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
    notionalByBackend: {},
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
          ...nonemptyObj("notionalByBackend", acc.notionalByBackend),
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
    ...slice,
    ...(bases === undefined ? {} : { role: bases.join(",") }),
    totals: scopedTotals,
    runsByRole: scopedByRole(acc.runsByRole, bases),
    costByRole: scopedByRole(acc.costByRole, bases),
    rejectionsByRole: scopedByRole(acc.rejectionsByRole, bases),
    postMergeRejectionsByRole: scopedByRole(acc.postMergeRejectionsByRole, bases),
    revisionsByRole: scopedByRole(acc.revisionsByRole, bases),
    refusalsByRole: scopedByRole(acc.refusalsByRole, bases),
    revertsByRole: scopedByRole(acc.revertsByRole, bases),
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
    ...nonemptyObj("notionalByRole", notionalByRole),
    // Provider spend is a team attribution (a provider is not a role), so a role-scoped
    // window carries empty maps — providers never baseRoleOf to the role — and the render
    // gates the provider lines to the team report anyway. Always present, empty when none.
    costByProvider: scopedByRole(acc.costByProvider, bases),
    notionalByProvider: scopedByRole(acc.notionalByProvider, bases),
    // Backend spend is a team attribution (a backend is not a role), so a role-scoped window
    // omits it — the same absent-when-empty rule the day collector applies.
    ...nonemptyObj("notionalByBackend", scopedByRole(acc.notionalByBackend, bases)),
    // Model attribution is team-only (a model is not a role, so no model folds to the
    // scoped role), the same full-map-for-team / empty-for-scoped rule costByProvider
    // follows. Always present so the render can gate on the window's own events.
    runsByModel: scopedByRole(acc.runsByModel, bases),
    ...nonemptyObj("deferredByReason", deferred),
    // Main's red time is main's own (G1's rule), not any role's, so a role-scoped window
    // carries 0 — the type's always-present default for the team-only field.
    mainRedMs:
      bases === undefined
        ? [...mainRedMinutesByDay(raw.events, cutoff, end).values()].reduce((a, b) => a + b, 0)
        : 0,
    coversFullWindow,
  };
}

/** A `ReportDay`'s per-day lower-median fields — the eight `…MedianMs` cells in
 * report-types.ts, each set from one folded ms list. */
type DayMedianKey =
  | "checkMedianMs"
  | "mergeWaitMedianMs"
  | "mergeSlotMedianMs"
  | "runMedianMs"
  | "providerWaitMedianMs"
  | "slotWaitMedianMs"
  | "checkWaitMedianMs"
  | "reviewMedianMs";

/** Set one per-day median cell only when the day actually has samples (`ms` non-empty), so a
 * medians-free day keeps its exact pre-feature shape (the field stays absent). The single home
 * of that guard — the day collector's eight `…MedianMs` cells all followed it inline before. */
function setLowerMedian(day: ReportDay, key: DayMedianKey, ms: number[]): void {
  if (ms.length > 0) day[key] = lowerMedian(ms);
}

/** Set one per-day role/product map cell only when the day actually has entries (`map`
 * non-empty), so a map-free day keeps its exact pre-feature shape (the field stays absent).
 * The single home of that guard — the day collector's per-role-and-product map cells all
 * followed it inline before. */
function setMapIfNonempty(day: ReportDay, key: string, map: Record<string, number> | undefined): void {
  if (map !== undefined && Object.keys(map).length > 0) {
    (day as unknown as Record<string, Record<string, number>>)[key] = map;
  }
}

/** Build one object-literal spread cell for a per-slice role/product map only when the map has
 * entries (`map` non-empty), so an entry-free window omits the field instead of carrying an
 * empty map. The single home of that guard — the window and totals object-literal spreads all
 * followed it inline before. */
function nonemptyObj<K extends string>(key: K, map: Record<string, number>): Partial<Record<K, Record<string, number>>> {
  return Object.keys(map).length > 0 ? ({ [key]: map } as Record<K, Record<string, number>>) : {};
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
      setMapIfNonempty(day, "rejectionsByRole", fold.rejectionsByRole);
      setMapIfNonempty(day, "postMergeRejectionsByRole", fold.postMergeRejectionsByRole);
      setMapIfNonempty(day, "revisionsByRole", fold.revisionsByRole);
      setMapIfNonempty(day, "refusalsByRole", fold.refusalsByRole);
      setMapIfNonempty(day, "revertsByRole", fold.revertsByRole);
      // Checks belong to the merge slot, so only the team series carries the median.
      setLowerMedian(day, "checkMedianMs", fold.checkDurationsMs);
      if (fold.checkFailures > 0) day.checkFailures = fold.checkFailures;
      setLowerMedian(day, "mergeWaitMedianMs", fold.mergeWaitsMs);
      setLowerMedian(day, "mergeSlotMedianMs", fold.mergeDurationsMs);
      setLowerMedian(day, "runMedianMs", fold.runDurationsMs);
      setLowerMedian(day, "providerWaitMedianMs", fold.providerWaitsMs);
      // A workspace wait is the pool's, not a role's, so only the team series carries it.
      setLowerMedian(day, "slotWaitMedianMs", fold.slotWaitsMs);
      // A check permit is the team's, not a role's, so only the team series carries it.
      setLowerMedian(day, "checkWaitMedianMs", fold.checkWaitsMs);
      // A review belongs to the merge slot/reviewer, not the author role, so only the team
      // series carries the median, mirroring checkMedianMs.
      setLowerMedian(day, "reviewMedianMs", fold.reviewDurationsMs);
      // Only set when nonzero, so a failure-free day keeps its exact pre-feature shape.
      setMapIfNonempty(day, "failedRunsByRole", fold.failedRunsByRole);
      setMapIfNonempty(day, "fallbacksByRole", fold.fallbacksByRole);
      setMapIfNonempty(day, "imageReroutesByRole", fold.imageReroutesByRole);
      day.commits = fold.commits;
      day.commitsByRole = fold.commitsByRole;
      day.workCommits = fold.workCommits;
      day.maintenanceCommits = fold.maintenanceCommits;
      day.costUsd = fold.costUsd;
      // Only set when nonzero, so zero-notional days keep their exact pre-feature shape.
      if (fold.notionalCostUsd > 0) day.notionalCostUsd = fold.notionalCostUsd;
      setMapIfNonempty(day, "notionalByRole", fold.notionalByRole);
      // Only set when a provider actually spent (zero means absent), so a provider-free day
      // keeps its exact pre-feature shape and `report --json` omits the maps when empty.
      setMapIfNonempty(day, "costByProvider", fold.costByProvider);
      setMapIfNonempty(day, "notionalByProvider", fold.notionalByProvider);
      // Backends are a team attribution (a backend is not a role), so only the team series
      // carries the map; only set when a backend actually spent (zero means absent), so a
      // backend-free day keeps its exact pre-feature shape.
      setMapIfNonempty(day, "notionalByBackend", fold.notionalByBackend);
      // Models are a team attribution (a model is not a role), so only the team series
      // carries the map; only set when a modelled start happened (zero means absent), so a
      // model-less day keeps its exact pre-feature shape.
      setMapIfNonempty(day, "runsByModel", fold.runsByModel);
      // Deferred runs are a team attribution (a reason is not a role), so only the team
      // series carries the map; only set when a day actually deferred (zero means absent),
      // so a deferral-free day keeps its exact pre-feature shape.
      setMapIfNonempty(day, "deferredByReason", fold.deferredByReason);
      day.mergeRuns = fold.mergeRuns;
      day.mergeTokens = fold.mergeTokens;
      day.mergeCostUsd = fold.mergeCostUsd;
      // Only set when nonzero, so a failure-free day keeps its exact pre-feature shape.
      if ((fold.mergeFailed ?? 0) > 0) day.mergeFailed = fold.mergeFailed;
      // Only set when a role actually merged/failed that day (zero means absent), so a
      // merge-free day keeps its exact pre-feature shape.
      setMapIfNonempty(day, "mergedByRole", fold.mergedByRole);
      setMapIfNonempty(day, "mergeFailedByRole", fold.mergeFailedByRole);
      // Reason codes are a team attribution (a result is not a role), so only the team
      // series carries the map; only set when nonzero, so a failure-free day keeps its
      // exact pre-feature shape. The role branch below leaves it unset — merge runs are
      // the merge slot's.
      setMapIfNonempty(day, "mergeFailedByReason", fold.mergeFailedByReason);
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
      setMapIfNonempty(day, "rejectionsByRole", narrowToRole(fold.rejectionsByRole, bases));
      setMapIfNonempty(day, "postMergeRejectionsByRole", narrowToRole(fold.postMergeRejectionsByRole, bases));
      setMapIfNonempty(day, "revisionsByRole", narrowToRole(fold.revisionsByRole, bases));
      setMapIfNonempty(day, "refusalsByRole", narrowToRole(fold.refusalsByRole, bases));
      setMapIfNonempty(day, "revertsByRole", narrowToRole(fold.revertsByRole, bases));
      setMapIfNonempty(day, "failedRunsByRole", narrowToRole(fold.failedRunsByRole, bases));
      setMapIfNonempty(day, "fallbacksByRole", narrowToRole(fold.fallbacksByRole, bases));
      setMapIfNonempty(day, "imageReroutesByRole", narrowToRole(fold.imageReroutesByRole, bases));
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
      setMapIfNonempty(day, "mergedByRole", narrowToRole(fold.mergedByRole, bases));
      setMapIfNonempty(day, "mergeFailedByRole", narrowToRole(fold.mergeFailedByRole, bases));
    }
  }

  // The merge share joins its day's tokensOut/costUsd (the budget charges these same
  // events, so the day series must sum to the totals the budget agrees with) while the
  // merge fields keep the reviewer's part of it visible on its own.
  for (const d of series) {
    d.tokensOut += d.mergeTokens ?? 0;
    d.costUsd += d.mergeCostUsd ?? 0;
  }

  // Main's red wall-clock per day, from G1's rule (main_red_hold / failed ran main_check open a
  // spell, a passing ran main_check closes it, an open spell runs to now). Team-only: main's
  // red time is main's own, not any role's, so a role-scoped series leaves every day unset —
  // exactly as checkFailures is team-only. Only set when a day actually was red (zero-absent,
  // like checkMedianMs).
  if (bases === undefined) {
    const redByDay = mainRedMinutesByDay(foldEntry.redEvents, dayAt(days - 1, now).getTime(), now.getTime());
    for (const d of series) {
      const ms = redByDay.get(d.date);
      if (ms !== undefined) d.mainRedMs = ms;
    }
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

  // The per-day backlog lag median: how long each finished plan or bug waited from its filing
  // stamp to its done/fixed stamp, folded per completion day — the median backlog age at
  // which the day's items closed. Team-only (a lag has no role, like the validation tally
  // and the filing stamps above) and zero-means-absent: a day with no lag-carrying completion
  // keeps its exact pre-feature shape, and an out-of-window completion date drops out (it
  // must be a byDate key, the same drop countOn applies). The same entry detection and date
  // rules (sectionCompletionLags / entryLags) the completion and filing reads use, so the
  // spans pair the days `featuresDone`/`bugsFixed` count.
  if (role === undefined) {
    const lagsByDay = new Map<string, number[]>();
    const foldLag = (date: string, lagDays: number): void => {
      const list = lagsByDay.get(date);
      if (list) list.push(lagDays);
      else lagsByDay.set(date, [lagDays]);
    };
    for (const file of finishedFiles("PLANS.md")) {
      for (const { date, lagDays } of sectionCompletionLags(root, file, "Done", DONE_DATE_RE))
        if (byDate.has(date)) foldLag(date, lagDays);
    }
    for (const file of finishedFiles("BUGS.md")) {
      for (const { date, lagDays } of sectionCompletionLags(root, file, "Fixed", FIXED_DATE_RE))
        if (byDate.has(date)) foldLag(date, lagDays);
    }
    for (const [date, lags] of lagsByDay) byDate.get(date)!.backlogLagMedianDays = lowerMedian(lags);
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
  const notionalByBackend: Record<string, number> = {};
  for (const d of series) {
    totals.tokensOut += d.tokensOut;
    for (const n of Object.values(d.runsByRole)) totals.runs += n;
    totals.commits += d.commits;
    for (const [role, n] of Object.entries(d.commitsByRole ?? {})) addTo(totals.commitsByRole, role, n);
    totals.workCommits += d.workCommits ?? 0;
    totals.maintenanceCommits += d.maintenanceCommits ?? 0;
    totals.costUsd += d.costUsd;
    notionalCostUsd += d.notionalCostUsd ?? 0;
    for (const [backend, c] of Object.entries(d.notionalByBackend ?? {}))
      addTo(notionalByBackend, backend, c);
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
      ...nonemptyObj("notionalByBackend", notionalByBackend),
      ...(mergeFailed > 0 ? { mergeFailed } : {}),
      ...(plansAdded > 0 ? { plansAdded } : {}),
      ...(bugsFiled > 0 ? { bugsFiled } : {}),
      ...nonemptyObj("validationGapsByTag", validationGaps),
    },
    coversFullWindow,
  };
}
