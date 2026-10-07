/** Collection half of `tumwater history`: read the event log and distill the last N completed
 * ticks into TickRow — one row per tick, newest first, with the paired duration and the raw
 * usage numbers. The Markdown/table rendering of this data lives in history.ts, a pure
 * function of it; the split mirrors the usage report's (src/report/report-data.ts / src/report/report-render.ts) and
 * keeps "what happened" (tick pairing, role filtering, scan windows) apart from "how it
 * prints" (column widths, terminal display padding), which change for different reasons —
 * and keeps core data collection out of the presentation layer, so a core consumer (as the
 * GUI's /api/history already is) never forces a core→ui import. */
import { eventRole, eventTick, eventUsage, readEvents, tickSpanMs, tickStartMap } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { readEventsSinceJoined } from "../events/event-window.js";
import { formatTimestamp } from "../text/datetime.js";
import { squash } from "../text/text.js";
import { usageText } from "../events/event-format.js";
import { groupBy } from "../collections.js";

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
 * above the dilution a whole role catalog can impose on HISTORY_MAX_TICKS rows. Exported as
 * the one ceiling every read-only view's single ask scans under: tick-detail-data.ts's
 * readTickDetail reads the same bound, so no ask can re-read more log than any other and the
 * cap cannot drift per consumer. */
export const HISTORY_SCAN_MAX_EVENTS = 20_000;

/** How far behind a since-shaped scan's cutoff the queued-row join reads its evidence: the
 * row set is ts-filtered to the cutoff, but a queued tick whose tick SPANS the cutoff logged
 * its `land_queued` pin before it (the pin is logged during the tick, the tick_end after it)
 * — so the join evidence needs its own read reaching further back. Six hours outlasts any
 * tick the harness runs (every stage inside a tick is timeout-bounded); a tick that somehow
 * queued later than that keeps the raw label, the conservative fallback. The wider read shares
 * one bounded backwards scan with the rows' own window (readEventsSinceJoined), and its
 * day-keyed scan never reaches past its own window's first day. */
const TICK_ROW_JOIN_BACKSLACK_MS = 6 * 60 * 60 * 1000;

/** Wider join evidence for a row set whose own window cut events the queued-row join needs
 * (the `--since` path; the tail-count path needs none — see readTickRows). `events` is the
 * cutoff-unfiltered read (a strict superset of the row set's events, oldest first);
 * `floorTs` is that read's requested lower bound (epoch ms): a queued row whose tick_start
 * sits before `floorTs` cannot trust the read around its pin (the day-keyed over-read can
 * hold older ticks' pins below the floor while the row's own pin is gone), so it keeps the
 * raw label rather than risk claiming another tick's pin — only the row's own tick block
 * being whole above the floor makes the newest-pin-at-or-before-the-end rule pick the right
 * one (resolveQueuedResult spells out why a missing start needs no guard). */
interface TickRowJoin {
  events: HarnessEvent[];
  floorTs: number;
}

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

/** The landing bookkeeping resolveQueuedResult joins over: per loop, the `land_queued` pins
 * and the `landed`/`land_failed` outcomes, each list oldest-first (the scan order). Exported
 * as one helper with exactly two call sites — readTickRows' history-row join and the failure
 * digest's time-and-spend fold (time-spend.ts) — so the two collectors cannot disagree about
 * which events feed the join or in what order they sit: a third landing-bookkeeping event
 * type, or a changed order rule, is edited once here. Callers bucket only the events they
 * need; the digest folds its `review_rejected` reasons with its own pass.
 * Roles or cutoffs are the caller's concern: pass a role-scoped or wider-read event list and
 * the maps carry exactly that list's evidence. */
export function bucketLandingEvents(events: HarnessEvent[]): {
  landQueuedByLoop: Map<string, HarnessEvent[]>;
  outcomeByLoop: Map<string, HarnessEvent[]>;
} {
  const landQueuedByLoop = groupBy(
    events.filter((e) => e.type === "land_queued"),
    (e) => e.loop,
  );
  const outcomeByLoop = groupBy(
    events.filter((e) => e.type === "landed" || e.type === "land_failed"),
    (e) => e.loop,
  );
  return { landQueuedByLoop, outcomeByLoop };
}

/** Resolve one queued tick row's eventual landing verdict: a "queued" tick_end carries no
 * result until its landing batch lands or fails, so the row joins its `end` tick_end to the
 * tick's land_queued pin and that pin's landed/land_failed outcome (both from the
 * bucketLandingEvents maps, oldest-first per loop). The claim cursor `claimTop` (mutated in
 * place) walks the pin list newest-first and hands each queued tick the newest unclaimed pin
 * at or before its end, so several queued ticks cannot claim one pin. `joinStarts` maps
 * loop#tick to its tick_start's ts; when `floorTs` (a since-window's cutoff, null in the
 * count view) sits after that start, the row's join evidence is not whole in the windowed
 * read and the row keeps its raw "queued" label (null). A MISSING start needs no guard — it
 * joins, because rotation drops a prefix, so every pin older than the lost start is lost with
 * it and nothing can be mis-claimed (and a skipped tick has no start at all but is never
 * queued). A landing with no outcome event in the join set also keeps the raw label: the
 * conservative fallback for a verdict simply not visible here. Returns the outcome's result
 * text and the landed sha, or null to keep the raw label. Pure apart from the cursor it
 * owns. */
export function resolveQueuedResult(
  end: HarnessEvent,
  landQueuedByLoop: Map<string, HarnessEvent[]>,
  outcomeByLoop: Map<string, HarnessEvent[]>,
  claimTop: Map<string, number>,
  joinStarts: Map<string, number>,
  floorTs: number | null,
): { result: string; sha: string } | null {
  if (floorTs !== null) {
    const startTs = joinStarts.get(`${end.loop}#${end.tick}`);
    if (startTs !== undefined && startTs < floorTs) return null;
  }
  const queuedList = landQueuedByLoop.get(end.loop);
  if (!queuedList || queuedList.length === 0) return null;
  let top = claimTop.get(end.loop) ?? queuedList.length - 1;
  while (top >= 0 && queuedList[top]!.ts > end.ts) top--;
  if (top < 0) return null;
  claimTop.set(end.loop, top - 1);
  const claimed = queuedList[top]!;
  const sha = String(claimed.commit ?? "");
  const outcome = (outcomeByLoop.get(end.loop) ?? []).find(
    (o) => o.ts >= claimed.ts && String(o.commit ?? "") === sha,
  );
  if (!outcome) return null;
  const result = String(outcome.result ?? (outcome.type === "landed" ? "changed" : ""));
  return result ? { result, sha } : null;
}

/** The tick rows for the last `limit` completed ticks in `events` (oldest-first, as
 * readEvents returns them), filtered to `role` when given, newest first. Pure: the CLI, the
 * GUI, and the tests share this collector, and none of them writes anything. */
export function tickRows(
  events: HarnessEvent[],
  limit: number,
  role: string | null,
  join?: TickRowJoin,
): TickRow[] {
  const scoped = role === null ? events : events.filter((e) => e.loop === role);
  // The start pairing is the shared helper (events.ts), so history's dash-on-unpaired rule
  // and the digest's fold cannot drift into different notions of a tick's span.
  const starts = tickStartMap(scoped);
  // The landing bookkeeping resolveQueuedResult joins over: per loop, the land_queued pins
  // (oldest first) and the landed/land_failed outcomes (oldest first). Both ride the role
  // filter with their tick, so the scoped events hold them exactly when they hold the row.
  // A since-shaped scan hands a WIDER join read instead (readTickRowsSince): its cutoff cut
  // the pins of ticks that span it, so the maps read the unfiltered-by-cutoff evidence and
  // resolveQueuedResult guards each claim on the row's tick_start being whole in that read.
  const joinScoped = join
    ? role === null
      ? join.events
      : join.events.filter((e) => e.loop === role)
    : scoped;
  const joinStarts = join ? tickStartMap(joinScoped) : starts;
  const floorTs = join ? join.floorTs : null;
  const { landQueuedByLoop, outcomeByLoop } = bucketLandingEvents(joinScoped);
  const claimTop = new Map<string, number>();
  const rows: TickRow[] = [];
  for (let i = scoped.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = scoped[i];
    if (!e || e.type !== "tick_end") continue;
    const rawResult = String(e.result);
    const result =
      rawResult === "queued"
        ? (resolveQueuedResult(e, landQueuedByLoop, outcomeByLoop, claimTop, joinStarts, floorTs)
            ?.result ?? rawResult)
        : rawResult;
    const usage = eventUsage(e);
    rows.push({
      ts: e.ts,
      time: formatTimestamp(e.ts),
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      loop: eventRole(e),
      tick: eventTick(e),
      result,
      durationMs: tickSpanMs(e, starts),
      usage: usageText(e),
      detail: squash(String(e.summary ?? e.error ?? ""), DETAIL_MAX),
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
 *   to rotation — growing re-pairs the former, and the latter only costs the bounded scan.
 *   (A queued row's landing verdict needs no growth: the landed/land_failed event sits
 *   after its tick_end, so any tail window holding the row holds the verdict too — or there
 *   is none yet, the genuinely-pending case that keeps the raw label.) */
export function readTickRows(root: string, limit: number, role: string | null): TickRow[] {
  const key = `${root}\u0000${role ?? ""}\u0000${limit}`;
  // A repeated ask's steady state starts where the last one ended, not back at the base
  // window: the GUI drawer's history panel re-issues this ask every second while events flow,
  // and each poll's ladder re-parsed every intermediate window (base → ×4 → …) before the one
  // that satisfied it — window sizes the previous poll had already proven too small. Rows are
  // a pure function of the window's events, and a larger tail window is a superset of a
  // smaller one's, so starting higher changes nothing the ask can see: a window that satisfied
  // last poll still satisfies now (events only accumulate), and if it no longer does — a
  // rotation shrank the live log, or the ask itself changed — the loop below keeps growing
  // exactly as before. In-memory only; a stale note costs one larger first read, never a
  // wrong row.
  let window = tickRowWindowMemo.get(key) ?? limit * 2 + 50;
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
  if (tickRowWindowMemo.size >= TICK_ROW_WINDOW_MEMO_MAX) tickRowWindowMemo.clear();
  tickRowWindowMemo.set(key, window);
  return rows;
}

/** Per (root, role, limit): the window readTickRows' last ask ended on — the first window that
 * satisfied it, or the cap when the ladder ran out (the next poll then skips the ladder's
 * proven-too-small windows, the same steady-state note mainCheckForPoll's grewFull carries).
 * Bounded so many short-lived roots in tests cannot grow it unbounded. */
const tickRowWindowMemo = new Map<string, number>();
const TICK_ROW_WINDOW_MEMO_MAX = 256;

/** The window-shaped sibling of readTickRows: the completed ticks of the last `sinceMs`, not
 * the last N — the collector behind `history --since`. The window read itself (cutoff, the
 * rotation-spanning day-keyed read with its at-most-one-day over-read, the ts filter, and the
 * exact coverage predicate cmdLogs consults) is event-window.ts's readEventsSinceJoined — one
 * backwards scan serves both this view and the wider join read, with the narrow view's events
 * and coverage derived from the wide scan, so neither windowed surface can claim coverage the
 * other would hedge or key its read differently. The rows read the cutoff-filtered events, but
 * their queued-row join reads WIDER evidence (TICK_ROW_JOIN_BACKSLACK_MS): a queued tick whose
 * tick spans the cutoff logged its land_queued pin before the cutoff, and without the wider
 * read the row would either keep "Queued to land" after its change landed or misclaim an older
 * tick's pin (BUGS.md 2026-09-30). The rows reuse the pure tickRows with limit =
 * events.length, so pairing, role filtering, and the dash-on-unpaired rule stay exactly the
 * count view's. Pure over root: reads the event log, writes nothing. */
export function readTickRowsSince(root: string, sinceMs: number, role: string | null): { rows: TickRow[]; covered: boolean } {
  // One backwards scan serves both the rows' window and the wider join read (see
  // readEventsSinceJoined): two readEventsSince calls re-scanned and re-parsed the same
  // log bytes — a whole duplicate window scan per `history --since`.
  const { events, join, covered } = readEventsSinceJoined(root, sinceMs, TICK_ROW_JOIN_BACKSLACK_MS);
  return {
    rows: tickRows(events, events.length, role, { events: join.events, floorTs: join.cutoff }),
    covered,
  };
}
