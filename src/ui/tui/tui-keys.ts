import { collectReport, collectReportSince } from "../../report/report-data.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "../../report/report-render.js";
import { REPORT_DEFAULT_DAYS, REPORT_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../../events/event-window.js";
import { collectFailureReport, collectFailureReportSince } from "../../failure/failure-data.js";
import { renderFailureMarkdown } from "../../failure/failure-render.js";
import {
  HISTORY_DEFAULT_TICKS,
  HISTORY_RESULT_CLASSES,
  historyClass,
  readTickRows,
  readTickRowsSince,
  tickRowsMatchingGrep,
  type HistoryResultClass,
} from "../../history/history-data.js";
import { historyPaneText } from "./tui-history.js";
import { readTickDetail, type TickDetail } from "../../tick/tick-detail-data.js";
import { renderTickDetail, tickDetailStat } from "../../tick/tick-detail.js";
import { collectFleetChanges, collectRoleChange, type FleetChangeView, type RoleChangeView } from "../../change/change-data.js";
import { renderFleetChange, renderRoleChange } from "../../change/change-render.js";
import { readBrief, renderBrief } from "../../brief/brief.js";
import { runDoctor } from "../../doctor/doctor.js";
import { renderDoctor } from "../../doctor/doctor-render.js";
import type { DoctorReport } from "../../doctor/doctor-checks.js";
import { readLandingQueue } from "../../landing/landing-queue.js";
import { renderLandingQueue } from "../../landing/landing-queue-render.js";
import { orchestratorAlive } from "../../fleet/orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { listWideScope, queuedListRows, renderQueuedList, type QueuedListRow } from "../../inbox/inbox.js";
import { commitOperatorBacklogEdit } from "../../backlog/backlog-commit.js";
import { stampedSubject } from "../../git/commit-message.js";
import { tryCancelEntry } from "../../backlog/backlog-write.js";
import { cancelRolePrompt } from "../../inbox/inbox-cancel.js";
import { requestAbort } from "../../operator/operator-intent.js";
import { saveRoleNote } from "../../agent/role-notes-write.js";
import { roleNotesPath } from "../../paths.js";
import { errorMessage } from "../../text/text.js";
import { DIRECTOR_ROLE } from "../../roles/roles.js";
import { baseRoleOf } from "../../roles/loop-ids.js";
import {
  labeledBacklogEntries,
  moveEntrySelection,
  stepEntryScroll,
} from "./tui-backlog.js";
import { activityEvents, roleInspectMarkdown } from "./tui-pane.js";
import { arrowDir, pageDir } from "./tui-keymap.js";
import { createTuiEditors, type TuiEditorCtx } from "./tui-editors.js";

/** How long a TUI flash notice stays visible (ms). */
const FLASH_MS = 3000;

/** Every Ctrl+<key> cycle walks its own ReadonlyArray<[key, label]> table one slot at a time,
 * wrapping past the last back to the first. Each handler holds a key the table carries (a null
 * default slot included), so findIndex always hits. The null fallback in cycleLabel keeps a
 * would-be stale key from rendering "undefined". */
function nextInCycle<T>(table: ReadonlyArray<[T, string]>, current: T): T {
  const i = table.findIndex(([key]) => key === current);
  return table[(i + 1) % table.length]![0];
}

function cycleLabel<T>(table: ReadonlyArray<[T, string]>, current: T): string | null {
  return table.find(([key]) => key === current)?.[1] ?? null;
}

/** The trailing 1h/6h/1d/7d slots the History (Ctrl+S) and Usage/Failures (Ctrl+E) session
 * window cycles share, minus each pane's leading `[null, "default"]` slot. Single-homed so
 * the two panes cannot drift — and the 7d slot reads the named REPORT_SINCE_MAX_MS cap (`tumwater
 * report --since`'s bound) rather than History's old hard-coded 604_800_000 magic number, which
 * was the same value but untethered from the cap it mirrors. */
const SESSION_WINDOW_TAIL: ReadonlyArray<[number, string]> = [
  [3_600_000, "1h"],
  [21_600_000, "6h"],
  [86_400_000, "1d"],
  [REPORT_SINCE_MAX_MS, "7d"],
];

/** The History pane's session window cycle, Ctrl+S: the default newest-N read, then the same
 * trailing windows the dashboard's History view and `tumwater history --since` offer — 1h,
 * 6h, 1d, and the 7d cap the CLI's flag and the dashboard both stop at. The label is what the
 * hint line names; the length is what readTickRowsSince takes. `null` is the default read
 * through readTickRows, kept first so the pane opens on today's behavior. */
const HISTORY_WINDOWS: ReadonlyArray<[number | null, string]> = [
  [null, "default"],
  ...SESSION_WINDOW_TAIL,
];

/** The Ctrl+G scope cycle: fleet-wide (null), then each unique base role the roster names, in
 * roster order. An instance id (`feature-2`) folds into its base role because the scoped
 * collectors aggregate by base role — report-data.ts's role scope groups an instance's usage
 * with its siblings' — so cycling through the instance ids would relabel the same body with
 * names that collect it identically. `feature`/`feature-2` therefore offer one slot, and the
 * name the tab strip and hint show is the name the collector honors. */
function scopeCycle(roleIds: readonly string[]): Array<string | null> {
  const bases: string[] = [];
  for (const id of roleIds) {
    const base = baseRoleOf(id);
    if (!bases.includes(base)) bases.push(base);
  }
  return [null, ...bases];
}

/** The History pane's session outcome cycle, Ctrl+O: all ticks, then the canonical classes
 * `tumwater history --result` and the dashboard's History filter speak. The class list comes
 * from history-data.ts (HISTORY_RESULT_CLASSES) rather than a copy, so the TUI, the CLI, and
 * the dashboard bucket a result the same way; the class id doubles as the label. `null` is no
 * filter, kept first so the pane opens on today's behavior. */
const HISTORY_RESULTS: ReadonlyArray<[HistoryResultClass | null, string]> = [
  [null, "all"],
  ...HISTORY_RESULT_CLASSES.map((c): [HistoryResultClass, string] => [c, c]),
];

/** The History pane's body for one trailing window, one outcome class, one exact-loop scope,
 * and one free-text search: the paneCache the Ctrl+T/Ctrl+S/Ctrl+O/Ctrl+G/`/` handlers store.
 * The default (null/null/null/null) read is byte-for-byte the newest-N pane that predates the
 * window, outcome, loop, and search cycles — readTickRows with HISTORY_DEFAULT_TICKS,
 * unfiltered. A trailing window reads through the same readTickRowsSince collector `tumwater
 * history --since` uses, a class filters through history-data.ts's canonical historyClass rule,
 * and the search filters through tickRowGrepHaystack — the same haystack and case-insensitive
 * substring rule `tumwater history --grep` and the dashboard's History search use — so the TUI,
 * the CLI, and the dashboard cannot disagree about the rows. The role is the exact loop id the
 * raw roster (and `history --role`, and the dashboard picker) names — readTickRows filters
 * `e.loop === role`, so an instance id is its own scope, never folded into a base role. An empty
 * read with no class and no search returns "" so the pane keeps its own no-ticks note instead of
 * a lone header; when a class or a search is active and the read returned rows, an empty
 * filtered body names whichever filter the CLI's precedence blames, so the pane states the
 * filter instead of claiming the log is empty. Otherwise the body is prefixed with the active
 * role/window/result/search labels and, when the read cannot prove full coverage, the same
 * sparse-window note every windowed render prints (SPARSE_WINDOW_NOTE). */
function historyPaneCache(
  root: string,
  sinceMs: number | null,
  resultClass: HistoryResultClass | null,
  role: string | null,
  grep: string | null,
): string {
  const { rows, covered } = sinceMs === null
    ? { rows: readTickRows(root, HISTORY_DEFAULT_TICKS, role), covered: true }
    : readTickRowsSince(root, sinceMs, role);
  // The search runs first, exactly as `tumwater history` orders --grep ahead of --result, and
  // its admitted count is saved so the empty-body wording blames the filter that actually
  // emptied the set (`afterGrep > 0` means rows matched the pattern and the class then removed
  // them). The search applies history-data.ts's shared tick-grep rule (tickRowsMatchingGrep),
  // the same one the CLI and the dashboard search use, so the three surfaces cannot disagree.
  const grepped = grep === null ? rows : tickRowsMatchingGrep(rows, grep);
  const afterGrep = grepped.length;
  const filtered = resultClass === null ? grepped : grepped.filter((r) => historyClass(r.result) === resultClass);
  const body = historyPaneText(filtered);
  // null when no class is active, so the header/empty-body paths below only name a result
  // filter the session actually holds (cycleLabel(HISTORY_RESULTS, null) is the "all" label).
  const resultLabel = resultClass === null ? null : cycleLabel(HISTORY_RESULTS, resultClass);
  // The role first, then the window/result/search labels: the loop is the coarsest cut, and a
  // role-only read (no window, no class) still prints its scope line above the rows.
  const header = [
    ...(role === null ? [] : ["role: " + role]),
    ...(sinceMs === null ? [] : ["window: last " + (cycleLabel(HISTORY_WINDOWS, sinceMs) ?? "default")]),
    ...(resultLabel === null ? [] : ["result: " + resultLabel]),
    ...(grep === null ? [] : ["search: " + grep]),
  ].join("\n");
  if (!body) {
    // The class names itself only when it emptied a set grep admitted (`afterGrep > 0`) — the
    // CLI's condition and the dashboard's `hasRows` draw the same line — so an empty log or
    // window keeps the pane's own no-ticks note instead of blaming a filter that removed
    // nothing. A pattern that admitted nothing names itself next, with the CLI's wording. An
    // empty read with neither filter returns "" so the pane keeps its own note, and a role-only
    // empty read returns "" too (the CLI's empty-state wording does not name --role), so the
    // pane never grows a lone `role:` header.
    if (resultClass !== null && afterGrep > 0) {
      return header + "\nno ticks with result \"" + resultLabel + "\"";
    }
    if (grep !== null) return header + "\nno ticks matching \"" + grep + "\"";
    return "";
  }
  return (header ? header + "\n" : "") + body + (sinceMs !== null && !covered ? "\n" + SPARSE_WINDOW_NOTE : "");
}

/** The Usage and Failures panes' session window cycle, Ctrl+E: the default whole-day report,
 * then 1h, 6h, 1d, and the REPORT_SINCE_MAX_MS 7d cap — the trailing windows
 * `tumwater report --since` / `tumwater report --failures --since` collect. (The dashboard's
 * report tabs stop at 1d.) The label is what the hint line names; the
 * length is what collectReportSince / collectFailureReportSince take. `null` is the default
 * REPORT_DEFAULT_DAYS shape, kept first so the panes open on today's behavior. */
const REPORT_WINDOWS: ReadonlyArray<[number | null, string]> = [
  [null, "default"],
  ...SESSION_WINDOW_TAIL,
];

/** The Usage pane's body for one window and role scope: the paneCache the Ctrl+T/Ctrl+G/Ctrl+E
 * handlers store. The default (null) read is byte-for-byte the day report the pane showed
 * before the window cycle — collectReport at REPORT_DEFAULT_DAYS; a trailing window reads
 * through the same collectReportSince collector `tumwater report --since` uses, so the TUI,
 * CLI, and dashboard cannot disagree. Both honor the Ctrl+G role scope, so the two session
 * cycles compose. */
function usagePaneCache(root: string, sinceMs: number | null, scope?: string): string {
  if (sinceMs === null) return renderReportMarkdown(collectReport(root, REPORT_DEFAULT_DAYS, scope));
  return renderSinceReportMarkdown(collectReportSince(root, sinceMs, scope));
}

/** The Failures pane's body for one window and role scope, the digest sibling of
 * usagePaneCache; renderFailureMarkdown renders both the day and --since shapes. */
function failuresPaneCache(root: string, sinceMs: number | null, scope?: string): string {
  if (sinceMs === null) return renderFailureMarkdown(collectFailureReport(root, REPORT_DEFAULT_DAYS, scope));
  return renderFailureMarkdown(collectFailureReportSince(root, sinceMs, scope));
}

/** The seams `createTuiKeys` cannot own itself (the factory's doc names each). */
interface TuiKeysDeps {
  root: string;
  /** Ctrl+D: the caller resolves its main loop (and tears down the terminal) here. */
  quit(): void;
  /** Every branch that used to call render() after a state change calls this instead. */
  requestRender(): void;
  /** Injectable clock for the flash expiry; production uses Date.now. */
  now?(): number;
  /** The Pending pane's async collector; production uses change-data's collectFleetChanges.
   * Injectable so tests can resolve a fixed roster without git plumbing. */
  collectPending?(root: string): Promise<FleetChangeView>;
  /** Seam for the Health tab's checks; defaults to `runDoctor` so tests need not probe
   * binaries or git. */
  runDoctor?(root: string): Promise<DoctorReport>;
  /** The transcript Change mode's async collector; production uses change-data's
   * collectRoleChange. Injectable so tests can resolve a fixed view without git plumbing. */
  collectChange?(root: string, role: string): Promise<RoleChangeView>;
  /** The History trail's per-file stat footer; defaults to tick-detail's tickDetailStat so
   * tests need not shell out to git. */
  tickStat?(root: string, detail: TickDetail): Promise<string>;
}

/** The state render reads back each frame: the prompt line, the modes it names in the hint
 * line, the view/selection/scroll state, the line budgets, and the flash notice — null when
 * expired, so the per-second repaint drops the notice on the same clock it was armed. */
interface TuiKeysState {
  input: string;
  cursor: number;
  budgetMode: boolean;
  rolePromptFor: string | null;
  /** Whether the prompt line is editing the next prompt's defer delay (Ctrl+L). */
  deferMode: boolean;
  /** Whether the prompt line is editing the fleet pause's duration and reason (Ctrl+F). */
  pauseEditMode: boolean;
  /** The loop the pause editor pauses, null for the fleet editor (Ctrl+F). */
  pauseEditRole: string | null;
  /** the per-loop editor schedules a wake (Ctrl+W) rather than a pause (Ctrl+P) */
  pauseEditWake: boolean;
  /** the fleet editor schedules a stop (Ctrl+Q) rather than a pause (Ctrl+F) */
  pauseEditStop: boolean;
  /** The pending defer delay as a human label (durationLabel), or null when the next prompt
   * delivers immediately; named in the prompt prefix and the Ctrl+L hint. */
  defer: string | null;
  view: number;
  /** The session-scoped role the Usage and Failures panes collect for (Ctrl+G), null for the
   * fleet; cleared when the incoming roster no longer names it. */
  scopeRole: string | null;
  /** The History pane's exact-loop scope (Ctrl+G), a raw roster id or null for the fleet's
   * full read; cleared when the incoming roster no longer names it. Separate from scopeRole:
   * History filters by exact loop (`history --role`), where `feature-2` is its own slot. */
  historyRole: string | null;
  selectedEntry: number | null;
  /** The armed backlog cancel (first Ctrl+X on a selected plan or bug): the entry a second
   * Ctrl+X would cancel, null once any other key lands. */
  cancelArmed: { kind: "plan" | "bug"; position: number; title: string } | null;
  entryScroll: number;
  /** The Queued pane's row selection (null = list mode): the index into queuedRows of the
   * prompt shown in full, cleared on every Ctrl+T cycle like selectedEntry. */
  selectedQueued: number | null;
  /** The Queued pane's in-place editor (Ctrl+E): the role and queue-file basename of the
   * entry the prompt line is editing, or null when no edit is open. The file address (not a
   * position) is what the write targets, so a concurrent dequeue cannot make a stale
   * selection rewrite the wrong prompt. */
  queuedEditFor: { role: string; file: string } | null;
  /** The backlog pane's answer editor (Ctrl+A on a selected open question): the question's
   * 1-based position among the open questions and the title the operator saw, or null when no
   * answer is open. The title rides into tryAnswerQuestion so a question that moved under the
   * editor is refused rather than answered wrongly. */
  answerFor: { position: number; title: string } | null;
  /** The backlog pane's title editor (Ctrl+E on a selected plan or bug): the entry's kind, its
   * 1-based position within its section, and the heading title the operator saw, or null when
   * no edit is open. A null position is the new-entry form (Ctrl+N, title ""): Enter files a new
   * entry of that kind instead of retitling one. The title rides into tryEditEntry so an
   * entry that moved under the editor is refused rather than rewritten. */
  entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null;
  /** The Queued pane's cached rows — the same list renderQueuedList printed — so a selection
   * addresses a row's role/position without re-reading the queue each frame. */
  queuedRows: QueuedListRow[];
  paneCache: string | null;
  /** Whether the viewed loop's pane shows its notebook (Ctrl+N) instead of the transcript —
   * true only on a transcript view. */
  noteMode: boolean;
  /** The notebook view's rendered Markdown, computed once on Ctrl+N entry and windowed by
   * paneBody; null when the live transcript is shown. */
  noteCache: string | null;
  /** Whether the History pane shows one completed tick's full event trail (Ctrl+N) instead
   * of the row list — true only on the History view while its pane holds a trail. */
  trailMode: boolean;
  /** The trail view's rendered TickDetail text (renderTickDetail), computed once on Ctrl+N
   * entry and windowed by paneBody; null while the rows are shown or when the newest
   * completed tick could not be read. */
  trailCache: string | null;
  /** Whether the viewed loop's pane shows the collected unlanded change (the second Ctrl+N
   * step) instead of the transcript — true only on a transcript view. */
  changeMode: boolean;
  /** The change view's rendered text (renderRoleChange), null until its async collector
   * resolves; windowed by paneBody. */
  changeCache: string | null;
  paneScroll: number;
  /** The Activity pane's body-window start into the loaded event tail, or null to follow the
   * live tail. Paged by PgUp/PgDn and reset to null on every Ctrl+T view cycle. */
  activityScroll: number | null;
  /** The Activity pane's session exact-loop scope (Ctrl+G), a raw roster id or null for the
   * fleet's full tail; cleared when the incoming roster no longer names it. Separate from
   * scopeRole for the same reason historyRole is: the feed filters by exact loop (`eventRole`),
   * where `feature-2` is its own slot. */
  activityRole: string | null;
  /** The Activity pane's active free-text search (the `/` editor), or null when none; matched
   * through eventMatchesGrep, the same rule `tumwater logs --grep` and the dashboard search use. */
  activityGrep: string | null;
  /** The History pane's active trailing window label (Ctrl+S), or null for the default
   * newest-N read; named in the hint line. */
  historySince: string | null;
  /** The Usage and Failures panes' active trailing window label (Ctrl+E), or null for the
   * default day report; named in the hint line. */
  reportSince: string | null;
  /** The History pane's active outcome class label (Ctrl+O), "all" when unfiltered; named in
   * the hint line. */
  historyResult: string | null;
  /** The History pane's active free-text search (the `/` editor), or null when none; named in
   * the pane's own `search:` header and in the hint line. */
  historyGrep: string | null;
  eventBudget: number;
  entryBudget: number;
  roleIds: string[];
  /** Whether the director loop currently has a tick in flight (render's feed, Ctrl+C's gate). */
  directorInFlight: boolean;
  /** The live flash notice, or null when none is armed or the clock passed its expiry. */
  flash: string | null;
}

/** The keypress handler's contract as createTuiKeys returns it: the dispatch the caller feeds
 * (handleKey), the per-frame setters it syncs through (syncSnapshot, setLineBudgets), and the
 * state it composes the frame from (state). */
export interface TuiKeys {
  /** The full keypress dispatch — ink's `useInput` (through the tui-keymap.ts adapter)
   * calls into this with the same (str, key) shape the readline "keypress" event delivered. */
  handleKey(str: string | undefined, key: { ctrl?: boolean; name?: string }): void;
  /** Render feeds the snapshot's cap/free flag/roles in each frame (the locals the handler
   * reads without re-reading config itself), plus the director loop's in-flight flag —
   * Ctrl+C's interrupt gate; the view clamps against a changed role count. */
  syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorInFlight?: boolean): void;
  /** Render feeds the activity pane's line budgets in each frame. */
  setLineBudgets(eventBudget: number, entryBudget: number): void;
  /** The state render composes the frame from. */
  state(): TuiKeysState;
}

/** The framework-free owner of the TUI's keypress handling (extracted from runTui, and fed
 * by ink's `useInput` through tui-keymap.ts's inkKeyToReadline adapter): the factory owns
 * every mutable local the keypress dispatch used to keep in runTui's closure — the prompt line
 * and its modal editors (owned by the tui-editors.ts sub-factory it constructs), the view and
 * pane-navigation state, the flash notice, and the line budgets render feeds back. It takes
 * only the seams it cannot own itself: the repo root the disk actions run against, the quit
 * callback (Ctrl+D), a render request callback (every branch that painted a frame), and an
 * injectable clock so the flash expiry is testable without waiting the real 3 s. Rendering
 * (src/ui/tui/tui.tsx) stays the caller: it syncs snapshot data and line budgets in, and reads
 * the resulting state out to compose the frame — the same data flow, one module boundary added.
 * The prompt-line editor half of this closure lives in tui-editors.ts; this file keeps the
 * outer dispatch and the pane-navigation state. */
export function createTuiKeys(deps: TuiKeysDeps): TuiKeys {
  const now = deps.now ?? Date.now;
  const { root } = deps;
  const collectPending = deps.collectPending ?? collectFleetChanges;
  const runDoctorSeam = deps.runDoctor ?? ((r: string) => runDoctor(r, undefined, undefined, "never"));
  const collectChange = deps.collectChange ?? collectRoleChange;
  const tickStat = deps.tickStat ?? tickDetailStat;
  // The project-status pane's flat entry list (plans, then bugs, then questions), read fresh —
  // tui-backlog.ts's one definition, shared with the render so stale-selection clamping cannot
  // drift.
  const flat = () => labeledBacklogEntries(root);

  let flash = "";
  let flashUntil = 0;
  // Flash a one-line notice on the prompt line: the single owner of the message+expiry
  // pair, so every notice expires on the same clock and no keypress branch grows its
  // own copy of the two assignments.
  const flashMessage = (message: string): void => {
    flash = message;
    flashUntil = now() + FLASH_MS;
  };
  // Flash a caught failure: the one home for the `error: <message>` prefix the TUI's catch
  // arms show, so their wording and formatting stay identical instead of drifting.
  const flashError = (err: unknown): void => {
    flashMessage(`error: ${errorMessage(err)}`);
  };
  // Commit an operator's backlog edit to main and flash when the commit did not land: the
  // one home for the "written but NOT committed" warning every edit, file, cancel, and
  // answer arm shares.
  const commitBacklogEdit = (file: string, subject: string): void => {
    void commitOperatorBacklogEdit(root, file, stampedSubject("operator", subject)).then((committed) => {
      if (!committed) flashMessage(`${file} written but NOT committed to main — commit it before the next fast-forward`);
    });
  };
  // The prompt-line editors are constructed below with the pane-side leaves they call on
  // commit/exit (refreshQueued, the search/applied writes, the selection clear), so they come
  // after the pane state and its paneCache/sync helpers are declared.

  // The activity pane cycles: 0 = recent events, then one transcript per loop, then project
  // status (planned features + open bugs + open questions), then the usage report, the failure
  // digest, the completed-tick history, the pending-change roster, and the queued prompts —
  // Ctrl+T.
  let view = 0;
  // The session-scoped role the Usage and Failures panes collect for, cycled by Ctrl+G, null
  // for the fleet. Session-only, like the view/selection/scroll state: a fresh TUI starts
  // fleet-wide, and syncSnapshot clears it when the roster drops the role.
  let scopeRole: string | null = null;
  // The project-status pane's entry selection (null = list mode): the flat index of the
  // entry shown in full — plans first, then bugs, then questions. Cleared on every Ctrl+T,
  // so cycling back into the view always starts at today's heading list.
  let selectedEntry: number | null = null;
  /** The role whose notebook a second Ctrl+X would clear, null once any other key lands. */
  let notesClearArmed: string | null = null;
  let cancelArmed: { kind: "plan" | "bug"; position: number; title: string } | null = null;
  // The Queued pane's row selection (null = list mode): the index into queuedRows of the
  // prompt shown in full. Cleared on every Ctrl+T, like selectedEntry, so cycling back into
  // the pane starts at today's list.
  let selectedQueued: number | null = null;
  // The Queued pane's cached rows, the same queuedListRows traversal the cached
  // renderQueuedList string was built from, so a selection addresses a row's role/position
  // without re-reading the queue on every frame.
  let queuedRows: QueuedListRow[] = [];
  // The within-body scroll offset (line index of the window head, 0 = head) for the selected
  // entry's body — PgDn/PgUp in project-status entry mode. Reset whenever the selection
  // changes or clears, so every newly opened entry starts at its head.
  let entryScroll = 0;
  // The Markdown/row panes' (usage report, failures, history) rendered bodies, computed once
  // per activation: the Ctrl+T handler sets it when cycling into one and nulls it on leaving.
  // collectReport/collectFailureReport tail-scan events.jsonl and readTickRows reads the log,
  // so they must not run on every second's re-render — those only re-window this string.
  let paneCache: string | null = null;
  // Ctrl+N toggles the viewed loop's pane between its live transcript and a read-only
  // notebook view (its note and next tick's prompt). Like paneCache, noteCache is computed
  // once on entry and only re-windowed each frame; both reset when the mode changes or the
  // view cycles.
  let noteMode = false;
  let noteCache: string | null = null;
  // Ctrl+N on the History pane swaps the row list for the newest completed tick's full event
  // trail (renderTickDetail over readTickDetail) — the same text `tumwater tick --last` and
  // the dashboard's History drill-down serve. Session-only like the other pane snapshots:
  // computed once on entry and only re-windowed each frame.
  let trailMode = false;
  let trailCache: string | null = null;
  let trailGen = 0; // bumped at every trail read or reset; a stat resolution applies only to its own gen
  // Ctrl+N's third step: the viewed loop's collected unlanded change (the CLI's
  // `renderRoleChange` text). changeCache is null until the async collector resolves, and the
  // pane paints a loading note meanwhile; both reset on leaving the mode or cycling the view.
  let changeMode = false;
  let changeCache: string | null = null;
  // The within-body scroll offset (line index of the window head) shared by the two Markdown
  // panes and the notebook view — PgDn/PgUp there. Reset to the head whenever the view is
  // entered, like entryScroll.
  let paneScroll = 0;
  // The Activity pane's body-window start into the loaded event tail, or null to follow the
  // live tail (the newest eventBudget events). PgUp pauses follow and pages back; PgDn returns
  // toward the tail and re-enables follow at the bottom. Reset on every Ctrl+T view cycle, so
  // re-entering Activity always starts at the live tail.
  let activityScroll: number | null = null;
  // The Activity pane's session exact-loop scope (Ctrl+G), a raw roster id or null for the
  // fleet's full tail. Session-only like the view/scroll state; syncSnapshot clears it when the
  // roster drops the id. The raw ids, not scopeCycle's base roles: the feed filters by exact
  // loop (eventRole), so `feature-2` is its own slot.
  let activityRole: string | null = null;
  // The Activity pane's session free-text search (the `/` prompt-line editor), a
  // case-insensitive substring over eventMatchesGrep's type-prefixed rendered line — the same
  // rule `tumwater logs --grep` and the dashboard search use. null is no search; session-only
  // like the scope, so the next read computes with it.
  let activityGrep: string | null = null;
  // The History pane's session trailing window (Ctrl+S), a HISTORY_WINDOWS length or null for
  // the default newest-N read. Session-only like the view/scroll state; the next Ctrl+T into
  // History computes the cache with it.
  let historyWindow: number | null = null;
  // The Usage and Failures panes' session trailing window (Ctrl+E), a REPORT_WINDOWS length or
  // null for the default day report. Session-only like the view/scroll state; the next Ctrl+T
  // into either pane computes the cache with it.
  let reportWindow: number | null = null;
  // The History pane's session outcome filter (Ctrl+O), a HISTORY_RESULTS class or null for no
  // filter. Session-only like the window; the next Ctrl+T into History computes with it.
  let historyResult: HistoryResultClass | null = null;
  // The History pane's session exact-loop scope (Ctrl+G), a raw roster id or null for the
  // fleet's full read. Session-only like the window/result; syncSnapshot clears it when the
  // roster drops the id. The raw ids, not scopeCycle's base roles: History filters by exact
  // loop (`history --role`), where `feature-2` is its own slot.
  let historyRole: string | null = null;
  // The History pane's session free-text search (the `/` prompt-line editor), a
  // case-insensitive substring over history-data.ts's tickRowGrepHaystack — the same rule
  // `tumwater history --grep` and the dashboard search use. null is no search; session-only
  // like the window/result/role, so the next Ctrl+T into History computes the cache with it.
  let historyGrep: string | null = null;
  // The activity pane's current line budget, refreshed by every render so keypress handlers
  // can page within it without re-deriving the height math. An open backlog entry spends the
  // pane's first line on its title, so its body pages by one line less (entryBudget).
  let eventBudget = 0;
  let entryBudget = 0;
  let roleIds: string[] = [];
  // Whether the director's status row is in flight, fed by render each frame: the gate for
  // Ctrl+C's interrupt — with no director tick running, Ctrl+C flashes a notice instead of
  // writing an abort marker nothing would consume.
  let directorInFlight = false;

  /** Recompute the active pane's cached Markdown after `changed` state moved, re-entering the
   * body at its head, and return whether the current view holds such a pane. "report" covers
   * the Usage/Failures panes (fed by the report window and base-role scope); "history" the
   * History pane (its window, outcome filter, exact-loop scope, and free-text search); "all"
   * either. A view that is not the named pane is left untouched, so advancing one window
   * redraws only the pane it feeds. The one home of the view-index→collector mapping the pane
   * key handlers and syncSnapshot share. */
  const refreshPaneCache = (changed: "report" | "history" | "all"): boolean => {
    const isReport = view === roleIds.length + 2 || view === roleIds.length + 3;
    const isHistory = view === roleIds.length + 4;
    if ((changed === "report" || changed === "all") && isReport) {
      paneCache = view === roleIds.length + 2
        ? usagePaneCache(root, reportWindow, scopeRole ?? undefined)
        : failuresPaneCache(root, reportWindow, scopeRole ?? undefined);
    } else if ((changed === "history" || changed === "all") && isHistory) {
      paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole, historyGrep);
    } else {
      return false;
    }
    paneScroll = 0;
    return true;
  };

  // Re-read the pane-scoped newest completed tick into trailCache for an on-screen trail
  // (Ctrl+N), so the trail cannot keep showing a retired loop's tick after Ctrl+G or a roster
  // change drops the History scope. The reader throw is caught and flashed rather than escaping
  // a key or sync path, the same guard the initial Ctrl+N entry uses.
  // Append the tick commit's per-file stat to the trail text once it resolves — the join
  // `tumwater tick --stat` uses. Applies only while the trail is still on and no read or reset
  // bumped trailGen since the request, so an older tick's stat never overwrites a newer view.
  const loadTrailStat = (detail: TickDetail): void => {
    const gen = trailGen;
    const text = renderTickDetail(detail);
    void tickStat(root, detail).then(
      (stat) => {
        if (!trailMode || gen !== trailGen) return;
        trailCache = `${text}\n\n${stat}`;
        deps.requestRender();
      },
      (err: unknown) => {
        if (!trailMode || gen !== trailGen) return;
        flashError(err);
        deps.requestRender();
      },
    );
  };

  const refreshTrail = (): void => {
    trailGen++;
    try {
      const row = readTickRows(root, 1, historyRole)[0];
      const detail = row === undefined ? null : readTickDetail(root, row.loop, row.tick);
      trailCache = detail === null ? null : renderTickDetail(detail);
      if (detail !== null) loadTrailStat(detail);
    } catch (err) {
      trailCache = null;
      flashError(err);
    }
  };

  // Re-read the Queued pane's rows and cached list after the queue changed (entry or cancel)
  // and clamp the row selection to the shortened queue — a selection past the new end lands
  // on the last remaining prompt, never on a stale role/position. An emptied queue clears it
  // back to list mode. The refreshed list and any clamped-in row share paneScroll, so the
  // offset resets too: a cancel that moves the selection opens the newly selected prompt at
  // its head. The one home of the queuedRows/paneCache pairing the Ctrl+T entry and the Ctrl+X
  // cancel share, so the pane's list and its selectable rows cannot drift.
  const refreshQueued = (): void => {
    queuedRows = queuedListRows(root, null, listWideScope(root));
    paneCache = renderQueuedList(queuedRows, now());
    selectedQueued = selectedQueued === null || queuedRows.length === 0
      ? null
      : Math.min(selectedQueued, queuedRows.length - 1);
    paneScroll = 0;
  };

  // Clear the project-status pane's selection and its body scroll after a recorded answer or
  // edited entry leaves the list — the pane-side half of an answer/title-edit commit.
  const clearBacklogSelection = (): void => {
    selectedEntry = null;
    entryScroll = 0;
  };
  // Apply a finished History search on the pane: set the grep, recompute the cached rows now
  // (the pane is showing), and re-enter at the body's head — the leaf the search editor's
  // Enter calls through its applyHistorySearch dep.
  const applyHistorySearch = (pattern: string | null): void => {
    historyGrep = pattern;
    paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole, historyGrep);
    paneScroll = 0;
  };
  // Apply a finished Activity search on the pane: set the grep and reset the scroll to the
  // live tail (the offset indexed the old filtered list) — the leaf the search editor's Enter
  // calls through its applyActivitySearch dep.
  const applyActivitySearch = (pattern: string | null): void => {
    activityGrep = pattern;
    activityScroll = null;
  };
  // The prompt-line editors, constructed with the pane-side leaves they call on commit/exit:
  // the disk writes, the flash pair, the selections/caches they return to, and the clock.
  const editors = createTuiEditors({
    root,
    now,
    flat,
    refreshQueued,
    clearBacklogSelection,
    applyHistorySearch,
    applyActivitySearch,
    flashMessage,
    flashError,
    commitBacklogEdit,
  });

  const handleKey = (str: string | undefined, key: { ctrl?: boolean; name?: string }): void => {
    // Every key starts disarmed; only the backlog Ctrl+X branch reads `armed` and only the
    // notebook Ctrl+X branch reads `armedNotes`.
    const armed = cancelArmed;
    cancelArmed = null;
    const armedNotes = notesClearArmed;
    notesClearArmed = null;
    if (key.ctrl && key.name === "d") {
      deps.quit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      // Ctrl+C interrupts the director's in-flight tick (shell-EOF behavior moved to
      // Ctrl+D): when the director row is in flight, write the same abort marker the
      // CLI's `abort --role director` does, through the shared requestAbort core so the
      // marker format and wording cannot drift; when none is, flash a notice and leave
      // the fleet untouched. A failed marker write flashes the reason instead of
      // escaping the handler — the same contract the per-loop controls above honor.
      if (!directorInFlight) {
        flashMessage("no director task in flight");
        deps.requestRender();
        return;
      }
      try {
        const result = requestAbort(root, DIRECTOR_ROLE);
        flashMessage(result.ok ? result.message : `error: ${result.error}`);
      } catch (err) {
        flashError(err);
      }
      deps.requestRender();
      return;
    }
    // The prompt-line editors own every arm that reads or writes the one prompt line — the
    // toggles and per-loop controls that open them, the escape/Enter arms that close and
    // commit them, and the `/` search. Route the key to them first; when they consumed it,
    // the dispatch is done (they always render on a handled key).
    const ctx: TuiEditorCtx = {
      view,
      roleIds,
      selectedEntry,
      selectedQueued,
      queuedRows,
      historyGrep,
      activityGrep,
    };
    if (editors.handleKey(str, key, ctx)) {
      deps.requestRender();
      return;
    }
    // The editor flags below (budget/role/defer/pause/queued/answer/entry/search) are all
    // false here — the editors consume every key that reads or writes the line, and they
    // return true whenever one is open — but the guards restate them so each pane arm keeps
    // its mutual-exclusion contract explicit rather than relying on the routing order.
    const es = editors.state();
    // Whether no editor currently holds the prompt line — the mutual-exclusion contract the
    // pane arms below restate when they open their own one-line editors. The editors consume
    // every key that reads or writes the line and return true while one is open, so by the
    // time this fallback runs the flags are already all false; the check stays explicit so
    // each arm's exclusion reads on its own instead of leaning on the routing order. Line 790
    // deliberately omits searchMode and keeps its own literal guard.
    const promptLineFree = (): boolean =>
      !es.budgetMode && !es.rolePromptFor && !es.searchMode && !es.deferMode &&
      !es.pauseEditMode && !es.queuedEditFor && !es.answerFor && !es.entryEditFor;
    if (key.ctrl && key.name === "n") {
      // Ctrl+N cycles the viewed loop's pane live transcript → notebook → change → transcript
      // (PLANS.md "Inspect a loop's notebook and next tick prompt in the TUI" and "Show a
      // loop's pending change in the TUI transcript pane"). The change step renders the same
      // collectRoleChange/renderRoleChange view the CLI's `tumwater diff --role <id>` and the
      // dashboard drawer use. Guarded to a transcript view and out of budget-edit and
      // role-prompt modes, the same way the per-loop controls below are; everywhere else the
      // key falls through to applyKey. On the History pane the same key swaps the row list for
      // one tick's full event trail instead (the CLI's `tumwater tick --last` text), so it is
      // handled before the transcript guard below.
      if (view === roleIds.length + 4 && promptLineFree()) {
        trailGen++;
        if (trailMode) {
          trailMode = false;
          trailCache = null;
        } else {
          // The newest completed tick in the pane's scope: the loop's when Ctrl+G set
          // historyRole, else the fleet's. A log holding none flashes and leaves the rows.
          const row = readTickRows(root, 1, historyRole)[0];
          if (row === undefined) {
            flashMessage("no completed ticks to inspect");
          } else {
            // readTickDetail reads the log and renderTickDetail renders it; a throw (an
            // injected seam or an unexpected failure) flashes the reason and leaves the rows
            // shown rather than escaping the handler and killing the TUI.
            try {
              const detail = readTickDetail(root, row.loop, row.tick);
              trailCache = detail === null ? null : renderTickDetail(detail);
              trailMode = true;
              if (detail !== null) loadTrailStat(detail);
            } catch (err) {
              trailCache = null;
              flashError(err);
            }
          }
        }
        paneScroll = 0; // either way the pane starts at its head
        deps.requestRender();
        return;
      }
      if (es.budgetMode || es.rolePromptFor || es.deferMode || es.pauseEditMode || es.queuedEditFor || es.answerFor || es.entryEditFor || roleIds.length === 0 || view < 1 || view > roleIds.length) {
        deps.requestRender();
        return;
      }
      const role = roleIds[view - 1]!; // defined: view is clamped inside the transcript range
      if (changeMode) {
        changeMode = false;
        changeCache = null;
      } else if (noteMode) {
        // notebook → change: reset the notebook snapshot and kick off the collector
        // fire-and-forget, caching the rendered text when it resolves (the Pending pane's
        // pattern). Guard on the change pane still being current — changeMode on, same role
        // at the same index — so a cycle away or a roster shift cannot overwrite the pane now
        // shown. The default collector degrades rather than throws, so the rejection arm only
        // covers an injected seam (or an unexpected throw).
        noteMode = false;
        noteCache = null;
        changeMode = true;
        changeCache = null;
        const target = role;
        void collectChange(root, target).then(
          (change) => {
            if (!changeMode || roleIds[view - 1] !== target) return;
            changeCache = renderRoleChange(change);
            deps.requestRender();
          },
          (err: unknown) => {
            if (!changeMode || roleIds[view - 1] !== target) return;
            flashError(err);
            deps.requestRender();
          },
        );
      } else {
        // rolePayload reads the notebook and assembles the next tick's prompt off disk; a
        // throw leaves the transcript shown (the mode stays off) and flashes the reason
        // instead of escaping the handler and killing the TUI.
        try {
          noteCache = roleInspectMarkdown(root, role);
          noteMode = true;
        } catch (err) {
          noteCache = null;
          flashError(err);
        }
      }
      paneScroll = 0; // either way the pane starts at its head
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "g" && promptLineFree()) {
      // Ctrl+G cycles the active pane's loop scope (mnemonic: the **g**lobal scope / the
      // **g**roup). Guarded out of the budget and role-prompt editors, whose prompt line the
      // key must not disturb — the same inertness the per-loop keys honor. On the History
      // pane it walks the raw roster ids (`[null, ...roleIds]`) so an instance id is its own
      // slot, matching `history --role` and the dashboard picker; on every other view it cycles
      // the base-role report scope the Usage and Failures collectors aggregate by, exactly as
      // before. A pane showing the scope recomputes its cached Markdown and re-enters the body
      // at its head; every other view keeps the scope for the Ctrl+T entry that later computes
      // with it.
      if (view === 0) {
        // The Activity feed scopes over the same raw roster ids, so `feature-2` is its own
        // slot; the filter reads exact loop ids through eventRole. The scroll resets because
        // its offset indexed the old (unfiltered or differently filtered) list.
        const slots: Array<string | null> = [null, ...roleIds];
        const slot = slots.indexOf(activityRole);
        activityRole = slots[(slot + 1) % slots.length] ?? null;
        activityScroll = null;
      } else if (view === roleIds.length + 4) {
        const slots: Array<string | null> = [null, ...roleIds];
        const slot = slots.indexOf(historyRole);
        historyRole = slots[(slot + 1) % slots.length] ?? null;
        // A trail already on screen follows the scope: re-read the new scope's newest
        // completed tick (or drop to the pane's no-trail note when it has none) so the trail
        // and the tab strip cannot name different loops.
        if (trailMode) refreshTrail();
      } else {
        const slots = scopeCycle(roleIds);
        const slot = slots.indexOf(scopeRole);
        scopeRole = slots[(slot + 1) % slots.length] ?? null;
      }
      refreshPaneCache("all");
      deps.requestRender();
      return;
    }
    if (
      key.ctrl && key.name === "e" &&
      !es.budgetMode && !es.rolePromptFor && !es.deferMode && !es.pauseEditMode && !es.queuedEditFor && !es.answerFor && !es.entryEditFor
    ) {
      // Ctrl+E advances the Usage and Failures panes' trailing report window (mnemonic:
      // **E**lapsed). Guarded out of the budget and role-prompt editors like the other
      // mode-sensitive keys. (The Queued-edit and backlog title-edit Ctrl+E arms live in
      // tui-editors, which handled them above and returned before this branch when they
      // matched.) The window is session state: advancing it off either report pane
      // only changes the label, and the next Ctrl+T into one computes the cache with it; on a
      // report pane this handler recomputes the cached Markdown from the newly windowed
      // collector and re-enters the body at its head.
      reportWindow = nextInCycle(REPORT_WINDOWS, reportWindow);
      refreshPaneCache("report");
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "s" && promptLineFree()) {
      // Ctrl+S advances the History pane's trailing window (mnemonic: **S**ince). Guarded out
      // of budget-edit and role-prompt modes like the other mode-sensitive keys. The window is
      // session state: advancing it off the History view only changes the label, and the next
      // Ctrl+T into History computes the cache with it; on the History view this handler
      // re-reads the rows now and resets the scroll so the changed body re-enters at its head.
      historyWindow = nextInCycle(HISTORY_WINDOWS, historyWindow);
      refreshPaneCache("history");
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "o" && promptLineFree()) {
      // Ctrl+O advances the History pane's outcome filter (mnemonic: **O**utcome). Guarded out
      // of budget-edit and role-prompt modes like Ctrl+S beside it. The class is session state:
      // advancing it off the History view only changes the label, and the next Ctrl+T into
      // History computes the cache with it; on the History view this handler re-reads and
      // re-filters the rows now and resets the scroll so the changed body re-enters at its head.
      historyResult = nextInCycle(HISTORY_RESULTS, historyResult);
      refreshPaneCache("history");
      deps.requestRender();
      return;
    }
    if (
      key.ctrl && key.name === "x" && noteMode &&
      promptLineFree() &&
      view >= 1 && view <= roleIds.length
    ) {
      // Ctrl+X twice clears the viewed loop's notebook through the writer the CLI's
      // `--clear-notes` and the dashboard drawer share, then re-renders the notebook view.
      const role = roleIds[view - 1]!;
      if (armedNotes === role) {
        try {
          flashMessage(`${role}: ${saveRoleNote(roleNotesPath(root, role), "")}`);
          noteCache = roleInspectMarkdown(root, role);
          paneScroll = 0;
        } catch (err) {
          flashError(err);
        }
      } else {
        notesClearArmed = role;
        flashMessage(`press Ctrl+X again to clear ${role}'s notebook — any other key keeps it`);
      }
      deps.requestRender();
      return;
    }
    if (
      key.ctrl && key.name === "x" &&
      promptLineFree() &&
      view === roleIds.length + 6 && selectedQueued !== null
    ) {
      // Ctrl+X cancels the selected queued prompt through the CLI's own per-loop path
      // (`tumwater prompt --cancel <n> --role <id>`): cancelRolePrompt removes that loop's
      // Nth queue file and logs the prompt_cancelled event, so the pane, the CLI, and the
      // dashboard cancel cannot drift. Then re-read the queue so the pane's list and rows
      // reflect the removal and the selection clamps. A no-selection press (list mode), and
      // every other view, leaves the queue untouched.
      try {
        const row = queuedRows[Math.min(selectedQueued, queuedRows.length - 1)];
        if (row !== undefined) {
          const outcome = cancelRolePrompt(root, row.role, row.position);
          // A gone outcome is the concurrent-dequeue race (cancelRolePrompt's own contract),
          // not a failure: flash it honestly and still refresh the listing.
          flashMessage(
            outcome.status === "cancelled"
              ? `cancelled queued prompt #${row.position} for ${row.role}`
              : `queued prompt #${row.position} for ${row.role} was already gone`,
          );
          refreshQueued();
        }
      } catch (err) {
        flashError(err);
      }
      deps.requestRender();
      return;
    }
    if (
      key.ctrl && key.name === "x" &&
      promptLineFree() &&
      view === roleIds.length + 1
    ) {
      // Ctrl+X twice cancels the selected plan or bug through the non-exiting core the
      // dashboard drawer uses; the title check inside tryCancelEntry refuses a stale selection.
      if (selectedEntry !== null) {
        const entries = flat();
        const sel = Math.min(selectedEntry, entries.length - 1);
        const picked = entries[sel];
        if (picked === undefined) {
          // an emptied list has nothing to cancel
        } else if (picked.label === "question") {
          flashMessage("only a plan or open bug can be cancelled here");
        } else {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
          const target = { kind, position, title: picked.title };
          if (armed !== null && armed.kind === kind && armed.position === position) {
            // The armed title (not the re-read one) goes to tryCancelEntry, so an entry that
            // changed since the arm reports `moved` instead of being cancelled.
            try {
              const outcome = tryCancelEntry(root, kind, position, armed.title);
              if (outcome.status === "cancelled") {
                commitBacklogEdit(outcome.file, `Cancel ${kind}: ${outcome.title}`);
              }
              selectedEntry = null;
              entryScroll = 0;
              flashMessage(
                outcome.status === "cancelled"
                  ? `cancelled ${kind} #${position}: ${target.title}`
                  : `that ${kind} was already removed or moved — nothing cancelled`,
              );
            } catch (err) {
              flashError(err);
            }
          } else {
            cancelArmed = target;
            flashMessage(`press Ctrl+X again to cancel ${kind} #${position} — any other key keeps it`);
          }
        }
      }
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "t") {
      // Ctrl+T exits every open editor too — view cycling is orthogonal to them, so a cycle
      // never strands an editor's pre-filled text in the prompt line. Each editor restores its
      // saved draft. Role-prompt mode composes the same way: cycling away restores the saved
      // director draft.
      editors.exitAll();
      noteMode = false; // a cycle away leaves notebook and change modes and drops their snapshots
      noteCache = null;
      changeMode = false;
      changeCache = null;
      trailGen++;
      trailMode = false; // the tick trail is History-only; a cycle away drops its snapshot too
      trailCache = null;
      view = (view + 1) % (roleIds.length + 9); // events → each loop's transcript → project status → usage report → failures → history → pending → queued → health → brief → events
      selectedEntry = null; // leaving a view drops any entry selection…
      selectedQueued = null; // …and any queued-row selection, so re-entering starts at the list
      entryScroll = 0; // …and its within-body scroll, so re-entering starts at the list/head
      paneScroll = 0; // the Markdown panes always re-enter at their head
      activityScroll = null; // Activity always re-enters at the live tail
      // Compute the pane's Markdown once per activation (this handler renders immediately), and
      // drop it on leaving — a visit's first frame is fresh, later frames only re-window.
      if (!refreshPaneCache("all")) {
        if (view === roleIds.length + 5) {
          // Pending is the cycle's one async collector: collectFleetChanges awaits git plumbing,
          // so kick it off fire-and-forget, cache the rendered text when it resolves, and repaint.
          // The durable land queue needs no git plumbing, so read and render it through the CLI's
          // own pair (`tumwater queue`) UP FRONT: the queue paints on entry, and the git-backed
          // roster is appended below it when the collector resolves, so the three surfaces
          // (CLI, dashboard, TUI) cannot drift on order, age, skips, or wording.
          // Guard on the PENDING pane still being current — view === roleIds.length + 5 — not just
          // on the raw index: an operator who cycled away, or a roster change that shifted which
          // pane the same index names, must not have this resolution overwrite the pane now shown.
          // The default collector degrades rather than throws, so the rejection arm only covers an
          // injected seam (or an unexpected throw).
          const queueView = readLandingQueue(root);
          const queueText = renderLandingQueue(queueView, now(), queueInFlight(root, queueView.entries, orchestratorAlive(root)));
          paneCache = queueText;
          void collectPending(root).then(
            (fleet) => {
              if (view !== roleIds.length + 5) return;
              paneCache = queueText + "\n\n" + renderFleetChange(fleet);
              deps.requestRender();
            },
            (err: unknown) => {
              if (view !== roleIds.length + 5) return;
              // Keep the queue visible rather than replacing it with a loading note: it is
              // already known and unaffected by the git read that failed.
              flashError(err);
              deps.requestRender();
            },
          );
        } else if (view === roleIds.length + 6) {
          // Queued is a synchronous read of the same queue list `tumwater prompt --list`
          // prints (renderQueuedList over queuedListRows), so it paints on entry with no
          // async collector. The now() clock keeps the age/countdown suffix testable.
          refreshQueued();
        } else if (view === roleIds.length + 7) {
          // Health reruns `tumwater doctor`'s checks on each entry; the loading note shows until
          // they resolve. Same stale-resolution guard as Pending: only paint while Health is
          // current.
          paneCache = null;
          void runDoctorSeam(root).then(
            (report) => {
              if (view !== roleIds.length + 7) return;
              paneCache = renderDoctor(report);
              deps.requestRender();
            },
            (err: unknown) => {
              if (view !== roleIds.length + 7) return;
              flashError(err);
              deps.requestRender();
            },
          );
        } else if (view === roleIds.length + 8) {
          // Brief is a synchronous fresh read of the file `tumwater brief` prints.
          const brief = readBrief(root);
          paneCache = brief ? renderBrief(brief) : null;
        } else {
          paneCache = null;
        }
      }
      deps.requestRender();
      return;
    }
    const arrow = arrowDir(key.name);
    const page = pageDir(key.name);
    if (view === roleIds.length + 1 && arrow !== null) {
      // In the project-status pane, up/down browse entries in full instead of editing the
      // prompt; every other view keeps today's behavior (arrows are ignored by applyKey).
      // An open answer editor pins the selection (its position was taken from it).
      if (!es.answerFor && !es.entryEditFor) {
        const count = flat().length;
        selectedEntry = moveEntrySelection(count, selectedEntry, arrow);
        entryScroll = 0; // a newly opened entry starts at its body's head
      }
      deps.requestRender();
      return;
    }
    if (view === roleIds.length + 6 && arrow !== null) {
      // In the Queued pane, up/down select a queued prompt row in full (wrapping, the backlog
      // pane's rule) instead of editing the prompt; an empty queue has nothing to select, so
      // moveEntrySelection clears the selection. Every other view keeps today's behavior.
      // The selected body shares paneScroll with the list, so a newly opened row must start
      // at its head (the status pane's entryScroll reset on the same move), or it renders
      // scrolled into the middle of the previous row's body.
      selectedQueued = moveEntrySelection(queuedRows.length, selectedQueued, arrow);
      paneScroll = 0;
      deps.requestRender();
      return;
    }
    if (page !== null && view === 0) {
      // The Activity pane keeps the live tail by default; PgUp pauses follow and pages back
      // through the loaded event tail, PgDn returns toward it and re-enables follow once the
      // window reaches the tail. Both directions clamp to [0, total - eventBudget], and a log
      // with eventBudget or fewer events stays on the tail. The read is the pane's own fixed
      // tail term (and active loop/text filter), so it hits readEvents' stat cache rather than
      // rescanning the log.
      const total = activityEvents(root, activityRole, activityGrep).length;
      const maxStart = Math.max(0, total - eventBudget);
      const current = activityScroll ?? maxStart;
      const next = stepEntryScroll(current, total, eventBudget, page);
      activityScroll = next >= maxStart ? null : next;
      deps.requestRender();
      return;
    }
    if (page !== null && (noteMode || changeMode || trailMode)) {
      // Within-body scroll in the notebook, change, and tick-trail views: PgDn/PgUp page the
      // cached inspection Markdown, clamped at both ends, exactly like the usage/failures
      // panes below.
      const total = (noteMode ? (noteCache ?? "") : trailMode ? (trailCache ?? "") : (changeCache ?? "")).split("\n").length;
      paneScroll = stepEntryScroll(paneScroll, total, eventBudget, page);
      deps.requestRender();
      return;
    }
    if (view >= roleIds.length + 2 && page !== null) {
      // Within-body scroll in the Markdown panes (usage report, failures): PgDn/PgUp page the
      // cached string, clamped at both ends. The total is derived from the cache, mirroring how
      // entry mode derives it from e.body; every other view ignores these keys as today.
      const total = (paneCache ?? "").split("\n").length;
      paneScroll = stepEntryScroll(paneScroll, total, eventBudget, page);
      deps.requestRender();
      return;
    }
    if (view === roleIds.length + 1 && page !== null) {
      // Within-body scroll in project-status ENTRY mode: PgDn/PgUp page the selected entry's
      // body, clamped at both ends. No-op in list mode and for bodies that fit — every other
      // view ignores these keys as today (applyKey drops them).
      if (selectedEntry !== null && !es.answerFor && !es.entryEditFor) {
        const entries = flat();
        const sel = entries.length > 0 ? Math.min(selectedEntry, entries.length - 1) : null;
        const body = sel === null ? "" : entries[sel]!.body;
        entryScroll = stepEntryScroll(
          entryScroll,
          body ? body.split("\n").length : 0,
          entryBudget,
          page,
        );
      }
      deps.requestRender();
      return;
    }
    if (arrow !== null && editors.onArrow(arrow)) {
      deps.requestRender();
      return;
    }
    if (
      key.name === "escape" && selectedQueued !== null && view === roleIds.length + 6 &&
      promptLineFree()
    ) {
      // Esc on the Queued pane returns it to list mode; the cached list is untouched (nothing
      // was cancelled), so the pane shows the same renderQueuedList it entered with. The
      // shared paneScroll resets with the body switch, like a selection move.
      selectedQueued = null;
      paneScroll = 0;
      deps.requestRender();
      return;
    }
    editors.apply(str, key);
    deps.requestRender();
  };

  return {
    handleKey,
    syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorRunning = false): void {
      editors.sync(capUsd, budgetFree);
      const previousCount = roleIds.length;
      roleIds = roles;
      directorInFlight = directorRunning;
      // The panes from project status on are anchored at roleIds.length, so a roster-size
      // change moves every one of their indices by the same delta: shift the view with them,
      // or an unadjusted index silently renames to a different pane while its cached body
      // stays, showing the wrong body under the tab now selected. A transcript view
      // (1..previousCount) keeps its index — it does not depend on the roster size — and the
      // clamp below handles one the shrunken roster no longer has.
      if (roleIds.length !== previousCount && view > previousCount) view += roleIds.length - previousCount;
      view = Math.min(view, roleIds.length + 8); // clamp a stale index if roles changed
      // A retired or renamed loop must not leave the report panes silently scoped to an
      // absent role — drop the scope with the stale view index. The tab strip and hint then
      // read "fleet", so a report pane still on screen must recompute its cached Markdown
      // from the fleet-wide collector (and re-enter at the body's head) to match; the other
      // views compute with the scope on their next Ctrl+T.
      if (scopeRole !== null && !roleIds.includes(scopeRole)) {
        scopeRole = null;
        refreshPaneCache("report");
      }
      // The same drop for History's exact-loop scope: a retired or renamed loop must not keep
      // labeling an empty pane. An on-screen History pane recomputes from the fleet-wide read
      // so its rows and its `role:` header clear together.
      if (historyRole !== null && !roleIds.includes(historyRole)) {
        historyRole = null;
        refreshPaneCache("history");
        // The retired scope may have been feeding an on-screen trail: re-read it from the
        // fleet so the pane and the tab strip cannot name a loop the roster no longer has.
        if (trailMode) refreshTrail();
      }
      // The same drop for the Activity feed's exact-loop scope: a retired or renamed loop must
      // not leave the pane filtering on an id the roster no longer names. The scroll resets
      // with it — the offset indexed the old filtered list.
      if (activityRole !== null && !roleIds.includes(activityRole)) {
        activityRole = null;
        activityScroll = null;
      }
    },
    setLineBudgets(evBudget: number, enBudget: number): void {
      eventBudget = evBudget;
      entryBudget = enBudget;
    },
    state(): TuiKeysState {
      const e = editors.state();
      return {
        ...e,
        view,
        scopeRole,
        historyRole,
        selectedEntry,
        cancelArmed,
        entryScroll,
        selectedQueued,
        queuedRows,
        paneCache,
        noteMode,
        noteCache,
        trailMode,
        trailCache,
        changeMode,
        changeCache,
        paneScroll,
        activityScroll,
        activityRole,
        activityGrep,
        historySince: historyWindow === null ? null : cycleLabel(HISTORY_WINDOWS, historyWindow),
        reportSince: reportWindow === null ? null : cycleLabel(REPORT_WINDOWS, reportWindow),
        historyResult: cycleLabel(HISTORY_RESULTS, historyResult),
        historyGrep,
        eventBudget,
        entryBudget,
        roleIds,
        directorInFlight,
        flash: flash && now() < flashUntil ? flash : null,
      };
    },
  };
}
