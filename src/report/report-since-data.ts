/** The trailing-window half of the usage report's collection: read the harness's event log
 * over the `sinceMs` window and distill it into a `SinceReport` — run/token/commit/cost
 * totals plus features-done/cost maps and main-red tallies. Split out of
 * src/report/report-data.ts (which keeps the per-day `ReportData` series collector) so each
 * window collector owns its own helpers and its own shape: the day collector's zero-filled
 * series and backlog-file reads have no place in a window totals view, and the two change
 * for different reasons. The event-log folding both collectors share lives in
 * src/report/report-usage-fold.ts (foldUsageEvent) and src/report/report-fold.ts (the windowed
 * cache and scope helpers), the shapes they produce in src/report/report-types.ts, and the
 * Markdown rendering in src/report/report-since-render.ts (which imports the shared formatting
 * voice from src/report/report-render.ts). */
import { assertReportSinceMs, eventWindowCovers, readWindowEvents, sinceWindowTiming } from "../events/event-window.js";
import { dayKey } from "../text/datetime.js";
import { addTo } from "../collections.js";
import {
  nonemptyObj,
  roleSum,
  scopeBases,
  scopedByRole,
  zeroCommitCounts,
  zeroMergeCounts,
} from "./report-fold.js";
import { foldUsageEvent, type UsageFold } from "./report-usage-fold.js";
import { mainRedCulpritsByDay, mainRedFailingTestsByDay, mainRedMinutesByDay } from "./report-main-red.js";
import type { ReportTotals, SinceReport } from "./report-types.js";

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
  const { raw, acc } = foldSinceWindow(root, cutoff, now, end, untilMs);
  // The empty-window branch of the shared proof matters here: with no retained events nothing
  // can have rotated away, and printing a rotation note over a fresh install would claim a
  // history that never existed. When neither proof holds, the oldest retained event lies inside
  // the window and the render notes the possible truncation.
  const coversFullWindow = eventWindowCovers(raw, cutoff);
  // Role scope: every map and total below derives from the fold's per-role maps for the named
  // base roles alone — merge usage (the merge slot's, not the role's) and the team-only
  // fields stay out, so a scoped --since report sums exactly the same events the scoped day
  // report would. The scope is the base roles, so instances (`feature-2`) aggregate into their
  // group as the cap does.
  const bases = scopeBases(role);
  return {
    ...slice,
    ...(bases === undefined ? {} : { role: bases.join(",") }),
    totals: sinceScopedTotals(acc, bases),
    ...sinceRoleMaps(acc, bases),
    // Main's red time is main's own (G1's rule), not any role's, so a role-scoped window
    // carries 0 — the type's always-present default for the team-only field.
    mainRedMs:
      bases === undefined
        ? [...mainRedMinutesByDay(raw.events, cutoff, end).values()].reduce((a, b) => a + b, 0)
        : 0,
    ...nonemptyObj("mainRedByTest", sinceMainRedByTest(raw, cutoff, end, bases)),
    ...nonemptyObj("mainRedByCulprit", sinceMainRedByCulprit(raw, cutoff, end, bases)),
    coversFullWindow,
  };
}

/** The window's event read and fold, one function so the read happens exactly once per window
 * and every downstream builder — the coverage proof and the main-red by-test/by-culprit maps
 * — consumes the same `raw`. `raw` is the one day-keyed log read the whole report is built on
 * (its `events` feed both the `acc` fold below and the red maps), so its retention-backed
 * coverage and its event set cannot disagree across the builders. */
function foldSinceWindow(
  root: string,
  cutoff: number,
  now: number,
  end: number,
  untilMs: number | undefined,
): { raw: ReturnType<typeof readWindowEvents>; acc: UsageFold } {
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
    tokensByRole: {},
    promptTokensByRole: {},
    cacheReadTokensByRole: {},
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
  return { raw, acc };
}

/** The window's `totals` group under both scope rules, named so the team-vs-role branch reads
 * as one function instead of a ternary buried in the return: the team figure sums the merge-slot
 * fields in (the merge slot's dash tokens/cost are the same team spend the budget charges), while
 * the role branch sums just the base roles through `roleSum` and zeroes the merge counts — a
 * role's merge usage is the merge slot's, not the role's. */
function sinceScopedTotals(acc: UsageFold, bases: string[] | undefined): ReportTotals {
  return bases === undefined
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
}

/** Flatten a per-day main-red record map (day → label → count) into one flat label→count map,
 * the shared body of sinceMainRedByTest and sinceMainRedByCulprit. Main's red state is main's
 * own, not any role's, so a role-scoped window carries none — the empty map `nonemptyObj` then
 * omits from the JSON, keeping a red-free --since byte-identical to today. */
function flattenMainRedByDay(
  perDay: ReadonlyMap<string, Record<string, number>>,
  bases: string[] | undefined,
): Record<string, number> {
  if (bases !== undefined) return {};
  const flat: Record<string, number> = {};
  for (const record of perDay.values()) {
    for (const [label, n] of Object.entries(record)) addTo(flat, label, n);
  }
  return flat;
}

/** Main's red failing tests over the window, flattened across the per-day records of the same
 * red `main_check` events the red time uses (G1's rule) into one map. Main's failing tests are
 * main's own, not any role's, so a role-scoped window carries none (see flattenMainRedByDay). */
function sinceMainRedByTest(
  raw: ReturnType<typeof readWindowEvents>,
  cutoff: number,
  end: number,
  bases: string[] | undefined,
): Record<string, number> {
  return flattenMainRedByDay(mainRedFailingTestsByDay(raw.events, cutoff, end), bases);
}

/** Main's red culprits over the window, flattened across the per-day records of the same red
 * `main_culprit` events the live `mainred` alert's `red.culprit` reads (the historical twin)
 * into one map. Main's own blame, not any role's, so a role-scoped window carries none (see
 * flattenMainRedByDay). */
function sinceMainRedByCulprit(
  raw: ReturnType<typeof readWindowEvents>,
  cutoff: number,
  end: number,
  bases: string[] | undefined,
): Record<string, number> {
  return flattenMainRedByDay(mainRedCulpritsByDay(raw.events, cutoff, end), bases);
}

/** The `SinceReport` return's role-scoped map group — every field a reader names when asking
 * "which fields are team-only?": each `scopedByRole` call applies the base-role scope (the
 * rule `collectReportSince`'s `bases` comment spells), so a role-scoped window shows exactly
 * the maps the scoped day report would, and the team-only fields (providers, backends, models,
 * deferred reasons) carry full maps for the team or empty maps for a scoped role. */
function sinceRoleMaps(
  acc: UsageFold,
  bases: string[] | undefined,
): Pick<
  SinceReport,
  | "runsByRole"
  | "costByRole"
  | "rejectionsByRole"
  | "postMergeRejectionsByRole"
  | "revisionsByRole"
  | "refusalsByRole"
  | "failedRunsByRole"
  | "fallbacksByRole"
  | "tokensByRole"
  | "commitsByRole"
  | "mergedByRole"
  | "mergeFailedByRole"
  | "mergeFailedByReason"
  | "costByProvider"
  | "notionalByProvider"
  | "runsByModel"
> &
  Partial<
    Pick<
      SinceReport,
      | "promptTokensByRole"
      | "cacheReadTokensByRole"
      | "notionalByRole"
      | "notionalByBackend"
      | "deferredByReason"
    >
  > {
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
    runsByRole: scopedByRole(acc.runsByRole, bases),
    costByRole: scopedByRole(acc.costByRole, bases),
    rejectionsByRole: scopedByRole(acc.rejectionsByRole, bases),
    postMergeRejectionsByRole: scopedByRole(acc.postMergeRejectionsByRole, bases),
    revisionsByRole: scopedByRole(acc.revisionsByRole, bases),
    refusalsByRole: scopedByRole(acc.refusalsByRole, bases),
    failedRunsByRole: scopedByRole(acc.failedRunsByRole, bases),
    fallbacksByRole: scopedByRole(acc.fallbacksByRole, bases),
    tokensByRole: scopedByRole(acc.tokensByRole, bases),
    ...nonemptyObj("promptTokensByRole", scopedByRole(acc.promptTokensByRole, bases)),
    ...nonemptyObj("cacheReadTokensByRole", scopedByRole(acc.cacheReadTokensByRole, bases)),
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
  };
}
