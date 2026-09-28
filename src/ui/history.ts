import { fail, flagValue, parseCountFlag, parseRoleScope, say } from "../cli-args.js";
import { readEvents } from "../events.js";
import { formatTimestamp } from "../datetime.js";
import { collapseWhitespace, displayWidth, padToWidth, shortSpanPhrase, truncate } from "../text.js";
import { usageText } from "./event-format.js";
import type { HarnessEvent } from "../types.js";

/** `tumwater history [--role <id>] [-n N]`: one row per completed tick, newest first. The
 * observing half beside cmdLogs (log-commands.ts): read-only over the event log, stdout only —
 * every datum rides the `tick_end` events src/loop.ts already writes, so this is a rendering
 * of the existing record, not a new one. Lives in ui/ with the other rendering layers. */

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
 * numbers `usage` folds into one string (0 when the event carries none, the same
 * omit-when-zero convention): the three fields `tumwater history --json` and the GUI's
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
 * readEvents returns them), filtered to `role` when given, newest first. Pure: the CLI and
 * the tests share this collector, and neither writes anything. */
export function tickRows(events: HarnessEvent[], limit: number, role: string | null): TickRow[] {
  const scoped = role === null ? events : events.filter((e) => e.loop === role);
  const starts = new Map<string, number>();
  for (const e of scoped) {
    if (e.type === "tick_start") starts.set(`${e.loop}#${e.tick}`, e.ts);
  }
  const rows: TickRow[] = [];
  for (let i = scoped.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = scoped[i];
    if (!e || e.type !== "tick_end") continue;
    const startTs = starts.get(`${e.loop}#${e.tick}`);
    rows.push({
      ts: e.ts,
      time: formatTimestamp(e.ts),
      tokens: Number(e.tokens ?? 0),
      costUsd: Number(e.costUsd ?? 0),
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

/** One aligned table line: fixed-width columns over the row set (the widths derive from the
 * rows actually shown, so a single-row table has no padding gap), then the free-text detail.
 * Every cell is padded to its column's width even when empty — usage is the one cell that can
 * be empty (a tick with neither tokens nor cost), and dropping it would pull the detail left,
 * misaligning that row against its neighbors; trimEnd strips only the trailing pad. */
function renderRow(row: TickRow, widths: { loop: number; tick: number; result: number; duration: number; usage: number }): string {
  const duration = row.durationMs === null ? "—" : shortSpanPhrase(row.durationMs);
  // Cells pad to terminal display columns (padToWidth), not UTF-16 code units: a loop name
  // holding CJK or emoji renders two columns per code point, and a code-unit padEnd lets
  // that row's later columns drift right of its ASCII neighbors.
  return [
    row.time,
    padToWidth(row.loop, widths.loop),
    `#${padToWidth(String(row.tick), widths.tick)}`,
    padToWidth(row.result, widths.result),
    padToWidth(duration, widths.duration),
    padToWidth(row.usage, widths.usage),
    row.detail,
  ]
    .join("  ")
    .trimEnd();
}

/** `tumwater history [--role <id>] [-n N]`: print the last N completed ticks, newest first.
 * Read-only: stdout only, no state file created — a missing or empty event log prints
 * `no ticks yet` and exits 0. */
export async function cmdHistory(root: string, args: string[]): Promise<void> {
  const nRaw = flagValue(args, "-n");
  const limit = nRaw !== null ? parseCountFlag("-n", nRaw) : HISTORY_DEFAULT_TICKS;
  if (limit > HISTORY_MAX_TICKS)
    fail(`-n must be between 1 and ${HISTORY_MAX_TICKS} (got ${JSON.stringify(nRaw)})`);
  // The config is read (through loadConfigCached, never throwing) only when --role is present:
  // a read-only view must not refuse a transiently broken tumwater.json.
  const role = parseRoleScope(root, args);
  const rows = readTickRows(root, limit, role);
  // --json swaps the renderer for the collector's own payload, exactly as status --json and
  // report --json: the same rows the table prints, each with ts/tokens/costUsd kept raw. A
  // JSON document even when the log is empty ({"rows":[]} — never the prose `no ticks yet`,
  // the report --json precedent: the flag's output must be parseable in every exit-0 case).
  if (args.includes("--json")) {
    say(JSON.stringify({ rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    say("no ticks yet");
    return;
  }
  // Widths in terminal display columns (displayWidth), for the same reason the cells pad
  // with padToWidth below.
  const widths = {
    loop: Math.max(...rows.map((r) => displayWidth(r.loop))),
    tick: Math.max(...rows.map((r) => String(r.tick).length)),
    result: Math.max(...rows.map((r) => displayWidth(r.result))),
    duration: Math.max(...rows.map((r) => (r.durationMs === null ? 1 : shortSpanPhrase(r.durationMs).length))),
    usage: Math.max(...rows.map((r) => displayWidth(r.usage))),
  };
  say(rows.map((r) => renderRow(r, widths)).join("\n"));
}
