/** Fixtures for the report data shape (src/report/report-types.ts's `ReportData` / `ReportTotals`),
 * shared by the report test files so the all-zero window totals live in one place. */
import type { ReportData } from "../../src/report/report-types.js";

/** A fresh all-zero `ReportData["totals"]` — every required field zero, the optional fields
 * absent. Returned as a new object each call so a test mutating it cannot leak into another.
 * The report test files' one home of the all-zero window totals: gui-client-report.test.ts,
 * gui-report.test.ts and report.test.ts each build their stand-in days/ReportData with it. A
 * totals that also carries a real value (a window with spend, or an extra field such as
 * plansAdded / a conditional notionalCostUsd spread) is a value, not a stand-in, and stays an
 * inline literal. */
export function zeroReportTotals(): ReportData["totals"] {
  return {
    tokensOut: 0,
    runs: 0,
    commits: 0,
    costUsd: 0,
    featuresDone: 0,
    bugsFixed: 0,
    mergeRuns: 0,
    mergeTokens: 0,
    mergeCostUsd: 0,
  };
}
