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
  /** Whether `/` on History targets the run trail's showing transcript. */
  trailSearch: boolean;
  /** The trail transcript's applied search. */
  trailGrep: string | null;
  /** The Activity pane's active free-text search (the `/` editor's applied pattern). */
  activityGrep: string | null;
  /** The Backlog pane's active free-text search (the `/` editor's applied pattern). */
  backlogGrep: string | null;
  /** The Inbox pane's active free-text search (the `/` editor's applied pattern). */
  queuedGrep: string | null;
  /** The viewed role's live-transcript search (the `/` editor's applied pattern). */
  transcriptGrep: string | null;
  /** Whether the viewed role's pane shows its notes (Ctrl+N) instead of the live
   * transcript — the notes Ctrl+E editor's open guard: it may only take the prompt line
   * while the notes view is up, so the Report window arm keeps Ctrl+E on its own views. */
  noteMode: boolean;
  /** Whether the viewed role's pane shows its change step (the second Ctrl+N step). */
  changeMode: boolean;
  /** Whether the Brief view is selected — the brief Ctrl+E editor's open guard: it may only
   * take the prompt line on the Brief view, so the Health reclaim and Report window arms keep
   * Ctrl+E on their own views. */
  briefMode: boolean;
}

/** The role id at the viewed index (`ctx.roleIds[ctx.view - 1]`) — the role each open-arm
 * editor reads before acting. Its callers carry the in-range guard themselves (an editor
 * falls through on a view outside the roster), so the deref is safe exactly where the
 * inline form was. One home keeps the read identical across the editor family. */
export function viewedRole(ctx: TuiEditorCtx): string {
  return ctx.roleIds[ctx.view - 1]!;
}

/** `viewedRole` when the view is inside the roster, else null — the budget editor's open-arm
 * guard, which keeps the role null on the Activity view instead of falling through. */
export function viewedRoleOrNull(ctx: TuiEditorCtx): string | null {
  return ctx.view >= 1 && ctx.view <= ctx.roleIds.length ? ctx.roleIds[ctx.view - 1]! : null;
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
