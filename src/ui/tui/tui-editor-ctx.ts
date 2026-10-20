import type { QueuedListRow } from "../../inbox/inbox.js";

/** The pane state the editor open arms read and the search editor pre-fills from. The factory
 * receives these per keypress; the pane (`createTuiKeys`) owns them. */
export interface TuiEditorCtx {
  /** The current pane index (the transcript/view window). */
  view: number;
  /** The current roster of role ids. */
  roleIds: string[];
  /** The project-status pane's entry selection (null = list mode). */
  selectedEntry: number | null;
  /** The Queued pane's row selection (null = list mode). */
  selectedQueued: number | null;
  /** The Queued pane's cached rows, the same list renderQueuedList built. */
  queuedRows: QueuedListRow[];
  /** The History pane's active free-text search (the `/` editor's applied pattern). */
  historyGrep: string | null;
  /** The Activity pane's active free-text search (the `/` editor's applied pattern). */
  activityGrep: string | null;
  /** The Backlog pane's active free-text search (the `/` editor's applied pattern). */
  backlogGrep: string | null;
  /** Whether the viewed role's pane shows its notes (Ctrl+N) instead of the live
   * transcript — the notes Ctrl+E editor's open guard: it may only take the prompt line
   * while the notes view is up, so the Report window arm keeps Ctrl+E on its own views. */
  noteMode: boolean;
  /** Whether the Brief view is selected — the brief Ctrl+E editor's open guard: it may only
   * take the prompt line on the Brief view, so the Health reclaim and Report window arms keep
   * Ctrl+E on their own views. */
  briefMode: boolean;
}

/** The shared contract every per-editor module returns to the aggregator: its handleKey arms
 * (true when the editor consumed the key, false to fall through to the next editor in the
 * aggregator's priority order), the exit helper the shared exitAll calls, and — for the budget
 * editor — the snapshot sync the render drives. */
export interface TuiEditorModule {
  handleKey(
    str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean;
  exit(): void;
  sync?(capUsd: number, budgetFree: boolean): void;
}
