// vocabulary: plain
/** Collection half of `tumwater history`: read the event log and distill the last N completed
 * runs into RunRow — one row per run, newest first, with the paired duration and the raw
 * usage numbers. The Markdown/table rendering of this data lives in history.ts, a pure
 * function of it; the split mirrors the usage report's (src/report/report-data.ts /
 * src/report/report-render.ts) and keeps "what happened" (run pairing, role filtering,
 * scan windows) apart from "how it prints" (column widths, terminal display padding),
 * which change for different reasons — and keeps core data collection out of the
 * presentation layer, so a core consumer (as the GUI's /api/history already is) never
 * forces a core→ui import. */
import { eventRole, eventTick, eventUsage, readEvents, tickSpanMs, tickStartMap, tickStartModel, tickStartModelMap } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { readEventsSinceJoined } from "../events/event-window.js";
import { formatTimestamp } from "../text/datetime.js";
import { eventTypeLabel } from "../events/event-labels.js";
import { roleLabel } from "../roles/role-labels.js";
import { squash, textOr } from "../text/text.js";
import { shortSpanPhrase } from "../text/phrases.js";
import { outcomeText, usageText } from "../events/event-format.js";
import { compareCodeUnits, groupBy } from "../collections.js";

/** `history`'s default row count and ceiling. The default shows a working hour of a quiet
 * team; the ceiling bounds how much log one ask re-reads — more rows only re-read more log
 * with no added signal, so an explicit flag above it fails fast (the report's --days pattern). */
export const HISTORY_DEFAULT_RUNS = 20;
export const HISTORY_MAX_RUNS = 200;

/** The outcome classes `tumwater history --result` and the dashboard's History filter both
 * speak: Changes (the run merged or queued work), No change (it did nothing on purpose, or
 * the operator aborted it), Refused (a run that deliberately declined its entry), Problems
 * (everything else, e.g. error/rejected). The one canonical
 * rule; the browser's copy in gui-client-history.ts is pinned to it by
 * test/gui-client-history.test.ts, so the two cannot drift. */
export const HISTORY_RESULT_CLASSES = ["changes", "none", "refused", "problems"] as const;

/** One outcome class, derived from the list above so the two cannot disagree. */
export type HistoryResultClass = (typeof HISTORY_RESULT_CLASSES)[number];

/** The spelling each class has on `--result` and in the TUI filter: `changes` reads `merged`. */
export const HISTORY_RESULT_FLAG_NAMES: Readonly<Record<HistoryResultClass, string>> = { changes: "merged", none: "none", refused: "refused", problems: "problems" };

/** Parse a `--result` value: a flag name, or a class name (so `changes` stays a hidden alias). */
export function parseHistoryResultClass(raw: string): HistoryResultClass | null {
  return HISTORY_RESULT_CLASSES.find((c) => raw === c || raw === HISTORY_RESULT_FLAG_NAMES[c]) ?? null;
}

/** Which outcome class a run result falls in (the HISTORY_RESULT_CLASSES rule): `changed` and
 * `queued` are `changes`; `no_change`, `skipped`, and `user_aborted` are `none`; `refused` is
 * `refused`; every other result is `problems`. Pure; the canonical home the dashboard's
 * client-side filter mirrors. */
export function historyClass(result: string): HistoryResultClass {
  if (result === "changed" || result === "queued") return "changes";
  if (result === "no_change" || result === "skipped" || result === "user_aborted") return "none";
  if (result === "refused") return "refused";
  return "problems";
}

/** One role's run tally by outcome class (the HISTORY_RESULT_CLASSES buckets); `runs` is their
 * sum. `lastChangeTs` is the newest changes-class row's `ts`, or null when the role had none among
 * the rows. The `total` line of a summary uses the role name "total". */
export interface HistorySummaryRow {
  role: string;
  runs: number;
  changes: number;
  none: number;
  refused: number;
  problems: number;
  tokens: number;
  costUsd: number;
  /** The sum of the summarized rows' `durationMs` (ms of agent wall-clock those runs consumed).
   * Optional and zero-absent, like the report's summable fields: the key appears only when at
   * least one contributing row carried a timed span, so an untimed window keeps today's exact
   * JSON shape. Absent for a role whose rows all carried a null span (their starts sat outside
   * the scanned window). */
  durationMs?: number;
  lastChangeTs: number | null;
}

/** Tally rows into groups by `keyOf`, each row counted once; the key lands in the group row's
 * `role` field. Groups come back in plain string order (not localeCompare) so the order is
 * deterministic; `total` sums every row. Pure. */
function tallyRows(rows: RunRow[], keyOf: (row: RunRow) => string): { groups: HistorySummaryRow[]; total: HistorySummaryRow } {
  const blank = (role: string): HistorySummaryRow => ({ role, runs: 0, changes: 0, none: 0, refused: 0, problems: 0, tokens: 0, costUsd: 0, lastChangeTs: null });
  const byKey = new Map<string, HistorySummaryRow>();
  const total = blank("total");
  for (const row of rows) {
    const key = keyOf(row);
    let entry = byKey.get(key);
    if (!entry) byKey.set(key, (entry = blank(key)));
    const cls = historyClass(row.result);
    for (const t of [entry, total]) {
      t.runs += 1;
      t[cls] += 1;
      t.tokens += row.tokens;
      t.costUsd += row.costUsd;
      if (row.durationMs !== null) t.durationMs = (t.durationMs ?? 0) + row.durationMs;
      if (cls === "changes") t.lastChangeTs = Math.max(t.lastChangeTs ?? row.ts, row.ts);
    }
  }
  const groups = [...byKey.values()].sort((a, b) => compareCodeUnits(a.role, b.role));
  return { groups, total };
}

/** Tally rows per role by historyClass, each row counted once. Roles come back in plain string
 * order (not localeCompare) so the order is deterministic; `total` sums every role. Pure. */
export function summarizeRunRows(rows: RunRow[]): { roles: HistorySummaryRow[]; total: HistorySummaryRow } {
  const { groups, total } = tallyRows(rows, (r) => r.role);
  return { roles: groups, total };
}

/** What `history --summary --by` accepts: the default per-role grouping or per-model. */
export const HISTORY_SUMMARY_GROUPS = ["role", "model"] as const;

/** One of HISTORY_SUMMARY_GROUPS. */
export type HistorySummaryGroup = (typeof HISTORY_SUMMARY_GROUPS)[number];

/** One model's tally: HistorySummaryRow's counts keyed by `model` instead of `role`. `null` is the
 * bucket of rows with no model (their start sat outside the scanned window or carried none). */
export type HistoryModelSummaryRow = Omit<HistorySummaryRow, "role"> & { model: string | null };

/** Sentinel group key for rows whose model is null; no model selector can equal it. */
const NO_MODEL_KEY = "\u0000";

/** summarizeRunRows grouped by the model each run started on instead of by role. Models come back
 * in plain string order with the null bucket last; `total` equals summarizeRunRows's. Pure. */
export function summarizeRunRowsByModel(rows: RunRow[]): { models: HistoryModelSummaryRow[]; total: HistorySummaryRow } {
  const { groups, total } = tallyRows(rows, (r) => r.model ?? NO_MODEL_KEY);
  const models = groups.map(({ role, ...counts }): HistoryModelSummaryRow => ({ model: role === NO_MODEL_KEY ? null : role, ...counts }));
  models.sort((a, b) => (a.model === null ? 1 : b.model === null ? -1 : compareCodeUnits(a.model, b.model)));
  return { models, total };
}

/** How much of a run's summary or error a row keeps. Long enough to name the work, short
 * enough that the row stays one terminal line next to its other columns. */
const DETAIL_MAX = 72;

/** The hard ceiling on one ask's scan window (events, not rows): the growth loop below
 * re-reads with a larger window only while the filtered rows fall short and the log may hold
 * more, and this bounds the worst case — readTailText reads bytes proportional to the limit's
 * line count, so the cap is also the largest byte read one command can cost. Comfortably
 * above the dilution a whole role catalog can impose on HISTORY_MAX_RUNS rows. Exported as
 * the one ceiling every read-only view's single ask scans under: run-detail-data.ts's
 * readRunDetail reads the same bound, so no ask can re-read more log than any other and the
 * cap cannot drift per consumer. */
export const HISTORY_SCAN_MAX_EVENTS = 20_000;

/** How far behind a since-shaped scan's cutoff the queued-row join reads its evidence: the
 * row set is ts-filtered to the cutoff, but a queued run whose run SPANS the cutoff logged
 * its `merge_queued` pin before it (the pin is logged during the run, the run_end after it)
 * — so the join evidence needs its own read reaching further back. Six hours outlasts any
 * run the harness runs (every stage inside a run is timeout-bounded); a run that somehow
 * queued later than that keeps the raw label, the conservative fallback. The wider read shares
 * one bounded backwards scan with the rows' own window (readEventsSinceJoined), and its
 * day-keyed scan never reaches past its own window's first day. */
const RUN_ROW_JOIN_BACKSLACK_MS = 6 * 60 * 60 * 1000;

/** Wider join evidence for a row set whose own window cut events the queued-row join needs
 * (the `--since` path; the tail-count path needs none — see readRunRows). `events` is the
 * cutoff-unfiltered read (a strict superset of the row set's events, oldest first);
 * `floorTs` is that read's requested lower bound (epoch ms): a queued row whose run_start
 * sits before `floorTs` cannot trust the read around its pin (the day-keyed over-read can
 * hold older runs' pins below the floor while the row's own pin is gone), so it keeps the
 * raw label rather than risk claiming another run's pin — only the row's own run block
 * being whole above the floor makes the newest-pin-at-or-before-the-end rule pick the right
 * one (resolveQueuedResult spells out why a missing start needs no guard). */
interface RunRowJoin {
  events: HarnessEvent[];
  floorTs: number;
}

/** One completed run, rendered. `durationMs` is null when the run's `run_start` is not in
 * the scanned window (log rotation, or a skipped run that never started) — the row shows a
 * dash rather than a fabricated duration. `usage` is "" when the event carries neither tokens
 * nor cost, matching the payload's omit-when-zero convention. `ts` is the raw run_end instant
 * (epoch ms) the rendered `time` string is derived from, and `tokens`/`costUsd` the raw usage
 * numbers `usage` folds into one string (0 when the event carries none — eventUsage's
 * loose-typing coercion, shared with the event feed's fragment): the three fields
 * `tumwater history --json` and the GUI's /api/history serve so a script gets the
 * numbers, not the table's rendering of them. `model` is the selector string the run's
 * run_start named (the agent-qualified selector — a per-role override, a fallback, or the
 * primary), or null when the start is outside the scanned window or carried no model — the
 * same absent-start rule durationMs uses, so a run whose start sits outside a `--since`
 * cutoff still names its model whenever the log holds the start. */
export interface RunRow {
  ts: number;
  time: string;
  role: string;
  run: number;
  result: string;
  model: string | null;
  durationMs: number | null;
  tokens: number;
  costUsd: number;
  usage: string;
  detail: string;
}

/** The five unpadded cell strings of one run row, the one home for the column values. The CLI
 * table (history-render.ts's renderRow, which pads) and the TUI History pane (tui-history.ts) both
 * build their lines from these; runRowGrepHaystack below joins them too, so the surfaces that
 * render or search a run row cannot disagree about what a row's fields say. `run` is the
 * unpadded number (the caller adds the `#` prefix), and a null `durationMs` (the run's start
 * sits outside the scanned window) shows the em dash rather than a fabricated duration. */
export interface RunRowCells {
  role: string;
  run: string;
  result: string;
  model: string;
  duration: string;
  usage: string;
}

export function runRowCells(row: RunRow): RunRowCells {
  return {
    role: roleLabel(row.role),
    run: String(row.run),
    result: eventTypeLabel(row.result),
    model: row.model ?? "",
    duration: row.durationMs === null ? "—" : shortSpanPhrase(row.durationMs),
    usage: row.usage,
  };
}

/** One run row's line: its timestamp, the six runRowCells values (the model cell between
 * the result and the duration), then the free-text detail, joined by two spaces and stripped
 * of trailing padding. This is the one home for the row's column order and separator;
 * renderRow (history-render.ts) passes a per-column padding function to align the CLI table,
 * while runRowGrepHaystack below passes none. The run cell's "#" prefix rides outside the
 * padding, so its column width measures the number alone. */
export function runRowLine(
  row: RunRow,
  pad: (column: keyof RunRowCells, value: string) => string = (_c, v) => v,
): string {
  const c = runRowCells(row);
  return [
    row.time,
    pad("role", c.role), // vocabulary-ok: column key, not shown
    `#${pad("run", c.run)}`,
    pad("result", c.result),
    pad("model", c.model),
    pad("duration", c.duration),
    pad("usage", c.usage),
    row.detail,
  ]
    .join("  ")
    .trimEnd();
}

/** The `--grep` haystack for one rendered history row: runRowLine's canonical unpadded row
 * line prefixed with the raw event type so stable ids (`run_end`) are greppable the way logs
 * --grep's haystack carries `e.type`, and followed by the raw role id and result code, which
 * the row shows as `feature #2` and `no change`, so a script's grep on the code still
 * matches. Built per row because the filter runs before the widths of the rows actually shown
 * are known, and shared by `tumwater history --grep` and the dashboard's
 * /api/history?grep so the two cannot disagree on the rule. The row's cells and column order
 * come from runRowCells and runRowLine, the one home for each. */
export function runRowGrepHaystack(row: RunRow): string {
  return `run_end ${runRowLine(row)} ${row.role} ${row.result}`;
}

/** The shared run-grep rule: a case-insensitive substring match over runRowGrepHaystack.
 * Four call sites apply it — `tumwater history --grep`, /api/history's window and count
 * shapes, and the TUI History search — so the three surfaces cannot disagree on what a match
 * means. The pattern is lowercased once here, not per row. */
export function runRowsMatchingGrep(rows: RunRow[], pattern: string): RunRow[] {
  const needle = pattern.toLowerCase();
  return rows.filter((r) => runRowGrepHaystack(r).toLowerCase().includes(needle));
}

/** The shared model filter: keeps the rows whose run_start named exactly one of `models`
 * (case-sensitive, the strings `history --summary --by model` prints); a null-model row never
 * matches. Two call sites apply it — `tumwater history --model` and /api/history?model — so the
 * CLI and the dashboard cannot disagree on what a model selector matches. */
export function runRowsOnModels(rows: RunRow[], models: string[]): RunRow[] {
  return rows.filter((r) => r.model !== null && models.includes(r.model));
}

/** The merge bookkeeping resolveQueuedResult joins over: per role, the `merge_queued` pins
 * and the `merge_done`/`merge_failed` outcomes, each list oldest-first (the scan order). Exported
 * as one helper with exactly three call sites — readRunRows' history-row join, the failure
 * digest's time-and-spend fold (time-spend.ts), and run-detail-data.ts — so the collectors
 * cannot disagree about which events feed the join or in what order they sit: a fourth
 * merge-bookkeeping event
 * type, or a changed order rule, is edited once here. Callers bucket only the events they
 * need; the digest folds its `review_rejected` reasons with its own pass.
 * Roles or cutoffs are the caller's concern: pass a role-scoped or wider-read event list and
 * the maps carry exactly that list's evidence. */
export function bucketMergeEvents(events: HarnessEvent[]): {
  mergeQueuedByRunner: Map<string, HarnessEvent[]>;
  outcomeByRunner: Map<string, HarnessEvent[]>;
} {
  const mergeQueuedByRunner = groupBy(
    events.filter((e) => e.type === "merge_queued"),
    (e) => e.source,
  );
  const outcomeByRunner = groupBy(
    events.filter((e) => e.type === "merge_done" || e.type === "merge_failed"), 
    (e) => e.source,
  );
  return { mergeQueuedByRunner, outcomeByRunner };
}

/** Resolve one queued run row's eventual merge verdict: a "queued" run_end carries no
 * result until its merge batch merges or fails, so the row joins its `end` run_end to the
 * run's merge_queued pin and that pin's merge_done/merge_failed outcome (both from the
 * bucketMergeEvents maps, oldest-first per role). The claim cursor `claimTop` (mutated in
 * place) walks the pin list newest-first and hands each queued run the newest unclaimed pin
 * at or before its end, so several queued runs cannot claim one pin.
 *
 * One change can take several merge attempts: a retriable result (RETRIABLE_MERGE_RESULTS:
 * review_error, merge_conflict, merge_blocked) keeps the pin, and the role's next run — a
 * leftover-recovery run that does no work of its own and ends in about a second — re-enqueues
 * it (isRecoveryPin). The authoring run and the recovery runs resolve by different rules, so
 * every attempt's verdict shows on exactly one row:
 * - The run that authored the change (its pin is not a re-enqueue of a kept attempt) takes
 *   the change's FINAL verdict, not its first attempt's: a retriable failure that recovery
 *   later merges reads "changed" (BUGS.md 2026-10-10). While a re-enqueued attempt is still
 *   pending the row keeps the raw "queued" label — the change is waiting to merge again, and
 *   the failure before it already shows on the recovery run's row.
 * - A recovery run takes the verdict of the attempt it re-enqueued — the retriable failure
 *   that kept the pin and made the run happen (recoveredAttemptVerdict). So a change that
 *   timed out in review seven times and was then rejected reads "rejected" once (the
 *   authoring row) and "review failed" seven times (the authoring attempt's and six
 *   recoveries' timeouts, each on the recovery row that followed it), not "rejected" on all
 *   eight rows.
 * When main moved before a retry the verification's syncPinToMain rebased the ref
 * (merge-core.ts), so the recovery pin carries the rebased sha while each attempt's own
 * merge_done/merge_failed logs its entry's sha (merge-slot.ts's entry.sha): the attempts' shas
 * differ, so the authoring row's walk follows the pin sequence (isRecoveryPin), not sha
 * equality alone. It stops at a pin that is not a recovery re-enqueue — a fresh change after a
 * conflict-cap discard — so the row never credits a different change's verdict (BUGS.md
 * 2026-10-10). A recovery pin whose previous attempt shows no retriable verdict (a crash
 * left the commit unpinned or the merge unfinished, or that attempt sits outside the read) is
 * the change's first visible attempt, so its row takes the authoring rule.
 *
 * `joinStarts` maps role#run to its run_start's ts; when `floorTs` (a since-window's cutoff,
 * null in the count view) sits after that start, the row's join evidence is not whole in the
 * windowed read and the row keeps its raw "queued" label (null). A MISSING start needs no
 * guard — it joins, because rotation drops a prefix, so every pin older than the lost start is
 * lost with it and nothing can be mis-claimed (and a skipped run has no start at all but is
 * never queued). A merge with no outcome event in the join set also keeps the raw label: the
 * conservative fallback for a verdict simply not visible here. Returns the verdict's result
 * text plus the pin and outcome of the attempt that produced it (and that pin's sha), or null
 * to keep the raw label. Pure apart from the cursor it owns. */
export function resolveQueuedResult(
  end: HarnessEvent,
  mergeQueuedByRunner: Map<string, HarnessEvent[]>,
  outcomeByRunner: Map<string, HarnessEvent[]>,
  claimTop: Map<string, number>,
  joinStarts: Map<string, number>,
  floorTs: number | null,
): QueuedVerdict | null {
  if (floorTs !== null) {
    const startTs = joinStarts.get(`${end.source}#${end.run}`);
    if (startTs !== undefined && startTs < floorTs) return null;
  }
  const queuedList = mergeQueuedByRunner.get(end.source);
  if (!queuedList || queuedList.length === 0) return null;
  let top = claimTop.get(end.source) ?? queuedList.length - 1;
  while (top >= 0 && queuedList[top]!.ts > end.ts) top--;
  if (top < 0) return null;
  claimTop.set(end.source, top - 1);
  const outcomes = outcomeByRunner.get(end.source) ?? [];
  // A recovery run's row: the attempt it re-enqueued, not the change's final verdict, so the
  // final verdict shows once (on the authoring row) and each retriable failure once (here).
  const recovered = recoveredAttemptVerdict(queuedList, top, outcomes);
  if (recovered !== null) return recovered;
  // The authoring row: walk forward while the next pin is a recovery re-enqueue and resolve to
  // the last attempt's verdict. `findLast` picks the newest same-sha outcome so an un-rebased
  // retry (recovery re-enqueues the identical sha, logged by both pins) does not re-match the
  // first attempt's outcome inside the recovery pin's walk. The returned pin/outcome ride the
  // result so a caller correlating sibling evidence (the failure digest's review-failure
  // message) can key on THIS attempt's position, not a sha a pre-review rebase may have moved
  // (BUGS.md 2026-10-10).
  let idx = top;
  let resolved: QueuedVerdict | null = null;
  for (;;) {
    const pin = queuedList[idx]!;
    const outcome = outcomes.findLast(
      (o) => o.ts >= pin.ts && textOr(o.commit, "") === textOr(pin.commit, ""),
    );
    // No outcome on the run's own pin, or on a recovery pin the walk reached: that attempt is
    // still pending, so the change is waiting to merge — keep the raw label. The previous
    // attempt's retriable verdict already shows on the recovery run's row.
    if (!outcome) return null;
    const verdict = attemptVerdict(pin, outcome);
    if (verdict === null) return resolved;
    // A merge or a rejection ends the change (the pin is discarded, so no recovery pin can
    // follow); any other verdict kept the pin, and the walk continues only if the next pin is
    // the recovery re-enqueue that kept it. Otherwise this attempt's verdict is the final one
    // visible.
    if (endsChange(verdict.result) || !isRecoveryPin(queuedList[idx + 1])) return verdict;
    resolved = verdict;
    idx += 1;
  }
}

/** One merge attempt's verdict as resolveQueuedResult returns it: the result text, the
 * attempt's pin and its sha, and the merge_done/merge_failed outcome that carried the result. */
interface QueuedVerdict {
  result: string;
  sha: string;
  pin: HarnessEvent;
  outcome: HarnessEvent;
}

/** The verdict one attempt's outcome carries, or null for a torn outcome with no result (a
 * merge_failed whose result is missing or not text). A merge_done with no result is a merge. */
function attemptVerdict(pin: HarnessEvent, outcome: HarnessEvent): QueuedVerdict | null {
  const result = textOr(outcome.result, outcome.type === "merge_done" ? "changed" : "");
  return result ? { result, sha: textOr(pin.commit, ""), pin, outcome } : null;
}

/** True when a verdict ends its change: a merge or a rejection discards the pin, so no recovery
 * re-enqueue can follow it. Every other verdict (the retriable ones) kept the pin. The one rule
 * both directions of resolveQueuedResult's chain read — the authoring row's walk forward and a
 * recovery row's step back — so the two cannot disagree on where a change ends. */
function endsChange(result: string): boolean {
  return result === "changed" || result === "rejected";
}

/** A recovery run's own row verdict: when the pin at `idx` is a recovery re-enqueue and the
 * previous pin's attempt ended in a retriable verdict (the kept pin this run re-enqueued), that
 * verdict, carrying the previous attempt's pin and outcome. The outcome is the newest one for
 * the previous pin's sha logged between the two pins: recovery runs only after the previous
 * attempt's outcome is written, and bounding at this pin keeps an un-rebased retry (both pins
 * share a sha) from matching a LATER attempt's outcome. Null when the pin is not a recovery
 * re-enqueue, or is one with no retriable attempt visible before it — a crash's unpinned or
 * unfinished commit, or a previous pin outside the read — so the row takes the authoring rule. */
function recoveredAttemptVerdict(queuedList: HarnessEvent[], idx: number, outcomes: HarnessEvent[]): QueuedVerdict | null {
  const pin = queuedList[idx]!;
  const prev = queuedList[idx - 1];
  if (prev === undefined || !isRecoveryPin(pin)) return null;
  const outcome = outcomes.findLast(
    (o) => o.ts >= prev.ts && o.ts <= pin.ts && textOr(o.commit, "") === textOr(prev.commit, ""),
  );
  const verdict = outcome === undefined ? null : attemptVerdict(prev, outcome);
  return verdict === null || endsChange(verdict.result) ? null : verdict;
}

/** True when a pin re-enqueues the previous attempt's kept pin rather than starting a fresh
 * change. `recoverLeftover` (src/runner/leftover.ts) is the one `merge_queued` producer whose
 * summary starts with this label, so a fresh change's pin after a conflict-cap discard ends
 * `resolveQueuedResult`'s walk. */
function isRecoveryPin(pin: HarnessEvent | undefined): boolean {
  return pin !== undefined && textOr(pin.summary, "").startsWith("recovered leftover work from ");
}

/** A role filter: one id, a list of ids (any listed role's events are kept), or null for all. */
type RoleScope = string | readonly string[] | null;

/** The run rows for the last `limit` completed runs in `events` (oldest-first, as
 * readEvents returns them), filtered to `role` when given, newest first. Pure: the CLI, the
 * GUI, and the tests share this collector, and none of them writes anything. */
export function runRows(
  events: HarnessEvent[],
  limit: number,
  role: RoleScope,
  join?: RunRowJoin,
): RunRow[] {
  const wanted = role === null ? null : new Set(typeof role === "string" ? [role] : role);
  const scoped = wanted === null ? events : events.filter((e) => wanted.has(e.source));
  // The start pairing is the shared helper (events.ts), so history's dash-on-unpaired rule
  // and the digest's fold cannot drift into different notions of a run's span.
  const starts = tickStartMap(scoped);
  const models = tickStartModelMap(scoped);
  // The merge bookkeeping resolveQueuedResult joins over: per role, the merge_queued pins
  // (oldest first) and the merge_done/merge_failed outcomes (oldest first). Both ride the role
  // filter with their run, so the scoped events hold them exactly when they hold the row.
  // A since-shaped scan hands a WIDER join read instead (readRunRowsSince): its cutoff cut
  // the pins of runs that span it, so the maps read the unfiltered-by-cutoff evidence and
  // resolveQueuedResult guards each claim on the row's run_start being whole in that read.
  const joinScoped = join
    ? wanted === null
      ? join.events
      : join.events.filter((e) => wanted.has(e.source))
    : scoped;
  const joinStarts = join ? tickStartMap(joinScoped) : starts;
  const joinModels = join ? tickStartModelMap(joinScoped) : models;
  const floorTs = join ? join.floorTs : null;
  const { mergeQueuedByRunner, outcomeByRunner } = bucketMergeEvents(joinScoped);
  const claimTop = new Map<string, number>();
  const rows: RunRow[] = [];
  for (let i = scoped.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = scoped[i];
    if (e?.type !== "run_end") continue;
    const rawResult = outcomeText(e);
    const result =
      rawResult === "queued"
        ? (resolveQueuedResult(e, mergeQueuedByRunner, outcomeByRunner, claimTop, joinStarts, floorTs)
            ?.result ?? rawResult)
        : rawResult;
    const usage = eventUsage(e);
    rows.push({
      ts: e.ts,
      time: formatTimestamp(e.ts),
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      role: eventRole(e),
      run: eventTick(e),
      result,
      model: tickStartModel(e, join ? joinModels : models),
      durationMs: tickSpanMs(e, starts),
      usage: usageText(e),
      detail: squash(textOr(e.summary, textOr(e.error, "")), DETAIL_MAX),
    });
  }
  return rows;
}

/** The last `limit` completed runs read from root's event log, filtered to `role` when
 * given (newest first) — the scan cmdHistory and the GUI's handleHistory share, so the two
 * surfaces cannot drift. A window twice the ask plus slack: run_start lines and unrelated
 * events interleave with the run_end rows scanned for, and a skipped run's end rides a start
 * that may sit outside any smaller window. Two shortfalls grow the window (and re-read) while
 * the scan filled it — `events.length >= window` means the log may hold older events — under
 * the same HISTORY_SCAN_MAX_EVENTS bound so one ask cannot scan without end:
 * - Rows fall short. A role filter dilutes the window (every other role's events occupy it
 *   too), so a quiet role in a busy team must still get its last `limit` runs whenever the
 *   retained log holds them — never a bare "no runs yet" for a role whose runs sit just
 *   past the first window.
 * - A row's run_start went unpaired. The window boundary can cut inside a run's own event
 *   block: every run_end of the ask sits within the window but the oldest one's run_start
 *   sits just before it, so the row renders a dash though the log holds the start. Every
 *   run_end the harness logs follows its run_start (run() logs the start before runOnce,
 *   skipped results included), so an unpaired start is either just past the window or lost
 *   to rotation — growing re-pairs the former, and the latter only costs the bounded scan.
 *   (A queued row's merge verdict needs no growth: the merge_done/merge_failed event sits
 *   after its run_end, so any tail window holding the row holds the verdict too — or there
 *   is none yet, the genuinely-pending case that keeps the raw label.) */
export function readRunRows(root: string, limit: number, role: RoleScope): RunRow[] {
  const key = `${root}\u0000${typeof role === "string" || role === null ? role ?? "" : role.join(",")}\u0000${limit}`;
  // A repeated ask's steady state starts where the last one ended, not back at the base window: the
  // GUI drawer's history panel re-issues this ask every second while events flow, and each poll's
  // ladder re-parsed every intermediate window (base → ×4 → …) before the one that satisfied
  // it — window sizes the previous poll had already proven too small. Rows are a pure function of
  // the window's events, and a larger tail window is a superset of a smaller one's, so starting
  // higher changes nothing the ask can see: a window that satisfied last poll still satisfies now
  // (events only accumulate), and if it no longer does — a rotation shrank the live log, or the
  // ask itself changed — the loop below keeps growing exactly as before. In-memory only; a stale
  // note costs one larger first read, never a wrong row.
  let window = runRowWindowMemo.get(key) ?? limit * 2 + 50;
  let events = readEvents(root, window);
  let rows = runRows(events, limit, role);
  while (
    (rows.length < limit || rows.some((r) => r.durationMs === null)) &&
    events.length >= window &&
    window < HISTORY_SCAN_MAX_EVENTS
  ) {
    window = Math.min(window * 4, HISTORY_SCAN_MAX_EVENTS);
    events = readEvents(root, window);
    rows = runRows(events, limit, role);
  }
  if (runRowWindowMemo.size >= RUN_ROW_WINDOW_MEMO_MAX) runRowWindowMemo.clear();
  runRowWindowMemo.set(key, window);
  return rows;
}

/** Per (root, role, limit): the window readRunRows' last ask ended on — the first window that
 * satisfied it, or the cap when the ladder ran out (the next poll then skips the ladder's
 * proven-too-small windows, the same steady-state note mainCheckForPoll's grewFull carries).
 * Bounded so many short-lived roots in tests cannot grow it unbounded. */
const runRowWindowMemo = new Map<string, number>();
const RUN_ROW_WINDOW_MEMO_MAX = 256;

/** The window-shaped sibling of readRunRows: the completed runs of the last `sinceMs`, not
 * the last N — the collector behind `history --since`. The window read itself (cutoff, the
 * rotation-spanning day-keyed read with its at-most-one-day over-read, the ts filter, and the
 * exact coverage predicate cmdLogs consults) is event-window.ts's readEventsSinceJoined — one
 * backwards scan serves both this view and the wider join read, with the narrow view's events
 * and coverage derived from the wide scan, so neither windowed surface can claim coverage the
 * other would hedge or key its read differently. The rows read the cutoff-filtered events, but
 * their queued-row join reads WIDER evidence (RUN_ROW_JOIN_BACKSLACK_MS): a queued run whose
 * run spans the cutoff logged its merge_queued pin before the cutoff, and without the wider
 * read the row would either keep "Queued to land" after its change merged or misclaim an older
 * run's pin (BUGS.md 2026-09-30). The rows reuse the pure runRows with limit =
 * events.length, so pairing, role filtering, and the dash-on-unpaired rule stay exactly the
 * count view's. Pure over root: reads the event log, writes nothing. */
export function readRunRowsSince(root: string, sinceMs: number, role: RoleScope): { rows: RunRow[]; covered: boolean } {
  // One backwards scan serves both the rows' window and the wider join read (see
  // readEventsSinceJoined): two readEventsSince calls re-scanned and re-parsed the same
  // log bytes — a whole duplicate window scan per `history --since`.
  const { events, join, covered } = readEventsSinceJoined(root, sinceMs, RUN_ROW_JOIN_BACKSLACK_MS);
  return {
    rows: runRows(events, events.length, role, { events: join.events, floorTs: join.cutoff }),
    covered,
  };
}

/** @deprecated Use summarizeRunRows. */
export const summarizeTickRows = summarizeRunRows;
/** @deprecated Use summarizeRunRowsByModel. */
export const summarizeTickRowsByModel = summarizeRunRowsByModel;
/** @deprecated Use RunRow. */
export type TickRow = RunRow;
/** @deprecated Use readRunRows. */
export const readTickRows = readRunRows;
/** @deprecated Use readRunRowsSince. */
export const readTickRowsSince = readRunRowsSince;
