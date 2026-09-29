/** Collection half of `tumwater history`: read the event log and distill the last N completed
 * ticks into TickRow — one row per tick, newest first, with the paired duration and the raw
 * usage numbers. The Markdown/table rendering of this data lives in ui/history.ts, a pure
 * function of it; the split mirrors the usage report's (report-data.ts / ui/report.ts) and
 * keeps "what happened" (tick pairing, role filtering, scan windows) apart from "how it
 * prints" (column widths, terminal display padding), which change for different reasons —
 * and keeps core data collection out of the presentation layer, so a core consumer (as the
 * GUI's /api/history already is) never forces a core→ui import. */
import { eventUsage, readEvents, tickStartMap, type HarnessEvent } from "./events.js";
import { formatTimestamp } from "./datetime.js";
import { collapseWhitespace, truncate } from "./text.js";
import { usageText } from "./event-format.js";

/** `history`'s default row count and ceiling. The default shows a working hour of a quiet
 * fleet; the ceiling bounds how much log one ask re-reads — more rows only re-read more log
 * with no added signal, so an explicit flag above it fails fast (the report's --days pattern). */
export const HISTORY_DEFAULT_TICKS = 20;
export const HISTORY_MAX_TICKS = 200;

/** How much of a tick's summary or error a row keeps. Long enough to name the work, short
 * enough that the row stays one terminal line next to its other columns. */
const DETAIL_MAX = 72;

/** The hard ceiling on one ask's scan window (events, not rows): the growth loop below
 * re-reads with a larger window only while the filtered rows fall short and the log may hold
 * more, and this bounds the worst case — readTailText reads bytes proportional to the limit's
 * line count, so the cap is also the largest byte read one command can cost. Comfortably
 * above the dilution a whole role catalog can impose on HISTORY_MAX_TICKS rows. */
const HISTORY_SCAN_MAX_EVENTS = 20_000;

/** One completed tick, rendered. `durationMs` is null when the tick's `tick_start` is not in
 * the scanned window (log rotation, or a skipped tick that never started) — the row shows a
 * dash rather than a fabricated duration. `usage` is "" when the event carries neither tokens
 * nor cost, matching the payload's omit-when-zero convention. `ts` is the raw tick_end instant
 * (epoch ms) the rendered `time` string is derived from, and `tokens`/`costUsd` the raw usage
 * numbers `usage` folds into one string (0 when the event carries none — eventUsage's
 * loose-typing coercion, shared with the event feed's fragment): the three fields `tumwater history --json` and the GUI's
 * /api/history serve so a script gets the numbers, not the table's rendering of them. */
export interface TickRow {
  ts: number;
  time: string;
  loop: string;
  tick: number;
  result: string;
  durationMs: number | null;
  tokens: number;
  costUsd: number;
  usage: string;
  detail: string;
}

/** The tick rows for the last `limit` completed ticks in `events` (oldest-first, as
 * readEvents returns them), filtered to `role` when given, newest first. Pure: the CLI, the
 * GUI, and the tests share this collector, and none of them writes anything. */
export function tickRows(events: HarnessEvent[], limit: number, role: string | null): TickRow[] {
  const scoped = role === null ? events : events.filter((e) => e.loop === role);
  // The start pairing is the shared helper (events.ts), so history's dash-on-unpaired rule
  // and the digest's fold cannot drift into different notions of a tick's span.
  const starts = tickStartMap(scoped);
  const rows: TickRow[] = [];
  for (let i = scoped.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = scoped[i];
    if (!e || e.type !== "tick_end") continue;
    const startTs = starts.get(`${e.loop}#${e.tick}`);
    const usage = eventUsage(e);
    rows.push({
      ts: e.ts,
      time: formatTimestamp(e.ts),
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      loop: String(e.loop),
      tick: Number(e.tick),
      result: String(e.result),
      durationMs: startTs === undefined ? null : Math.max(0, e.ts - startTs),
      usage: usageText(e),
      detail: truncate(collapseWhitespace(String(e.summary ?? e.error ?? "")), DETAIL_MAX),
    });
  }
  return rows;
}

/** The last `limit` completed ticks read from root's event log, filtered to `role` when
 * given (newest first) — the scan cmdHistory and the GUI's handleHistory share, so the two
 * surfaces cannot drift. A window twice the ask plus slack: tick_start lines and unrelated
 * events interleave with the tick_end rows scanned for, and a skipped tick's end rides a start
 * that may sit outside any smaller window. Two shortfalls grow the window (and re-read) while
 * the scan filled it — `events.length >= window` means the log may hold older events — under
 * the same HISTORY_SCAN_MAX_EVENTS bound so one ask cannot scan without end:
 * - Rows fall short. A role filter dilutes the window (every other loop's events occupy it
 *   too), so a quiet role in a busy fleet must still get its last `limit` ticks whenever the
 *   retained log holds them — never a bare "no ticks yet" for a role whose ticks sit just
 *   past the first window.
 * - A row's tick_start went unpaired. The window boundary can cut inside a tick's own event
 *   block: every tick_end of the ask sits within the window but the oldest one's tick_start
 *   sits just before it, so the row renders a dash though the log holds the start. Every
 *   tick_end the harness logs follows its tick_start (tick() logs the start before runTick,
 *   skipped results included), so an unpaired start is either just past the window or lost
 *   to rotation — growing re-pairs the former, and the latter only costs the bounded scan. */
export function readTickRows(root: string, limit: number, role: string | null): TickRow[] {
  let window = limit * 2 + 50;
  let events = readEvents(root, window);
  let rows = tickRows(events, limit, role);
  while (
    (rows.length < limit || rows.some((r) => r.durationMs === null)) &&
    events.length >= window &&
    window < HISTORY_SCAN_MAX_EVENTS
  ) {
    window = Math.min(window * 4, HISTORY_SCAN_MAX_EVENTS);
    events = readEvents(root, window);
    rows = tickRows(events, limit, role);
  }
  return rows;
}
