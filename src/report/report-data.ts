/** Collection half of the usage report: read the harness's event log and backlog history over
 * a window of local calendar days and distill it into a `ReportData` — per-day tick/token/
 * commit/cost counts plus features-done and bugs-fixed tallies from PLANS.md and BUGS.md.
 * The Markdown rendering of this data lives in src/report/report-render.ts, a pure function
 * of it; the split mirrors the failure report's (src/failure/failure-data.ts /
 * src/failure/failure-render.ts) and keeps "what happened" (window math, aggregation, bounds)
 * apart from "how it prints" (bars, cell wording), which change for different reasons — and
 * keeps core data collection out of the presentation layer, so a core consumer (as
 * /api/report already is) never forces a core→ui import. */
import { statOrNull } from "../files/files.js";
import { eventWindowCovers, readWindowEvents, REPORT_SINCE_MAX_MS } from "../events/event-window.js";
import { eventDayKey, eventRole, eventUsage, parseEventLine } from "../events/event-read.js";
import { readCompleteLines } from "../files/tail.js";
import { eventsLogPath } from "../paths.js";
import type { HarnessEvent } from "../events/events.js";
import { sectionCompletionDates } from "../backlog/backlog.js";
import { dayAt, dayKey, dayWindow, formatDate, humanSeconds } from "../text/datetime.js";
import { addTo } from "../collections.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { commitTier } from "../roles/roles.js";

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
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
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
    addTo(target.ticksByRole, role, 1);
    if (target.ticks !== undefined) target.ticks++;
    const { tokens, costUsd } = eventUsage(ev);
    target.tokensOut += tokens;
    target.costUsd += costUsd;
    if (costUsd !== 0) addTo(target.costByRole, role, costUsd);
  } else if (ev.type === "merged") {
    target.commits++;
    // Work ratio 4/4: split landed commits by base role and by tier. Instance suffixes fold
    // into their role (`feature-2` counts as feature) so the split does not fragment.
    const role = baseRoleOf(eventRole(ev));
    addTo(target.commitsByRole, role, 1);
    const tier = commitTier(role);
    if (tier === "work") target.workCommits++;
    else if (tier === "maintenance") target.maintenanceCommits++;
  } else if (ev.type === "landed" || ev.type === "land_failed") {
    target.landingRuns = (target.landingRuns ?? 0) + 1;
    const { tokens, costUsd } = eventUsage(ev);
    target.landingTokens = (target.landingTokens ?? 0) + tokens;
    target.landingCostUsd = (target.landingCostUsd ?? 0) + costUsd;
  }
}

/** One day's worth of folded events, the event-log half of a ReportDay: everything
 * foldUsageEvent accumulates for a single local day (ticks are not tracked — the series
 * derives them from ticksByRole). Cached across calls by foldWindowEvents so an appended
 * log line is folded once, not once per report request. */
interface DayFold {
  tokensOut: number;
  commits: number;
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
  costUsd: number;
  ticksByRole: Record<string, number>;
  costByRole: Record<string, number>;
  landingRuns: number;
  landingTokens: number;
  landingCostUsd: number;
}

/** The event-log half of a windowed report, memoized per (root, fromKey). `offset` is how
 * many live-log bytes the folds already cover; the log is append-only (events.ts appends
 * whole lines, rotation replaces the file whole), so appends after `offset` are the only
 * bytes a repeat request has not folded. `fileCovers` is the day-keyed read's own coverage
 * proof (readWindowEvents's coversFullWindow) — a property of the retained bytes and the
 * fromKey, both of which the cache key pins, so it cannot go stale the way a proof carried
 * across window changes would. `hadEvents`/`firstEventTs` mirror raw.events[0]'s role in
 * eventWindowCovers: the first in-window event's ts (undefined when it has no numeric ts). */
interface ReportFoldEntry {
  root: string;
  fromKey: string;
  offset: number;
  mtimeMs: number;
  // The log file's identity. Size/mtime alone cannot tell a replaced file from a grown one:
  // rotation renames events.jsonl away and a fresh log grows in its place, and a fresh file
  // whose size already exceeds the cached offset would be read from that offset and fold a
  // different log's bytes into the old folds. The inode pins the file the folds cover.
  dev: number;
  ino: number;
  fileCovers: boolean;
  hadEvents: boolean;
  firstEventTs?: number;
  days: Map<string, DayFold>;
}

/** Bounded memo of window folds. Eight entries cover a dashboard flipping among a few day
 * counts plus the midnight rollover's new fromKey; oldest-insertion eviction (Map preserves
 * insertion order) keeps the memory bound to a handful of per-day accumulator maps. */
const reportFoldCache = new Map<string, ReportFoldEntry>();
const REPORT_FOLD_CACHE_MAX = 8;

function dayFoldFor(entry: ReportFoldEntry, dayKey: string): DayFold {
  let fold = entry.days.get(dayKey);
  if (!fold) {
    fold = {
      tokensOut: 0,
      commits: 0,
      commitsByRole: {},
      workCommits: 0,
      maintenanceCommits: 0,
      costUsd: 0,
      ticksByRole: {},
      costByRole: {},
      landingRuns: 0,
      landingTokens: 0,
      landingCostUsd: 0,
    };
    entry.days.set(dayKey, fold);
  }
  return fold;
}

/** Fold one already-parsed event into a cache entry: only in-window events (a non-null day
 * on or after fromKey) count, matching readWindowEvents's event list; the first such event
 * seen takes firstEventTs. The one home of the fold body, shared by the incremental append
 * path (foldLineInto) and the full re-read path, so the two can never drift. */
function foldEventInto(entry: ReportFoldEntry, ev: HarnessEvent): void {
  const dayKey = eventDayKey(ev);
  if (dayKey === null || dayKey < entry.fromKey) return;
  if (!entry.hadEvents) {
    entry.hadEvents = true;
    entry.firstEventTs = typeof ev.ts === "number" ? ev.ts : undefined;
  }
  foldUsageEvent(dayFoldFor(entry, dayKey), ev);
}

/** Parse one appended log line and fold it; a torn or non-event line folds nothing. */
function foldLineInto(entry: ReportFoldEntry, line: string): void {
  const ev = parseEventLine(line);
  if (ev) foldEventInto(entry, ev);
}

/** The event-log half of collectReport, memoized: a dashboard re-fetching /api/report every
 * poll re-read and re-parsed the whole window's log bytes each time (~6.8 MB and tens of ms
 * on this repo's own day log, growing toward the 16 MB rotation cap). Now a request whose
 * log has not changed costs one stat; growth folds only the appended complete lines
 * (readCompleteLines holds back a torn trailing write, so it is folded whole next call).
 * Same size with a changed mtime, a shrunken file (rotation or rewrite), or a new fromKey
 * falls back to the full readWindowEvents pass — the fallback re-derives everything, so a
 * mis-fold can only come from the append assumption, and rotation's whole-file replace
 * always hits the shrink arm. The entry's coverage parts are pinned by the cache key:
 * fromKey and file bytes decide them, so an advancing window re-derives fresh instead of
 * carrying yesterday's proof forward. */
function foldWindowEvents(root: string, fromKey: string): ReportFoldEntry {
  const key = `${root}\0${fromKey}`;
  const liveStat = statOrNull(eventsLogPath(root));
  const size = liveStat?.size ?? 0;
  const mtimeMs = liveStat?.mtimeMs ?? 0;
  const dev = liveStat?.dev ?? 0;
  const ino = liveStat?.ino ?? 0;
  const cached = reportFoldCache.get(key);
  if (cached && size === cached.offset && mtimeMs === cached.mtimeMs && dev === cached.dev && ino === cached.ino) {
    reportFoldCache.delete(key); // Refresh LRU position.
    reportFoldCache.set(key, cached);
    return cached;
  }
  if (cached && size > cached.offset && dev === cached.dev && ino === cached.ino) {
    const { lines, end } = readCompleteLines(eventsLogPath(root), cached.offset, size);
    if (end > cached.offset) {
      for (const line of lines) foldLineInto(cached, line);
      cached.offset = end;
      cached.mtimeMs = mtimeMs;
      return cached;
    }
    // Grown but no complete line yet (a torn write in flight): reuse the folds; the next
    // request sees the completed line and folds it then.
    return cached;
  }
  const raw = readWindowEvents(root, fromKey);
  const entry: ReportFoldEntry = {
    root,
    fromKey,
    // The scan's own end, not the outer `size`: an event appended between that stat and the
    // read is already folded, and seeding the offset from the stale size would fold it again
    // on the next append (readTailTextWithEnd's coveredEnd is exactly where the scan stopped).
    offset: raw.liveEnd,
    mtimeMs,
    dev,
    ino,
    fileCovers: raw.coversFullWindow,
    hadEvents: false,
    days: new Map(),
  };
  for (const ev of raw.events) foldEventInto(entry, ev);
  if (reportFoldCache.size >= REPORT_FOLD_CACHE_MAX) {
    const oldest = reportFoldCache.keys().next().value;
    if (oldest !== undefined) reportFoldCache.delete(oldest);
  }
  reportFoldCache.set(key, entry);
  return entry;
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
  commitsByRole?: Record<string, number>; // landed commits by base role (Work ratio 4/4)
  workCommits?: number; // of those, feature/bugfix/director
  maintenanceCommits?: number; // of those, code-maintenance + readme
  costUsd: number;
  featuresDone: number;
  bugsFixed: number;
  landingRuns?: number; // landed/land_failed events this day folded (absent when none)
  landingTokens?: number; // their output tokens, also included in tokensOut above
  landingCostUsd?: number; // their cost, also included in costUsd above
}

/** The window totals both reports surface — output tokens (the landing share included), the
 * tick and commit counts, cost (the landing share included), and the landing share named for
 * itself. SinceReport carries it directly; ReportData adds the day-granular backlog tallies
 * on top. The single home of this shape, so report-render.ts's totalsLine/landingShareLine
 * read exactly the fields the collectors produce. */
export interface ReportTotals {
  tokensOut: number; // includes landing spend — the same events the daily budget charges
  ticks: number;
  commits: number;
  costUsd: number; // includes landing spend, so the report and the budget agree
  landingRuns: number; // the landing share of the above, named for itself
  landingTokens: number;
  landingCostUsd: number;
}

/** Fleet usage over a window of exactly `days` local calendar days ending today. */
export interface ReportData {
  days: number;
  from: string; // day key of the oldest day in the series
  to: string; // day key of today
  series: ReportDay[]; // oldest → newest, zero-filled
  totals: ReportTotals & {
    featuresDone: number;
    bugsFixed: number;
    commitsByRole?: Record<string, number>;
    workCommits?: number;
    maintenanceCommits?: number;
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
  totals: ReportTotals;
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
    throw new Error(
      `sinceMs must be between 1 and ${humanSeconds(REPORT_SINCE_MAX_MS / 1000)} (got ${sinceMs})`,
    );
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
    commitsByRole: {},
    workCommits: 0,
    maintenanceCommits: 0,
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
      commitsByRole: {},
      workCommits: 0,
      maintenanceCommits: 0,
      costUsd: 0,
      featuresDone: 0,
      bugsFixed: 0,
    });
  }
  const byDate = new Map<string, ReportDay>();
  for (const d of series) byDate.set(d.date, d);

  const foldEntry = foldWindowEvents(root, from);
  for (const [dayKey, fold] of foldEntry.days) {
    const day = byDate.get(dayKey);
    if (!day) continue; // Out-of-window day key (e.g. future-dated) — no series slot to fill.
    day.tokensOut = fold.tokensOut;
    day.ticksByRole = fold.ticksByRole;
    day.costByRole = fold.costByRole;
    day.commits = fold.commits;
    day.commitsByRole = fold.commitsByRole;
    day.workCommits = fold.workCommits;
    day.maintenanceCommits = fold.maintenanceCommits;
    day.costUsd = fold.costUsd;
    day.landingRuns = fold.landingRuns;
    day.landingTokens = fold.landingTokens;
    day.landingCostUsd = fold.landingCostUsd;
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
  for (const d of sectionCompletionDates(root, "PLANS.md", "Done", /done (\d{4}-\d{2}-\d{2})/))
    countOn(d, "featuresDone");
  // The completion verbs track the phrasing the harness's own loops actually write: the
  // bugfix prompt pins the date, not the verb, and the re-land flow's own epitaph —
  // "re-landed <date>" on an entry whose first landing was rejected in review — is a
  // completion the report must count (a rejected landing is not a fix, the re-land is).
  // Body verbs without a date ("was fixed;") match nothing, and a bare "landed <date>"
  // stays out: headings mention sibling landings, and a sibling's date is not this entry's.
  for (const d of sectionCompletionDates(root, "BUGS.md", "Fixed", /\b(?:re-landed|fixed|closed|resolved) (\d{4}-\d{2}-\d{2})/))
    countOn(d, "bugsFixed");

  const totals = {
    tokensOut: 0,
    ticks: 0,
    commits: 0,
    commitsByRole: {} as Record<string, number>,
    workCommits: 0,
    maintenanceCommits: 0,
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
    for (const [role, n] of Object.entries(d.commitsByRole ?? {})) addTo(totals.commitsByRole, role, n);
    totals.workCommits += d.workCommits ?? 0;
    totals.maintenanceCommits += d.maintenanceCommits ?? 0;
    totals.costUsd += d.costUsd;
    totals.featuresDone += d.featuresDone;
    totals.bugsFixed += d.bugsFixed;
    totals.landingRuns += d.landingRuns ?? 0;
    totals.landingTokens += d.landingTokens ?? 0;
    totals.landingCostUsd += d.landingCostUsd ?? 0;
  }

  // The shared coverage proof (event-window.ts), rebuilt from the memoized read's pinned
  // parts: the day-keyed proof (fileCovers — a property of the retained bytes and fromKey,
  // both in the cache key), the vacuous empty-log arm, and the oldest retained event's ts.
  // The window's first local midnight is the cutoff: an event at that instant is the
  // earliest the window could contain, so the same-day arm degenerates harmlessly. Without
  // this field the day report was the one windowed consumer that could undercount in
  // silence — the --since report and the failure digest both carry the note, and a silent
  // number invites an operator to trust a truncated window as an idle fleet.
  const cutoffMs = dayAt(days - 1, now).getTime();
  const coversFullWindow =
    foldEntry.fileCovers ||
    !foldEntry.hadEvents ||
    (foldEntry.firstEventTs !== undefined && foldEntry.firstEventTs <= cutoffMs);
  return { days, from, to, series, totals, coversFullWindow };
}
