/** The trailing-window half of the usage report's Markdown render: turn a collected `SinceReport`
 * (src/report/report-since-data.ts) into the bounded Markdown the CLI's `report --since` and the
 * TUI usage pane print. Split out of src/report/report-render.ts (which keeps the per-day
 * `ReportData` renderer), mirroring the collection split (report-data.ts / report-since-data.ts),
 * so each window's renderer owns its own `pushSince*`/`pushReport*` assembly. The shared
 * formatting voice — the ranked lines, the totals/notional/scope summary, the cost-per-commit
 * core — stays in src/report/report-render.ts, and both renderers call the same helpers so the
 * day report and the --since window cannot drift. Pure function of SinceReport: no I/O, no clock
 * reads (the window line's local time is rendered from the collector's captured cutoff, so the
 * printed window matches the aggregated one). */
import type { SinceReport } from "./report-types.js";
import { compactTokens, usd } from "../text/format.js";
import { durationLabel } from "../cli/cli-args.js";
import { boundedWindowLine, sinceWindowLine } from "../text/datetime.js";
import { SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { foldBaseRoles } from "./report-fold.js";
import {
  rankedRoleMap,
  rankedRoleLine,
  promptTokensLine,
  pushRankedRoleLine,
  pushPresentRankedLine,
  pushProviderCostLines,
  pushReportSummary,
  costPerCommitPairsFrom,
  costPerCommitLine,
} from "./report-render.js";

/** Render a trailing-window totals report as Markdown — the aggregate sibling of the
 * `logs --since` raw stream ("how much" here, "what exactly" there). Pure function of
 * SinceReport: no I/O, no clock reads (the window line's local time is rendered from the
 * collector's captured cutoff, so the printed window matches the aggregated one). */
export function renderSinceReportMarkdown(data: SinceReport): string {
  const lines: string[] = [];
  pushSinceWindowHeader(lines, data);
  pushSinceSummary(lines, data);
  pushSinceRoleLines(lines, data);
  pushSinceProviderModelLines(lines, data);
  pushSinceMainRedLines(lines, data);
  pushSinceFrictionLines(lines, data);
  pushSinceDeferralLines(lines, data);
  pushSinceCommitLines(lines, data);
  pushSinceCostLines(lines, data);
  pushSinceCoverageLines(lines, data);
  return lines.join("\n");
}

/** The window header: the title, the bounded-or-since window line and the role scope line. */
function pushSinceWindowHeader(lines: string[], data: SinceReport): void {
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(
    data.untilMs !== undefined && data.toIso !== undefined
      ? boundedWindowLine(durationLabel(data.sinceMs), durationLabel(data.untilMs), data.fromIso, data.toIso)
      : sinceWindowLine(durationLabel(data.sinceMs), data.fromIso),
  );
  if (data.role !== undefined) lines.push(`role: ${data.role}`);
  lines.push("");
}

/** The shared totals voice (minus features/bugs/filing cells, stated at the tail), gated
 * to the team report like the day sibling's. */
function pushSinceSummary(lines: string[], data: SinceReport): void {
  const t = data.totals;
  // Same totals voice as the day report, minus the features/bugs and filing cells: those tallies
  // come from day-granular backlog-file dates that cannot subdivide a sub-day window, so the
  // final line below states the omission instead of showing a day-rounded number.
  pushReportSummary(lines, t, "", data.role !== undefined);
  lines.push("");
}

/** Runs / tokens / prompt-tokens / cost breakdowns by role. */
function pushSinceRoleLines(lines: string[], data: SinceReport): void {
  lines.push(rankedRoleLine("Runs by role", rankedRoleMap(data.runsByRole), String));
  // Same breakdown for token spend: ranked by tokens desc then name asc, zero-token roles
  // omitted — an all-zero window renders "-" like the other lines. Output tokens are the
  // resource the budget charges, so this is the line an operator reads to find which role's
  // prompt loop burned the window's tokens.
  pushRankedRoleLine(lines, "Tokens by role", rankedRoleMap(data.tokensByRole), compactTokens);
  // The prompt side of the same breakdown, straight after the output-token line: how many
  // prompt tokens each role sent and the share of them its backend served from cache — the
  // input side of the bill an operator cannot see from Tokens by role. Zero-prompt roles are
  // omitted, and an all-zero window renders "-" like the sibling lines.
  lines.push(
    promptTokensLine(
      rankedRoleMap(data.promptTokensByRole ?? {}),
      rankedRoleMap(data.cacheReadTokensByRole ?? {}),
    ),
  );
  // Same breakdown for spend: ranked by spend desc then name asc, zero-spend roles omitted —
  // an all-zero window renders "-" like the runs line.
  pushRankedRoleLine(lines, "Cost by role", rankedRoleMap(data.costByRole), usd);
}

/** The provider cost lines and the per-model line, gated to the team report. */
function pushSinceProviderModelLines(lines: string[], data: SinceReport): void {
  // The same breakdown per PROVIDER (plans: per-provider spend), gated to the team report
  // like its day sibling. SinceReport.costByProvider is always present (empty when none), so
  // the zero-means-absent gate prints no line for a window with no provider spend.
  if (data.role === undefined) {
    pushProviderCostLines(lines, () => rankedRoleMap(data.costByProvider), () => rankedRoleMap(data.notionalByProvider));
    // The same breakdown per MODEL (each run_start's agent-qualified selector — the model a
    // team mixing providers, per-role overrides and fallbacks actually ran on), gated to the
    // team report like the provider lines: a model is not a role, so a role-scoped window
    // omits it. SinceReport.runsByModel is always present, so a window with no modelled
    // start prints no line (keeping a model-less day's output unchanged), exactly as the
    // provider lines stay absent when no provider spent.
    pushPresentRankedLine(lines, "Runs by model", rankedRoleMap(data.runsByModel));
  }
}

/** Main's red time and the test/merge culprits behind it, gated like the day sibling. */
function pushSinceMainRedLines(lines: string[], data: SinceReport): void {
  // Main's red wall-clock over the window (main's own, not any role's — a role-scoped
  // collector carries 0, so this never prints for a scoped window). Zero-absent: no line for
  // a window main was never red.
  if (data.mainRedMs > 0) lines.push(`**Main red:** ${durationLabel(data.mainRedMs)}`);
  // The same "what kept main red" detail named by failing test — which tests main's own red
  // checks named over the window. Team-only like main's red time, so a role-scoped window
  // omits it; zero-absent: no line when the window's red checks named no test.
  if (data.role === undefined) {
    pushPresentRankedLine(lines, "Main red by test", rankedRoleMap(data.mainRedByTest ?? {}));
    // The same "what kept main red" detail named by merge — the landed merges the watch's
    // own main_culprit events blamed, mirroring the failing-test line right above. Team-only
    // like main's red time and zero-absent: no line when the window blamed no merge.
    pushPresentRankedLine(lines, "Main red by merge", rankedRoleMap(data.mainRedByCulprit ?? {}));
  }
}

/** The review-friction and failed-run breakdowns by role. */
function pushSinceFrictionLines(lines: string[], data: SinceReport): void {
  // The same breakdown for review friction: rejections per role from review_rejected events;
  // a window with none renders "-" like the other lines. The post-merge line is the
  // afterMerge: true subset — rejections that reached an already-merged commit.
  pushRankedRoleLine(lines, "Rejections by role", rankedRoleMap(data.rejectionsByRole));
  pushRankedRoleLine(lines, "Post-merge rejections by role", rankedRoleMap(data.postMergeRejectionsByRole));
  pushRankedRoleLine(lines, "Revisions by role", rankedRoleMap(data.revisionsByRole));
  pushRankedRoleLine(lines, "Refusals by role", rankedRoleMap(data.refusalsByRole));
  // The same breakdown for outright failures: error-class run_ends per role under the
  // digest's OUTCOME_CLASS — the runs that burned agent time and merged nothing without
  // going through review, which rejections/revisions would miss entirely. A window with
  // none renders "-" like the other lines.
  pushRankedRoleLine(lines, "Failed runs by role", rankedRoleMap(data.failedRunsByRole));
}

/** Deferred maintenance runs by reason code, gated to the team report. */
function pushSinceDeferralLines(lines: string[], data: SinceReport): void {
  // Deferred maintenance runs per reason code, the --since twin of the day render's line:
  // how many due maintenance runs stood down and why (backlog / no-work / plans-full).
  // Gated to the team report — a reason is not a role, so a role-scoped window omits it.
  // Zero-means-absent: a window with no deferral prints no line.
  if (data.role === undefined) {
    pushPresentRankedLine(lines, "Deferred runs by reason", rankedRoleMap(data.deferredByReason ?? {}));
  }
}

/** Commits by role and the merged/merge-failure split, gated to the team report. */
function pushSinceCommitLines(lines: string[], data: SinceReport): void {
  // The merged-commits split by base role, matching the day render's unfiltered line: the
  // window's totals.commits carries the count; this line says which role's commits it was.
  lines.push(rankedRoleLine("Commits by role", rankedRoleMap(data.commitsByRole), String));
  // The merged-outcomes split by base role, mirroring the day render's line: which roles'
  // changes reach main and which bounce off the gate (merge_failed). Gated to the team
  // report — a role-scoped window omits merge (ROLE_SCOPE_NOTE), so the per-role
  // attribution would contradict it. Zero-means-absent: the failures line prints only when
  // some role has one; a merge-free window renders `-` like the other lines.
  if (data.role === undefined) {
    lines.push(rankedRoleLine("Merged by role", rankedRoleMap(data.mergedByRole), String));
    pushPresentRankedLine(lines, "Merge failures by role", rankedRoleMap(data.mergeFailedByRole));
    // WHY the window's merges failed, from each merge_failed's result code — the day
    // report's reason twin of the role line above, so an operator can tell a review
    // rejection (fix the change) from a conflict/block (rebase) from a shutdown abort
    // (capacity). Ranked the same way (count desc then code asc), reason-free only.
    pushPresentRankedLine(lines, "Merge failures by reason", rankedRoleMap(data.mergeFailedByReason ?? {}));
  }
}

/** Cost/estimated per commit and the notional Estimated by role lines. */
function pushSinceCostLines(lines: string[], data: SinceReport): void {
  // Spend per merged commit, the --since twin of the day render's `Cost per commit:` line:
  // costByRole is keyed by role id (instances not folded, so `feature-2` joins `feature`),
  // commitsByRole is already base-role keyed. Prints for a spend-free window as `-` and for a
  // role-scoped window from its scoped maps, matching the day render.
  lines.push(costPerCommitLine("Cost per commit", costPerCommitPairsFrom(foldBaseRoles(data.costByRole), data.commitsByRole)));
  // Subscription spend is notional: its own line, only when the window has any — the same
  // conditional/filtered `usd` form the day render's "Estimated by role" uses.
  if (data.notionalByRole !== undefined) {
    pushRankedRoleLine(lines, "Estimated by role", rankedRoleMap(data.notionalByRole), usd);
    // The day render's `Estimated per commit:` twin, after `Estimated by role`, from the same
    // notionalByRole source folded to base roles and the base-keyed commitsByRole.
    lines.push(costPerCommitLine("Estimated per commit", costPerCommitPairsFrom(foldBaseRoles(data.notionalByRole), data.commitsByRole)));
  }
}

/** The trailing blank and the exactly-one coverage/backlog-omission note. */
function pushSinceCoverageLines(lines: string[], data: SinceReport): void {
  lines.push("");
  // Exactly one final line, chosen by the collector's coverage proof: either a hedged note
  // that stays true whenever it prints (the oldest retained event lies inside the window —
  // whether from rotation or a log born inside the window), or the one-time statement of the
  // backlog-tally omission. A flat "rotated out" claim would be false for a log that never
  // had the older events, so the wording names only what is provably the case. A role-scoped
  // report already states the omission in ROLE_SCOPE_NOTE, so it does not repeat the --days
  // pointer, which would imply a scoped day report shows the tallies it too omits.
  if (!data.coversFullWindow) lines.push(SPARSE_WINDOW_NOTE);
  else if (data.role === undefined)
    lines.push("backlog tallies (features done / bugs fixed / plans added / bugs filed) need the day report (--days)");
}
