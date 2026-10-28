import { listWideScope, queuedListRows, queuedRowsMatching, renderQueuedList, type QueuedListRow } from "../../inbox/inbox.js";
import { cancelRolePrompt } from "../../inbox/inbox-cancel.js";
import { movePromptToTop } from "../../inbox/inbox-top.js";
import { moveEntrySelection } from "./tui-backlog.js";
import { arrowDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { guardError } from "./tui-guard.js";
import { paneAtHead, type TuiPaneSession } from "./tui-pane-session.js";

/** The Queued pane (view roleIds.length + 6) of the TUI (src/ui/tui/tui.tsx): the prompt row
 * selection, the up/down select and Esc-to-list arms, and the Ctrl+X cancel and Ctrl+V
 * move-to-top arms. Split out of the pane-navigation monolith; it owns the pane's
 * rows/selection state and the arms that touch them. */
export function createQueuedPane(
  session: TuiPaneSession,
) {
  // The Queued pane's row selection (null = list mode): the index into queuedRows of the
  // prompt shown in full. Cleared on every Ctrl+T, like selectedEntry, so cycling back into
  // the pane starts at today's list.
  let selectedQueued: number | null = null;
  // The Queued pane's cached rows, the same queuedListRows traversal the cached
  // renderQueuedList string was built from, so a selection addresses a row's role/position
  // without re-reading the queue on every frame.
  let queuedRows: QueuedListRow[] = [];
  // The Inbox pane's active `/` search, or null: keeps only the rows whose text contains it,
  // each still under its unfiltered per-role position. Persists across Ctrl+T cycles, like
  // backlogGrep.
  let queuedGrep: string | null = null;

  // Re-read the Queued pane's rows and cached list after the queue changed (entry or cancel)
  // and clamp the row selection to the shortened queue — a selection past the new end lands
  // on the last remaining prompt, never on a stale role/position. An emptied queue clears it
  // back to list mode. The refreshed list and any clamped-in row share paneScroll, so the
  // offset resets too: a cancel that moves the selection opens the newly selected prompt at
  // its head. The one home of the queuedRows/paneCache pairing the Ctrl+T entry and the Ctrl+X
  // cancel share, so the pane's list and its selectable rows cannot drift.
  const refreshQueued = (): void => {
    queuedRows = queuedRowsMatching(queuedListRows(session.root, null, listWideScope(session.root)), queuedGrep);
    session.queuedSearchLines = queuedGrep ? 1 : 0;
    session.paneCache = renderQueuedList(queuedRows, session.now());
    selectedQueued = selectedQueued === null || queuedRows.length === 0
      ? null
      : Math.min(selectedQueued, queuedRows.length - 1);
    session.paneScroll = 0;
  };


  // Ctrl+X cancels the selected queued prompt through the CLI's own per-role path
  // (`tumwater prompt --cancel <n> --role <id>`): cancelRolePrompt removes that role's Nth
  // queue file and logs the prompt_cancelled event, so the pane, the CLI, and the dashboard
  // cancel cannot drift. It then re-reads the queue so the pane's list and rows reflect the
  // removal and the selection clamps. Its write and flash stay under one guard; the caller
  // guards on the row being defined (a no-selection list-mode press, or any other view,
  // leaves the queue untouched).
  const cancelQueuedRow = (row: QueuedListRow): void => {
    guardError(session, () => {
      const outcome = cancelRolePrompt(session.root, row.role, row.position);
      // A gone outcome is the concurrent-dequeue race (cancelRolePrompt's own contract),
      // not a failure: flash it honestly and still refresh the listing.
      session.flashMessage(
        outcome.status === "cancelled"
          ? `cancelled inbox message #${row.position} for ${row.role}`
          : `inbox message #${row.position} for ${row.role} was already gone`,
      );
      refreshQueued();
    });
  };

  // Ctrl+V moves the selected queued prompt to the head of its role's queue through the
  // CLI's own per-role path (`tumwater prompt --top <n>`): movePromptToTop renames that
  // role's Nth queue file to the head and logs the prompt_topped event, so the pane, the
  // CLI, and the dashboard cannot drift. A position-1 row is already the head (a no-op); a
  // gone outcome is the concurrent-dequeue race (movePromptToTop's own contract), not a
  // failure, so flash it honestly. Its write and flash stay under one guard; the caller
  // guards on the row being defined (a no-selection list-mode press, or any other view,
  // leaves the queues untouched).
  const moveQueuedRow = (row: QueuedListRow): void => {
    guardError(session, () => {
      if (row.position === 1) {
        // A head row is a no-op, not movePromptToTop's throw: it is already where the
        // reorder would put it, and throwing would flash an error for a press that
        // changed nothing.
        session.flashMessage(`inbox message #1 for ${row.role} is already first`);
        return;
      }
      const outcome = movePromptToTop(session.root, row.role, row.position);
      selectedQueued = null;
      refreshQueued();
      session.flashMessage(
        outcome.status === "topped"
          ? `moved inbox message #${row.position} for ${row.role} to the top: ${outcome.preview}`
          : `inbox message #${row.position} for ${row.role} was already gone`,
      );
    });
  };

  // Ctrl+X cancels the selected queued prompt and Ctrl+V moves it to its role queue's head,
  // each through the CLI's own per-role path (cancelRolePrompt / movePromptToTop). The two
  // arms share one shape — a guarded ctrl-keypress that resolves the clamped selected row,
  // runs cancel or move, and repaints — differing only in the key and the action, so one
  // helper owns the guard, the clamp, and the render.
  const handleQueuedRowAction = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
    keyName: string,
    action: (row: QueuedListRow) => void,
  ): boolean => {
    if (
      key.ctrl && key.name === keyName &&
      promptLineFree(ctx.es) &&
      session.view === session.roleIds.length + 6 && selectedQueued !== null
    ) {
      const row = queuedRows[Math.min(selectedQueued, queuedRows.length - 1)];
      if (row !== undefined) action(row);
      session.requestRender();
      return true;
    }
    return false;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (handleQueuedRowAction(key, ctx, "x", cancelQueuedRow)) return true;
    if (handleQueuedRowAction(key, ctx, "v", moveQueuedRow)) return true;
    const arrow = arrowDir(key.name);
    if (session.view === session.roleIds.length + 6 && arrow !== null) {
      // In the Queued pane, up/down select a queued prompt row in full (wrapping, the backlog
      // pane's rule) instead of editing the prompt; an empty queue has nothing to select, so
      // moveEntrySelection clears the selection. Every other view keeps today's behavior.
      // The selected body shares paneScroll with the list, so a newly opened row must start
      // at its head (the status pane's entryScroll reset on the same move), or it renders
      // scrolled into the middle of the previous row's body.
      // An open in-place editor pins the selection (its row was captured at Ctrl+E), the
      // backlog pane's answer/title rule: the arrows must not jump the highlighted body to a
      // different message while the prompt line is editing another.
      if (!ctx.es.queuedEditFor) {
        selectedQueued = moveEntrySelection(queuedRows.length, selectedQueued, arrow);
        session.paneScroll = 0;
      }
      session.requestRender();
      return true;
    }
    if (
      key.name === "escape" && selectedQueued !== null && session.view === session.roleIds.length + 6 &&
      promptLineFree(ctx.es)
    ) {
      // Esc on the Queued pane returns it to list mode; the cached list is untouched (nothing
      // was cancelled), so the pane shows the same renderQueuedList it entered with. The
      // shared paneScroll resets with the body switch, like a selection move.
      selectedQueued = null;
      paneAtHead(session);
      return true;
    }
    return false;
  };

  return {
    handleKey,
    enter: () => {
      // Queued is a synchronous read of the same queue list `tumwater prompt --list`
      // prints (renderQueuedList over queuedListRows), so it paints on entry with no
      // async collector. The now() clock keeps the age/countdown suffix testable.
      refreshQueued();
      return true;
    },
    reset() {
      // Leaving a view drops any queued-row selection; re-entering starts at the list.
      selectedQueued = null;
    },
    refreshQueued,
    applySearch(pattern: string | null): void {
      // The `/` editor's Enter: sets the applied pattern, clears the row selection, and
      // re-reads the rows so the list shows only the matches.
      queuedGrep = pattern;
      selectedQueued = null;
      refreshQueued();
      session.requestRender();
    },
    state() {
      return { selectedQueued, queuedRows, queuedGrep };
    },
  } satisfies TuiPaneModule & { refreshQueued(): void; applySearch(pattern: string | null): void };
}
