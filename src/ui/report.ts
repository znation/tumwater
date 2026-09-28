/** The usage report: turn a collected `ReportData` (report-data.ts) into the bounded Markdown
 * the CLI prints and the TUI usage pane reuses (pure function of the data — no I/O, no clock
 * reads — so the bounds argued at collection hold here unchanged), plus `report`'s CLI command
 * half (cmdReport), which parses the flags and drives the collectors and the renderers. */
import { collectReport, collectReportSince, type ReportData, type ReportDay, type SinceReport } from "../report-data.js";
import { collectFailureReport } from "../failure-data.js";
import { renderFailureMarkdown } from "../failure-report.js";
import { compactTokens, usd } from "../text.js";
import { reportWindow } from "../datetime.js";
import { durationLabel, fail, failOverDurationCap, parseCountFlag, parseDurationFlag, say } from "../cli-args.js";

// The windowed tail read (and the REPORT_*_DAYS bounds it serves) moved to core
// event-window.ts so the failure digest can share it without a core→ui import. Re-exported
// here because every existing caller (cli.ts, gui.ts, the tests) imports them from this
// module — moving them must not churn those import sites; cmdReport binds the same constants
// directly so it can enforce the bounds.
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, REPORT_SINCE_MAX_MS } from "../event-window.js";
export { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, REPORT_SINCE_MAX_MS };

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

/** Rank one role map by total desc then name asc so identical totals render deterministically.
 * Callers filter/format the ranked pairs. */
function rankedRoleMap(totals: Record<string, number>): [string, number][] {
  return Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Render a trailing-window totals report as Markdown — the aggregate sibling of the
 * `logs --since` raw stream ("how much" here, "what exactly" there). Pure function of
 * SinceReport: no I/O, no clock reads (the window line's local time is rendered from the
 * collector's captured cutoff, so the printed window matches the aggregated one). */
export function renderSinceReportMarkdown(data: SinceReport): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(`window: last ${durationLabel(data.sinceMs)} (since ${new Date(data.fromIso).toLocaleString()})`);
  lines.push("");
  const t = data.totals;
  // Same totals voice as the day report, minus the features/bugs cells: those tallies come
  // from day-granular backlog-file dates that cannot subdivide a sub-day window, so the final
  // line below states the omission instead of showing a day-rounded number.
  lines.push(`**Totals:** ${compactTokens(t.tokensOut)} output tokens · ${t.ticks} ticks · ${t.commits} commits · ${usd(t.costUsd)}`);
  lines.push("");
  const roles = rankedRoleMap(data.ticksByRole);
  lines.push(`**Ticks by role:** ${roles.length === 0 ? "-" : roles.map(([r, n]) => `${r} — ${n}`).join(" · ")}`);
  // Same breakdown for spend: ranked by spend desc then name asc, zero-spend roles omitted —
  // an all-zero window renders "-" like the ticks line.
  const spenders = rankedRoleMap(data.costByRole).filter(([, c]) => c > 0);
  lines.push(`**Cost by role:** ${spenders.length === 0 ? "-" : spenders.map(([r, c]) => `${r} — ${usd(c)}`).join(" · ")}`);
  lines.push("");
  // Exactly one final line, chosen by the collector's coverage proof: either a hedged note
  // that stays true whenever it prints (the oldest retained event lies inside the window —
  // whether from rotation or a log born inside the window), or the one-time statement of the
  // backlog-tally omission. A flat "rotated out" claim would be false for a log that never
  // had the older events, so the wording names only what is provably the case.
  if (!data.coversFullWindow)
    lines.push("note: the log's oldest retained event lies inside this window; older events may have rotated out");
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

/** `tumwater report [--days <n>] [--failures] [--since <duration>]`: the command half, beside
 * the renderers above (the cmdLogs/cmdHistory pattern of this directory): parse the flags,
 * collect through report-data.ts / failure-data.ts, and print. Unknown-args rejection and the
 * no-ready-repo-gate decision stay in cli.ts's case, like every other command's. */
export async function cmdReport(root: string, args: string[]): Promise<void> {
  // --since is handled before the day-shape reads: it is a rival shape (totals over a
  // trailing window vs a series over whole days), not a modifier of either.
  const sinceFlag = args.indexOf("--since");
  if (sinceFlag >= 0) {
    if (args.includes("--days"))
      fail("report --since cannot be combined with --days (--days counts whole local days; --since totals a trailing window)");
    if (args.includes("--failures"))
      fail("report --since cannot be combined with --failures (the failure digest has no windowed-since mode)");
    const ms = parseDurationFlag("--since", args[sinceFlag + 1]);
    // The shared over-cap check (the same idiom logs --since and pause --for use), so the
    // cap message cannot drift from the other capped duration flags.
    failOverDurationCap("report --since", ms, REPORT_SINCE_MAX_MS);
    say(renderSinceReportMarkdown(collectReportSince(root, ms)));
    return;
  }
  const daysFlag = args.indexOf("--days");
  let days = REPORT_DEFAULT_DAYS;
  if (daysFlag >= 0) {
    days = parseCountFlag("--days", args[daysFlag + 1]);
    // /api/report clamps its ?days= param to the same bound; an explicit flag fails fast
    // instead — a typo'd "3650" must not build a ten-year series (one entry per day), and
    // a huge value would grow it until the process runs out of memory. parseCountFlag has
    // already rejected 0, non-decimals, and a missing value.
    if (days > REPORT_MAX_DAYS)
      fail(`--days must be between 1 and ${REPORT_MAX_DAYS} (got ${JSON.stringify(args[daysFlag + 1])})`);
  }
  say(
    args.includes("--failures")
      ? renderFailureMarkdown(collectFailureReport(root, days))
      : renderReportMarkdown(collectReport(root, days)),
  );
}
