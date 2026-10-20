// vocabulary: plain
import { fail, say, sayJson, sayJsonLine } from "../cli/cli-output.js";
import { durationLabel, failRivalShapes, flagValue, parseCountFlag, parseGrepFlag, parseRoleListScope, parseSinceFlag } from "../cli/cli-args.js";
import { HISTORY_DEFAULT_RUNS, HISTORY_MAX_RUNS, HISTORY_RESULT_FLAG_NAMES, HISTORY_SUMMARY_GROUPS, historyClass, parseHistoryResultClass, readRunRows, readRunRowsSince, runRows, summarizeRunRows, summarizeRunRowsByModel, runRowsMatchingGrep, runRowsOnModels, type HistoryResultClass, type RunRow } from "./history-data.js";
import { renderModelSummary, renderRow, renderSummary, widenWidths, widestWidths } from "./history-render.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { followUntilParentGone, type FollowSeams } from "../cli/log-commands.js";
import { parseEventLine, readEventsTailWithEnd } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { eventsLogPath } from "../paths.js";
import { gotSuffix } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";

/** `tumwater history [--role <id>[,<id>...]] [-n N]`: one row per completed run, newest first. The
 * observing half beside cmdLogs (log-commands.ts): read-only over the event log, stdout only —
 * every datum rides the `run_end` events src/run/run-finalize.ts already writes, so this
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

/** The missing-value error cmdHistory prints for a valueless, empty or comma-only `--model`,
 * exported so cli.ts's rejectUnknownArgs spec for --model fails a trailing `history --model`
 * with the same wording. Its sibling of HISTORY_RESULT_VALUE_ERROR. */
export const HISTORY_MODEL_VALUE_ERROR = "history --model needs a model selector";

/** The missing-value error for a valueless or empty `--by`, exported for cli.ts's flag spec. */
export const HISTORY_BY_VALUE_ERROR = "history --by needs role or model";

/** How many trailing events `history -f` keeps: the seed read and the rolling buffer a finished
 * run's start is paired from. */
const HISTORY_FOLLOW_BUFFER_EVENTS = 2000;

/** `tumwater history [--role <id>[,<id>...]] [-n N] [-f] [--since <duration>] [--grep <text>]
 * [--result <class>] [--model <selector>[,...]]`: print the last N completed runs, newest
 * first — or,
 * with `--since`, the runs of a bounded past window over the same record, the same shape
 * `logs --since` and `report --since` speak. `--grep` keeps rows whose rendered line matches,
 * `--result` narrows to the listed outcome classes (changes/none/problems, the dashboard History
 * filter's buckets) and `--model` keeps runs that started on the listed models; all compose
 * with --role, -n, and --since. Read-only: stdout only, no state file created — a missing or empty
 * event log prints `no runs yet` and exits 0. */
export async function cmdHistory(root: string, args: string[], seams: FollowSeams = {}): Promise<void> {
  // `--grep <text>` filters the row set case-insensitively against the WYSIWYG row line (plus a
  // `run_end` prefix, the same haystack rule logs --grep applies to its rendered lines), so
  // both observing views answer substring questions the same way. The flag scan itself — the
  // value lookup, the `rest` construction that keeps a flag-shaped pattern (`history --grep
  // --since` greps for the text "--since") from impersonating a rival flag, and the
  // empty-value fail — is cli/cli-args.ts's parseGrepFlag, the one home shared with logs. With no
  // --grep, rest is args.
  const { rest, pattern: grepPattern } = parseGrepFlag(args, HISTORY_GREP_VALUE_ERROR);
  const nRaw = flagValue(rest, "-n");
  // `--since <duration>` is the window-shaped view over the same run record the -n view
  // dumps: a rival shape to -n, so they fail together naming both (the same rule and wording
  // shape logs uses). It reuses the logs --since cap (same log, same cap — no third cap
  // value) through parseSinceFlag, so the error wordings cannot drift. `--role` composes with
  // --since here: history's --role is a row filter, not the rival transcript view logs guards
  // against.
  let rows: RunRow[];
  let covered = true;
  const follow = rest.includes("-f") || rest.includes("--follow");
  if (follow) {
    if (rest.includes("--since"))
      failRivalShapes("history --since", "-f/--follow", 'follow means "from now on"; --since shows a bounded past window');
    if (rest.includes("--summary"))
      failRivalShapes("history --summary", "-f/--follow", "a summary tallies a bounded set; -f follows from now on");
  }
  const followTail = follow ? readEventsTailWithEnd(root, HISTORY_FOLLOW_BUFFER_EVENTS) : null;
  const sinceMs = parseSinceFlag(rest, "history --since", LOGS_SINCE_MAX_MS);
  if (followTail !== null) {
    const limit = nRaw !== null ? parseCountFlag("-n", nRaw, HISTORY_MAX_RUNS) : HISTORY_DEFAULT_RUNS;
    // The seed goes through readRunRows, which widens its window until it finds `limit` rows;
    // the tail buffer only feeds the live follow.
    rows = readRunRows(root, limit, parseRoleListScope(root, rest));
  } else if (sinceMs !== null) {
    if (nRaw !== null) failRivalShapes("history --since", "-n", "a count and a window are rival shapes");
    const role = parseRoleListScope(root, rest);
    const windowed = readRunRowsSince(root, sinceMs, role);
    rows = windowed.rows;
    covered = windowed.covered;
  } else {
    // parseCountFlag's max caps the scan window: a typo'd "999999" must not build a
    // HISTORY_MAX_RUNS-sized slice scan from a huge limit.
    const limit = nRaw !== null ? parseCountFlag("-n", nRaw, HISTORY_MAX_RUNS) : HISTORY_DEFAULT_RUNS;
    // The config is read (through loadConfigCached, never throwing) only when --role is present:
    // a read-only view must not refuse a transiently broken tumwater.json.
    const role = parseRoleListScope(root, rest);
    rows = readRunRows(root, limit, role);
  }
  // The filter runs on the collected rows, before rendering and before --json serialization:
  // the same rows the table would print, filtered the same way in both forms (the logs --grep
  // rule: -n bounds the scanned window, not the printed rows).
  if (grepPattern !== null) rows = runRowsMatchingGrep(rows, grepPattern);
  // The set --grep admitted, saved so the empty-state wording blames the filter that actually
  // emptied it: if the result filter below removes rows grep matched, naming the pattern would
  // be false (`no runs matching "widget"` when feature #7 does match). The GUI draws the same
  // line between a search and its outcome filter.
  const afterGrep = rows.length;
  // `--result <class>[,<class>...]` narrows to the listed outcome buckets, reading the same
  // canonical historyClass rule the dashboard's History filter applies (shared from
  // history-data.ts, not copied). It composes with --role, -n, --since, and --grep, so no
  // rival-shape rule: a missing or empty value fails with its own wording, and an unknown
  // class names the accepted ones (the gotSuffix shape the other flag validators use, plus a
  // did-you-mean hint for a near-miss of a real result — the same typoSuffix treatment
  // `logs --type` gives its codes). Applied after --grep, over the same rows both the table
  // and --json serialize.
  const resultRaw = flagValue(rest, "--result");
  let resultClasses: HistoryResultClass[] | null = null;
  if (resultRaw !== null) {
    if (resultRaw === undefined || resultRaw === "") fail(HISTORY_RESULT_VALUE_ERROR);
    // A comma list names several classes; the first unknown piece fails with its own hint.
    const pieces = resultRaw.split(",").map((p) => p.trim()).filter((p) => p !== "");
    if (pieces.length === 0) fail(HISTORY_RESULT_VALUE_ERROR);
    const parsed: HistoryResultClass[] = [];
    for (const piece of pieces) {
      const cls = parseHistoryResultClass(piece);
      if (cls === null)
        fail(`history --result must be one of ${Object.values(HISTORY_RESULT_FLAG_NAMES).join(", ")}${gotSuffix(piece)}${typoSuffix(piece, Object.values(HISTORY_RESULT_FLAG_NAMES))}`);
      if (!parsed.includes(cls)) parsed.push(cls);
    }
    const wanted = parsed;
    resultClasses = wanted;
    rows = rows.filter((r) => wanted.includes(historyClass(r.result)));
  }
  // `--model <selector>[,...]` keeps the rows whose run_start named exactly one of the listed
  // selectors (case-sensitive, the strings `--summary --by model` prints); a null-model row never
  // matches. An unknown selector is not an error: models have no closed vocabulary and an old log
  // holds models the config has since dropped, so it simply keeps no rows.
  const afterResult = rows.length;
  const modelRaw = flagValue(rest, "--model");
  let models: string[] | null = null;
  if (modelRaw !== null) {
    if (modelRaw === undefined || modelRaw === "") fail(HISTORY_MODEL_VALUE_ERROR);
    const pieces = [...new Set(modelRaw.split(",").map((p) => p.trim()).filter((p) => p !== ""))];
    if (pieces.length === 0) fail(HISTORY_MODEL_VALUE_ERROR);
    models = pieces;
    rows = runRowsOnModels(rows, pieces);
  }
  if (followTail !== null) {
    await followHistory(root, rest, rows, followTail, (r) => rowKept(r, grepPattern, resultClasses, models), seams, rest.includes("--json"));
    return;
  }
  // --json swaps the renderer for the collector's own payload, exactly as status --json and
  // report --json: the same rows the table prints, each with ts/tokens/costUsd kept raw. A
  // JSON document even when the log is empty ({"rows":[]} — never the prose `no runs yet`,
  // the report --json precedent: the flag's output must be parseable in every exit-0 case).
  // `--by role|model` picks how --summary groups its lines (role by default).
  const byRaw = flagValue(rest, "--by");
  let byModel = false;
  if (rest.includes("--by")) {
    if (!byRaw) return fail(HISTORY_BY_VALUE_ERROR);
    if (!(HISTORY_SUMMARY_GROUPS as readonly string[]).includes(byRaw)) {
      fail(`history --by must be one of ${HISTORY_SUMMARY_GROUPS.join(", ")}${gotSuffix(byRaw)}${typoSuffix(byRaw, [...HISTORY_SUMMARY_GROUPS])}`);
    }
    if (!rest.includes("--summary")) fail("history --by needs --summary (it picks how the summary groups runs)");
    byModel = byRaw === "model";
  }
  const summary = rest.includes("--summary") && rows.length > 0;
  if (rest.includes("--json")) {
    sayJson(summary ? (byModel ? summarizeRunRowsByModel(rows) : summarizeRunRows(rows)) : { rows });
    return;
  }
  if (rows.length === 0) {
    // A grep that matched nothing must not borrow the empty-log prose: `no runs yet` and
    // `no runs in 2h` are statements about the LOG and the WINDOW, and both are false when
    // rows were scanned and filtered out — the operator would read a quiet team where the
    // truth is `the runs are there, none match`. The logs --grep rule (its `no events
    // matching "<pattern>"`, src/cli/log-commands.ts) names the pattern instead; --json stays
    // a bare {"rows":[]} document above, never prose in either form.
    //
    // The result class is named only when it emptied a non-empty set (`afterGrep > 0`): an
    // empty log or window scanned no rows, so the result filter removed nothing and the
    // empty-log/window prose is the true one — the dashboard's History view draws the same
    // line. A grep that admitted nothing keeps its own wording regardless of --result.
    say(
      models !== null && afterResult > 0
        ? `no runs on model "${models.join(",")}"`
        : resultClasses !== null && afterGrep > 0
        ? `no runs with result "${resultClasses.join(",")}"`
        : grepPattern !== null
          ? `no runs matching "${grepPattern}"`
          : sinceMs === null
            ? "no runs yet"
            : `no runs in ${durationLabel(sinceMs)}`,
    );
    return;
  }
  if (summary) say(byModel ? renderModelSummary(summarizeRunRowsByModel(rows)) : renderSummary(summarizeRunRows(rows)));
  else {
    const widths = widestWidths(rows);
    say(rows.map((r) => renderRow(r, widths)).join("\n"));
  }
  // A sparse window is never mistaken for a quiet team — but the note only ever rides rows
  // (an empty window returned above), it never touches --json output, and it is the shared
  // SPARSE_WINDOW_NOTE wording: the oldest retained event being inside the window is exactly
  // the unproven case, whether the cause is rotation or idleness.
  if (!covered) say(SPARSE_WINDOW_NOTE);
}

/** The row filters `--grep`, `--result` and `--model` apply, as one predicate for followed rows. */
function rowKept(row: RunRow, grep: string | null, classes: HistoryResultClass[] | null, models: string[] | null): boolean {
  if (grep !== null && runRowsMatchingGrep([row], grep).length === 0) return false;
  if (classes !== null && !classes.includes(historyClass(row.result))) return false;
  return models === null || runRowsOnModels([row], models).length > 0;
}

/** `history -f`: print the seed rows oldest first, then one row per `run_end` as it lands. A run
 * whose change waits to merge prints `queued` and no second line when the merge resolves. With
 * `json`, each row is one `sayJsonLine` object (the `history --json` row shape), nothing else. */
async function followHistory(
  root: string,
  rest: string[],
  seed: RunRow[],
  tail: { events: HarnessEvent[]; coveredEnd: number },
  keep: (row: RunRow) => boolean,
  seams: FollowSeams,
  json: boolean,
): Promise<void> {
  const ordered = [...seed].reverse();
  let widths = widestWidths(ordered);
  if (json) for (const r of ordered) sayJsonLine(r);
  else if (ordered.length > 0) say(ordered.map((r) => renderRow(r, widths)).join("\n"));
  const seen = new Set(seed.map((r) => `${r.role}#${r.run}`));
  const buffer = [...tail.events];
  const role = parseRoleListScope(root, rest);
  await followUntilParentGone(eventsLogPath(root), tail.coveredEnd, (lines) => {
    for (const line of lines.filter(Boolean)) {
      const e = parseEventLine(line);
      if (!e) continue;
      buffer.push(e);
      if (buffer.length > HISTORY_FOLLOW_BUFFER_EVENTS) buffer.splice(0, buffer.length - HISTORY_FOLLOW_BUFFER_EVENTS);
      if (e.type !== "run_end") continue;
      const row = runRows(buffer, 1, role)[0];
      if (!row) continue;
      const key = `${row.role}#${row.run}`;
      if (seen.has(key) || !keep(row)) continue;
      seen.add(key);
      if (json) {
        sayJsonLine(row);
        continue;
      }
      widths = widenWidths(widths, widestWidths([row]));
      say(renderRow(row, widths));
    }
  }, seams);
}
