import { fail, say, sayJson, sayJsonLine } from "../cli/cli-output.js";
import { betweenWindow, durationLabel, failFollowJsonRival, failFollowSinceRival, failRivalShapes, failUntilShorterThanSince, flagValue, parseCountFlag, parseGrepFlag, parseRoleListScope, parseSinceFlag, rejectFlagLookingValue } from "../cli/cli-args.js";
import { HISTORY_DEFAULT_RUNS, HISTORY_MAX_RUNS, HISTORY_RESULT_FLAG_NAMES, HISTORY_SUMMARY_GROUPS, historyClass, parseHistoryResultClass, readRunRows, readRunRowsSince, runRows, summarizeRunRows, summarizeRunRowsByModel, runRowsMatchingGrep, runRowsOnModels, type HistoryResultClass, type RunRow } from "./history-data.js";
import { renderModelSummary, renderRow, renderSummary, widenWidths, widestWidths } from "./history-render.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { followUntilParentGone, type FollowSeams } from "../cli/cli-log-commands.js";
import { followView, type FollowViewSeams } from "../cli/follow-view.js";
import { hasFollowFlag } from "../cli/cli-flag-specs.js";
import { parseEventLine, readEventsTailWithEnd } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { eventsLogPath } from "../paths.js";
import { splitCommaList, splitCommaListUnique } from "../text/text.js";
import { trimToLast } from "../collections.js";
import { oneOfMessage } from "../text/suggest.js";

/** Parse a `--model` value: a comma list of model selectors, deduplicated in first-seen order.
 * A missing, empty or all-commas value fails with HISTORY_MODEL_VALUE_ERROR; selectors have no
 * closed vocabulary, so none is rejected as unknown. Shared by the listing and the one-run
 * trail's `--last --model`. */
export function parseHistoryModelList(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") fail(HISTORY_MODEL_VALUE_ERROR);
  const pieces = splitCommaListUnique(raw);
  if (pieces.length === 0) fail(HISTORY_MODEL_VALUE_ERROR);
  return pieces;
}

/** `tumwater history [--role <id>[,<id>...]] [-n N]`: one row per completed run, newest first. The
 * observing half beside cmdLogs (cli-log-commands.ts): read-only over the event log, stdout only —
 * every datum rides the `run_end` events src/run/run-finalize.ts already writes, so this
 * is a rendering of the existing record, not a new one. The rows themselves are collected
 * by history-data.ts (beside src/report/report-data.ts and src/failure/failure-data.ts), and
 * the aligned table/summary text they print is rendered by history-render.ts (beside
 * src/report/report-render.ts); this module parses the args, drives the CLI, and prints. */

/** The missing-pattern error cmdHistory prints for a valueless or empty `--grep`, exported so
 * cli.ts's rejectUnknownArgs spec for --grep can fail a trailing `history --grep` with the same
 * wording. Kept local to this module — cli-log-commands.ts holds its own GREP_VALUE_ERROR — so the
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

/** Parse a `--result` value: a comma list of outcome classes (the spellings
 * HISTORY_RESULT_FLAG_NAMES prints, plus the hidden `changes` alias), deduplicated in first-seen
 * order. A missing, empty or all-commas value fails with HISTORY_RESULT_VALUE_ERROR; the first
 * unknown piece fails naming the accepted classes (gotSuffix plus a did-you-mean hint). Shared by
 * the listing and the one-run trail's `--last --result`. */
export function parseHistoryResultList(raw: string | undefined): HistoryResultClass[] {
  if (raw === undefined || raw === "") fail(HISTORY_RESULT_VALUE_ERROR);
  const pieces = splitCommaList(raw);
  if (pieces.length === 0) fail(HISTORY_RESULT_VALUE_ERROR);
  const parsed: HistoryResultClass[] = [];
  for (const piece of pieces) {
    const cls = parseHistoryResultClass(piece);
    if (cls === null)
      fail(`history --result ${oneOfMessage(Object.values(HISTORY_RESULT_FLAG_NAMES))(piece)}`);
    if (!parsed.includes(cls)) parsed.push(cls);
  }
  return parsed;
}

/** The scanned `history` query: the remaining non-flag args, the `--grep` pattern, the raw
 * `-n` string (kept unparsed so a bad count still fails inside collectHistoryRows, after the
 * `--since` rival check and before `--result`), the follow tail (null unless `-f`), and the
 * `--since`/`--until` window bounds (null when absent). */
interface HistoryQuery {
  rest: string[];
  grepPattern: string | null;
  nRaw: string | null | undefined;
  followTail: { events: HarnessEvent[]; coveredEnd: number } | null;
  sinceMs: number | null;
  untilMs: number | null;
}

/** Scan `history`'s flags: the `--grep` pattern, the raw `-n` value, the `-f`/`--since`
 * rival shape checks, and the `--since`/`--until` window. These failures all fire here in
 * the same order as before, so a bad value names the same command and flag; only the `-n`
 * count is left raw (see collectHistoryRows), so its own parse and failure live there, in
 * the deliberate spot after the `--since` rival check and before `--result`. */
function parseHistoryQuery(root: string, args: string[]): HistoryQuery {
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
  const follow = hasFollowFlag(rest);
  if (follow) {
    // `--since` stays a rival to every follow form: it names a bounded past window, a follow
    // means from now on. `--summary` is no longer a rival — `-f --summary` repaints the
    // bounded tally (followHistorySummary) — but a `--summary` follow still takes this seed
    // read, so the tail buffer is read for either follow shape.
    if (rest.includes("--since"))
      failFollowSinceRival("history");
  }
  const followTail = follow ? readEventsTailWithEnd(root, HISTORY_FOLLOW_BUFFER_EVENTS) : null;
  const sinceMs = parseSinceFlag(rest, "history --since", LOGS_SINCE_MAX_MS);
  const untilMs = parseSinceFlag(rest, "history --until", LOGS_SINCE_MAX_MS, "--until");
  failUntilShorterThanSince("history", untilMs, sinceMs);
  return { rest, grepPattern, nRaw, followTail, sinceMs, untilMs };
}

/** Collect the row set the query names: the `-f` seed, the `--since` window, or the plain `-n`
 * scan. The `-n` and `--since` rival checks live here so a bad count still fails after the
 * `--since` check and before `--result` filtering. Returns the rows plus whether the scan
 * covered the whole log (false when a bounded window hit the retained buffer's edge). The
 * post-collection filters run collectFilteredHistoryRows, so the one-shot and the `--summary -f`
 * repaint paths share the same collection and the same filter order. */
function collectHistoryRows(root: string, q: HistoryQuery): { rows: RunRow[]; covered: boolean } {
  let rows: RunRow[];
  let covered = true;
  if (q.followTail !== null) {
    const limit = q.nRaw !== null ? parseCountFlag("-n", q.nRaw, HISTORY_MAX_RUNS) : HISTORY_DEFAULT_RUNS;
    // The seed goes through readRunRows, which widens its window until it finds `limit` rows;
    // the tail buffer only feeds the live follow.
    rows = readRunRows(root, limit, parseRoleListScope(root, q.rest));
  } else if (q.sinceMs !== null) {
    if (q.nRaw !== null) failRivalShapes("history --since", "-n", "a count and a window are rival shapes");
    const role = parseRoleListScope(root, q.rest);
    const windowed = readRunRowsSince(root, q.sinceMs, role, q.untilMs);
    rows = windowed.rows;
    covered = windowed.covered;
  } else {
    // parseCountFlag's max caps the scan window: a typo'd "999999" must not build a
    // HISTORY_MAX_RUNS-sized slice scan from a huge limit.
    const limit = q.nRaw !== null ? parseCountFlag("-n", q.nRaw, HISTORY_MAX_RUNS) : HISTORY_DEFAULT_RUNS;
    // The config is read (through loadConfigCached, never throwing) only when --role is present:
    // a read-only view must not refuse a transiently broken tumwater.json.
    const role = parseRoleListScope(root, q.rest);
    rows = readRunRows(root, limit, role);
  }
  return { rows, covered };
}

/** The one-shot path's collect-and-filter body, and the `--summary -f` repaint frame's read:
 * the row set the query names (the `-f` seed, the `--since` window, or the plain `-n` scan,
 * through collectHistoryRows), then `--grep`, `--result` and `--model` in the one-shot order.
 * Each follow frame re-reads the last `-n` rows through readRunRows, so a run that ends
 * between frames joins the next tally and a row pushed past the count rolls off — exactly what
 * a rerun would show. Returns the filtered rows, whether the scan covered the whole log, and
 * the filter state the empty-state wording blames. */
function collectFilteredHistoryRows(root: string, q: HistoryQuery): { rows: RunRow[]; covered: boolean; filtering: HistoryFiltering } {
  let { rows, covered } = collectHistoryRows(root, q);
  // The filter runs on the collected rows, before rendering and before --json serialization:
  // the same rows the table prints, filtered the same way in both forms (the logs --grep
  // rule: -n bounds the scanned window, not the printed rows).
  if (q.grepPattern !== null) rows = runRowsMatchingGrep(rows, q.grepPattern);
  // The set --grep admitted, saved so the empty-state wording blames the filter that actually
  // emptied it: if the result filter below removes rows grep matched, naming the pattern would
  // be false (`no runs matching "widget"` when feature #7 does match). The GUI draws the same
  // line between a search and its outcome filter.
  const afterGrep = rows.length;
  // --result and --model each narrow the set further, and the counts saved here let the
  // empty-state wording blame whichever filter actually emptied it.
  const result = applyHistoryResultFilter(rows, q.rest);
  rows = result.rows;
  const afterResult = rows.length;
  const model = applyHistoryModelFilter(rows, q.rest);
  rows = model.rows;
  return { rows, covered, filtering: { afterGrep, afterResult, classes: result.classes, models: model.models } };
}

/** `--result <class>[,<class>...]` narrows the rows to the listed outcome buckets, reading the
 * same canonical historyClass rule the dashboard's History filter applies (shared from
 * history-data.ts, not copied). It composes with --role, -n, --since, and --grep, so no
 * rival-shape rule: a missing or empty value fails with its own wording, and an unknown class
 * names the accepted ones (the gotSuffix shape the other flag validators use, plus a did-you-mean
 * hint for a near-miss of a real result — the same typoSuffix treatment `logs --type` gives its
 * codes). Applied after --grep, over the same rows both the table and --json serialize. */
function applyHistoryResultFilter(rows: RunRow[], rest: string[]): { rows: RunRow[]; classes: HistoryResultClass[] | null } {
  const resultRaw = rejectFlagLookingValue("history --result", flagValue(rest, "--result"));
  let resultClasses: HistoryResultClass[] | null = null;
  if (resultRaw !== null) {
    const wanted = parseHistoryResultList(resultRaw);
    resultClasses = wanted;
    rows = rows.filter((r) => wanted.includes(historyClass(r.result)));
  }
  return { rows, classes: resultClasses };
}

/** `--model <selector>[,...]` keeps the rows whose run_start named exactly one of the listed
 * selectors (case-sensitive, the strings `--summary --by model` prints); a null-model row never
 * matches. An unknown selector is not an error: models have no closed vocabulary and an old log
 * holds models the config has since dropped, so it simply keeps no rows. */
function applyHistoryModelFilter(rows: RunRow[], rest: string[]): { rows: RunRow[]; models: string[] | null } {
  const modelRaw = rejectFlagLookingValue("history --model", flagValue(rest, "--model"));
  let models: string[] | null = null;
  if (modelRaw !== null) {
    const pieces = parseHistoryModelList(modelRaw);
    models = pieces;
    rows = runRowsOnModels(rows, pieces);
  }
  return { rows, models };
}

/** The post-collection filter state a narrowed row set carries into rendering: how many rows a
 * `--grep` and a `--result` pass admitted (0 when the flag is absent), plus the filter values
 * themselves when present. Shared by `sayHistory` and `historyEmptyText` so the empty-state
 * wording can blame whichever filter emptied the set. */
interface HistoryFiltering {
  afterGrep: number;
  afterResult: number;
  classes: HistoryResultClass[] | null;
  models: string[] | null;
}

/** Validate `--by`'s value and its `--summary` requirement; return whether the grouping is by
 * model (false for `role`). One home for "can this `--by` proceed, and does it group by model?" */
function historySummaryGroup(q: HistoryQuery): boolean {
  // `--by role|model` picks how --summary groups its lines (role by default). A `--`-token
  // in the value slot is the operator's slipped value (`--by --json`): refuse it up front
  // with rejectFlagLookingValue's shared wording — the same guard --result and --model
  // apply — instead of misreading the next flag as a `--by` value and reporting it as a
  // bad grouping ("must be one of role, model (got \"--json\")").
  const byRaw = rejectFlagLookingValue("history --by", flagValue(q.rest, "--by"));
  let byModel = false;
  if (q.rest.includes("--by")) {
    if (!byRaw) return fail(HISTORY_BY_VALUE_ERROR);
    if (!(HISTORY_SUMMARY_GROUPS as readonly string[]).includes(byRaw)) {
      fail(`history --by ${oneOfMessage(HISTORY_SUMMARY_GROUPS)(byRaw)}`);
    }
    if (!q.rest.includes("--summary")) fail("history --by needs --summary (it picks how the summary groups runs)");
    byModel = byRaw === "model";
  }
  return byModel;
}

/** The empty-set prose: blame the filter that emptied the set (model, then result, then grep),
 * else the log or window. Never the `no runs yet`/`no runs in <window>` prose when rows were
 * scanned and filtered out — the runs are there, none match. Pure — it returns the text instead
 * of calling `say` — so the one-shot path and each `--summary -f` repaint frame build the
 * identical first frame from the same state. */
function historyEmptyText(q: HistoryQuery, filtered: HistoryFiltering): string {
  // A grep that matched nothing must not borrow the empty-log prose: `no runs yet` and
  // `no runs in 2h` are statements about the LOG and the WINDOW, and both are false when
  // rows were scanned and filtered out — the operator would read a quiet team where the
  // truth is `the runs are there, none match`. The logs --grep rule (its `no events
  // matching "<pattern>"`, src/cli/cli-log-commands.ts) names the pattern instead; --json stays
  // a bare {"rows":[]} document above, never prose in either form.
  //
  // The result class is named only when it emptied a non-empty set (`afterGrep > 0`): an
  // empty log or window scanned no rows, so the result filter removed nothing and the
  // empty-log/window prose is the true one — the dashboard's History view draws the same
  // line. A grep that admitted nothing keeps its own wording regardless of --result.
  return (
    filtered.models !== null && filtered.afterResult > 0
      ? `no runs on model "${filtered.models.join(",")}"`
      : filtered.classes !== null && filtered.afterGrep > 0
      ? `no runs with result "${filtered.classes.join(",")}"`
      : q.grepPattern !== null
        ? `no runs matching "${q.grepPattern}"`
        : q.sinceMs === null
          ? "no runs yet"
          : q.untilMs === null
            ? `no runs in ${durationLabel(q.sinceMs)}`
            : `no runs ${betweenWindow(q.sinceMs, q.untilMs)}`
  );
}

/** The aligned table text for the row view: the same rows, columns, and padding the one-shot
 * table prints, returned as text instead of said so the one-shot and the `--summary -f`
 * repaint paths share one home. Called only with `rows.length > 0`. */
function rowsToText(rows: RunRow[]): string {
  const widths = widestWidths(rows);
  return rows.map((r) => renderRow(r, widths)).join("\n");
}

/** The summary text for the `--summary` view, returned as text instead of said. Called only
 * with `rows.length > 0`. */
function summaryRowsText(rows: RunRow[], byModel: boolean): string {
  return byModel ? renderModelSummary(summarizeRunRowsByModel(rows)) : renderSummary(summarizeRunRows(rows));
}

/** Render the collected-and-filtered rows: the `--by`/`--summary` summary grouping, the `--json`
 * document, the empty-state wording (blaming the filter that emptied the set, else the log or
 * window), the aligned table, and the sparse-window note. A bad `--by` value fails here, after
 * row collection and filtering and before `--json`. */
function sayHistory(rows: RunRow[], q: HistoryQuery, covered: boolean, filtered: HistoryFiltering): void {
  const byModel = historySummaryGroup(q);
  const summary = q.rest.includes("--summary") && rows.length > 0;
  // --json swaps the renderer for the collector's own payload, exactly as status --json and
  // report --json: the same rows the table prints, each with ts/tokens/costUsd kept raw. A
  // JSON document even when the log is empty ({"rows":[]} — never the prose `no runs yet`,
  // the report --json precedent: the flag's output must be parseable in every exit-0 case).
  if (q.rest.includes("--json")) {
    sayJson(summary ? (byModel ? summarizeRunRowsByModel(rows) : summarizeRunRows(rows)) : { rows });
    return;
  }
  say(historyText(rows, q, covered, filtered));
}

/** The one-shot non-JSON text the collected-and-filtered rows render to: the empty-state
 * wording (blaming the filter that emptied the set, else the log or window), the summary or
 * aligned table, and the sparse-window note. Pure — it returns the text instead of calling
 * `say` — so the one-shot path and each `--summary -f` repaint frame build the identical table
 * from the same rows. A bad `--by` value fails here, after row collection and filtering. */
function historyText(rows: RunRow[], q: HistoryQuery, covered: boolean, filtered: HistoryFiltering): string {
  const byModel = historySummaryGroup(q);
  const summary = q.rest.includes("--summary") && rows.length > 0;
  const body = rows.length === 0 ? historyEmptyText(q, filtered) : summary ? summaryRowsText(rows, byModel) : rowsToText(rows);
  // A sparse window is never mistaken for a quiet team — but the note only ever rides rows
  // (an empty set returns its prose alone, as sayHistory did), it never touches --json
  // output, and it is the shared SPARSE_WINDOW_NOTE wording: the oldest retained event being
  // inside the window is exactly the unproven case, whether the cause is rotation or
  // idleness.
  if (!covered && rows.length > 0) return body + "\n" + SPARSE_WINDOW_NOTE;
  return body;
}

/** `tumwater history [--role <id>[,<id>...]] [-n N] [-f] [--since <duration>]
 * [--until <duration>] [--grep <text>] [--result <class>] [--model <selector>[,...]]`: print the
 * last N completed runs, newest first — or,
 * with `--since`, the runs of a bounded past window over the same record, the same shape
 * `logs --since` and `report --since` speak. `--grep` keeps rows whose rendered line matches,
 * `--result` narrows to the listed outcome classes (changes/none/problems, the dashboard History
 * filter's buckets) and `--model` keeps runs that started on the listed models; all compose
 * with --role, -n, and --since. Read-only: stdout only, no state file created — a missing or empty
 * event log prints `no runs yet` and exits 0. */
export async function cmdHistory(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  const q = parseHistoryQuery(root, args);
  if (q.followTail !== null && q.rest.includes("--summary")) {
    // The live summary: the bounded tally repainted until the parent exits. It re-runs the
    // one-shot view's whole read — the same -n bound, --role scope, and --grep/--result/
    // --model filters — each frame through collectFilteredHistoryRows, so the repaint is a
    // rerun of the one-shot view, not a different one. `--json` and `--since` are refused
    // before any frame, and the seams ride the shared FollowViewSeams shape so a test can
    // drive the TTY and piped frame shapes.
    await followHistorySummary(root, q, seams);
    return;
  }
  const { rows, covered, filtering } = collectFilteredHistoryRows(root, q);
  if (q.followTail !== null) {
    await followHistory(root, q.rest, rows, q.followTail, (r) => rowKept(r, q.grepPattern, filtering.classes, filtering.models), seams, q.rest.includes("--json"));
    return;
  }
  sayHistory(rows, q, covered, filtering);
}

/** The row filters `--grep`, `--result` and `--model` apply, as one predicate for followed rows. */
function rowKept(row: RunRow, grep: string | null, classes: HistoryResultClass[] | null, models: string[] | null): boolean {
  if (grep !== null && runRowsMatchingGrep([row], grep).length === 0) return false;
  if (classes !== null && !classes.includes(historyClass(row.result))) return false;
  return models === null || runRowsOnModels([row], models).length > 0;
}

/** `history --summary -f`: the bounded tally repainted until the parent exits. The rivals are
 * checked before entering the loop so they fail with the one-shot wording instead of being
 * swallowed by the follow's per-frame catch: `--json` (a repainting document has no parseable
 * stream) and a bad `--by` value (historySummaryGroup's one-shot sentence). `--since` is
 * refused in parseHistoryQuery, before this point. Each frame re-reads the last `-n` rows
 * through readRunRows, so a run that ends between frames appears in the next tally and a row
 * pushed past the count rolls off — the same rows a fresh `history --summary -n <n>` would
 * print at that moment. A frame that fails (a transiently unreadable log) is skipped and
 * retried on the next tick, the followView policy, so one bad tick does not kill the follow. */
async function followHistorySummary(root: string, q: HistoryQuery, seams: FollowViewSeams): Promise<void> {
  if (q.rest.includes("--json")) failFollowJsonRival("history --summary --json");
  historySummaryGroup(q);
  await followView(
    () => {
      const { rows, covered, filtering } = collectFilteredHistoryRows(root, q);
      return historyText(rows, q, covered, filtering);
    },
    seams,
  );
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
      trimToLast(buffer, HISTORY_FOLLOW_BUFFER_EVENTS);
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
