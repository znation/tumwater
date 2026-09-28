import { knownRoleIds, loadConfigCached } from "../config.js";
import { allRoleIds } from "../roles.js";
import { fail, parseCountFlag, parseRoleFlag } from "../cli-args.js";
import { readEvents } from "../events.js";
import { formatDate, formatTime } from "../datetime.js";
import { collapseWhitespace, compactTokens, shortSpanPhrase, truncate, usd } from "../text.js";
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

/** One completed tick, rendered. `durationMs` is null when the tick's `tick_start` is not in
 * the scanned window (log rotation, or a skipped tick that never started) — the row shows a
 * dash rather than a fabricated duration. `usage` is "" when the event carries neither tokens
 * nor cost, matching the payload's omit-when-zero convention. */
export interface TickRow {
  time: string;
  loop: string;
  tick: number;
  result: string;
  durationMs: number | null;
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
    const tokens = Number(e.tokens ?? 0);
    const costUsd = Number(e.costUsd ?? 0);
    rows.push({
      time: `${formatDate(new Date(e.ts))} ${formatTime(new Date(e.ts))}`,
      loop: String(e.loop),
      tick: Number(e.tick),
      result: String(e.result),
      durationMs: startTs === undefined ? null : Math.max(0, e.ts - startTs),
      usage:
        (tokens > 0 ? `${compactTokens(tokens)} tok` : "") +
        (costUsd > 0 ? `${tokens > 0 ? " · " : ""}${usd(costUsd)}` : ""),
      detail: truncate(collapseWhitespace(String(e.summary ?? e.error ?? "")), DETAIL_MAX),
    });
  }
  return rows;
}

/** One aligned table line: fixed-width columns over the row set (the widths derive from the
 * rows actually shown, so a single-row table has no padding gap), then the free-text detail. */
function renderRow(row: TickRow, widths: { loop: number; tick: number; result: number; duration: number; usage: number }): string {
  const duration = row.durationMs === null ? "—" : shortSpanPhrase(row.durationMs);
  return [
    row.time,
    row.loop.padEnd(widths.loop),
    `#${String(row.tick).padEnd(widths.tick)}`,
    row.result.padEnd(widths.result),
    duration.padEnd(widths.duration),
    row.usage.padEnd(widths.usage),
    row.detail,
  ]
    .filter((cell) => cell !== "")
    .join("  ")
    .trimEnd();
}

/** `tumwater history [--role <id>] [-n N]`: print the last N completed ticks, newest first.
 * Read-only: stdout only, no state file created — a missing or empty event log prints
 * `no ticks yet` and exits 0. */
export async function cmdHistory(root: string, args: string[]): Promise<void> {
  const nFlag = args.indexOf("-n");
  const limit = nFlag >= 0 ? parseCountFlag("-n", args[nFlag + 1]) : HISTORY_DEFAULT_TICKS;
  if (limit > HISTORY_MAX_TICKS)
    fail(`-n must be between 1 and ${HISTORY_MAX_TICKS} (got ${JSON.stringify(args[nFlag + 1])})`);
  // The config is needed only to validate --role against built-ins PLUS user-defined loops,
  // read through loadConfigCached (which never throws) exactly as cmdLogs does: a transiently
  // broken tumwater.json must not take down a read-only view. Without --role no config is read.
  let role: string | null = null;
  if (args.includes("--role")) {
    const { config } = loadConfigCached(root);
    role = parseRoleFlag(args, config ? knownRoleIds(config) : allRoleIds());
  }
  // A window twice the ask plus slack: tick_start lines and unrelated events interleave with
  // the tick_end rows scanned for, and a skipped tick's end rides a start that may sit outside
  // any smaller window.
  const rows = tickRows(readEvents(root, limit * 2 + 50), limit, role);
  if (rows.length === 0) {
    process.stdout.write("no ticks yet\n");
    return;
  }
  const widths = {
    loop: Math.max(...rows.map((r) => r.loop.length)),
    tick: Math.max(...rows.map((r) => String(r.tick).length)),
    result: Math.max(...rows.map((r) => r.result.length)),
    duration: Math.max(...rows.map((r) => (r.durationMs === null ? 1 : shortSpanPhrase(r.durationMs).length))),
    usage: Math.max(...rows.map((r) => r.usage.length)),
  };
  process.stdout.write(rows.map((r) => renderRow(r, widths)).join("\n") + "\n");
}
