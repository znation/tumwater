/** Collection half of the usage report's per-day series: read the harness's event log
 * (through the shared event-folding core in src/report/report-usage-fold.ts) and the backlog
 * history over a window of local calendar days and distill it into a `ReportData` — per-day
 * run/token/commit/cost counts plus features-done and bugs-fixed tallies from PLANS.md and
 * BUGS.md. The Markdown rendering of this data lives in src/report/report-render.ts, a pure
 * function of it; the split mirrors the failure report's (src/failure/failure-data.ts /
 * src/failure/failure-render.ts) and keeps "what happened" (window math, aggregation, bounds)
 * apart from "how it prints" (bars, cell wording), which change for different reasons — and
 * keeps core data collection out of the presentation layer, so a core consumer (as
 * /api/report already is) never forces a core→ui import. The trailing-window `SinceReport`
 * collector lives in src/report/report-since-data.ts beside it; both fold events through the
 * shared one-event core in src/report/report-usage-fold.ts and its memoized per-window cache
 * in src/report/report-fold.ts, and the report shapes they produce live in
 * src/report/report-types.ts (report-fold has its own test, report-fold-cache). */
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
import { dayAt, dayWindow, formatDate } from "../text/datetime.js";
import { addTo, lowerMedian } from "../collections.js";
import { commitTier } from "../roles/roles.js";
import {
  foldWindowEvents,
  narrowToRole,
  nonemptyObj,
  roleSum,
  scopeBases,
  zeroCommitCounts,
  zeroMergeCounts,
} from "./report-fold.js";
import { mainRedCulpritsByDay, mainRedFailingTestsByDay, mainRedMinutesByDay } from "./report-main-red.js";
import type { ReportData, ReportDay } from "./report-types.js";

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

/** The fold entry `foldWindowEvents` returns, and one day slot of its per-day map — both
 * module-private in src/report/report-fold.ts, so the phase builders below alias them here
 * rather than editing report-fold.ts's surface. */
type ReportFoldEntry = ReturnType<typeof foldWindowEvents>;
type DayFold = NonNullable<ReturnType<ReportFoldEntry["days"]["get"]>>;

/** Zero-fill the per-day series across `days` calendar days ending `now` and index it by
 * date, so the fold's day keys can address their slots and the out-of-window keys drop out. */
function buildEmptySeries(days: number, now: Date): { series: ReportDay[]; byDate: Map<string, ReportDay> } {
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
  return { series, byDate };
}

/** Fill one team day from its folded events: every field the fold carries, with the
 * nonzero-or-absent and median-guard rules the day's exact pre-feature shape relies on. */
function applyTeamDay(day: ReportDay, fold: DayFold): void {
  day.tokensOut = fold.tokensOut;
  day.runsByRole = fold.runsByRole;
  day.tokensByRole = fold.tokensByRole;
  // Only set when nonempty, so a prompt-free day keeps its exact pre-feature shape.
  setMapIfNonempty(day, "promptTokensByRole", fold.promptTokensByRole);
  setMapIfNonempty(day, "cacheReadTokensByRole", fold.cacheReadTokensByRole);
  day.costByRole = fold.costByRole;
  // Only set when nonzero, so a rejection-free day keeps its exact pre-feature shape.
  setMapIfNonempty(day, "rejectionsByRole", fold.rejectionsByRole);
  setMapIfNonempty(day, "postMergeRejectionsByRole", fold.postMergeRejectionsByRole);
  setMapIfNonempty(day, "revisionsByRole", fold.revisionsByRole);
  setMapIfNonempty(day, "refusalsByRole", fold.refusalsByRole);
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
}

/** Fill one role-scoped day from the fold's per-role maps, so the series carries only the
 * named base role's usage, folded across an instance id's siblings, and keeps the merge
 * fields and team-only maps unset. */
function applyRoleDay(day: ReportDay, fold: DayFold, bases: string[]): void {
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
  setMapIfNonempty(day, "promptTokensByRole", narrowToRole(fold.promptTokensByRole, bases));
  setMapIfNonempty(day, "cacheReadTokensByRole", narrowToRole(fold.cacheReadTokensByRole, bases));
  day.costByRole = narrowToRole(fold.costByRole, bases);
  setMapIfNonempty(day, "rejectionsByRole", narrowToRole(fold.rejectionsByRole, bases));
  setMapIfNonempty(day, "postMergeRejectionsByRole", narrowToRole(fold.postMergeRejectionsByRole, bases));
  setMapIfNonempty(day, "revisionsByRole", narrowToRole(fold.revisionsByRole, bases));
  setMapIfNonempty(day, "refusalsByRole", narrowToRole(fold.refusalsByRole, bases));
  setMapIfNonempty(day, "failedRunsByRole", narrowToRole(fold.failedRunsByRole, bases));
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

/** Dispatch a day's fill on the role scope: team days read the fold whole, scoped days
 * narrow to the named base roles. */
function fillDayFromFold(day: ReportDay, fold: DayFold, bases: string[] | undefined): void {
  if (bases === undefined) applyTeamDay(day, fold);
  else applyRoleDay(day, fold, bases);
}

/** The merge share joins its day's tokensOut/costUsd (the budget charges these same
 * events, so the day series must sum to the totals the budget agrees with) while the
 * merge fields keep the reviewer's part of it visible on its own. */
function addMergeShareToSeries(series: ReportDay[]): void {
  for (const d of series) {
    d.tokensOut += d.mergeTokens ?? 0;
    d.costUsd += d.mergeCostUsd ?? 0;
  }
}

/** Main's red wall-clock per day, from G1's rule (main_red_hold / failed ran main_check open a
 * spell, a passing ran main_check closes it, an open spell runs to now). Team-only: main's
 * red time is main's own, not any role's, so a role-scoped series leaves every day unset —
 * exactly as checkFailures is team-only. Only set when a day actually was red (zero-absent,
 * like checkMedianMs). */
function applyMainRedToSeries(series: ReportDay[], foldEntry: ReportFoldEntry, days: number, now: Date): void {
  const redByDay = mainRedMinutesByDay(foldEntry.redEvents, dayAt(days - 1, now).getTime(), now.getTime());
  const redTestsByDay = mainRedFailingTestsByDay(foldEntry.redEvents, dayAt(days - 1, now).getTime(), now.getTime());
  const redCulpritsByDay = mainRedCulpritsByDay(foldEntry.redEvents, dayAt(days - 1, now).getTime(), now.getTime());
  for (const d of series) {
    const ms = redByDay.get(d.date);
    if (ms !== undefined) d.mainRedMs = ms;
    setMapIfNonempty(d, "mainRedByTest", redTestsByDay.get(d.date));
    setMapIfNonempty(d, "mainRedByCulprit", redCulpritsByDay.get(d.date));
  }
}

/** Count the window's backlog completions and filings onto their days. Day-granular, so a
 * role-scoped report keeps these at zero (a date is file metadata with no role). */
function applyCompletionAndFilingCounts(
  root: string,
  byDate: Map<string, ReportDay>,
  role: string | readonly string[] | undefined,
): void {
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
}

/** Tally the fixed bugs' `Validation gap` tags over the window, so the team can see where
 * its own tests were weakest. An entry counts only when it is in the window (the same
 * out-of-window drop countOn applies: its completion date must be a key of byDate), and
 * only the team report carries the tally — a tag has no role (the render gates on the
 * same `role === undefined`). Zero-means-absent: a window with no tagged fixed bug spreads
 * no key, so the byte-for-byte assertions on pre-feature windows hold. */
function applyValidationGaps(
  root: string,
  byDate: Map<string, ReportDay>,
  role: string | readonly string[] | undefined,
): Record<string, number> {
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
  return validationGaps;
}

/** The per-day backlog lag median: how long each finished plan or bug waited from its filing
 * stamp to its done/fixed stamp, folded per completion day — the median backlog age at
 * which the day's items closed. Team-only (a lag has no role, like the validation tally
 * and the filing stamps above) and zero-means-absent: a day with no lag-carrying completion
 * keeps its exact pre-feature shape, and an out-of-window completion date drops out (it
 * must be a byDate key, the same drop countOn applies). The same entry detection and date
 * rules (sectionCompletionLags / entryLags) the completion and filing reads use, so the
 * spans pair the days `featuresDone`/`bugsFixed` count. */
function applyBacklogLags(
  root: string,
  byDate: Map<string, ReportDay>,
  role: string | readonly string[] | undefined,
): void {
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
}

/** Reduce the filled day series to the report's totals, plus the nonzero-only fields the
 * return literal folds into `ReportData.totals` (notional spend, merge failures, plans/bugs
 * filings, backend attribution). */
function foldSeriesTotals(series: ReportDay[]): {
  totals: ReportData["totals"];
  notionalCostUsd: number;
  mergeFailed: number;
  plansAdded: number;
  bugsFiled: number;
  notionalByBackend: Record<string, number>;
} {
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
  return { totals, notionalCostUsd, mergeFailed, plansAdded, bugsFiled, notionalByBackend };
}

/** The shared coverage proof (event-window.ts), rebuilt from the memoized read's pinned
 * parts: the day-keyed proof (fileCovers — a property of the retained bytes and fromKey,
 * both in the cache key), the vacuous empty-log arm, and the oldest retained event's ts.
 * The window's first local midnight is the cutoff: an event at that instant is the
 * earliest the window could contain, so the same-day arm degenerates harmlessly. Without
 * this field the day report was the one windowed consumer that could undercount in
 * silence — the --since report and the failure digest both carry the note, and a silent
 * number invites an operator to trust a truncated window as an idle team. */
function windowCoverage(foldEntry: ReportFoldEntry, days: number, now: Date): boolean {
  const cutoffMs = dayAt(days - 1, now).getTime();
  return (
    foldEntry.fileCovers ||
    !foldEntry.hadEvents ||
    (foldEntry.firstEventTs !== undefined && foldEntry.firstEventTs <= cutoffMs)
  );
}

/** Aggregate team usage over exactly `days` local calendar days ending today, from the event
 * log (run_end/merged) and the backlog history (`## Done` in PLANS.md and PLANS-DONE.md,
 * `## Fixed` in BUGS.md and BUGS-FIXED.md). */
export function collectReport(root: string, days: number, role?: string | readonly string[]): ReportData {
  const bases = scopeBases(role);
  const now = new Date();
  // One captured instant for the whole window, so every day key derives from the same day.
  const { from, to } = dayWindow(days, now);

  const { series, byDate } = buildEmptySeries(days, now);

  const foldEntry = foldWindowEvents(root, from);
  for (const [dayKey, fold] of foldEntry.days) {
    const day = byDate.get(dayKey);
    if (!day) continue; // Out-of-window day key (e.g. future-dated) — no series slot to fill.
    fillDayFromFold(day, fold, bases);
  }

  addMergeShareToSeries(series);

  // Team-only: main's red time is main's own, not any role's (see applyMainRedToSeries).
  if (bases === undefined) applyMainRedToSeries(series, foldEntry, days, now);

  applyCompletionAndFilingCounts(root, byDate, role);
  const validationGaps = applyValidationGaps(root, byDate, role);
  applyBacklogLags(root, byDate, role);

  const { totals, notionalCostUsd, mergeFailed, plansAdded, bugsFiled, notionalByBackend } =
    foldSeriesTotals(series);

  const coversFullWindow = windowCoverage(foldEntry, days, now);
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
