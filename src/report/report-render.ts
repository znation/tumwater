/** The usage report's Markdown render: turn a collected `ReportData` (src/report/report-types.ts)
 * into the bounded Markdown the CLI prints and the TUI usage pane reuses (pure function of the
 * data — no I/O, no clock reads — so the bounds argued at collection hold here unchanged). The
 * command half (cmdReport) lives in report.ts, alongside it in src/report/. report-render.ts
 * sits beside src/failure/failure-render.ts — the failure digest's Markdown render of the same
 * shape — because it is a pure render with no ink or UI dependency, and core modules
 * (collections.ts, history-data.ts) name it in their contracts. */
import type { ReportData, ReportDay, ReportTotals, SinceReport } from "./report-types.js";
import { addTo, rankCountEntries, sortByValueDesc } from "../collections.js";
import { compactTokens, usd } from "../text/format.js";
import { durationLabel } from "../cli/cli-args.js";
import { boundedWindowLine, monthDay, reportWindow, sinceWindowLine } from "../text/datetime.js";
import { eventsRotationLabel } from "../events/events.js";
import { SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { shortSpanPhrase } from "../text/phrases.js";
import { markdownTable } from "../text/markdown.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { backendDisplayName } from "../agent/backend-traits.js";

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

/** Push one "**Label:** …" ranked-role line, dropping roles with a non-positive value (zero
 * count/spend) before rendering, so an all-zero window still renders "-" exactly like the
 * unfiltered lines. fmt formats each role's number (default String for count lines; pass
 * usd/compactTokens for spend/token lines). All the "X by role" lines share this filter-rule
 * home so the zero-means-render-dash guard cannot drift between the --since and day renders. */
function pushRankedRoleLine(
  lines: string[],
  label: string,
  pairs: [string, number][],
  fmt: (n: number) => string = String,
): void {
  lines.push(rankedRoleLine(label, pairs.filter(([, n]) => n > 0), fmt));
}

/** The per-day cameo line of the team day report — "MMM D <cell>" cells for each day that
 * carries a value, joined under a bold title, or undefined when no day has one (zero means
 * absent). The one home of that cameo rendering, shared by the per-day medians, the red-check
 * count and the main-red wall-clock lines so their date+cell shape and title line cannot drift.
 * Each caller supplies its own cell formatter (shortSpanPhrase for the medians, `×n` for the
 * red-check count, durationLabel for the main-red span). */
function dayCameoLine(
  series: ReportDay[],
  title: string,
  pick: (d: ReportDay) => number | undefined,
  fmt: (v: number) => string = shortSpanPhrase,
): string | undefined {
  const cells = series.flatMap((d) => {
    const v = pick(d);
    return v === undefined ? [] : [`${monthDay(d.date)} ${fmt(v)}`];
  });
  return cells.length > 0 ? `**${title}:** ${cells.join(" · ")}` : undefined;
}

/** Push a day-cameo line onto `lines` only when some day carries a value — the “compute a
 * cameo line, push it when present” boilerplate every per-day cell repeats. Renders via
 * dayCameoLine (the one cameo shape), so the date+cell shape and title line cannot drift.
 * Zero-means-absent: a day whose field is undefined renders no cell, and a series with no such
 * day pushes no line. */
function pushDayCameoLine(
  lines: string[],
  series: ReportDay[],
  title: string,
  pick: (d: ReportDay) => number | undefined,
  fmt: (v: number) => string = shortSpanPhrase,
): void {
  const line = dayCameoLine(series, title, pick, fmt);
  if (line !== undefined) lines.push(line);
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
 * cells only one shape has: the day report's features/bugs counts and the filing counts
 * (a sub-day window cannot subdivide their day-granular dates, so the --since render passes
 * nothing). */
function totalsLine(t: ReportTotals, tail = ""): string {
  return `**Totals:** ${compactTokens(t.tokensOut)} output tokens · ${t.runs} runs · ${t.commits} commits · ${usd(t.costUsd)}${tail}`;
}

/** The "of which merge runs …" line under a totals line — one home for the merge share's
 * wording. The caller decides when it prints: zero-means-absent, so a team with no merge
 * spend renders exactly as before (the budget charges the merge slot's runs too, so the
 * totals include them — this line says how much of the spend was reviewer + conflict
 * resolution work). */
function mergeShareLine(t: ReportTotals): string {
  const failed = (t.mergeFailed ?? 0) > 0 ? ` (${t.mergeFailed} failed)` : "";
  return `of which merge runs: ${t.mergeRuns} runs${failed} · ${compactTokens(t.mergeTokens)} tokens · ${usd(t.mergeCostUsd)} (reviewer + conflict resolution)`;
}

/** A float-robust "the per-backend notional sums account for the window's total" check: the two
 * numbers fold in different orders (per-event vs per-backend-then-summed), so their float traces
 * need not coincide exactly even when every subscription event is attributed — the gap lands
 * around machine epsilon. A small relative slack absorbs that reordering noise, while a genuinely
 * partial map (an unattributed subscription merge, or a legacy event with no agent) is off by a
 * real, much larger amount and must fall back to the generic line. */
function notionalSumsCoverTotal(summed: number, total: number): boolean {
  return Math.abs(summed - total) <= 1e-9 * Math.max(1, Math.abs(total));
}

/** The notional-spend line(s) (plans/agent-backends.md part 6a, codex-backend.md part 3d/9):
 * the API-equivalent cost of subscription runs folded into the window. Never part of the
 * totals' costUsd, because a subscription run is exempt from the daily dollar cap; the caller
 * prints it only when a subscription run actually folded in (zero means absent, like the merge
 * line), so an API-only team's report is unchanged. When the window's notional spend fully
 * decomposes into backends, one labeled line names each backend — including a single non-claude
 * backend (a codex-only window), so a codex team's line never reads "claude". A claude-only
 * account, an old-log window, or unattributed merge spend keeps one generic lowercase "claude
 * subscription" line — byte-identical to the pre-codex render. */
function notionalLines(t: ReportTotals): string[] {
  const total = t.notionalCostUsd ?? 0;
  const byBackend = t.notionalByBackend ?? {};
  const backends = Object.entries(byBackend).filter(([, c]) => c > 0);
  const summed = backends.reduce((n, [, c]) => n + c, 0);
  // A single fully-attributed claude account collapses to the generic line (its true or
  // fallback backend is claude, and the capitalization keeps old/byte-identical output);
  // every other fully-attributed window — multi-backend, or a single codex/other backend —
  // names each backend on its own line.
  const singleClaude = backends.length === 1 && backends[0]?.[0] === "claude";
  if (notionalSumsCoverTotal(summed, total) && !singleClaude) {
    return backends.map(
      ([backend, c]) => `${backendDisplayName(backend)} subscription, API-equivalent: ${usd(c)} estimated`,
    );
  }
  return [`claude subscription, API-equivalent: ${usd(total)} estimated`];
}

/** The scope note a `--role` report prints: merge runs belong to the merge slot and the
 * day-granular backlog tallies (features done / bugs fixed / plans added / bugs filed) come
 * from day-granular backlog-file dates, so none can
 * be scoped to a role and all are omitted from the scoped totals. Shared by the day and
 * --since renders so the two say the same thing. */
const ROLE_SCOPE_NOTE =
  "role scope: merge runs and backlog tallies (features done / bugs fixed / plans added / bugs filed) are team-wide and omitted";

/** The summary block both report shapes print, in the same order: the totals line (carrying
 * the caller's extra `tail` cells), the merge-share line and the notional line when each is
 * nonzero (zero means absent, so an API-only or merge-free window renders as before), and the
 * role-scope note when the report is scoped. One home so the day report and the --since window
 * cannot drift on the order, the omission predicates, or the scope note. */
function pushReportSummary(lines: string[], t: ReportTotals, tail = "", scoped = false): void {
  lines.push(totalsLine(t, tail));
  if (t.mergeRuns > 0) lines.push(mergeShareLine(t));
  if ((t.notionalCostUsd ?? 0) > 0) lines.push(...notionalLines(t));
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
  lines.push(
    data.untilMs !== undefined && data.toIso !== undefined
      ? boundedWindowLine(durationLabel(data.sinceMs), durationLabel(data.untilMs), data.fromIso, data.toIso)
      : sinceWindowLine(durationLabel(data.sinceMs), data.fromIso),
  );
  if (data.role !== undefined) lines.push(`role: ${data.role}`);
  lines.push("");
  const t = data.totals;
  // Same totals voice as the day report, minus the features/bugs and filing cells: those tallies
  // come from day-granular backlog-file dates that cannot subdivide a sub-day window, so the
  // final line below states the omission instead of showing a day-rounded number.
  pushReportSummary(lines, t, "", data.role !== undefined);
  lines.push("");
  lines.push(rankedRoleLine("Runs by role", rankedRoleMap(data.runsByRole), String));
  // Same breakdown for token spend: ranked by tokens desc then name asc, zero-token roles
  // omitted — an all-zero window renders "-" like the other lines. Output tokens are the
  // resource the budget charges, so this is the line an operator reads to find which role's
  // prompt loop burned the window's tokens.
  pushRankedRoleLine(lines, "Tokens by role", rankedRoleMap(data.tokensByRole), compactTokens);
  // Same breakdown for spend: ranked by spend desc then name asc, zero-spend roles omitted —
  // an all-zero window renders "-" like the runs line.
  pushRankedRoleLine(lines, "Cost by role", rankedRoleMap(data.costByRole), usd);
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
    const modelPairs = rankedRoleMap(data.runsByModel).filter(([, n]) => n > 0);
    if (modelPairs.length > 0) lines.push(rankedRoleLine("Runs by model", modelPairs, String));
  }
  // Main's red wall-clock over the window (main's own, not any role's — a role-scoped
  // collector carries 0, so this never prints for a scoped window). Zero-absent: no line for
  // a window main was never red.
  if (data.mainRedMs > 0) lines.push(`**Main red:** ${durationLabel(data.mainRedMs)}`);
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
  pushRankedRoleLine(lines, "Fallbacks by role", rankedRoleMap(data.fallbacksByRole));
  pushRankedRoleLine(lines, "Image reroutes by role", rankedRoleMap(data.imageReroutesByRole));
  // Deferred maintenance runs per reason code, the --since twin of the day render's line:
  // how many due maintenance runs stood down and why (backlog / no-work / plans-full).
  // Gated to the team report — a reason is not a role, so a role-scoped window omits it.
  // Zero-means-absent: a window with no deferral prints no line.
  if (data.role === undefined) {
    const deferred = rankedRoleMap(data.deferredByReason ?? {}).filter(([, n]) => n > 0);
    if (deferred.length > 0) lines.push(rankedRoleLine("Deferred runs by reason", deferred, String));
  }
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
    const mergeFailures = rankedRoleMap(data.mergeFailedByRole).filter(([, n]) => n > 0);
    if (mergeFailures.length > 0)
      lines.push(rankedRoleLine("Merge failures by role", mergeFailures, String));
    // WHY the window's merges failed, from each merge_failed's result code — the day
    // report's reason twin of the role line above, so an operator can tell a review
    // rejection (fix the change) from a conflict/block (rebase) from a shutdown abort
    // (capacity). Ranked the same way (count desc then code asc), reason-free only.
    const mergeFailureReasons = rankedRoleMap(data.mergeFailedByReason ?? {}).filter(([, n]) => n > 0);
    if (mergeFailureReasons.length > 0)
      lines.push(rankedRoleLine("Merge failures by reason", mergeFailureReasons, String));
  }
  // Subscription spend is notional: its own line, only when the window has any — the same
  // conditional/filtered `usd` form the day render's "Estimated by role" uses.
  if (data.notionalByRole !== undefined) {
    pushRankedRoleLine(lines, "Estimated by role", rankedRoleMap(data.notionalByRole), usd);
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
    lines.push("backlog tallies (features done / bugs fixed / plans added / bugs filed) need the day report (--days)");
  return lines.join("\n");
}

/** Cost per merged commit by base role. Spend comes from costByRole (keyed by role id, folded to
 * its base role so `feature-2` joins `feature`), commits from commitsByRole (already base-role
 * keyed). `merged` is [role, cost per commit, commits] for roles with both, ranked by cost per
 * commit desc then name asc; `idle` is roles that spent and merged nothing, ranked by spend.
 * Merge spend (the reviewer's) and notional subscription spend stay out by default, matching
 * `**Cost by role:**` (`pick` selects another per-role-id spend map, e.g. notionalByRole); a
 * role with commits but no spend in the picked map appears in neither list. */
function costPerCommitPairs(
  series: ReportDay[],
  pick: (d: ReportDay) => Record<string, number> = (d) => d.costByRole,
): { mergeDone: [string, number, number][]; idle: [string, number][] } {
  const cost: Record<string, number> = {};
  const commits: Record<string, number> = {};
  for (const d of series) {
    for (const [id, c] of Object.entries(pick(d))) addTo(cost, baseRoleOf(id), c);
    for (const [role, n] of Object.entries(d.commitsByRole ?? {})) addTo(commits, role, n);
  }
  const mergeDone: [string, number, number][] = [];
  const idleCost: [string, number][] = [];
  for (const [role, c] of Object.entries(cost)) {
    if (c <= 0) continue;
    const n = commits[role] ?? 0;
    if (n > 0) mergeDone.push([role, c / n, n]);
    else idleCost.push([role, c]);
  }
  sortByValueDesc(mergeDone);
  return { mergeDone, idle: rankCountEntries(idleCost) };
}

/** One `**<label>:** …` line from costPerCommitPairs output; `-` when there is nothing. */
function costPerCommitLine(label: string, pairs: ReturnType<typeof costPerCommitPairs>): string {
  const parts = [
    ...pairs.mergeDone.map(([r, per, n]) => `${r} — ${usd(per)} (${n})`),
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
  // A role-scoped report drops the team-only features/bugs and filing cells from the totals
  // line — their dates carry no role — and states the omission through ROLE_SCOPE_NOTE below.
  const openedTail =
    (t.plansAdded ?? 0) + (t.bugsFiled ?? 0) > 0
      ? ` · ${t.plansAdded ?? 0} plans added · ${t.bugsFiled ?? 0} bugs filed`
      : "";
  const tail =
    data.role === undefined
      ? ` · ${t.featuresDone} features done · ${t.bugsFixed} bugs fixed${openedTail}`
      : "";
  pushReportSummary(lines, t, tail, data.role !== undefined);
  lines.push("");
  const maxTokens = data.series.reduce((m, d) => Math.max(m, d.tokensOut), 0);
  lines.push(
    ...markdownTable(
      ["day", "tokens out", "runs", "commits", "cost"],
      data.series.map((d) => {
        const runs = Object.values(d.runsByRole).reduce((a, b) => a + b, 0);
        const w = maxTokens > 0 ? barWidth(d.tokensOut, maxTokens) : 0;
        const bar = w > 0 ? ` ${"█".repeat(w)}` : ""; // Zero days carry no bar (and no stray space).
        return [monthDay(d.date), `${compactTokens(d.tokensOut)}${bar}`, String(runs), String(d.commits), usd(d.costUsd)];
      }),
      ["left", "right", "right", "right", "right"],
    ),
  );
  lines.push("");
  lines.push(rankedRoleLine("Runs by role", rankedRoleTotals(data.series, (d) => d.runsByRole), String));
  // The same breakdown for output tokens (the resource the budget charges): window totals per
  // role from tokensByRole, ranked like the runs line. Zero-token roles are omitted; an
  // all-zero window renders "-" like the runs line.
  pushRankedRoleLine(lines, "Tokens by role", rankedRoleTotals(data.series, (d) => d.tokensByRole ?? {}), compactTokens);
  // The same breakdown for spend: window totals per role from costByRole, ranked by spend
  // desc then name asc — spend is what the operator acts on (an operator tuning per-role
  // intervals wants the burning role first, not the busiest one). Zero-spend roles are
  // omitted; an all-zero window renders "-" like the runs line.
  pushRankedRoleLine(lines, "Cost by role", rankedRoleTotals(data.series, (d) => d.costByRole), usd);
  // The same breakdown per PROVIDER (plans: per-provider spend): which seam of a mixed team
  // spent what, straight from the events' providerCost maps (run_end's own runs and the
  // merge's reviewer seam). Gated to the team report — a provider is not a role, so a
  // role-scoped report omits it (ROLE_SCOPE_NOTE covers the omission). Zero-means-absent: a
  // window with no provider spend prints no line. Ranked and formatted exactly like Cost by
  // role.
  if (data.role === undefined) {
    pushProviderCostLines(
      lines,
      () => rankedRoleTotals(data.series, (d) => d.costByProvider ?? {}),
      () => rankedRoleTotals(data.series, (d) => d.notionalByProvider ?? {}),
    );
    // The same breakdown per MODEL (each run_start's agent-qualified selector — the model a
    // team mixing providers, per-role overrides and fallbacks actually ran on), gated to the
    // team report like the provider lines: a model is not a role, so a role-scoped report
    // omits it (ROLE_SCOPE_NOTE covers the omission), and a window with no modelled start
    // prints no line (keeping a model-less day's output unchanged), exactly as the provider
    // lines stay absent when no provider spent. Ranked and formatted like Cost by role.
    const modelPairs = rankedRoleTotals(data.series, (d) => d.runsByModel ?? {}).filter(([, n]) => n > 0);
    if (modelPairs.length > 0) lines.push(rankedRoleLine("Runs by model", modelPairs, String));
  }
  // The same breakdown for review friction: window rejections per role from review_rejected
  // events, ranked like the runs line; a window with none renders "-". The post-merge line
  // is the afterMerge: true subset — rejections that reached an already-merged commit.
  pushRankedRoleLine(lines, "Rejections by role", rankedRoleTotals(data.series, (d) => d.rejectionsByRole ?? {}));
  pushRankedRoleLine(lines, "Post-merge rejections by role", rankedRoleTotals(data.series, (d) => d.postMergeRejectionsByRole ?? {}));
  pushRankedRoleLine(lines, "Revisions by role", rankedRoleTotals(data.series, (d) => d.revisionsByRole ?? {}));
  pushRankedRoleLine(lines, "Refusals by role", rankedRoleTotals(data.series, (d) => d.refusalsByRole ?? {}));
  // The same breakdown for outright failures: error-class run_ends per role under the
  // digest's OUTCOME_CLASS — runs that burned agent time and merged nothing without going
  // through review, which rejections/revisions would miss entirely. Zero-means-absent, so a
  // failure-free window renders no line and an all-zero window renders "-" like the others.
  pushRankedRoleLine(lines, "Failed runs by role", rankedRoleTotals(data.series, (d) => d.failedRunsByRole ?? {}));
  pushRankedRoleLine(lines, "Fallbacks by role", rankedRoleTotals(data.series, (d) => d.fallbacksByRole ?? {}));
  pushRankedRoleLine(lines, "Image reroutes by role", rankedRoleTotals(data.series, (d) => d.imageReroutesByRole ?? {}));
  // Deferred maintenance runs per reason code — how many due maintenance runs stood down
  // and why, so an idle day reads as backlog-open / no-work / plans-full rather than blank,
  // the per-role breakdown of the deferred maintenances. Gated to the team report — a
  // reason is not a role (ROLE_SCOPE_NOTE covers the omission). Zero-means-absent: a window
  // with no deferral prints no line, so a deferral-free day's output is unchanged.
  if (data.role === undefined) {
    const deferred = rankedRoleTotals(data.series, (d) => d.deferredByReason ?? {}).filter(([, n]) => n > 0);
    if (deferred.length > 0) lines.push(rankedRoleLine("Deferred runs by reason", deferred, String));
  }
  // Work ratio 4/4: the merged commits split by base role and by tier. The totals line's
  // `commits` carries the count; these lines say who made it and how much of it was work.
  lines.push(rankedRoleLine("Commits by role", rankedRoleTotals(data.series, (d) => d.commitsByRole ?? {}), String));
  // The merged-outcomes split by base role: which authoring roles' changes reach main through
  // the merge slot, and — the new signal — which roles' changes bounce off the gate (a
  // merge_failed: review rejection, under-cap review, a conflict, a blocked fast-forward, a
  // shutdown abort). Gated to the team report — a role-scoped report omits merge runs
  // (they are the merge slot's, per ROLE_SCOPE_NOTE), so the per-role attribution would
  // contradict that stance. Zero-means-absent: a window with merges renders Merged by role;
  // the failures line prints only when some role actually has one.
  if (data.role === undefined) {
    const mergeDone = rankedRoleTotals(data.series, (d) => d.mergedByRole ?? {});
    lines.push(rankedRoleLine("Merged by role", mergeDone, String));
    const mergeFailures = rankedRoleTotals(data.series, (d) => d.mergeFailedByRole ?? {}).filter(([, n]) => n > 0);
    if (mergeFailures.length > 0)
      lines.push(rankedRoleLine("Merge failures by role", mergeFailures, String));
    // The --since reason twin, folded across the series the same way; a reason-free window
    // prints no line, so its output is byte-for-byte unchanged.
    const mergeFailureReasons = rankedRoleTotals(data.series, (d) => d.mergeFailedByReason ?? {}).filter(([, n]) => n > 0);
    if (mergeFailureReasons.length > 0)
      lines.push(rankedRoleLine("Merge failures by reason", mergeFailureReasons, String));
    // Per-day median passing check time, so a suite slowing over days shows; days without a
    // check are left out, and no line prints when no day has one (zero means absent).
    pushDayCameoLine(lines, data.series, "Merge check median", (d) => d.checkMedianMs);
    // Per-day count of red full-suite checks, beside the passing medians above; a day whose
    // suite went red before passing shows here. Zero-absent: no line when no day fails.
    pushDayCameoLine(lines, data.series, "Red merge checks", (d) => d.checkFailures, (n) => `×${n}`);
    // Per-day main red wall-clock, beside the red-check counts above: how long each day main
    // had no passing full check (the span every code role was held). Team-only (main's own
    // red time, not any role's) and zero-absent: no line when no day was red.
    pushDayCameoLine(lines, data.series, "Main red", (d) => d.mainRedMs, durationLabel);
    pushDayCameoLine(lines, data.series, "Merge wait median", (d) => d.mergeWaitMedianMs);
    // How long the merge slot itself held each change it landed, beside the merge-wait median:
    // the queue backlog (merge wait minus slot time) apart from the slot's own review/check/
    // rebase/merge work. Team-only (the slot is the team's), omitted when no day carries one.
    pushDayCameoLine(lines, data.series, "Merge slot median", (d) => d.mergeSlotMedianMs);
    pushDayCameoLine(lines, data.series, "Run duration median", (d) => d.runMedianMs);
    // How long the review gate ran per day — how long the reviewer's verdict run(s) took —
    // beside the run/merge-wait medians; pushDayCameoLine omits the line when no day carries one.
    pushDayCameoLine(lines, data.series, "Review duration median", (d) => d.reviewMedianMs);
    pushDayCameoLine(lines, data.series, "Provider wait median", (d) => d.providerWaitMedianMs);
    pushDayCameoLine(lines, data.series, "Workspace wait median", (d) => d.slotWaitMedianMs);
    pushDayCameoLine(lines, data.series, "Check wait median", (d) => d.checkWaitMedianMs);
  }
  lines.push(costPerCommitLine("Cost per commit", costPerCommitPairs(data.series)));
  // Subscription spend is notional: its own two lines, only when the window has any.
  if ((t.notionalCostUsd ?? 0) > 0) {
    const notionalOf = (d: ReportDay): Record<string, number> => d.notionalByRole ?? {};
    pushRankedRoleLine(lines, "Estimated by role", rankedRoleTotals(data.series, notionalOf), usd);
    lines.push(costPerCommitLine("Estimated per commit", costPerCommitPairs(data.series, notionalOf)));
  }
  // Commits per backlog item is day-granular backlog data (features done + bugs fixed), so it
  // belongs only to the day report; zero items means the denominator is absent, not NaN.
  const items = t.featuresDone + t.bugsFixed;
  const perItem = items > 0 ? ` · ${(t.commits / items).toFixed(1)} commits per backlog item` : "";
  lines.push(`**Commits:** ${t.workCommits ?? 0} work / ${t.maintenanceCommits ?? 0} maintenance${perItem}`);
  // How long each finished plan or bug waited from filing to done, per completion day — the
  // median backlog age at which the day's items closed. Team-only (a lag has no role) and
  // zero-means-absent: no line when no day carries one. Values are whole days from
  // daysBetween, so a plain `${n}d` is exact where medianLine's shortSpanPhrase would print
  // minutes.
  if (data.role === undefined) {
    const lags = data.series.flatMap((d) =>
      d.backlogLagMedianDays === undefined
        ? []
        : [`${monthDay(d.date)} ${d.backlogLagMedianDays}d`],
    );
    if (lags.length > 0) lines.push(`**Backlog lag median:** ${lags.join(" · ")}`);
  }
  // Where the bugfix work was hardest to confirm: the window's fixed bugs tallied by their
  // `Validation gap` tag, so the team can see where its own test infrastructure was weakest
  // (recorded first, consumed now). Team-only (a tag has no role) and zero-means-absent: no
  // line and no totals key for a role-scoped report or a window with no tagged fixed bug.
  if (data.role === undefined && t.validationGapsByTag && Object.keys(t.validationGapsByTag).length > 0) {
    lines.push(rankedRoleLine("Validation gaps", rankedRoleMap(t.validationGapsByTag), String));
  }
  // The shared SPARSE_WINDOW_NOTE (one voice across the report's two windows and the other
  // windowed renders): covered is false only when events were aggregated from a log whose
  // oldest retained event lies inside the window, so the hedged sentence stays true whenever
  // it prints — an empty or fully covered log never claims a history it cannot see.
  if (!data.coversFullWindow) lines.push("", SPARSE_WINDOW_NOTE);
  return lines.join("\n");
}
