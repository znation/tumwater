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
import { eventWindowCovers, readWindowEvents, REPORT_SINCE_MAX_MS } from "./event-window.js";
import { eventDayKey, eventRole, eventUsage, type HarnessEvent } from "./events.js";
import { fenceTracker, sectionLines } from "./backlog.js";
import { dayAt, dayKey, dayWindow, formatDate } from "./datetime.js";

/** The fields both usage collectors fold events into: per-role tick counts, per-role cost,
 * and the totals each render prints. `ticks` is counted only where a consumer needs a window
 * total (the trailing-window report); the per-day series derives it later by summing
 * ticksByRole, so a day carries no redundant counter. The landing fields mirror that split
 * for the landing slot's own pi runs (reviewer + conflict resolution): their tokens/cost
 * always accumulate into `landingTokens`/`landingCostUsd` — never into `tokensOut`/`costUsd`
 * here, so each collector decides once how the landing share joins its surfaced totals (the
 * budget charges these same events, so the totals must include it) — and `landingRuns` counts
 * `landed`/`land_failed` events on every target: unlike ticks there is no per-role map a day
 * could derive a run count from, so the day must fold it for the totals to sum. */
interface UsageFold {
  ticks?: number;
  ticksByRole: Record<string, number>;
  costByRole: Record<string, number>;
  tokensOut: number;
  commits: number;
  costUsd: number;
  landingRuns?: number;
  landingTokens?: number;
  landingCostUsd?: number;
}

/** Fold one event into a usage accumulator: tick_end events add a tick (per role and, when
 * the target counts ticks, in total), their output tokens, and their cost — zero-cost ticks
 * contribute nothing, so they leave no costByRole key, keeping the render's "$0 roles are
 * omitted" rule true on the aggregation itself, not just at display time; merged events add
 * a commit; landed/land_failed events add a landing run and
 * accumulate their tokens/cost into the landing fields only — costByRole stays a ticks-only
 * breakdown, and the landing line is how the reviewer's share is named. Both collectors fold
 * through this one place, so the two windows' aggregation rules cannot drift apart. */
function foldUsageEvent(target: UsageFold, ev: HarnessEvent): void {
  if (ev.type === "tick_end") {
    const role = eventRole(ev);
    target.ticksByRole[role] = (target.ticksByRole[role] ?? 0) + 1;
    if (target.ticks !== undefined) target.ticks++;
    const { tokens, costUsd } = eventUsage(ev);
    target.tokensOut += tokens;
    target.costUsd += costUsd;
    if (costUsd !== 0) target.costByRole[role] = (target.costByRole[role] ?? 0) + costUsd;
  } else if (ev.type === "merged") {
    target.commits++;
  } else if (ev.type === "landed" || ev.type === "land_failed") {
    target.landingRuns = (target.landingRuns ?? 0) + 1;
    const { tokens, costUsd } = eventUsage(ev);
    target.landingTokens = (target.landingTokens ?? 0) + tokens;
    target.landingCostUsd = (target.landingCostUsd ?? 0) + costUsd;
  }
}

/** One day of a usage report: the local calendar day key plus what the fleet did on it.
 * `ticksByRole` counts tick_end events per loop id (role ids — works for custom loops too);
 * tokensOut sums their `tokens`; commits counts `merged` events; costUsd sums `costUsd`.
 * `costByRole` splits that same costUsd per loop id — sourced from the same tick_end events
 * (never a second pass), so its per-day sum equals the day's costUsd by construction.
 * Landing usage (`landed`/`land_failed`) is sparse: the landing fields are absent until the
 * day folds a landing event, and a day's tokensOut/costUsd already include the landing share
 * by the time they are read (the collector folds it in right after the event pass), so the
 * series keeps summing to the totals the budget also reports. */
export interface ReportDay {
  date: string; // "YYYY-MM-DD" local day key
  tokensOut: number;
  ticksByRole: Record<string, number>;
  costByRole: Record<string, number>;
  commits: number;
  costUsd: number;
  featuresDone: number;
  bugsFixed: number;
  landingRuns?: number; // landed/land_failed events this day folded (absent when none)
  landingTokens?: number; // their output tokens, also included in tokensOut above
  landingCostUsd?: number; // their cost, also included in costUsd above
}

/** Fleet usage over a window of exactly `days` local calendar days ending today. */
export interface ReportData {
  days: number;
  from: string; // day key of the oldest day in the series
  to: string; // day key of today
  series: ReportDay[]; // oldest → newest, zero-filled
  totals: {
    tokensOut: number; // includes landing spend — the same events the daily budget charges
    ticks: number;
    commits: number;
    costUsd: number; // includes landing spend, so the report and the budget agree
    featuresDone: number;
    bugsFixed: number;
    landingRuns: number; // the landing share of the above, named for itself
    landingTokens: number;
    landingCostUsd: number;
  };
  /** True when the report provably reflects every event the window could have contained:
   * the day-keyed read proved the log reaches back before the window's first day, or the
   * retained log holds no events at all — nothing ever existed that could have rotated away.
   * False means events were aggregated from a log whose oldest event lies inside the window
   * with no proof that older data was not rotated away (two or more 16 MB rotations inside a
   * long window outrun the one kept archive generation) — the renders say so, exactly as the
   * --since report and the failure digest already do. */
  coversFullWindow: boolean;
}

/** Fleet usage over a trailing window of `sinceMs` ending now: the same tick_end/merged
 * aggregation as `collectReport` but keyed to a cutoff instant rather than whole local days.
 * Backlog tallies (features done / bugs fixed) are deliberately absent: they are counted from
 * PLANS.md/BUGS.md `done`/`fixed` dates, which are day-granular file metadata that cannot
 * subdivide a sub-day window — the render says so instead of showing a day-rounded number. */
export interface SinceReport {
  sinceMs: number; // the requested window length
  fromIso: string; // ISO string of the cutoff instant (window start)
  totals: {
    tokensOut: number; // includes landing spend — the same events the daily budget charges
    ticks: number;
    commits: number;
    costUsd: number; // includes landing spend, so the report and the budget agree
    landingRuns: number; // the landing share of the above, named for itself
    landingTokens: number;
    landingCostUsd: number;
  };
  ticksByRole: Record<string, number>;
  costByRole: Record<string, number>; // zero-cost roles leave no key, as in collectReport
  /** True when the report provably reflects every event the window could have contained:
   * the day-keyed read proved the log reaches back before the cutoff's day, the log's oldest
   * retained event predates the cutoff instant (the same-day case a day key cannot decide),
   * or the retained log holds no events at all — nothing ever existed that could have rotated
   * away, so an empty or missing log must not read as a truncated history. False means events
   * were aggregated from a log whose oldest event lies inside the window with no proof that
   * older data was not rotated away — the render adds a note so a sparse window is never
   * mistaken for an idle fleet. */
  coversFullWindow: boolean;
}

/** Aggregate fleet usage over the trailing `sinceMs` window ending now, from the event log
 * only (tick_end/merged — see SinceReport for why the backlog files are not read). Kept a
 * separate function rather than a `collectReport` variant flag: the day collector's
 * zero-filled series and backlog-file reads have no place in a window totals view. */
export function collectReportSince(root: string, sinceMs: number): SinceReport {
  if (sinceMs <= 0 || sinceMs > REPORT_SINCE_MAX_MS)
    throw new Error(`sinceMs must be between 1 and REPORT_SINCE_MAX_MS (got ${sinceMs})`);
  const now = Date.now();
  const cutoff = now - sinceMs;
  // The window key is the cutoff's local calendar day, from the shared dayKey helper
  // eventDayKey buckets events with, so the read's day keys cannot disagree with the ts
  // filter below; the day-keyed read may include earlier hours of that day, which the ts
  // filter removes (over-read is at most one day's events). Future-dated events are dropped
  // here too, matching collectReport (its day map only holds the window's days).
  const fromKey = dayKey(cutoff);
  const raw = readWindowEvents(root, fromKey);
  const acc: UsageFold = {
    ticks: 0,
    ticksByRole: {},
    costByRole: {},
    tokensOut: 0,
    commits: 0,
    costUsd: 0,
    landingRuns: 0,
    landingTokens: 0,
    landingCostUsd: 0,
  };
  for (const ev of raw.events) {
    if (typeof ev.ts !== "number" || ev.ts < cutoff || ev.ts > now) continue;
    foldUsageEvent(acc, ev);
  }
  // The empty-window branch of the shared proof matters here: with no retained events nothing
  // can have rotated away, and printing a rotation note over a fresh install would claim a
  // history that never existed. When neither proof holds, the oldest retained event lies inside
  // the window and the render notes the possible truncation.
  const coversFullWindow = eventWindowCovers(raw, cutoff);
  return {
    sinceMs,
    fromIso: new Date(cutoff).toISOString(),
    totals: {
      tokensOut: acc.tokensOut + (acc.landingTokens ?? 0),
      ticks: acc.ticks ?? 0,
      commits: acc.commits,
      costUsd: acc.costUsd + (acc.landingCostUsd ?? 0),
      landingRuns: acc.landingRuns ?? 0,
      landingTokens: acc.landingTokens ?? 0,
      landingCostUsd: acc.landingCostUsd ?? 0,
    },
    ticksByRole: acc.ticksByRole,
    costByRole: acc.costByRole,
    coversFullWindow,
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
  const { from, to } = dayWindow(days, now);

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

  const raw = readWindowEvents(root, from);
  for (const ev of raw.events) {
    const dayKey = eventDayKey(ev);
    const day = dayKey === null ? undefined : byDate.get(dayKey);
    if (!day) continue; // Outside [from, to] — also guards future-dated events.
    foldUsageEvent(day, ev);
  }

  // The landing share joins its day's tokensOut/costUsd (the budget charges these same
  // events, so the day series must sum to the totals the budget agrees with) while the
  // landing fields keep the reviewer's part of it visible on its own.
  for (const d of series) {
    d.tokensOut += d.landingTokens ?? 0;
    d.costUsd += d.landingCostUsd ?? 0;
  }

  const countOn = (date: string, field: "featuresDone" | "bugsFixed"): void => {
    const day = byDate.get(date);
    if (day) day[field] += 1; // Out-of-window dates drop out here.
  };
  for (const d of entryDates(readMarkdown(path.join(root, "PLANS.md")), "Done", /done (\d{4}-\d{2}-\d{2})/))
    countOn(d, "featuresDone");
  // The completion verbs track the phrasing the harness's own loops actually write: the
  // bugfix prompt pins the date, not the verb, and the re-land flow's own epitaph —
  // "re-landed <date>" on an entry whose first landing was rejected in review — is a
  // completion the report must count (a rejected landing is not a fix, the re-land is).
  // Body verbs without a date ("was fixed;") match nothing, and a bare "landed <date>"
  // stays out: headings mention sibling landings, and a sibling's date is not this entry's.
  for (const d of entryDates(readMarkdown(path.join(root, "BUGS.md")), "Fixed", /\b(?:re-landed|fixed|closed|resolved) (\d{4}-\d{2}-\d{2})/))
    countOn(d, "bugsFixed");

  const totals = {
    tokensOut: 0,
    ticks: 0,
    commits: 0,
    costUsd: 0,
    featuresDone: 0,
    bugsFixed: 0,
    landingRuns: 0,
    landingTokens: 0,
    landingCostUsd: 0,
  };
  for (const d of series) {
    totals.tokensOut += d.tokensOut;
    for (const n of Object.values(d.ticksByRole)) totals.ticks += n;
    totals.commits += d.commits;
    totals.costUsd += d.costUsd;
    totals.featuresDone += d.featuresDone;
    totals.bugsFixed += d.bugsFixed;
    totals.landingRuns += d.landingRuns ?? 0;
    totals.landingTokens += d.landingTokens ?? 0;
    totals.landingCostUsd += d.landingCostUsd ?? 0;
  }

  // The shared coverage proof (event-window.ts), with the window's first local midnight as
  // the cutoff: an event at that instant is the earliest the window could contain, so the
  // same-day arm degenerates harmlessly. Without this field the day report was the one
  // windowed consumer that could undercount in silence — the --since report and the failure
  // digest both carry the note, and a silent number invites an operator to trust a truncated
  // window as an idle fleet.
  const coversFullWindow = eventWindowCovers(raw, dayAt(days - 1, now).getTime());
  return { days, from, to, series, totals, coversFullWindow };
}
