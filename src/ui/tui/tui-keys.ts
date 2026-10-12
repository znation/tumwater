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
  tickRowGrepHaystack,
  type HistoryResultClass,
} from "../../history/history-data.js";
import { historyPaneText } from "./tui-history.js";
import { collectFleetChanges, collectRoleChange, type FleetChangeView, type RoleChangeView } from "../../change/change-data.js";
import { renderFleetChange, renderRoleChange } from "../../change/change-render.js";
import { readLandingQueue } from "../../landing/landing-queue.js";
import { renderLandingQueue } from "../../landing/landing-queue-render.js";
import { submitPrompt } from "../../inbox/inbox-submit.js";
import { listWideScope, queuedListRows, renderQueuedList } from "../../inbox/inbox.js";
import { setDailyBudgetUsd } from "../../config/config-write.js";
import {
  isFleetPaused,
  pausedRoles,
  pauseFleet,
  pauseRole,
  resumeFleet,
  resumeRole,
} from "../../fleet/fleet-state.js";
import {
  requestAbort,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  submitRolePromptAndWake,
} from "../../operator/operator-intent.js";
import { errorMessage } from "../../text/text.js";
import { fleetPausePhrase, fleetResumePhrase } from "../../text/phrases.js";
import { usdCap } from "../../text/format.js";
import { DIRECTOR_ROLE } from "../../roles/roles.js";
import { baseRoleOf } from "../../roles/loop-ids.js";
import {
  applyKey,
  parseBudgetInput,
  parseRolePromptInput,
} from "./tui-input.js";
import {
  newPromptHistory,
  type PromptHistory,
  pushPromptHistory,
  recallPromptHistory,
  resetPromptRecall,
  settlePromptRecall,
} from "./tui-prompt-history.js";
import { labeledBacklogEntries, moveEntrySelection, stepEntryScroll } from "./tui-backlog.js";
import { roleInspectMarkdown } from "./tui-pane.js";
import { arrowDir, pageDir } from "./tui-keymap.js";

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

/** The History pane's session window cycle, Ctrl+S: the default newest-N read, then the same
 * trailing windows the dashboard's History view and `tumwater history --since` offer — 1h,
 * 6h, 1d, and the 7d cap the CLI's flag and the dashboard both stop at. The label is what the
 * hint line names; the length is what readTickRowsSince takes. `null` is the default read
 * through readTickRows, kept first so the pane opens on today's behavior. */
const HISTORY_WINDOWS: ReadonlyArray<[number | null, string]> = [
  [null, "default"],
  [3_600_000, "1h"],
  [21_600_000, "6h"],
  [86_400_000, "1d"],
  [604_800_000, "7d"],
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
  // them). The needle is the same case-insensitive substring rule over tickRowGrepHaystack the
  // CLI and the dashboard search use, so the three surfaces cannot disagree.
  const needle = grep === null ? null : grep.toLowerCase();
  const grepped = needle === null ? rows : rows.filter((r) => tickRowGrepHaystack(r).toLowerCase().includes(needle));
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
  [3_600_000, "1h"],
  [21_600_000, "6h"],
  [86_400_000, "1d"],
  [REPORT_SINCE_MAX_MS, "7d"],
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
  /** The transcript Change mode's async collector; production uses change-data's
   * collectRoleChange. Injectable so tests can resolve a fixed view without git plumbing. */
  collectChange?(root: string, role: string): Promise<RoleChangeView>;
}

/** The state render reads back each frame: the prompt line, the modes it names in the hint
 * line, the view/selection/scroll state, the line budgets, and the flash notice — null when
 * expired, so the per-second repaint drops the notice on the same clock it was armed. */
interface TuiKeysState {
  input: string;
  cursor: number;
  budgetMode: boolean;
  rolePromptFor: string | null;
  view: number;
  /** The session-scoped role the Usage and Failures panes collect for (Ctrl+G), null for the
   * fleet; cleared when the incoming roster no longer names it. */
  scopeRole: string | null;
  /** The History pane's exact-loop scope (Ctrl+G), a raw roster id or null for the fleet's
   * full read; cleared when the incoming roster no longer names it. Separate from scopeRole:
   * History filters by exact loop (`history --role`), where `feature-2` is its own slot. */
  historyRole: string | null;
  selectedEntry: number | null;
  entryScroll: number;
  paneCache: string | null;
  /** Whether the viewed loop's pane shows its notebook (Ctrl+N) instead of the transcript —
   * true only on a transcript view. */
  noteMode: boolean;
  /** The notebook view's rendered Markdown, computed once on Ctrl+N entry and windowed by
   * paneBody; null when the live transcript is shown. */
  noteCache: string | null;
  /** Whether the viewed loop's pane shows the collected unlanded change (the second Ctrl+N
   * step) instead of the transcript — true only on a transcript view. */
  changeMode: boolean;
  /** The change view's rendered text (renderRoleChange), null until its async collector
   * resolves; windowed by paneBody. */
  changeCache: string | null;
  paneScroll: number;
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
 * every mutable local the keypress dispatch used to keep in runTui's closure — the prompt line,
 * budget-edit and role-prompt modes, the session history, the flash notice, the
 * view/selection/scroll state, and the line budgets render feeds back. It takes only the
 * seams it cannot own itself: the repo root the disk actions run against, the quit callback
 * (Ctrl+D), a render request callback (every branch that painted a frame), and an injectable clock
 * so the flash expiry is testable without waiting the real 3 s. Rendering (src/ui/tui/tui.tsx)
 * stays the caller: it syncs snapshot data and line budgets in, and reads the resulting state
 * out to compose the frame — the same data flow, one module boundary added. */
export function createTuiKeys(deps: TuiKeysDeps): TuiKeys {
  const now = deps.now ?? Date.now;
  const { root } = deps;
  const collectPending = deps.collectPending ?? collectFleetChanges;
  const collectChange = deps.collectChange ?? collectRoleChange;
  // The project-status pane's flat entry list (plans, then bugs, then questions), read fresh —
  // tui-backlog.ts's one definition, shared with the render so stale-selection clamping cannot
  // drift.
  const flat = () => labeledBacklogEntries(root);

  let input = "";
  let cursor = 0;
  // Ctrl+B budget-edit mode on the prompt line: while set, the line edits the daily cost cap
  // (pre-filled with the current cap — empty when disabled) instead of a director prompt.
  // The previous prompt text is saved so leaving the mode restores it byte-for-byte.
  let budgetMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // Ctrl+R role-prompt mode on the prompt line: while set (to the viewed loop's role id), the
  // line edits a prompt for that one loop instead of a director prompt. It keeps its OWN saved
  // pair, separate from budget mode's: the two modes are mutually exclusive (each refuses to
  // open while the other holds the line), and with separate pairs neither can clobber the
  // other's saved draft even if a guard is ever loosened.
  let rolePromptFor: string | null = null;
  let roleSavedInput = "";
  let roleSavedCursor = 0;
  // The prompt line's session history (tui-prompt-history.ts's rules): every successfully submitted
  // prompt — director and per-role alike — joins it, and Up/Down walk it the way readline
  // does. Not persisted: a TUI session starts blank, like a fresh shell.
  let promptHistory: PromptHistory = newPromptHistory();
  // The last snapshot's cap, captured by render so the Ctrl+B handler can pre-fill without
  // re-reading config itself (render already polls snapshot every second).
  let currentCapUsd = 0;
  // The last snapshot's free flag: true when every model the fleet could use is unpriced,
  // so a cap could never bind — the Ctrl+B handler flashes a notice instead of opening
  // the editor (BUGS.md 2026-09-14), leaving the prompt line untouched.
  let currentBudgetFree = false;
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
  // Ctrl+N's third step: the viewed loop's collected unlanded change (the CLI's
  // `renderRoleChange` text). changeCache is null until the async collector resolves, and the
  // pane paints a loading note meanwhile; both reset on leaving the mode or cycling the view.
  let changeMode = false;
  let changeCache: string | null = null;
  // The within-body scroll offset (line index of the window head) shared by the two Markdown
  // panes and the notebook view — PgDn/PgUp there. Reset to the head whenever the view is
  // entered, like entryScroll.
  let paneScroll = 0;
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
  // loop (`history --role`), so `feature-2` is its own slot.
  let historyRole: string | null = null;
  // The History pane's session free-text search (the `/` prompt-line editor), a
  // case-insensitive substring over history-data.ts's tickRowGrepHaystack — the same rule
  // `tumwater history --grep` and the dashboard search use. null is no search; session-only
  // like the window/result/role, so the next Ctrl+T into History computes the cache with it.
  let historyGrep: string | null = null;
  // The History search editor on the prompt line: `/` enters it (only on History with an empty
  // line), pre-filling the applied pattern; Enter applies it, Esc restores the draft. Its own
  // saved-draft pair, exactly like the budget and role-prompt editors: the three share one
  // prompt line and are mutually exclusive, so no editor can clobber another's saved draft.
  let searchMode = false;
  let searchSavedInput = "";
  let searchSavedCursor = 0;
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

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  // The recall state resets with it: the restored text is the live draft now, so the next
  // Up starts a fresh browse instead of resuming whatever the cap editor's line left behind.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    input = savedInput;
    cursor = savedCursor;
    promptHistory = resetPromptRecall(promptHistory);
  };

  // Leave role-prompt mode (Esc, Ctrl+R again, or Ctrl+T): restore the saved prompt text,
  // and reset the recall state with it — the saved draft was saved settled (see the Ctrl+R
  // handler), so resuming a browse entered in role mode would restore role-mode text onto
  // the director line and lose the director draft the arrows had saved.
  const exitRolePromptMode = (): void => {
    if (!rolePromptFor) return;
    rolePromptFor = null;
    input = roleSavedInput;
    cursor = roleSavedCursor;
    promptHistory = resetPromptRecall(promptHistory);
  };

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

  // Leave History search mode (Enter applies, Esc cancels, Ctrl+T cycles): restore the saved
  // prompt text, and reset the recall state with it — the same settle contract the budget and
  // role-prompt editors honor. The applied historyGrep itself persists across view cycling,
  // like historyWindow/historyResult.
  const exitHistorySearch = (): void => {
    if (!searchMode) return;
    searchMode = false;
    input = searchSavedInput;
    cursor = searchSavedCursor;
    promptHistory = resetPromptRecall(promptHistory);
  };

  const handleKey = (str: string | undefined, key: { ctrl?: boolean; name?: string }): void => {
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
    if (key.ctrl && key.name === "b") {
      // Ctrl+B toggles budget-edit mode on the prompt line (mnemonic for *b*udget): entering
      // pre-fills the current cap (empty when disabled — empty means "no cap" on save) and
      // saves the prompt text; leaving restores it. Esc cancels the same way.
      if (rolePromptFor || searchMode) {
        // Mutually exclusive with the role-prompt and History-search editors: all three share
        // one prompt line, so a mode may not enter while another holds it. Flash the way out
        // instead of silently dropping the held mode's saved draft (or parsing its text as a
        // cap on Enter).
        flashMessage(
          searchMode
            ? "finish or cancel the search first (Esc cancels)"
            : `finish or cancel the prompt for ${rolePromptFor} first (Esc cancels)`,
        );
        deps.requestRender();
        return;
      }
      if (budgetMode) {
        exitBudgetMode();
      } else if (currentBudgetFree) {
        // An all-free fleet has no spend a cap could bind: the editor would pre-fill a
        // value that can never take effect, so Ctrl+B flashes a one-line notice and
        // leaves the prompt line untouched (toggle/Esc logic unchanged).
        flashMessage("budget n/a — all models free");
      } else {
        // Mid-recall, hand the arrows' saved draft back before the cap editor takes the
        // line — the same settle the role editor does — so leaving budget mode restores
        // the draft, not a history entry, with no stale recall state riding along.
        const settled = settlePromptRecall(promptHistory, input, cursor);
        promptHistory = settled.history;
        savedInput = settled.text;
        savedCursor = settled.cursor;
        budgetMode = true;
        input = currentCapUsd > 0 ? String(currentCapUsd) : "";
        cursor = input.length;
        flashMessage("edit daily cost budget (USD): Enter to save, Esc to cancel");
      }
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "f" && !budgetMode && !rolePromptFor) {
      // Ctrl+F toggles the whole-fleet pause (mnemonic: **F**leet) through the same
      // pauseFleet/resumeFleet marker writers `tumwater pause`/`resume` and the dashboard's
      // /api/pause call use, so the surfaces cannot drift on marker format or idempotence.
      // The shared fleetPausePhrase/fleetResumePhrase base lines keep the flash wording the
      // event feed and failure digest already read; a no-op flashes the same
      // already-paused/was-not-paused contract the CLI prints. Guarded out of the budget and
      // role-prompt editors, whose prompt line the fleet toggle must not disturb — the same
      // inertness the per-loop keys honor below. The write can fail (a lock timeout, a torn
      // fs), so flash the reason instead of letting the throw kill the TUI.
      try {
        const paused = isFleetPaused(root);
        const changed = paused ? resumeFleet(root) : pauseFleet(root);
        flashMessage(
          paused
            ? changed
              ? fleetResumePhrase()
              : "fleet was not paused"
            : changed
              ? fleetPausePhrase()
              : "fleet is already paused",
        );
      } catch (err) {
        flashError(err);
      }
      deps.requestRender();
      return;
    }
    // Per-loop controls on the transcript pane (PLANS.md "TUI per-loop controls"): Ctrl+P
    // toggles the viewed loop's pause, Ctrl+A aborts its in-flight tick, Ctrl+W wakes it,
    // and Ctrl+R opens the role-prompt editor for it (PLANS.md "Per-role prompts 2/2").
    // They call the same marker-writing/submit cores the CLI's --role flags do, so the
    // surfaces cannot drift on marker format, idempotence, or wording. Guarded to the
    // transcript views and out of budget-edit mode; everywhere else the keys fall through
    // to applyKey, where only Ctrl+U (kill to line start) and Ctrl+K (kill to line end)
    // edit the prompt line and the rest of these ctrl-key presses stay inert.
    // Every branch is a disk write that can fail (a lock timeout, a torn fs), and an
    // unguarded throw would escape this keypress handler and kill the TUI — flash the
    // reason instead, the same contract the prompt-submit path below honors.
    if (
      !budgetMode &&
      roleIds.length > 0 &&
      view >= 1 && view <= roleIds.length &&
      key.ctrl && (key.name === "p" || key.name === "a" || key.name === "w" || key.name === "r")
    ) {
      const role = roleIds[view - 1]!; // defined: view is clamped inside the transcript range
      try {
        if (key.name === "r") {
          // Ctrl+R toggles role-prompt mode for the viewed loop (mnemonic: p**R**ompt —
          // Ctrl+P is taken by pause): entering saves the director draft in this mode's own
          // pair and blanks the line; entering again (or Esc) restores it. Mutually
          // exclusive with budget mode by the outer guard and the mirrored refusal in the
          // Ctrl+B branch.
          if (rolePromptFor) {
            exitRolePromptMode();
            flashMessage("role prompt cancelled");
          } else {
            // Mid-recall, the line holds a history entry while the real draft sits in the
            // recall state: settle first, so the role editor saves (and later restores) the
            // draft the operator was writing, and no stale index/draft crosses modes —
            // otherwise Esc here would surface role-mode recalls on the director line.
            const settled = settlePromptRecall(promptHistory, input, cursor);
            promptHistory = settled.history;
            roleSavedInput = settled.text;
            roleSavedCursor = settled.cursor;
            rolePromptFor = role;
            input = "";
            cursor = 0;
            flashMessage(`prompt for ${role}: Enter to send, Esc to cancel`);
          }
        } else if (key.name === "p") {
          // Toggle by the marker's current state, read fresh: pauseRole/resumeRole's false
          // return means another window raced us to the same state, and the wording
          // helpers render that honestly — the changed-state contract the CLI prints.
          const paused = pausedRoles(root).includes(role);
          const changed = paused ? resumeRole(root, role) : pauseRole(root, role);
          flashMessage(
            paused
              ? roleResumeMessage(root, role, changed)
              : rolePauseMessage(root, role, changed),
          );
        } else if (key.name === "a") {
          const result = requestAbort(root, role);
          flashMessage(result.ok ? result.message : `error: ${result.error}`);
        } else {
          flashMessage(requestWake(root, [role]));
        }
      } catch (err) {
        flashError(err);
      }
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "n") {
      // Ctrl+N cycles the viewed loop's pane live transcript → notebook → change → transcript
      // (PLANS.md "Inspect a loop's notebook and next tick prompt in the TUI" and "Show a
      // loop's pending change in the TUI transcript pane"). The change step renders the same
      // collectRoleChange/renderRoleChange view the CLI's `tumwater diff --role <id>` and the
      // dashboard drawer use. Guarded to a transcript view and out of budget-edit and
      // role-prompt modes, the same way the per-loop controls below are; everywhere else the
      // key falls through to applyKey.
      if (budgetMode || rolePromptFor || roleIds.length === 0 || view < 1 || view > roleIds.length) {
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
    if (key.ctrl && key.name === "g" && !budgetMode && !rolePromptFor && !searchMode) {
      // Ctrl+G cycles the active pane's loop scope (mnemonic: the **g**lobal scope / the
      // **g**roup). Guarded out of the budget and role-prompt editors, whose prompt line the
      // key must not disturb — the same inertness the per-loop keys honor. On the History
      // pane it walks the raw roster ids (`[null, ...roleIds]`) so an instance id is its own
      // slot, matching `history --role` and the dashboard picker; on every other view it cycles
      // the base-role report scope the Usage and Failures collectors aggregate by, exactly as
      // before. A pane showing the scope recomputes its cached Markdown and re-enters the body
      // at its head; every other view keeps the scope for the Ctrl+T entry that later computes
      // with it.
      if (view === roleIds.length + 4) {
        const slots: Array<string | null> = [null, ...roleIds];
        const slot = slots.indexOf(historyRole);
        historyRole = slots[(slot + 1) % slots.length] ?? null;
      } else {
        const slots = scopeCycle(roleIds);
        const slot = slots.indexOf(scopeRole);
        scopeRole = slots[(slot + 1) % slots.length] ?? null;
      }
      refreshPaneCache("all");
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "e" && !budgetMode && !rolePromptFor) {
      // Ctrl+E advances the Usage and Failures panes' trailing report window (mnemonic:
      // **E**lapsed). Guarded out of the budget and role-prompt editors like the other
      // mode-sensitive keys. The window is session state: advancing it off either report pane
      // only changes the label, and the next Ctrl+T into one computes the cache with it; on a
      // report pane this handler recomputes the cached Markdown from the newly windowed
      // collector and re-enters the body at its head.
      reportWindow = nextInCycle(REPORT_WINDOWS, reportWindow);
      refreshPaneCache("report");
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "s" && !budgetMode && !rolePromptFor && !searchMode) {
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
    if (key.ctrl && key.name === "o" && !budgetMode && !rolePromptFor && !searchMode) {
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
    if (key.ctrl && key.name === "t") {
      // Ctrl+T exits budget-edit mode too — view cycling is orthogonal to it, so a cycle
      // never strands the editor with its pre-filled cap in the prompt line. Role-prompt
      // mode composes the same way: cycling away restores the saved director draft.
      exitBudgetMode();
      exitRolePromptMode();
      exitHistorySearch();
      noteMode = false; // a cycle away leaves notebook and change modes and drops their snapshots
      noteCache = null;
      changeMode = false;
      changeCache = null;
      view = (view + 1) % (roleIds.length + 7); // events → each loop's transcript → project status → usage report → failures → history → pending → queued → events
      selectedEntry = null; // leaving a view drops any entry selection…
      entryScroll = 0; // …and its within-body scroll, so re-entering starts at the list/head
      paneScroll = 0; // the Markdown panes always re-enter at their head
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
          const queueText = renderLandingQueue(readLandingQueue(root), now());
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
          paneCache = renderQueuedList(queuedListRows(root, null, listWideScope(root)), now());
        } else {
          paneCache = null;
        }
      }
      deps.requestRender();
      return;
    }
    if (!key.ctrl && str === "/" && !searchMode && !budgetMode && !rolePromptFor && view === roleIds.length + 4 && input === "") {
      // `/` opens the History pane's free-text search on the prompt line (the pager's search
      // key; this project already reserves `/` for a meta action). Guarded to the History view
      // and to an empty line, so off History it types into the prompt as today and on History a
      // director draft is never disturbed. Pre-fills the applied pattern so Enter re-submits it
      // and the operator can edit it; Esc cancels without applying.
      const settled = settlePromptRecall(promptHistory, input, cursor);
      promptHistory = settled.history;
      searchSavedInput = settled.text;
      searchSavedCursor = settled.cursor;
      searchMode = true;
      input = historyGrep ?? "";
      cursor = input.length;
      flashMessage("search ticks: Enter to filter, Esc to cancel");
      deps.requestRender();
      return;
    }
    const arrow = arrowDir(key.name);
    const page = pageDir(key.name);
    if (view === roleIds.length + 1 && arrow !== null) {
      // In the project-status pane, up/down browse entries in full instead of editing the
      // prompt; every other view keeps today's behavior (arrows are ignored by applyKey).
      const count = flat().length;
      selectedEntry = moveEntrySelection(count, selectedEntry, arrow);
      entryScroll = 0; // a newly opened entry starts at its body's head
      deps.requestRender();
      return;
    }
    if (page !== null && (noteMode || changeMode)) {
      // Within-body scroll in the notebook and change views (a transcript view): PgDn/PgUp page
      // the cached inspection Markdown, clamped at both ends, exactly like the usage/failures
      // panes below.
      const total = (noteMode ? (noteCache ?? "") : (changeCache ?? "")).split("\n").length;
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
      if (selectedEntry !== null) {
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
    if (!budgetMode && !searchMode && arrow !== null) {
      // Up/Down walk the submitted-prompt history the way readline does (tui-prompt-history.ts's
      // recall rules). The backlog pane keeps the arrows for entry browsing (its branch
      // above already returned), and budget mode keeps them out — recalling a prompt into
      // the cap field would be a paste, not a recall. No history in this direction: fall
      // through to applyKey, which ignores arrows as before.
      const recalled = recallPromptHistory(
        promptHistory,
        input,
        cursor,
        key.name === "up" ? "older" : "newer",
      );
      if (recalled) {
        promptHistory = recalled.history;
        input = recalled.text;
        cursor = recalled.cursor;
      }
    }
    if (key.name === "escape" && searchMode) {
      // Esc cancels the History search without applying it; the applied pattern is unchanged.
      exitHistorySearch();
      deps.requestRender();
      return;
    }
    if (key.name === "escape" && budgetMode) {
      // Esc cancels budget-edit mode, restoring the previous prompt text.
      exitBudgetMode();
      deps.requestRender();
      return;
    }
    if (key.name === "escape" && rolePromptFor) {
      // Esc cancels role-prompt mode the same way, restoring the previous prompt text.
      exitRolePromptMode();
      deps.requestRender();
      return;
    }
    if (key.name === "return") {
      if (searchMode) {
        // Enter applies the trimmed line as the History search: an empty line clears it. The
        // cache is recomputed now (the pane is showing) and the body re-enters at its head; a
        // successful apply restores the saved prompt draft through exitHistorySearch.
        const pattern = input.trim();
        historyGrep = pattern === "" ? null : pattern;
        exitHistorySearch();
        paneCache = historyPaneCache(root, historyWindow, historyResult, historyRole, historyGrep);
        paneScroll = 0;
        flashMessage(historyGrep === null ? "search cleared" : `search: "${historyGrep}"`);
      } else if (budgetMode) {
        // Enter in budget mode parses + saves the cap through the shared setter (which
        // writes tumwater.json atomically; the running orchestrator picks it up on its next
        // ~2 s poll). An invalid value flashes and STAYS in edit mode so the operator can
        // fix it; success restores the saved prompt text.
        const parsed = parseBudgetInput(input);
        if (!parsed.ok) {
          flashMessage(parsed.error);
        } else {
          const result = setDailyBudgetUsd(root, parsed.value);
          if (result.ok) {
            exitBudgetMode();
            currentCapUsd = parsed.value; // the next render's snapshot agrees within ~2 s
            flashMessage(
              parsed.value === 0
                ? "budget disabled"
                : `budget set to ${usdCap(parsed.value)}`,
            );
          } else {
            flashMessage(result.error); // broken config or write failure — stay in edit mode
          }
        }
      } else if (rolePromptFor) {
        // Enter in role-prompt mode submits for the viewed loop through the same path
        // `tumwater prompt --role` uses: the shared submitRolePromptAndWake enqueues into
        // that loop's own queue (length-capped by the shared rule), logs under the loop,
        // and wakes it so a live fleet's loop comes in within one poll. An invalid
        // (whitespace-only) line flashes and STAYS in edit mode; a failed queue write
        // flashes the reason and keeps the text, the same contract the director path
        // below honors; success restores the saved draft.
        const parsed = parseRolePromptInput(input);
        if (!parsed.ok) {
          flashMessage(parsed.error);
        } else {
          const role = rolePromptFor;
          try {
            submitRolePromptAndWake(root, role, parsed.value);
            promptHistory = pushPromptHistory(promptHistory, parsed.value);
            exitRolePromptMode();
            flashMessage(`queued for the ${role} loop`);
          } catch (err) {
            flashError(err);
          }
        }
      } else {
        const prompt = input.trim();
        if (!prompt) {
          // Whitespace-only input queues nothing; drop it like an empty line.
          input = "";
          cursor = 0;
        } else {
          try {
            submitPrompt(root, prompt);
            promptHistory = pushPromptHistory(promptHistory, prompt);
            input = "";
            cursor = 0;
            flashMessage("queued for the director loop");
          } catch (err) {
            // The queue write failed (disk full, permissions): keep the operator's text so
            // it can be resubmitted, and flash the reason — the same contract the GUI's
            // prompt form honors. Clearing the line first would silently lose the prompt,
            // and an unguarded throw would escape the keypress handler and kill the TUI.
            flashError(err);
          }
        }
      }
    } else {
      const next = applyKey(input, cursor, str, key);
      input = next.text;
      cursor = next.cursor;
    }
    deps.requestRender();
  };

  return {
    handleKey,
    syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorRunning = false): void {
      currentCapUsd = capUsd;
      currentBudgetFree = budgetFree;
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
      view = Math.min(view, roleIds.length + 6); // clamp a stale index if roles changed
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
      }
    },
    setLineBudgets(evBudget: number, enBudget: number): void {
      eventBudget = evBudget;
      entryBudget = enBudget;
    },
    state(): TuiKeysState {
      return {
        input,
        cursor,
        budgetMode,
        rolePromptFor,
        view,
        scopeRole,
        historyRole,
        selectedEntry,
        entryScroll,
        paneCache,
        noteMode,
        noteCache,
        changeMode,
        changeCache,
        paneScroll,
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
