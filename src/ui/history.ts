import { durationLabel, fail, failOverDurationCap, flagValue, parseCountFlag, parseDurationFlag, parseRoleScope, say } from "../cli-args.js";
import { displayWidth, padToWidth, shortSpanPhrase } from "../text.js";
import { HISTORY_DEFAULT_TICKS, HISTORY_MAX_TICKS, readTickRows, readTickRowsSince, type TickRow } from "../history-data.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../event-window.js";

/** `tumwater history [--role <id>] [-n N]`: one row per completed tick, newest first. The
 * observing half beside cmdLogs (log-commands.ts): read-only over the event log, stdout only —
 * every datum rides the `tick_end` events src/loop.ts already writes, so this is a rendering
 * of the existing record, not a new one. The rows themselves are collected by history-data.ts
 * (beside report-data.ts and failure-data.ts); this module renders them and drives the CLI. */

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

/** `tumwater history [--role <id>] [-n N] [--since <duration>]`: print the last N completed
 * ticks, newest first — or, with `--since`, the ticks of a bounded past window over the same
 * record, the same shape `logs --since` and `report --since` speak. Read-only: stdout only,
 * no state file created — a missing or empty event log prints `no ticks yet` and exits 0. */
export async function cmdHistory(root: string, args: string[]): Promise<void> {
  const nRaw = flagValue(args, "-n");
  // `--since <duration>` is the window-shaped view over the same tick record the -n view
  // dumps: a rival shape to -n, so they fail together naming both (the same rule and wording
  // shape logs uses). It reuses the logs --since cap (same log, same cap — no third cap
  // value) through the shared parser and over-cap helpers, so the error wordings cannot
  // drift. `--role` composes with --since here: history's --role is a row filter, not the
  // rival transcript view logs guards against.
  const sinceRaw = flagValue(args, "--since");
  let rows: TickRow[];
  let covered = true;
  let sinceMs: number | null = null;
  if (sinceRaw !== null) {
    if (nRaw !== null) fail("history --since cannot be combined with -n (a count and a window are rival shapes)");
    sinceMs = parseDurationFlag("--since", sinceRaw);
    failOverDurationCap("history --since", sinceMs, LOGS_SINCE_MAX_MS);
    const role = parseRoleScope(root, args);
    const windowed = readTickRowsSince(root, sinceMs, role);
    rows = windowed.rows;
    covered = windowed.covered;
  } else {
    const limit = nRaw !== null ? parseCountFlag("-n", nRaw) : HISTORY_DEFAULT_TICKS;
    if (limit > HISTORY_MAX_TICKS)
      fail(`-n must be between 1 and ${HISTORY_MAX_TICKS} (got ${JSON.stringify(nRaw)})`);
    // The config is read (through loadConfigCached, never throwing) only when --role is present:
    // a read-only view must not refuse a transiently broken tumwater.json.
    const role = parseRoleScope(root, args);
    rows = readTickRows(root, limit, role);
  }
  // --json swaps the renderer for the collector's own payload, exactly as status --json and
  // report --json: the same rows the table prints, each with ts/tokens/costUsd kept raw. A
  // JSON document even when the log is empty ({"rows":[]} — never the prose `no ticks yet`,
  // the report --json precedent: the flag's output must be parseable in every exit-0 case).
  if (args.includes("--json")) {
    say(JSON.stringify({ rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    say(sinceMs === null ? "no ticks yet" : `no ticks in ${durationLabel(sinceMs)}`);
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
  // A sparse window is never mistaken for a quiet fleet — but the note only ever rides rows
  // (an empty window returned above), it never touches --json output, and it is the shared
  // SPARSE_WINDOW_NOTE wording: the oldest retained event being inside the window is exactly
  // the unproven case, whether the cause is rotation or idleness.
  if (!covered) say(SPARSE_WINDOW_NOTE);
}
