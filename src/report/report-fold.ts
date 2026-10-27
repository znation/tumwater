/** The windowed event-log fold backing the usage report: read the harness's event log over a
 * local-day window, memoize the day-keyed read per (root, fromKey) so a dashboard polling
 * /api/report only folds appended lines instead of re-reading the window, and group events
 * into per-day `DayFold` accumulators plus the base-role scoping helpers the day and failure
 * reports share. The two window collectors — collectReport (src/report/report-data.ts) and
 * collectReportSince (src/report/report-since-data.ts) — fold through this layer, each parsed
 * event through the shared single-event core in src/report/report-usage-fold.ts
 * (`foldUsageEvent`), so the --since and day windows present cannot drift apart; it lives here
 * matching its own test (test/report-fold-cache.test.ts). Zero incidental runtime
 * dependencies: node built-ins and the app's own modules only. */
import { sameStatIdentity, statIdentityOrZero, statOrNull } from "../files/files.js";
import { readWindowEvents } from "../events/event-window.js";
import { eventDayKey, parseEventLine } from "../events/event-read.js";
import { readCompleteLines } from "../files/tail.js";
import { eventsLogPath } from "../paths.js";
import type { HarnessEvent } from "../events/events.js";
import { isPassingMainCheck, isRedMain } from "../baseline/main-guardrails.js";
import { memoSetLru } from "../collections.js";
import { asList } from "../text/text.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { foldUsageEvent } from "./report-usage-fold.js";
/** One day's worth of folded events, the event-log half of a ReportDay: everything
 * foldUsageEvent accumulates for a single local day (runs are not tracked — the series
 * derives them from runsByRole). Cached across calls by foldWindowEvents so an appended
 * log line is folded once, not once per report request. */
interface DayFold {
  tokensOut: number;
  commits: number;
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
  costUsd: number;
  notionalCostUsd: number;
  runsByRole: Record<string, number>;
  rejectionsByRole: Record<string, number>;
  /** The day's `review_rejected` events whose `afterMerge` is true, per role id — the subset
   * of rejectionsByRole whose rejection reached an already-merged commit. */
  postMergeRejectionsByRole: Record<string, number>;
  revisionsByRole: Record<string, number>;
  refusalsByRole: Record<string, number>;
  /** Wall-clock ms of each passing full-suite build_check that day, unsorted. */
  checkDurationsMs: number[];
  /** Count of failed full-suite build_check events that day (isRedFullCheck). */
  checkFailures: number;
  /** Enqueue-to-outcome ms of each merge_done that carries queuedMs, unsorted. */
  mergeWaitsMs: number[];
  /** Verification-start-to-outcome ms of each that-day merge_done that carries positive
   * durationMs (writeMergeOutcome), unsorted — how long the merge slot itself held each
   * change it landed. */
  mergeDurationsMs: number[];
  /** ms of each that-day run_end that carried a positive durationMs, unsorted. */
  runDurationsMs: number[];
  /** ms of each that-day provider_wait event that carries positive waitedMs, unsorted. */
  providerWaitsMs: number[];
  /** ms of each that-day slot_wait event that carries positive waitedMs, unsorted. */
  slotWaitsMs: number[];
  /** ms of each that-day check_wait event that carries positive waitedMs, unsorted. */
  checkWaitsMs: number[];
  /** ms of each reviewer run that reached a verdict that day (a `review_verdict` approval or
   * a `review_rejected` that carried a positive durationMs), unsorted. */
  reviewDurationsMs: number[];
  failedRunsByRole: Record<string, number>;
  fallbacksByRole: Record<string, number>;
  imageReroutesByRole: Record<string, number>;
  tokensByRole: Record<string, number>;
  promptTokensByRole: Record<string, number>;
  cacheReadTokensByRole: Record<string, number>;
  costByRole: Record<string, number>;
  notionalByRole: Record<string, number>;
  mergeRuns: number;
  mergeTokens: number;
  mergeCostUsd: number;
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  mergedByRole: Record<string, number>;
  mergeFailedByRole: Record<string, number>;
  mergeFailedByReason: Record<string, number>;
  costByProvider: Record<string, number>;
  notionalByProvider: Record<string, number>;
  notionalByBackend: Record<string, number>;
  runsByModel: Record<string, number>;
  deferredByReason: Record<string, number>;
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
  /** The main is-red / passing-check / culprit events folded so far, in fold order — the
   * retained input the report's per-day main-red walk (src/report/report-main-red.ts)
   * reads. Only the three shapes it needs are kept, so the list stays tiny across the
   * append-only fold. */
  redEvents: HarnessEvent[];
}

/** Bounded memo of window folds. Eight entries cover a dashboard flipping among a few day
 * counts plus the midnight rollover's new fromKey; oldest-insertion eviction (Map preserves
 * insertion order) keeps the memory bound to a handful of per-day accumulator maps. */
const reportFoldCache = new Map<string, ReportFoldEntry>();
const REPORT_FOLD_CACHE_MAX = 8;

/** The empty commit-family counters every accumulator starts from: the total and per-base-role
 * merged-commit count plus the work/maintenance split (Work ratio 4/4). Four shapes carry them —
 * DayFold, UsageFold, the ReportDay series slots, and the window totals — so the empty quartet
 * lives once here and a new commit counter is added in one place. */
export function zeroCommitCounts(): {
  commits: number;
  commitsByRole: Record<string, number>;
  workCommits: number;
  maintenanceCommits: number;
} {
  return { commits: 0, commitsByRole: {}, workCommits: 0, maintenanceCommits: 0 };
}

/** The empty merge-run counters every accumulator starts from: the merge slot's run count
 * and its own token/cost share (foldUsageEvent's merge_done/merge_failed branch). Four shapes carry
 * them — DayFold, UsageFold, the scoped window totals, and the window totals — so the empty
 * triple lives once here and a new merge counter is added in one place. */
export function zeroMergeCounts(): {
  mergeRuns: number;
  mergeTokens: number;
  mergeCostUsd: number;
} {
  return { mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
}

/** Build one object-literal spread cell for a per-slice role/product map only when the map has
 * entries (`map` non-empty), so an entry-free window omits the field instead of carrying an
 * empty map. The single home of that guard for both window collectors — the day report's and
 * the trailing-window totals object-literal spreads all followed it inline before. */
export function nonemptyObj<K extends string>(key: K, map: Record<string, number>): Partial<Record<K, Record<string, number>>> {
  return Object.keys(map).length > 0 ? ({ [key]: map } as Record<K, Record<string, number>>) : {};
}

/** The base roles a report scope names: undefined and an empty list mean no scope (the team
 * report); otherwise each id folded through `baseRoleOf`, deduplicated in first-seen order, so
 * `feature-2,feature` is one base. */
export function scopeBases(role: string | readonly string[] | undefined): string[] | undefined {
  if (role === undefined) return undefined;
  const ids = asList(role);
  if (ids.length === 0) return undefined;
  const out: string[] = [];
  for (const id of ids) {
    const base = baseRoleOf(id);
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** Sum a per-role-id count/cost map over the scoped base roles: instance keys (`feature-2`)
 * fold into their base (`feature`), so a scoped report aggregates a whole role group exactly
 * as the per-role cap's group does. Runs/tokens/cost are keyed by exact role id while commits are
 * already base-role keyed; running every key through `baseRoleOf` reads both shapes the same
 * and returns 0 when nothing matches. */
export function roleSum(record: Record<string, number>, bases: string | readonly string[]): number {
  const list = asList(bases);
  let sum = 0;
  for (const [key, n] of Object.entries(record)) {
    if (list.includes(baseRoleOf(key))) sum += n;
  }
  return sum;
}

/** Narrow a per-role-id count/cost map to the scoped base roles, one entry per base keyed by
 * that base; a role absent from the map (no runs, or no nonzero cost) yields no entry, never
 * a zero one — the same zero-means-absent rule the team render applies. Used by the
 * role-scoped collectors so a scoped series derives from the fold's per-role maps without
 * inventing entries. */
export function narrowToRole(
  record: Record<string, number>,
  bases: string | readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const base of asList(bases)) {
    const n = roleSum(record, base);
    if (n !== 0) out[base] = n;
  }
  return out;
}

/** A per-role map scoped to the base roles of a report: the full map as-is when no scope is
 * set (a team report), else the same map narrowed to `bases` — narrowToRole's zero-means-absent
 * rule, so a scoped report never invents a zero entry. The one home of the "keep everything,
 * or keep only the named base role" rule: all 21 per-role, reason-keyed, and team-attribution
 * fields of the `--since` report's output shape through it — the four team maps
 * (costByProvider, notionalByProvider, notionalByBackend, runsByModel) narrow to empty in a
 * scoped window (a provider/backend/model is not a role) but still shape through it — so the
 * scoping rule cannot drift between them. */
export function scopedByRole(
  record: Record<string, number>,
  bases: readonly string[] | undefined,
): Record<string, number> {
  return bases === undefined ? record : narrowToRole(record, bases);
}

function dayFoldFor(entry: ReportFoldEntry, dayKey: string): DayFold {
  let fold = entry.days.get(dayKey);
  if (!fold) {
    fold = {
      tokensOut: 0,
      ...zeroCommitCounts(),
      costUsd: 0,
      notionalCostUsd: 0,
      runsByRole: {},
      rejectionsByRole: {},
      postMergeRejectionsByRole: {},
      revisionsByRole: {},
      refusalsByRole: {},
      checkDurationsMs: [],
      checkFailures: 0,
      mergeWaitsMs: [],
      mergeDurationsMs: [],
      runDurationsMs: [],
      providerWaitsMs: [],
      slotWaitsMs: [],
      checkWaitsMs: [],
      reviewDurationsMs: [],
      failedRunsByRole: {},
      fallbacksByRole: {},
      imageReroutesByRole: {},
      tokensByRole: {},
      promptTokensByRole: {},
      cacheReadTokensByRole: {},
      costByRole: {},
      notionalByRole: {},
      ...zeroMergeCounts(),
      mergedByRole: {},
      mergeFailedByRole: {},
      mergeFailedByReason: {},
      costByProvider: {},
      notionalByProvider: {},
      notionalByBackend: {},
      runsByModel: {},
      deferredByReason: {},
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
  if (isRedMain(ev) || isPassingMainCheck(ev) || ev.type === "main_culprit") entry.redEvents.push(ev);
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
export function foldWindowEvents(root: string, fromKey: string): ReportFoldEntry {
  const key = `${root}\0${fromKey}`;
  const { size, mtimeMs, dev, ino } = statIdentityOrZero(statOrNull(eventsLogPath(root)));
  const cached = reportFoldCache.get(key);
  if (
    cached &&
    sameStatIdentity(
      { dev, ino, mtimeMs, size },
      { dev: cached.dev, ino: cached.ino, mtimeMs: cached.mtimeMs, size: cached.offset },
    )
  ) {
    memoSetLru(reportFoldCache, key, cached, REPORT_FOLD_CACHE_MAX);
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
    redEvents: [],
  };
  for (const ev of raw.events) foldEventInto(entry, ev);
  memoSetLru(reportFoldCache, key, entry, REPORT_FOLD_CACHE_MAX);
  return entry;
}
