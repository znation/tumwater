import { fail, say, sayJson } from "../cli-output.js";
import { durationLabel, failOverDurationCap, flagValue, parseCountFlag, parseDurationFlag, parseGrepFlag, parseRoleScope } from "../cli-args.js";
import { displayWidth, padToWidth } from "../text-width.js";
import { shortSpanPhrase } from "../phrases.js";
import { HISTORY_DEFAULT_TICKS, HISTORY_MAX_TICKS, readTickRows, readTickRowsSince, type TickRow } from "../history-data.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../event-window.js";

/** `tumwater history [--role <id>] [-n N]`: one row per completed tick, newest first. The
 * observing half beside cmdLogs (log-commands.ts): read-only over the event log, stdout only —
 * every datum rides the `tick_end` events src/loop.ts already writes, so this is a rendering
 * of the existing record, not a new one. The rows themselves are collected by history-data.ts
 * (beside report-data.ts and failure-data.ts); this module renders them and drives the CLI. */

/** The row's five padded columns as their unpadded strings — the one home for the cell values,
 * shared by the renderer (which pads), the width pass (which measures), and the grep haystack
 * (which needs the row as it renders when it is the widest row in each column). A tick with no
 * reported duration shows the em dash. */
function cellsOf(row: TickRow): { loop: string; tick: string; result: string; duration: string; usage: string } {
  return {
    loop: row.loop,
    tick: String(row.tick),
    result: row.result,
    duration: row.durationMs === null ? "—" : shortSpanPhrase(row.durationMs),
    usage: row.usage,
  };
}

/** Each column's width from its unpadded cell. Text cells measure terminal display columns
 * (displayWidth), not UTF-16 code units: a loop name holding CJK or emoji renders two columns
 * per code point, and a code-unit padEnd lets that row's later columns drift right of its
 * ASCII neighbors. The tick cell measures before its "#" prefix is added (the prefix rides
 * outside the pad), and duration is ASCII, so both take plain length. */
function widthsOf(cells: { loop: string; tick: string; result: string; duration: string; usage: string }): { loop: number; tick: number; result: number; duration: number; usage: number } {
  return {
    loop: displayWidth(cells.loop),
    tick: cells.tick.length,
    result: displayWidth(cells.result),
    duration: cells.duration.length,
    usage: displayWidth(cells.usage),
  };
}

/** The per-column maxima over every row the table shows — the widths derive from the rows
 * actually shown, so a single-row table has no padding gap. */
function widestWidths(rows: TickRow[]): { loop: number; tick: number; result: number; duration: number; usage: number } {
  const widths = { loop: 0, tick: 0, result: 0, duration: 0, usage: 0 };
  for (const row of rows) {
    const w = widthsOf(cellsOf(row));
    widths.loop = Math.max(widths.loop, w.loop);
    widths.tick = Math.max(widths.tick, w.tick);
    widths.result = Math.max(widths.result, w.result);
    widths.duration = Math.max(widths.duration, w.duration);
    widths.usage = Math.max(widths.usage, w.usage);
  }
  return widths;
}

/** One aligned table line: fixed-width columns over the row set, then the free-text detail.
 * Every cell is padded to its column's width even when empty — usage is the one cell that can
 * be empty (a tick with neither tokens nor cost), and dropping it would pull the detail left,
 * misaligning that row against its neighbors; trimEnd strips only the trailing pad. */
function renderRow(row: TickRow, widths: { loop: number; tick: number; result: number; duration: number; usage: number }): string {
  const c = cellsOf(row);
  return [
    row.time,
    padToWidth(c.loop, widths.loop),
    `#${padToWidth(c.tick, widths.tick)}`,
    padToWidth(c.result, widths.result),
    padToWidth(c.duration, widths.duration),
    padToWidth(c.usage, widths.usage),
    row.detail,
  ]
    .join("  ")
    .trimEnd();
}

/** The --grep haystack: the WYSIWYG row line — renderRow over the row's own widths, where
 * padToWidth is the identity, so this is the canonical unpadded line the row renders as
 * whenever it is the widest row in each column — prefixed with the raw event type so stable
 * ids (`tick_end`) are greppable the way logs --grep's haystack carries e.type. Built per row
 * because the filter runs before the widths of the rows actually shown are known. */
function grepHaystack(row: TickRow): string {
  return `tick_end ${renderRow(row, widthsOf(cellsOf(row)))}`;
}

/** The missing-pattern error cmdHistory prints for a valueless or empty `--grep`, exported so
 * cli.ts's rejectUnknownArgs spec for --grep can fail a trailing `history --grep` with the same
 * wording. Kept local to this module — log-commands.ts holds its own GREP_VALUE_ERROR — so the
 * two observing views' wordings each name the command that printed them. */
export const HISTORY_GREP_VALUE_ERROR = "history --grep needs a pattern";

/** `tumwater history [--role <id>] [-n N] [--since <duration>] [--grep <text>]`: print the last
 * N completed ticks, newest first — or, with `--since`, the ticks of a bounded past window over
 * the same record, the same shape `logs --since` and `report --since` speak. Read-only: stdout
 * only, no state file created — a missing or empty event log prints `no ticks yet` and exits 0. */
export async function cmdHistory(root: string, args: string[]): Promise<void> {
  // `--grep <text>` filters the row set case-insensitively against the WYSIWYG row line (plus a
  // `tick_end` prefix, the same haystack rule logs --grep applies to its rendered lines), so
  // both observing views answer substring questions the same way. The flag scan itself — the
  // value lookup, the `rest` construction that keeps a flag-shaped pattern (`history --grep
  // --since` greps for the text "--since") from impersonating a rival flag, and the
  // empty-value fail — is cli-args.ts's parseGrepFlag, the one home shared with logs. With no
  // --grep, rest is args.
  const { rest, pattern: grepPattern } = parseGrepFlag(args, HISTORY_GREP_VALUE_ERROR);
  const nRaw = flagValue(rest, "-n");
  // `--since <duration>` is the window-shaped view over the same tick record the -n view
  // dumps: a rival shape to -n, so they fail together naming both (the same rule and wording
  // shape logs uses). It reuses the logs --since cap (same log, same cap — no third cap
  // value) through the shared parser and over-cap helpers, so the error wordings cannot
  // drift. `--role` composes with --since here: history's --role is a row filter, not the
  // rival transcript view logs guards against.
  const sinceRaw = flagValue(rest, "--since");
  let rows: TickRow[];
  let covered = true;
  let sinceMs: number | null = null;
  if (sinceRaw !== null) {
    if (nRaw !== null) fail("history --since cannot be combined with -n (a count and a window are rival shapes)");
    sinceMs = parseDurationFlag("--since", sinceRaw);
    failOverDurationCap("history --since", sinceMs, LOGS_SINCE_MAX_MS);
    const role = parseRoleScope(root, rest);
    const windowed = readTickRowsSince(root, sinceMs, role);
    rows = windowed.rows;
    covered = windowed.covered;
  } else {
    // parseCountFlag's max caps the scan window: a typo'd "999999" must not build a
    // HISTORY_MAX_TICKS-sized slice scan from a huge limit.
    const limit = nRaw !== null ? parseCountFlag("-n", nRaw, HISTORY_MAX_TICKS) : HISTORY_DEFAULT_TICKS;
    // The config is read (through loadConfigCached, never throwing) only when --role is present:
    // a read-only view must not refuse a transiently broken tumwater.json.
    const role = parseRoleScope(root, rest);
    rows = readTickRows(root, limit, role);
  }
  // The filter runs on the collected rows, before rendering and before --json serialization:
  // the same rows the table would print, filtered the same way in both forms (the logs --grep
  // rule: -n bounds the scanned window, not the printed rows).
  if (grepPattern !== null) {
    const needle = grepPattern.toLowerCase();
    rows = rows.filter((r) => grepHaystack(r).toLowerCase().includes(needle));
  }
  // --json swaps the renderer for the collector's own payload, exactly as status --json and
  // report --json: the same rows the table prints, each with ts/tokens/costUsd kept raw. A
  // JSON document even when the log is empty ({"rows":[]} — never the prose `no ticks yet`,
  // the report --json precedent: the flag's output must be parseable in every exit-0 case).
  if (rest.includes("--json")) {
    sayJson({ rows });
    return;
  }
  if (rows.length === 0) {
    // A grep that matched nothing must not borrow the empty-log prose: `no ticks yet` and
    // `no ticks in 2h` are statements about the LOG and the WINDOW, and both are false when
    // rows were scanned and filtered out — the operator would read a quiet fleet where the
    // truth is `the ticks are there, none match`. The logs --grep rule (its `no events
    // matching "<pattern>"`, src/ui/log-commands.ts) names the pattern instead; --json stays
    // a bare {"rows":[]} document above, never prose in either form.
    say(
      grepPattern !== null
        ? `no ticks matching "${grepPattern}"`
        : sinceMs === null
          ? "no ticks yet"
          : `no ticks in ${durationLabel(sinceMs)}`,
    );
    return;
  }
  const widths = widestWidths(rows);
  say(rows.map((r) => renderRow(r, widths)).join("\n"));
  // A sparse window is never mistaken for a quiet fleet — but the note only ever rides rows
  // (an empty window returned above), it never touches --json output, and it is the shared
  // SPARSE_WINDOW_NOTE wording: the oldest retained event being inside the window is exactly
  // the unproven case, whether the cause is rotation or idleness.
  if (!covered) say(SPARSE_WINDOW_NOTE);
}
