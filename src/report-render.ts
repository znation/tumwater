/** The usage report's Markdown render: turn a collected `ReportData` (report-data.ts) into the
 * bounded Markdown the CLI prints and the TUI usage pane reuses (pure function of the data —
 * no I/O, no clock reads — so the bounds argued at collection hold here unchanged). The
 * command half (cmdReport) lives in report.ts. It sits at the top level beside
 * src/failure/failure-render.ts — the failure digest's Markdown render of the same shape — because it is
 * a pure render with no ink or UI dependency, and core modules (rank.ts, history-data.ts)
 * name it in their contracts. */
import { type ReportData, type ReportDay, type SinceReport } from "./report-data.js";
import { rankCountEntries } from "./rank.js";
import { compactTokens, usd } from "./format.js";
import { durationLabel } from "./cli/cli-args.js";
import { formatTimestamp, reportWindow } from "./datetime.js";
import { eventsRotationLabel } from "./events/events.js";
import { SPARSE_WINDOW_NOTE } from "./events/event-window.js";

/** Bar width for one day: up to 20 blocks scaled to the window's max tokensOut —
 * round(20·v/max), min 1 when v > 0. */
function barWidth(v: number, max: number): number {
  if (v <= 0) return 0;
  return Math.max(1, Math.round((20 * v) / max));
}

/** Rank one role map by total desc then name asc so identical totals render deterministically —
 * rank.ts's rule, so the report cannot drift from the other counters that rank the same way.
 * Callers filter/format the ranked pairs. */
function rankedRoleMap(totals: Record<string, number>): [string, number][] {
  return rankCountEntries(Object.entries(totals));
}

/** Window totals per role: fold the per-day role maps (any `Record<string, number>` day field,
 * e.g. ticksByRole or costByRole) across the series, then rank through rankedRoleMap.
 * Callers filter/format the ranked pairs. */
function rankedRoleTotals(series: ReportDay[], pick: (d: ReportDay) => Record<string, number>): [string, number][] {
  const totals: Record<string, number> = {};
  for (const d of series) {
    for (const [role, n] of Object.entries(pick(d))) totals[role] = (totals[role] ?? 0) + n;
  }
  return rankedRoleMap(totals);
}

/** One "**Label:** role — n · role — n" Markdown line from already-ranked pairs; an empty
 * pair list (an all-zero window) renders "-". fmt formats each role's number. */
function rankedRoleLine(label: string, pairs: [string, number][], fmt: (n: number) => string): string {
  return `**${label}:** ${pairs.length === 0 ? "-" : pairs.map(([r, n]) => `${r} — ${fmt(n)}`).join(" · ")}`;
}

/** The totals fields both renders print (both collectors' inline `totals` shapes satisfy it
 * structurally); the day report's shape adds the day-granular features/bugs cells on top. */
type SharedTotals = {
  tokensOut: number;
  ticks: number;
  commits: number;
  costUsd: number;
  landingRuns: number;
  landingTokens: number;
  landingCostUsd: number;
};

/** The "**Totals:** …" line both renders print — one home so field order, units, and the ·
 * separators cannot drift between the day report and the --since window. `tail` carries the
 * cells only one shape has: the day report's features/bugs counts (a sub-day window cannot
 * subdivide their day-granular dates, so the --since render passes nothing). */
function totalsLine(t: SharedTotals, tail = ""): string {
  return `**Totals:** ${compactTokens(t.tokensOut)} output tokens · ${t.ticks} ticks · ${t.commits} commits · ${usd(t.costUsd)}${tail}`;
}

/** The "of which landing runs …" line under a totals line — one home for the landing share's
 * wording. The caller decides when it prints: zero-means-absent, so a fleet with no landing
 * spend renders exactly as before (the budget charges the landing slot's runs too, so the
 * totals include them — this line says how much of the spend was reviewer + conflict
 * resolution work). */
function landingShareLine(t: SharedTotals): string {
  return `of which landing runs: ${t.landingRuns} runs · ${compactTokens(t.landingTokens)} tokens · ${usd(t.landingCostUsd)} (reviewer + conflict resolution)`;
}

/** Render a trailing-window totals report as Markdown — the aggregate sibling of the
 * `logs --since` raw stream ("how much" here, "what exactly" there). Pure function of
 * SinceReport: no I/O, no clock reads (the window line's local time is rendered from the
 * collector's captured cutoff, so the printed window matches the aggregated one). */
export function renderSinceReportMarkdown(data: SinceReport): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(`window: last ${durationLabel(data.sinceMs)} (since ${formatTimestamp(new Date(data.fromIso).getTime())})`);
  lines.push("");
  const t = data.totals;
  // Same totals voice as the day report, minus the features/bugs cells: those tallies come
  // from day-granular backlog-file dates that cannot subdivide a sub-day window, so the final
  // line below states the omission instead of showing a day-rounded number.
  lines.push(totalsLine(t));
  // The landing share of those totals: the budget charges the landing slot's runs too, so the
  // totals include them — this line says how much of the spend was reviewer + conflict
  // resolution work. Omitted entirely when no landing ran (zero means absent, like the
  // cost-by-role line), so a fleet with no landing spend renders exactly as before.
  if (t.landingRuns > 0) lines.push(landingShareLine(t));
  lines.push("");
  lines.push(rankedRoleLine("Ticks by role", rankedRoleMap(data.ticksByRole), String));
  // Same breakdown for spend: ranked by spend desc then name asc, zero-spend roles omitted —
  // an all-zero window renders "-" like the ticks line.
  lines.push(rankedRoleLine("Cost by role", rankedRoleMap(data.costByRole).filter(([, c]) => c > 0), usd));
  lines.push("");
  // Exactly one final line, chosen by the collector's coverage proof: either a hedged note
  // that stays true whenever it prints (the oldest retained event lies inside the window —
  // whether from rotation or a log born inside the window), or the one-time statement of the
  // backlog-tally omission. A flat "rotated out" claim would be false for a log that never
  // had the older events, so the wording names only what is provably the case.
  if (!data.coversFullWindow) lines.push(SPARSE_WINDOW_NOTE);
  else lines.push("backlog tallies (features done / bugs fixed) need the day report (--days)");
  return lines.join("\n");
}

/** Render a report as Markdown — the pinned shape the CLI prints and the TUI usage pane
 * (report 3/3) reuses; the GUI tab (report 2/3) renders its own SVG charts from the same
 * ReportData instead. Pure function of ReportData: no I/O, no clock reads. */
export function renderReportMarkdown(data: ReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(reportWindow(data.from, data.to, data.days, eventsRotationLabel()));
  lines.push("");
  const t = data.totals;
  lines.push(totalsLine(t, ` · ${t.featuresDone} features done · ${t.bugsFixed} bugs fixed`));
  // The landing share of those totals: the reviewer's and conflict resolution's part of spend
  // the budget already charges, shown only when landing runs actually folded into the window
  // (the shared zero-means-absent rule lives on landingShareLine).
  if (t.landingRuns > 0) lines.push(landingShareLine(t));
  lines.push("");
  lines.push("| day | tokens out | ticks | commits | cost |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  const maxTokens = data.series.reduce((m, d) => Math.max(m, d.tokensOut), 0);
  for (const d of data.series) {
    const ticks = Object.values(d.ticksByRole).reduce((a, b) => a + b, 0);
    const w = maxTokens > 0 ? barWidth(d.tokensOut, maxTokens) : 0;
    const bar = w > 0 ? ` ${"█".repeat(w)}` : ""; // Zero days carry no bar (and no stray space).
    lines.push(`| ${d.date.slice(5)} | ${compactTokens(d.tokensOut)}${bar} | ${ticks} | ${d.commits} | ${usd(d.costUsd)} |`);
  }
  lines.push("");
  lines.push(rankedRoleLine("Ticks by role", rankedRoleTotals(data.series, (d) => d.ticksByRole), String));
  // The same breakdown for spend: window totals per role from costByRole, ranked by spend
  // desc then name asc — spend is what the operator acts on (an operator tuning per-role
  // intervals wants the burning loop first, not the busiest one). Zero-spend roles are
  // omitted; an all-zero window renders "-" like the ticks line.
  lines.push(rankedRoleLine("Cost by role", rankedRoleTotals(data.series, (d) => d.costByRole).filter(([, c]) => c > 0), usd));
  // The shared SPARSE_WINDOW_NOTE (one voice across the report's two windows and the other
  // windowed renders): covered is false only when events were aggregated from a log whose
  // oldest retained event lies inside the window, so the hedged sentence stays true whenever
  // it prints — an empty or fully covered log never claims a history it cannot see.
  if (!data.coversFullWindow) lines.push("", SPARSE_WINDOW_NOTE);
  return lines.join("\n");
}
