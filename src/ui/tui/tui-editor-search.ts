import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The shared `/` search editor on the prompt line: over the History pane's run rows or the
 * Activity feed's events. It owns its mode flag (`searchMode`), its target pane (`searchFor`),
 * its saved-draft pair, and the applyHistorySearch / applyActivitySearch leaves. Mutually
 * exclusive with the other editors via the session's held registry. */
export function createSearchEditor(session: TuiEditorSession): TuiEditorModule {
  let searchMode = false;
  // Which pane the shared `/` editor feeds: History's run search, Activity's event search, the
  // Backlog pane's entry search, or a role's live-transcript search. The target is captured when
  // `/` opens so a roster change mid-edit cannot retarget Enter.
  let searchFor: "history" | "activity" | "backlog" | "queued" | "transcript" = "history";
  let restoreDraft: () => void = () => {};

  // Leave the shared search editor (Enter applies, Esc cancels, Ctrl+T cycles): restore the
  // saved prompt text, and reset the recall state with it — the same settle contract the budget
  // and role-prompt editors honor. The applied activityGrep/historyGrep itself persists across
  // view cycling, like historyWindow/historyResult.
  const exitHistorySearch = (): void => {
    if (!searchMode) return;
    searchMode = false;
    session.held.search = false;
    restoreDraft();
  };

  // `/` opens a free-text search on the prompt line (the pager's search key; this project
  // already reserves `/` for a meta action): over the History pane's run rows on History,
  // over the Activity feed's events on Activity, and over the Backlog pane's active entries
  // on Backlog, over the Inbox pane's queued prompts, and over a role's live transcript.
  // Guarded to those views and to an empty line, so elsewhere it types into the prompt as
  // today and a director draft is never disturbed. Pre-fills the applied pattern so Enter
  // re-submits it and the operator can edit it; Esc cancels without applying.
  const openSearchEdit = (ctx: TuiEditorCtx): boolean => {
    if (
      searchMode || session.anyEditorHeld() || session.input !== "" ||
      !(
        ctx.view === 0 || ctx.view === ctx.roleIds.length + 1 || ctx.view === ctx.roleIds.length + 4 || ctx.view === ctx.roleIds.length + 6 ||
        (ctx.view >= 1 && ctx.view <= ctx.roleIds.length && !ctx.noteMode && !ctx.changeMode)
      )
    ) return false;
    restoreDraft = session.takeDraft();
    if (ctx.view === 0) searchFor = "activity";
    else if (ctx.view === ctx.roleIds.length + 1) searchFor = "backlog";
    else if (ctx.view === ctx.roleIds.length + 4) searchFor = "history";
    else if (ctx.view === ctx.roleIds.length + 6) searchFor = "queued";
    else searchFor = "transcript";
    searchMode = true;
    session.held.search = true;
    const applied = { activity: ctx.activityGrep, history: ctx.trailSearch ? ctx.trailGrep : ctx.historyGrep, backlog: ctx.backlogGrep, queued: ctx.queuedGrep, transcript: ctx.transcriptGrep }[searchFor];
    const noun = { activity: "events", history: ctx.trailSearch ? "transcript" : "runs", backlog: "backlog", queued: "inbox", transcript: "transcript" }[searchFor];
    session.input = applied ?? "";
    session.cursor = session.input.length;
    session.flashMessage(`search ${noun}: Enter to filter, Esc to cancel`);
    return true;
  };

  // Esc cancels the History search without applying it; the applied pattern is unchanged.
  const cancelSearchEdit = (): boolean => {
    if (!searchMode) return false;
    exitHistorySearch();
    return true;
  };

  // Enter applies the trimmed line to the pane the editor opened over: Activity sets
  // activityGrep (an empty line clears it) and resets the scroll to the live tail — the
  // offset indexed the old filtered list; History recomputes its row cache now (the pane
  // is showing) and re-enters at its head; Backlog sets backlogGrep and clears its entry
  // selection so the next frame starts in list mode; Inbox sets queuedGrep, clears its row
  // selection, and re-reads the filtered rows. A successful apply restores the saved
  // prompt draft through exitHistorySearch, the shared editor's exit.
  const submitSearchEdit = (): boolean => {
    if (!searchMode) return false;
    const applied = session.input.trim() === "" ? null : session.input.trim();
    if (searchFor === "activity") session.applyActivitySearch(applied);
    else if (searchFor === "history") session.applyHistorySearch(applied);
    else if (searchFor === "backlog") session.applyBacklogSearch(applied);
    else if (searchFor === "queued") session.applyQueuedSearch(applied);
    else session.applyTranscriptSearch(applied);
    exitHistorySearch();
    session.flashMessage(applied === null ? "search cleared" : `search: "${applied}"`);
    return true;
  };

  const handleKey = (
    str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (!key.ctrl && str === "/") return openSearchEdit(ctx);
    if (key.name === "escape" && searchMode) return cancelSearchEdit();
    if (key.name === "return" && searchMode) return submitSearchEdit();
    return false;
  };

  return { handleKey, exit: exitHistorySearch };
}
