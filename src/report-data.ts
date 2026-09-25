/** Collection half of the usage report: read the harness's event log and backlog history over
 * a window of local calendar days and distill it into a `ReportData` — per-day tick/token/
 * commit/cost counts plus features-done and bugs-fixed tallies from PLANS.md and BUGS.md.
 * The Markdown rendering of this data lives in ui/report.ts, a pure function of it; the split
 * mirrors the failure report's (failure-data.ts / failure-report.ts) and keeps "what happened"
 * (window math, aggregation, bounds) apart from "how it prints" (bars, cell wording), which
 * change for different reasons — and keeps core data collection out of the presentation
 * layer, so a core consumer (as /api/report already is) never forces a core→ui import. */
import path from "node:path";
import { readTextOrNull } from "./files.js";
import { readWindowEvents } from "./event-window.js";
import { eventDayKey, eventRole } from "./events.js";
import { fenceTracker, sectionLines } from "./backlog.js";
import { dayAt, formatDate } from "./text.js";

/** One day of a usage report: the local calendar day key plus what the fleet did on it.
 * `ticksByRole` counts tick_end events per loop id (role ids — works for custom loops too);
 * tokensOut sums their `tokens`; commits counts `merged` events; costUsd sums `costUsd`.
 * `costByRole` splits that same costUsd per loop id — sourced from the same tick_end events
 * (never a second pass), so its per-day sum equals the day's costUsd by construction. */
export interface ReportDay {
  date: string; // "YYYY-MM-DD" local day key
  tokensOut: number;
  ticksByRole: Record<string, number>;
  costByRole: Record<string, number>;
  commits: number;
  costUsd: number;
  featuresDone: number;
  bugsFixed: number;
}

/** Fleet usage over a window of exactly `days` local calendar days ending today. */
export interface ReportData {
  days: number;
  from: string; // day key of the oldest day in the series
  to: string; // day key of today
  series: ReportDay[]; // oldest → newest, zero-filled
  totals: {
    tokensOut: number;
    ticks: number;
    commits: number;
    costUsd: number;
    featuresDone: number;
    bugsFixed: number;
  };
}

/** A file's text, or "" when missing/unreadable — a report degrades to zeros, never throws. */
function readMarkdown(file: string): string {
  return readTextOrNull(file) ?? "";
}

/** The completion dates ("YYYY-MM-DD") of the entries inside one `## <sectionTitle>` section.
 * An entry starts at a `### ` heading or `- ` bullet line and ends at the next such line; only
 * its METADATA is matched for dates — never its body, so a body's "**Done 2026-…**" recap line
 * (or a prose cross-reference like "(done 2026-…)") cannot double-count. Fenced lines are
 * body content, never entry starts — an entry quoting a markdown template with a
 * `### … (fixed DATE)` heading inside must not count as a completion of its own. Metadata =
 * the start line plus, for `### ` headings only, continuation lines up to and including the
 * first line ending in `)` (capped at 3 lines) — wrapped headings carry their date on the
 * second line, while `- ` epitaphs are single-line by construction, so a bullet's own line is
 * its whole metadata (a following prose paragraph is body, never matched). Joining with a
 * space keeps "done\n2026-…" matchable. Entries without a parseable date are skipped.
 *
 * A `- ` line needs more than a date to be an entry: the sections also hold body bullets (an
 * entry's repro steps, a plan's task breakdown), and a body bullet that merely mentions a
 * completion — "- same shape as the sibling bug (fixed 2026-09-24)" — is not one. The epitaph
 * shape separates them: an epitaph always closes its line with a parenthetical that records
 * both the completion date and the landing commit ("(planned …, done …; commit abc1234)"),
 * so a bullet counts only when its trailing `(…)` group carries the date AND a `commit`
 * reference; a heading entry keeps the plain metadata match (headings are the primary entry
 * format and always close their metadata parenthetical by convention). */
function entryDates(md: string, sectionTitle: string, dateRe: RegExp): string[] {
  const dates: string[] = [];
  // A section always starts at its non-fenced `## ` heading, so a fresh tracker is in sync
  // with the document's fence state here and for the whole section.
  const fenced = fenceTracker();
  const lines = sectionLines(md, sectionTitle).filter((line) => !fenced.inside(line));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("### ") && !line.startsWith("- ")) continue;
    const meta: string[] = [line];
    let closed = line.endsWith(")");
    let j = i + 1;
    // Continuation is a heading-only concern (wrapped headings); bullets are single-line.
    while (line.startsWith("### ") && meta.length < 3 && j < lines.length && !closed) {
      const next = lines[j] ?? "";
      if (next.startsWith("### ") || next.startsWith("- ")) break; // The entry ends at the next start.
      meta.push(next);
      j++;
      closed = next.endsWith(")");
    }
    let m: RegExpMatchArray | null;
    if (line.startsWith("- ")) {
      // Epitaph guard (see the doc comment): the date must live in the line's trailing
      // parenthetical beside a commit reference, or the bullet is body text, not an entry.
      const tail = line.match(/\(([^()]*)\)\s*$/)?.[1] ?? "";
      m = tail.match(dateRe);
      if (m && !/\bcommits?\b/.test(tail)) m = null;
    } else {
      m = meta.join(" ").match(dateRe);
    }
    if (m && m[1]) dates.push(m[1]);
    i = j - 1; // The loop's ++ resumes at the first line not consumed as metadata.
  }
  return dates;
}

/** Aggregate fleet usage over exactly `days` local calendar days ending today, from the event
 * log (tick_end/merged) and the backlog history files (PLANS.md ## Done, BUGS.md ## Fixed). */
export function collectReport(root: string, days: number): ReportData {
  const now = new Date();
  // One captured instant for the whole window, so every day key derives from the same day.
  const from = formatDate(dayAt(days - 1, now));
  const to = formatDate(dayAt(0, now));

  const series: ReportDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    series.push({
      date: formatDate(dayAt(i, now)),
      tokensOut: 0,
      ticksByRole: {},
      costByRole: {},
      commits: 0,
      costUsd: 0,
      featuresDone: 0,
      bugsFixed: 0,
    });
  }
  const byDate = new Map<string, ReportDay>();
  for (const d of series) byDate.set(d.date, d);

  for (const ev of readWindowEvents(root, from).events) {
    const dayKey = eventDayKey(ev);
    const day = dayKey === null ? undefined : byDate.get(dayKey);
    if (!day) continue; // Outside [from, to] — also guards future-dated events.
    if (ev.type === "tick_end") {
      const role = eventRole(ev);
      day.ticksByRole[role] = (day.ticksByRole[role] ?? 0) + 1;
      day.tokensOut += typeof ev.tokens === "number" ? ev.tokens : 0;
      const cost = typeof ev.costUsd === "number" ? ev.costUsd : 0;
      day.costUsd += cost;
      // Zero-cost ticks contribute nothing, so they leave no key — the render's "$0 roles are
      // omitted" rule then holds on the aggregation itself, not just at display time.
      if (cost !== 0) day.costByRole[role] = (day.costByRole[role] ?? 0) + cost;
    } else if (ev.type === "merged") {
      day.commits++;
    }
  }

  const countOn = (date: string, field: "featuresDone" | "bugsFixed"): void => {
    const day = byDate.get(date);
    if (day) day[field] += 1; // Out-of-window dates drop out here.
  };
  for (const d of entryDates(readMarkdown(path.join(root, "PLANS.md")), "Done", /done (\d{4}-\d{2}-\d{2})/))
    countOn(d, "featuresDone");
  for (const d of entryDates(readMarkdown(path.join(root, "BUGS.md")), "Fixed", /\b(?:fixed|closed|resolved) (\d{4}-\d{2}-\d{2})/))
    countOn(d, "bugsFixed");

  const totals = { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  for (const d of series) {
    totals.tokensOut += d.tokensOut;
    for (const n of Object.values(d.ticksByRole)) totals.ticks += n;
    totals.commits += d.commits;
    totals.costUsd += d.costUsd;
    totals.featuresDone += d.featuresDone;
    totals.bugsFixed += d.bugsFixed;
  }

  return { days, from, to, series, totals };
}
