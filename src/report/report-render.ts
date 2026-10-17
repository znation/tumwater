// vocabulary: plain
/** The usage report's Markdown render: turn a collected `ReportData` (src/report/report-data.ts)
 * into the bounded Markdown the CLI prints and the TUI usage pane reuses (pure function of the
 * data — no I/O, no clock reads — so the bounds argued at collection hold here unchanged). The
 * command half (cmdReport) lives in report.ts, alongside it in src/report/. report-render.ts
 * sits beside src/failure/failure-render.ts — the failure digest's Markdown render of the same
 * shape — because it is a pure render with no ink or UI dependency, and core modules
 * (collections.ts, history-data.ts) name it in their contracts. */
import type { ReportData, ReportDay, ReportTotals, SinceReport } from "./report-data.js";
import { addTo, compareCodeUnits, rankCountEntries } from "../collections.js";
import { compactTokens, usd } from "../text/format.js";
import { durationLabel } from "../cli/cli-args.js";
import { monthDay, reportWindow, sinceWindowLine } from "../text/datetime.js";
import { eventsRotationLabel } from "../events/events.js";
import { SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { markdownTable } from "../text/markdown.js";
import { baseRoleOf } from "../roles/loop-ids.js";

/** Bar width for one day: up to 20 blocks scaled to the window's max tokensOut —
 * round(20·v/max), min 1 when v > 0. */
function barWidth(v: number, max: number): number {
  if (v <= 0) return 0;
  return Math.max(1, Math.round((20 * v) / max));
}

/** Rank one role map by total desc then name asc so identical totals render deterministically —
 * collections.ts's rank rule, so the report cannot drift from the other counters that rank the
 * same way.
 * Callers filter/format the ranked pairs. */
function rankedRoleMap(totals: Record<string, number>): [string, number][] {
  return rankCountEntries(Object.entries(totals));
}

/** Window totals per role: fold the per-day role maps (any `Record<string, number>` day field,
 * e.g. runsByRole or costByRole) across the series, then rank through rankedRoleMap.
 * Callers filter/format the ranked pairs. */
function rankedRoleTotals(series: ReportDay[], pick: (d: ReportDay) => Record<string, number>): [string, number][] {
  const totals: Record<string, number> = {};
  for (const d of series) {
    for (const [role, n] of Object.entries(pick(d))) addTo(totals, role, n);
  }
  return rankedRoleMap(totals);
}

/** One "**Label:** role — n · role — n" Markdown line from already-ranked pairs; an empty
 * pair list (an all-zero window) renders "-". fmt formats each role's number. */
function rankedRoleLine(label: string, pairs: [string, number][], fmt: (n: number) => string): string {
  return `**${label}:** ${pairs.length === 0 ? "-" : pairs.map(([r, n]) => `${r} — ${fmt(n)}`).join(" · ")}`;
}

/** Push the `Cost by provider` and `Estimated by provider` lines of the per-provider spend
 * breakdown (plans: per-provider spend), from the caller's already-ranked real- and notional-
 * spend pairs. Role scoping is the caller's `role === undefined` gate — this helper only
 * renders. Zero-means-absent: a provider with no spend prints no line, and both lanes format
 * with usd so the day and --since windows cannot drift (the --since path ranks via rankedRoleMap,
 * the day path via rankedRoleTotals). */
function pushProviderCostLines(
  lines: string[],
  rankCost: () => [string, number][],
  rankNotional: () => [string, number][],
): void {
  const providers = rankCost().filter(([, c]) => c > 0);
  if (providers.length > 0) lines.push(rankedRoleLine("Cost by provider", providers, usd));
  const notionalProviders = rankNotional().filter(([, c]) => c > 0);
  if (notionalProviders.length > 0) lines.push(rankedRoleLine("Estimated by provider", notionalProviders, usd));
}

/** The "**Totals:** …" line both renders print — one home so field order, units, and the ·
 * separators cannot drift between the day report and the --since window. `tail` carries the
 * cells only one shape has: the day report's features/bugs counts (a sub-day window cannot
 * subdivide their day-granular dates, so the --since render passes nothing). */
function totalsLine(t: ReportTotals, tail = ""): string {
  return `**Totals:** ${compactTokens(t.tokensOut)} output tokens · ${t.runs} runs · ${t.commits} commits · ${usd(t.costUsd)}${tail}`;
}

/** The "of which landing runs …" line under a totals line — one home for the landing share's
 * wording. The caller decides when it prints: zero-means-absent, so a team with no landing
 * spend renders exactly as before (the budget charges the landing slot's runs too, so the
 * totals include them — this line says how much of the spend was reviewer + conflict
 * resolution work). */
function landingShareLine(t: ReportTotals): string {
  const failed = (t.mergeFailed ?? 0) > 0 ? ` (${t.mergeFailed} failed)` : "";
  return `of which merge runs: ${t.mergeRuns} runs${failed} · ${compactTokens(t.mergeTokens)} tokens · ${usd(t.mergeCostUsd)} (reviewer + conflict resolution)`;
}

/** The notional-spend line (plans/agent-backends.md part 6a): the API-equivalent cost of
 * claude.ai subscription runs folded into the window. Never part of the totals' costUsd,
 * because a subscription run is exempt from the daily dollar cap; the caller prints it only
 * when a subscription run actually folded in (zero means absent, like the landing line), so
 * an API-only team's report is unchanged. */
function notionalLine(t: ReportTotals): string {
  return `claude subscription, API-equivalent: ${usd(t.notionalCostUsd ?? 0)} estimated`;
}

/** The scope note a `--role` report prints: landing runs belong to the landing slot and the
 * features-done/bugs-fixed tallies come from day-granular backlog-file dates, so neither can
 * be scoped to a role and both are omitted from the scoped totals. Shared by the day and
 * --since renders so the two say the same thing. */
const ROLE_SCOPE_NOTE =
  "role scope: merge runs and backlog tallies (features done / bugs fixed) are team-wide and omitted";

/** The summary block both report shapes print, in the same order: the totals line (carrying
 * the caller's extra `tail` cells), the landing-share line and the notional line when each is
 * nonzero (zero means absent, so an API-only or landing-free window renders as before), and the
 * role-scope note when the report is scoped. One home so the day report and the --since window
 * cannot drift on the order, the omission predicates, or the scope note. */
function pushReportSummary(lines: string[], t: ReportTotals, tail = "", scoped = false): void {
  lines.push(totalsLine(t, tail));
  if (t.mergeRuns > 0) lines.push(landingShareLine(t));
  if ((t.notionalCostUsd ?? 0) > 0) lines.push(notionalLine(t));
  if (scoped) lines.push(ROLE_SCOPE_NOTE);
}

/** Render a trailing-window totals report as Markdown — the aggregate sibling of the
 * `logs --since` raw stream ("how much" here, "what exactly" there). Pure function of
 * SinceReport: no I/O, no clock reads (the window line's local time is rendered from the
 * collector's captured cutoff, so the printed window matches the aggregated one). */
export function renderSinceReportMarkdown(data: SinceReport): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(sinceWindowLine(durationLabel(data.sinceMs), data.fromIso));
  if (data.role !== undefined) lines.push(`role: ${data.role}`);
  lines.push("");
  const t = data.totals;
  // Same totals voice as the day report, minus the features/bugs cells: those tallies come
  // from day-granular backlog-file dates that cannot subdivide a sub-day window, so the final
  // line below states the omission instead of showing a day-rounded number.
  pushReportSummary(lines, t, "", data.role !== undefined);
  lines.push("");
  lines.push(rankedRoleLine("Runs by role", rankedRoleMap(data.runsByRole), String));
  // Same breakdown for token spend: ranked by tokens desc then name asc, zero-token roles
  // omitted — an all-zero window renders "-" like the other lines. Output tokens are the
  // resource the budget charges, so this is the line an operator reads to find which role's
  // prompt loop burned the window's tokens.
  lines.push(rankedRoleLine("Tokens by role", rankedRoleMap(data.tokensByRole).filter(([, n]) => n > 0), compactTokens));
  // Same breakdown for spend: ranked by spend desc then name asc, zero-spend roles omitted —
  // an all-zero window renders "-" like the ticks line.
  lines.push(rankedRoleLine("Cost by role", rankedRoleMap(data.costByRole).filter(([, c]) => c > 0), usd));
  // The same breakdown per PROVIDER (plans: per-provider spend), gated to the team report
  // like its day sibling. SinceReport.costByProvider is always present (empty when none), so
  // the zero-means-absent gate prints no line for a window with no provider spend.
  if (data.role === undefined) {
    pushProviderCostLines(lines, () => rankedRoleMap(data.costByProvider), () => rankedRoleMap(data.notionalByProvider));
  }
  // The same breakdown for review friction: rejections per role from review_rejected events;
  // a window with none renders "-" like the other lines.
  lines.push(rankedRoleLine("Rejections by role", rankedRoleMap(data.rejectionsByRole).filter(([, r]) => r > 0), String));
  lines.push(rankedRoleLine("Revisions by role", rankedRoleMap(data.revisionsByRole).filter(([, r]) => r > 0), String));
  // The same breakdown for outright failures: error-class run_ends per role under the
  // digest's OUTCOME_CLASS — the ticks that burned agent time and landed nothing without
  // going through review, which rejections/revisions would miss entirely. A window with
  // none renders "-" like the other lines.
  lines.push(rankedRoleLine("Failed runs by role", rankedRoleMap(data.failedRunsByRole).filter(([, n]) => n > 0), String));
  lines.push(rankedRoleLine("Fallbacks by role", rankedRoleMap(data.fallbacksByRole).filter(([, n]) => n > 0), String));
  lines.push(rankedRoleLine("Image reroutes by role", rankedRoleMap(data.imageReroutesByRole).filter(([, n]) => n > 0), String));
  // The landed-commits split by base role, matching the day render's unfiltered line: the
  // window's totals.commits carries the count; this line says which role's commits it was.
  lines.push(rankedRoleLine("Commits by role", rankedRoleMap(data.commitsByRole), String));
  // The landed-outcomes split by base role, mirroring the day render's line: which roles'
  // changes reach main and which bounce off the gate (merge_failed). Gated to the team
  // report — a role-scoped window omits landing (ROLE_SCOPE_NOTE), so the per-role
  // attribution would contradict it. Zero-means-absent: the failures line prints only when
  // some role has one; a landing-free window renders `-` like the other lines.
  if (data.role === undefined) {
    lines.push(rankedRoleLine("Merged by role", rankedRoleMap(data.mergedByRole), String));
    const landingFailures = rankedRoleMap(data.mergeFailedByRole).filter(([, n]) => n > 0);
    if (landingFailures.length > 0)
      lines.push(rankedRoleLine("Merge failures by role", landingFailures, String));
  }
  // Subscription spend is notional: its own line, only when the window has any — the same
  // conditional/filtered `usd` form the day render's "Estimated by role" uses.
  if (data.notionalByRole !== undefined) {
    lines.push(rankedRoleLine("Estimated by role", rankedRoleMap(data.notionalByRole).filter(([, c]) => c > 0), usd));
  }
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
    lines.push("backlog tallies (features done / bugs fixed) need the day report (--days)");
  return lines.join("\n");
}

/** Cost per landed commit by base role. Spend comes from costByRole (keyed by loop id, folded to
 * its base role so `feature-2` joins `feature`), commits from commitsByRole (already base-role
 * keyed). `landed` is [role, cost per commit, commits] for roles with both, ranked by cost per
 * commit desc then name asc; `idle` is roles that spent and landed nothing, ranked by spend.
 * Landing spend (the reviewer's) and notional subscription spend stay out by default, matching
 * `**Cost by role:**` (`pick` selects another per-loop-id spend map, e.g. notionalByRole); a
 * role with commits but no spend in the picked map appears in neither list. */
function costPerCommitPairs(
  series: ReportDay[],
  pick: (d: ReportDay) => Record<string, number> = (d) => d.costByRole,
): { landed: [string, number, number][]; idle: [string, number][] } {
  const cost: Record<string, number> = {};
  const commits: Record<string, number> = {};
  for (const d of series) {
    for (const [id, c] of Object.entries(pick(d))) addTo(cost, baseRoleOf(id), c);
    for (const [role, n] of Object.entries(d.commitsByRole ?? {})) addTo(commits, role, n);
  }
  const landed: [string, number, number][] = [];
  const idleCost: [string, number][] = [];
  for (const [role, c] of Object.entries(cost)) {
    if (c <= 0) continue;
    const n = commits[role] ?? 0;
    if (n > 0) landed.push([role, c / n, n]);
    else idleCost.push([role, c]);
  }
  landed.sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]));
  return { landed, idle: rankCountEntries(idleCost) };
}

/** One `**<label>:** …` line from costPerCommitPairs output; `-` when there is nothing. */
function costPerCommitLine(label: string, pairs: ReturnType<typeof costPerCommitPairs>): string {
  const parts = [
    ...pairs.landed.map(([r, per, n]) => `${r} — ${usd(per)} (${n})`),
    ...pairs.idle.map(([r, c]) => `${r} — ${usd(c)}, no commits`),
  ];
  return `**${label}:** ${parts.length === 0 ? "-" : parts.join(" · ")}`;
}

/** Render a report as Markdown — the pinned shape the CLI prints and the TUI usage pane
 * (report 3/3) reuses; the GUI tab (report 2/3) renders its own SVG charts from the same
 * ReportData instead. Pure function of ReportData: no I/O, no clock reads. */
export function renderReportMarkdown(data: ReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(reportWindow(data.from, data.to, data.days, eventsRotationLabel()));
  if (data.role !== undefined) lines.push(`role: ${data.role}`);
  lines.push("");
  const t = data.totals;
  // A role-scoped report drops the team-only features/bugs cells from the totals line — their
  // dates carry no role — and states the omission through ROLE_SCOPE_NOTE below instead.
  const tail =
    data.role === undefined ? ` · ${t.featuresDone} features done · ${t.bugsFixed} bugs fixed` : "";
  pushReportSummary(lines, t, tail, data.role !== undefined);
  lines.push("");
  const maxTokens = data.series.reduce((m, d) => Math.max(m, d.tokensOut), 0);
  lines.push(
    ...markdownTable(
      ["day", "tokens out", "runs", "commits", "cost"],
      data.series.map((d) => {
        const ticks = Object.values(d.runsByRole).reduce((a, b) => a + b, 0);
        const w = maxTokens > 0 ? barWidth(d.tokensOut, maxTokens) : 0;
        const bar = w > 0 ? ` ${"█".repeat(w)}` : ""; // Zero days carry no bar (and no stray space).
        return [monthDay(d.date), `${compactTokens(d.tokensOut)}${bar}`, String(ticks), String(d.commits), usd(d.costUsd)];
      }),
      ["left", "right", "right", "right", "right"],
    ),
  );
  lines.push("");
  lines.push(rankedRoleLine("Runs by role", rankedRoleTotals(data.series, (d) => d.runsByRole), String));
  // The same breakdown for output tokens (the resource the budget charges): window totals per
  // role from tokensByRole, ranked like the ticks line. Zero-token roles are omitted; an
  // all-zero window renders "-" like the ticks line.
  lines.push(rankedRoleLine("Tokens by role", rankedRoleTotals(data.series, (d) => d.tokensByRole ?? {}).filter(([, n]) => n > 0), compactTokens));
  // The same breakdown for spend: window totals per role from costByRole, ranked by spend
  // desc then name asc — spend is what the operator acts on (an operator tuning per-role
  // intervals wants the burning loop first, not the busiest one). Zero-spend roles are
  // omitted; an all-zero window renders "-" like the ticks line.
  lines.push(rankedRoleLine("Cost by role", rankedRoleTotals(data.series, (d) => d.costByRole).filter(([, c]) => c > 0), usd));
  // The same breakdown per PROVIDER (plans: per-provider spend): which seam of a mixed team
  // spent what, straight from the events' providerCost maps (run_end's own runs and the
  // landing's reviewer seam). Gated to the team report — a provider is not a role, so a
  // role-scoped report omits it (ROLE_SCOPE_NOTE covers the omission). Zero-means-absent: a
  // window with no provider spend prints no line. Ranked and formatted exactly like Cost by
  // role.
  if (data.role === undefined) {
    pushProviderCostLines(
      lines,
      () => rankedRoleTotals(data.series, (d) => d.costByProvider ?? {}),
      () => rankedRoleTotals(data.series, (d) => d.notionalByProvider ?? {}),
    );
  }
  // The same breakdown for review friction: window rejections per role from review_rejected
  // events, ranked like the ticks line; a window with none renders "-".
  lines.push(rankedRoleLine("Rejections by role", rankedRoleTotals(data.series, (d) => d.rejectionsByRole ?? {}).filter(([, r]) => r > 0), String));
  lines.push(rankedRoleLine("Revisions by role", rankedRoleTotals(data.series, (d) => d.revisionsByRole ?? {}).filter(([, r]) => r > 0), String));
  // The same breakdown for outright failures: error-class run_ends per role under the
  // digest's OUTCOME_CLASS — ticks that burned agent time and landed nothing without going
  // through review, which rejections/revisions would miss entirely. Zero-means-absent, so a
  // failure-free window renders no line and an all-zero window renders "-" like the others.
  lines.push(rankedRoleLine("Failed runs by role", rankedRoleTotals(data.series, (d) => d.failedRunsByRole ?? {}).filter(([, n]) => n > 0), String));
  lines.push(rankedRoleLine("Fallbacks by role", rankedRoleTotals(data.series, (d) => d.fallbacksByRole ?? {}).filter(([, n]) => n > 0), String));
  lines.push(rankedRoleLine("Image reroutes by role", rankedRoleTotals(data.series, (d) => d.imageReroutesByRole ?? {}).filter(([, n]) => n > 0), String));
  // Work ratio 4/4: the landed commits split by base role and by tier. The totals line's
  // `commits` carries the count; these lines say who made it and how much of it was work.
  lines.push(rankedRoleLine("Commits by role", rankedRoleTotals(data.series, (d) => d.commitsByRole ?? {}), String));
  // The landed-outcomes split by base role: which authoring roles' changes reach main through
  // the landing slot, and — the new signal — which roles' changes bounce off the gate (a
  // merge_failed: review rejection, under-cap review, a conflict, a blocked fast-forward, a
  // shutdown abort). Gated to the team report — a role-scoped report omits landing runs
  // (they are the landing slot's, per ROLE_SCOPE_NOTE), so the per-role attribution would
  // contradict that stance. Zero-means-absent: a window with landings renders Merged by role;
  // the failures line prints only when some role actually has one.
  if (data.role === undefined) {
    const landed = rankedRoleTotals(data.series, (d) => d.mergedByRole ?? {});
    lines.push(rankedRoleLine("Merged by role", landed, String));
    const landingFailures = rankedRoleTotals(data.series, (d) => d.mergeFailedByRole ?? {}).filter(([, n]) => n > 0);
    if (landingFailures.length > 0)
      lines.push(rankedRoleLine("Merge failures by role", landingFailures, String));
  }
  lines.push(costPerCommitLine("Cost per commit", costPerCommitPairs(data.series)));
  // Subscription spend is notional: its own two lines, only when the window has any.
  if ((t.notionalCostUsd ?? 0) > 0) {
    const notionalOf = (d: ReportDay): Record<string, number> => d.notionalByRole ?? {};
    lines.push(rankedRoleLine("Estimated by role", rankedRoleTotals(data.series, notionalOf).filter(([, c]) => c > 0), usd));
    lines.push(costPerCommitLine("Estimated per commit", costPerCommitPairs(data.series, notionalOf)));
  }
  // Commits per backlog item is day-granular backlog data (features done + bugs fixed), so it
  // belongs only to the day report; zero items means the denominator is absent, not NaN.
  const items = t.featuresDone + t.bugsFixed;
  const perItem = items > 0 ? ` · ${(t.commits / items).toFixed(1)} commits per backlog item` : "";
  lines.push(`**Commits:** ${t.workCommits ?? 0} work / ${t.maintenanceCommits ?? 0} maintenance${perItem}`);
  // The shared SPARSE_WINDOW_NOTE (one voice across the report's two windows and the other
  // windowed renders): covered is false only when events were aggregated from a log whose
  // oldest retained event lies inside the window, so the hedged sentence stays true whenever
  // it prints — an empty or fully covered log never claims a history it cannot see.
  if (!data.coversFullWindow) lines.push("", SPARSE_WINDOW_NOTE);
  return lines.join("\n");
}
