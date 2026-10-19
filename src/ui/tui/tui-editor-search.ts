// vocabulary: plain
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The shared `/` search editor on the prompt line: over the History pane's tick rows or the
 * Activity feed's events. It owns its mode flag (`searchMode`), its target pane (`searchFor`),
 * its saved-draft pair, and the applyHistorySearch / applyActivitySearch leaves. Mutually
 * exclusive with the other editors via the session's held registry. */
export function createSearchEditor(session: TuiEditorSession): TuiEditorModule {
  let searchMode = false;
  // Which pane the shared `/` editor feeds: History's tick search, Activity's event search, or
  // the Backlog pane's entry search. The target is captured when `/` opens so a roster change
  // mid-edit cannot retarget Enter.
  let searchFor: "history" | "activity" | "backlog" = "history";
  let searchSavedInput = "";
  let searchSavedCursor = 0;

  // Leave the shared search editor (Enter applies, Esc cancels, Ctrl+T cycles): restore the
  // saved prompt text, and reset the recall state with it — the same settle contract the budget
  // and role-prompt editors honor. The applied activityGrep/historyGrep itself persists across
  // view cycling, like historyWindow/historyResult.
  const exitHistorySearch = (): void => {
    if (!searchMode) return;
    searchMode = false;
    session.held.search = false;
    session.restorePromptFrom(searchSavedInput, searchSavedCursor);
  };

  const handleKey = (
    str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (
      !key.ctrl && str === "/" && !searchMode && !session.held.budget &&
      !session.held.rolePromptFor && !session.held.pause &&
      !session.held.queued && !session.held.answer && !session.held.entry &&
      !session.held.attach && !session.held.notes && !session.held.brief &&
      !session.held.retire && !session.held.quiet && !session.held.interval &&
      !session.held.instructions && !session.held.providerCaps && !session.held.concurrency && !session.held.slots &&
      !session.held.notify && !session.held.backends && !session.held.fallback && !session.held.roleModel &&
      (ctx.view === 0 || ctx.view === ctx.roleIds.length + 1 || ctx.view === ctx.roleIds.length + 4) && session.input === ""
    ) {
      // `/` opens a free-text search on the prompt line (the pager's search key; this project
      // already reserves `/` for a meta action): over the History pane's tick rows on History,
      // over the Activity feed's events on Activity, and over the Backlog pane's active entries
      // on Backlog. Guarded to those three views and to an empty line, so elsewhere it types
      // into the prompt as today and a director draft is never disturbed. Pre-fills the applied
      // pattern so Enter re-submits it and the operator can edit it; Esc cancels without applying.
      session.settleDraft((t) => (searchSavedInput = t), (n) => (searchSavedCursor = n));
      searchFor = ctx.view === 0 ? "activity" : ctx.view === ctx.roleIds.length + 1 ? "backlog" : "history";
      searchMode = true;
      session.held.search = true;
      session.input = (searchFor === "activity" ? ctx.activityGrep : searchFor === "history" ? ctx.historyGrep : ctx.backlogGrep) ?? "";
      session.cursor = session.input.length;
      session.flashMessage(searchFor === "activity" ? "search events: Enter to filter, Esc to cancel" : searchFor === "backlog" ? "search backlog: Enter to filter, Esc to cancel" : "search runs: Enter to filter, Esc to cancel");
      return true;
    }
    if (key.name === "escape" && searchMode) {
      // Esc cancels the History search without applying it; the applied pattern is unchanged.
      exitHistorySearch();
      return true;
    }
    if (key.name === "return" && searchMode) {
      // Enter applies the trimmed line to the pane the editor opened over: Activity sets
      // activityGrep (an empty line clears it) and resets the scroll to the live tail — the
      // offset indexed the old filtered list; History recomputes its row cache now (the pane
      // is showing) and re-enters at its head; Backlog sets backlogGrep and clears its entry
      // selection so the next frame starts in list mode. A successful apply restores the saved
      // prompt draft through exitHistorySearch, the shared editor's exit.
      const applied = session.input.trim() === "" ? null : session.input.trim();
      if (searchFor === "activity") session.applyActivitySearch(applied);
      else if (searchFor === "history") session.applyHistorySearch(applied);
      else session.applyBacklogSearch(applied);
      exitHistorySearch();
      session.flashMessage(applied === null ? "search cleared" : `search: "${applied}"`);
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitHistorySearch };
}
