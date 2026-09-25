/** Rendering half of the usage report: turn a collected `ReportData` (report-data.ts) into the
 * bounded Markdown the CLI prints and the TUI usage pane reuses. Pure function of the data —
 * no I/O, no clock reads — so the bounds argued at collection hold here unchanged. */
import type { ReportData, ReportDay } from "../report-data.js";
import { compactTokens, usd } from "../text.js";
import { reportWindow } from "../datetime.js";

// The windowed tail read (and the REPORT_*_DAYS bounds it serves) moved to core
// event-window.ts so the failure digest can share it without a core→ui import. Re-exported
// here because every existing caller (cli.ts, gui.ts, the tests) imports them from this
// module — moving them must not churn those import sites.
export { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../event-window.js";

/** Bar width for one day: up to 20 blocks scaled to the window's max tokensOut —
 * round(20·v/max), min 1 when v > 0. */
function barWidth(v: number, max: number): number {
  if (v <= 0) return 0;
  return Math.max(1, Math.round((20 * v) / max));
}

/** Window totals per role: fold the per-day role maps (any `Record<string, number>` day field,
 * e.g. ticksByRole or costByRole) across the series, then rank by total desc and name asc so
 * identical totals render deterministically. Callers filter/s format the ranked pairs. */
function rankedRoleTotals(series: ReportDay[], pick: (d: ReportDay) => Record<string, number>): [string, number][] {
  const totals = new Map<string, number>();
  for (const d of series) {
    for (const [role, n] of Object.entries(pick(d))) totals.set(role, (totals.get(role) ?? 0) + n);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Render a report as Markdown — the pinned shape the CLI prints and the TUI usage pane
 * (report 3/3) reuses; the GUI tab (report 2/3) renders its own SVG charts from the same
 * ReportData instead. Pure function of ReportData: no I/O, no clock reads. */
export function renderReportMarkdown(data: ReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(reportWindow(data.from, data.to, data.days));
  lines.push("");
  const t = data.totals;
  lines.push(
    `**Totals:** ${compactTokens(t.tokensOut)} output tokens · ${t.ticks} ticks · ${t.commits} commits · ${usd(t.costUsd)} · ${t.featuresDone} features done · ${t.bugsFixed} bugs fixed`,
  );
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
  const roles = rankedRoleTotals(data.series, (d) => d.ticksByRole);
  lines.push("");
  lines.push(`**Ticks by role:** ${roles.length === 0 ? "-" : roles.map(([r, n]) => `${r} — ${n}`).join(" · ")}`);
  // The same breakdown for spend: window totals per role from costByRole, ranked by spend
  // desc then name asc — spend is what the operator acts on (an operator tuning per-role
  // intervals wants the burning loop first, not the busiest one). Zero-spend roles are
  // omitted; an all-zero window renders "-" like the ticks line.
  const spenders = rankedRoleTotals(data.series, (d) => d.costByRole).filter(([, c]) => c > 0);
  lines.push(`**Cost by role:** ${spenders.length === 0 ? "-" : spenders.map(([r, c]) => `${r} — ${usd(c)}`).join(" · ")}`);
  return lines.join("\n");
}
