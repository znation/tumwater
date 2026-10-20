// vocabulary: plain
import { REPORT_SINCE_MAX_MS } from "../../events/event-window.js";
import type { TeamChangeView, RoleChangeView } from "../../change/change-data.js";
import type { DoctorReport } from "../../doctor/doctor-checks.js";
import type { OrphanKillReport } from "../../doctor/doctor-orphans.js";
import type { RunDetail } from "../../run/run-detail-data.js";
import { HISTORY_RESULT_CLASSES, HISTORY_RESULT_FLAG_NAMES } from "../../history/history-data.js";
import type { HistoryResultClass } from "../../history/history-data.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import type { labeledBacklogEntries } from "./tui-backlog.js";

/** A backlog-entry cancel or release target (plan or bug position + title), shared by the
 * backlog pane's two-step Ctrl+X arm, its two-step Ctrl+R release arm, and the shell's
 * beginKey. Internal to the pane session module: the armed targets ride on the session only. */
interface CancelTarget {
  kind: "plan" | "bug";
  position: number;
  title: string;
}

/** The seams `createTuiPanes` cannot own itself: the shell's flash pair and backlog commit, the
 * flat backlog list, the clock, and the four async collectors, each already resolved to its
 * default by createTuiKeys. */
export interface TuiPanesDeps {
  root: string;
  now(): number;
  requestRender(): void;
  flat(): ReturnType<typeof labeledBacklogEntries>;
  flashMessage(message: string): void;
  flashError(err: unknown): void;
  commitBacklogEdit(file: string, subject: string): void;
  collectPending(root: string): Promise<TeamChangeView>;
  runDoctor(root: string): Promise<DoctorReport>;
  killOrphans(root: string): Promise<OrphanKillReport>;
  collectChange(root: string, role: string): Promise<RoleChangeView>;
  runStat(root: string, detail: RunDetail): Promise<string>;
}

/** Every Ctrl+<key> cycle walks its own ReadonlyArray<[key, label]> table one slot at a time,
 * wrapping past the last back to the first. Each handler holds a key the table carries (a null
 * default slot included), so findIndex always hits. */
export function nextInCycle<T>(table: ReadonlyArray<[T, string]>, current: T): T {
  const i = table.findIndex(([key]) => key === current);
  return table[(i + 1) % table.length]![0];
}

/** The null fallback in cycleLabel keeps a would-be stale key from rendering "undefined". */
export function cycleLabel<T>(table: ReadonlyArray<[T, string]>, current: T): string | null {
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
 * hint line names; the length is what readRunRowsSince takes. `null` is the default read
 * through readRunRows, kept first so the pane opens on today's behavior. */
export const HISTORY_WINDOWS: ReadonlyArray<[number | null, string]> = [
  [null, "default"],
  ...SESSION_WINDOW_TAIL,
];

/** The Ctrl+G scope cycle: team-wide (null), then each unique base role the roster names, in
 * roster order. An instance id (`feature-2`) folds into its base role because the scoped
 * collectors aggregate by base role — report-data.ts's role scope groups an instance's usage
 * with its siblings' — so cycling through the instance ids would relabel the same body with
 * names that collect it identically. `feature`/`feature-2` therefore offer one slot, and the
 * name the tab strip and hint show is the name the collector honors. */
export function scopeCycle(roleIds: readonly string[]): Array<string | null> {
  const bases: string[] = [];
  for (const id of roleIds) {
    const base = baseRoleOf(id);
    if (!bases.includes(base)) bases.push(base);
  }
  return [null, ...bases];
}

/** The History pane's session outcome cycle, Ctrl+O: all runs, then the canonical classes
 * `tumwater history --result` and the dashboard's History filter speak. The class list comes
 * from history-data.ts (HISTORY_RESULT_CLASSES) rather than a copy, so the TUI, the CLI, and
 * the dashboard bucket a result the same way; the class id doubles as the label. `null` is no
 * filter, kept first so the pane opens on today's behavior. */
export const HISTORY_RESULTS: ReadonlyArray<[HistoryResultClass | null, string]> = [
  [null, "all"],
  ...HISTORY_RESULT_CLASSES.map((c): [HistoryResultClass, string] => [
    c,
    HISTORY_RESULT_FLAG_NAMES[c],
  ]),
];

/** The Usage and Failures panes' session window cycle, Ctrl+E: the default whole-day report,
 * then 1h, 6h, 1d, and the REPORT_SINCE_MAX_MS 7d cap — the trailing windows
 * `tumwater report --since` / `tumwater report --failures --since` collect. (The dashboard's
 * report tabs stop at 1d.) The label is what the hint line names; the
 * length is what collectReportSince / collectFailureReportSince take. `null` is the default
 * REPORT_DEFAULT_DAYS shape, kept first so the panes open on today's behavior. */
export const REPORT_WINDOWS: ReadonlyArray<[number | null, string]> = [
  [null, "default"],
  ...SESSION_WINDOW_TAIL,
];

/** The shared cross-pane session and seams every pane module takes (the analog of
 * `TuiEditorSession`): the state `createTuiKeys` and the pane arms all share — the view index,
 * the roster, the shared pane scroll/budget state, the active pane's cache slot, and the armed
 * two-step Ctrl+X and Ctrl+R targets — plus every seam (`TuiPanesDeps`) and the shared cycle
 * helpers, single-homed here so the panes cannot drift. Per-pane state and arms live in each
 * pane module beside this session. */
export interface TuiPaneSession {
  /** The current pane index (the transcript/view window). */
  view: number;
  /** The current roster of role ids. */
  roleIds: string[];
  /** The within-body scroll offset (line index of the window head) shared by the Markdown
   * panes, the notes/change/trail views, and the queued/entry bodies — PgDn/PgUp there. */
  paneScroll: number;
  /** The activity pane's current line budget, refreshed by every render. */
  eventBudget: number;
  /** An open backlog entry spends the pane's first line on its title, so its body pages by
   * one line less (entryBudget). */
  entryBudget: number;
  /** The active Markdown/row pane's rendered body, computed once per activation. */
  paneCache: string | null;
  /** The armed backlog cancel (first Ctrl+X on a selected plan or bug), read by the second. */
  armed: CancelTarget | null;
  /** The backlog pane's armed target for a second Ctrl+X; moved to `armed` by beginKey. */
  cancelArmed: CancelTarget | null;
  /** The armed backlog release (first Ctrl+R on a selected Refused or Waiting-for-the-next-
   * failure plan or bug), read by the second. */
  armedRelease: CancelTarget | null;
  /** The backlog pane's armed target for a second Ctrl+R; moved to `armedRelease` by beginKey. */
  releaseArmed: CancelTarget | null;
  /** The armed notes clear (first Ctrl+X on a transcript notes view), read by the second. */
  armedNotes: string | null;
  /** The transcript pane's armed role for a second Ctrl+X; moved to `armedNotes` by beginKey. */
  notesClearArmed: string | null;
  /** The armed orphan kill (first Ctrl+K on the Health pane), read by the second. */
  armedKillOrphans: boolean;
  /** The Health pane's pending second Ctrl+K; moved to `armedKillOrphans` by beginKey. */
  killOrphansArmed: boolean;
  root: string;
  now(): number;
  requestRender(): void;
  flat(): ReturnType<typeof labeledBacklogEntries>;
  flashMessage(message: string): void;
  flashError(err: unknown): void;
  commitBacklogEdit(file: string, subject: string): void;
  collectPending(root: string): Promise<TeamChangeView>;
  runDoctor(root: string): Promise<DoctorReport>;
  killOrphans(root: string): Promise<OrphanKillReport>;
  collectChange(root: string, role: string): Promise<RoleChangeView>;
  runStat(root: string, detail: RunDetail): Promise<string>;
}

/** Build the shared pane session from the disk-side deps the aggregator received. The pane
 * modules then take this session (plus each keypress's `TuiPaneCtx`). */
export function createTuiPaneSession(deps: TuiPanesDeps): TuiPaneSession {
  return {
    view: 0,
    roleIds: [],
    paneScroll: 0,
    eventBudget: 0,
    entryBudget: 0,
    paneCache: null,
    armed: null,
    cancelArmed: null,
    armedRelease: null,
    releaseArmed: null,
    armedNotes: null,
    notesClearArmed: null,
    armedKillOrphans: false,
    killOrphansArmed: false,
    root: deps.root,
    now: deps.now,
    requestRender: deps.requestRender,
    flat: deps.flat,
    flashMessage: deps.flashMessage,
    flashError: deps.flashError,
    commitBacklogEdit: deps.commitBacklogEdit,
    collectPending: deps.collectPending,
    runDoctor: deps.runDoctor,
    killOrphans: deps.killOrphans,
    collectChange: deps.collectChange,
    runStat: deps.runStat,
  };
}
