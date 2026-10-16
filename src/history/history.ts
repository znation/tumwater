import { fail, say, sayJson } from "../cli/cli-output.js";
import { durationLabel, failRivalShapes, flagValue, parseCountFlag, parseGrepFlag, parseRoleScope, parseSinceFlag } from "../cli/cli-args.js";
import { HISTORY_DEFAULT_TICKS, HISTORY_MAX_TICKS, HISTORY_RESULT_CLASSES, historyClass, readTickRows, readTickRowsSince, summarizeTickRows, tickRowsMatchingGrep, type HistoryResultClass, type TickRow } from "./history-data.js";
import { renderRow, renderSummary, widestWidths } from "./history-render.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { gotSuffix } from "../text/text.js";

/** `tumwater history [--role <id>] [-n N]`: one row per completed tick, newest first. The
 * observing half beside cmdLogs (log-commands.ts): read-only over the event log, stdout only —
 * every datum rides the `tick_end` events src/tick/tick-finalize.ts already writes, so this
 * is a rendering of the existing record, not a new one. The rows themselves are collected
 * by history-data.ts (beside src/report/report-data.ts and src/failure/failure-data.ts), and
 * the aligned table/summary text they print is rendered by history-render.ts (beside
 * src/report/report-render.ts); this module parses the args, drives the CLI, and prints. */

/** The missing-pattern error cmdHistory prints for a valueless or empty `--grep`, exported so
 * cli.ts's rejectUnknownArgs spec for --grep can fail a trailing `history --grep` with the same
 * wording. Kept local to this module — log-commands.ts holds its own GREP_VALUE_ERROR — so the
 * two observing views' wordings each name the command that printed them. */
export const HISTORY_GREP_VALUE_ERROR = "history --grep needs a pattern";

/** The missing-value error cmdHistory prints for a valueless or empty `--result`, exported so
 * cli.ts's rejectUnknownArgs spec for --result can fail a trailing `history --result` with the
 * same wording. Its sibling of HISTORY_GREP_VALUE_ERROR: each names the command that printed
 * it. */
export const HISTORY_RESULT_VALUE_ERROR = "history --result needs a value";

/** `tumwater history [--role <id>] [-n N] [--since <duration>] [--grep <text>] [--result
 * <class>]`: print the last N completed ticks, newest first — or, with `--since`, the ticks of a
 * bounded past window over the same record, the same shape `logs --since` and `report --since`
 * speak. `--grep` keeps rows whose rendered line matches, and `--result` narrows to one outcome
 * class (changes/none/problems, the dashboard History filter's buckets); both compose with
 * --role, -n, and --since. Read-only: stdout only, no state file created — a missing or empty
 * event log prints `no ticks yet` and exits 0. */
export async function cmdHistory(root: string, args: string[]): Promise<void> {
  // `--grep <text>` filters the row set case-insensitively against the WYSIWYG row line (plus a
  // `tick_end` prefix, the same haystack rule logs --grep applies to its rendered lines), so
  // both observing views answer substring questions the same way. The flag scan itself — the
  // value lookup, the `rest` construction that keeps a flag-shaped pattern (`history --grep
  // --since` greps for the text "--since") from impersonating a rival flag, and the
  // empty-value fail — is cli/cli-args.ts's parseGrepFlag, the one home shared with logs. With no
  // --grep, rest is args.
  const { rest, pattern: grepPattern } = parseGrepFlag(args, HISTORY_GREP_VALUE_ERROR);
  const nRaw = flagValue(rest, "-n");
  // `--since <duration>` is the window-shaped view over the same tick record the -n view
  // dumps: a rival shape to -n, so they fail together naming both (the same rule and wording
  // shape logs uses). It reuses the logs --since cap (same log, same cap — no third cap
  // value) through parseSinceFlag, so the error wordings cannot drift. `--role` composes with
  // --since here: history's --role is a row filter, not the rival transcript view logs guards
  // against.
  let rows: TickRow[];
  let covered = true;
  const sinceMs = parseSinceFlag(rest, "history --since", LOGS_SINCE_MAX_MS);
  if (sinceMs !== null) {
    if (nRaw !== null) failRivalShapes("history --since", "-n", "a count and a window are rival shapes");
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
  if (grepPattern !== null) rows = tickRowsMatchingGrep(rows, grepPattern);
  // The set --grep admitted, saved so the empty-state wording blames the filter that actually
  // emptied it: if the result filter below removes rows grep matched, naming the pattern would
  // be false (`no ticks matching "widget"` when feature #7 does match). The GUI draws the same
  // line between a search and its outcome filter.
  const afterGrep = rows.length;
  // `--result <class>` narrows to one outcome bucket, reading the same canonical historyClass
  // rule the dashboard's History filter applies (shared from history-data.ts, not copied). It
  // composes with --role, -n, --since, and --grep, so no rival-shape rule: a missing or empty
  // value fails with its own wording, and an unknown class names the accepted ones (the gotSuffix
  // shape the other flag validators use). Applied after --grep, over the same rows both the table
  // and --json serialize.
  const resultRaw = flagValue(rest, "--result");
  let resultClass: HistoryResultClass | null = null;
  if (resultRaw !== null) {
    if (resultRaw === undefined || resultRaw === "") fail(HISTORY_RESULT_VALUE_ERROR);
    if (!(HISTORY_RESULT_CLASSES as readonly string[]).includes(resultRaw))
      fail(`history --result must be one of ${HISTORY_RESULT_CLASSES.join(", ")}${gotSuffix(resultRaw)}`);
    resultClass = resultRaw as HistoryResultClass;
    rows = rows.filter((r) => historyClass(r.result) === resultClass);
  }
  // --json swaps the renderer for the collector's own payload, exactly as status --json and
  // report --json: the same rows the table prints, each with ts/tokens/costUsd kept raw. A
  // JSON document even when the log is empty ({"rows":[]} — never the prose `no ticks yet`,
  // the report --json precedent: the flag's output must be parseable in every exit-0 case).
  const summary = rest.includes("--summary") && rows.length > 0;
  if (rest.includes("--json")) {
    sayJson(summary ? summarizeTickRows(rows) : { rows });
    return;
  }
  if (rows.length === 0) {
    // A grep that matched nothing must not borrow the empty-log prose: `no ticks yet` and
    // `no ticks in 2h` are statements about the LOG and the WINDOW, and both are false when
    // rows were scanned and filtered out — the operator would read a quiet fleet where the
    // truth is `the ticks are there, none match`. The logs --grep rule (its `no events
    // matching "<pattern>"`, src/cli/log-commands.ts) names the pattern instead; --json stays
    // a bare {"rows":[]} document above, never prose in either form.
    //
    // The result class is named only when it emptied a non-empty set (`afterGrep > 0`): an
    // empty log or window scanned no rows, so the result filter removed nothing and the
    // empty-log/window prose is the true one — the dashboard's History view draws the same
    // line. A grep that admitted nothing keeps its own wording regardless of --result.
    say(
      resultClass !== null && afterGrep > 0
        ? `no ticks with result "${resultClass}"`
        : grepPattern !== null
          ? `no ticks matching "${grepPattern}"`
          : sinceMs === null
            ? "no ticks yet"
            : `no ticks in ${durationLabel(sinceMs)}`,
    );
    return;
  }
  if (summary) say(renderSummary(summarizeTickRows(rows)));
  else {
    const widths = widestWidths(rows);
    say(rows.map((r) => renderRow(r, widths)).join("\n"));
  }
  // A sparse window is never mistaken for a quiet fleet — but the note only ever rides rows
  // (an empty window returned above), it never touches --json output, and it is the shared
  // SPARSE_WINDOW_NOTE wording: the oldest retained event being inside the window is exactly
  // the unproven case, whether the cause is rotation or idleness.
  if (!covered) say(SPARSE_WINDOW_NOTE);
}
