// vocabulary: plain

/** The editor-mode flags the pane arms' exclusion guards read (es.*) — the same flags the
 * prompt-line editors consume every line-key on. Each pane arm restates its guard so its
 * mutual-exclusion contract reads on its own instead of leaning on the routing order. */
export interface TuiPaneEditorState {
  budgetMode: boolean;
  rolePromptFor: string | null;
  searchMode: boolean;
  pauseEditMode: boolean;
  queuedEditFor: { role: string; file: string } | null;
  answerFor: { position: number; title: string } | null;
  entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null;
  /** The notes view's Ctrl+E replace-notes mode holds the prompt line: the role whose notes
   * the prompt line is replacing from a typed file path, or null when closed. */
  notesEditFor: string | null;
  /** The Brief view's Ctrl+E replace-the-brief mode holds the prompt line, editing one typed
   * file path that becomes the whole brief through editInitialPrompt. */
  briefEditMode: boolean;
  /** The Health view's Ctrl+X retire mode holds the prompt line, editing a role id. */
  retireMode: boolean;
  /** The Transcript view's Ctrl+O quiet-hours mode holds the prompt line. */
  quietMode: boolean;
  /** The Transcript view's Ctrl+S min-run-interval mode holds the prompt line. */
  intervalMode: boolean;
}

/** The per-keypress read `createTuiKeys` passes to every pane arm — the editor flags the
 * arms' mutual-exclusion guards restate — the analog of the per-module `ctx` argument in
 * `TuiEditorModule.handleKey`. The view-index and roster live on the shared session, so the
 * per-key read carries only what the editors own. */
export interface TuiPaneCtx {
  es: TuiPaneEditorState;
}

/** Whether no editor currently holds the prompt line — the mutual-exclusion contract the pane
 * arms below restate when they open their own one-line editors. The editors consume every key
 * that reads or writes the line and return true while one is open, so by the time the pane
 * fallback runs the flags are already all false; the check stays explicit so each arm's
 * exclusion reads on its own instead of leaning on the routing order. */
export function promptLineFree(es: TuiPaneEditorState): boolean {
  return (
    !es.budgetMode && !es.rolePromptFor && !es.searchMode &&
    !es.pauseEditMode && !es.queuedEditFor && !es.answerFor && !es.entryEditFor &&
    !es.notesEditFor && !es.briefEditMode && !es.retireMode && !es.quietMode && !es.intervalMode
  );
}

/** The shared contract every per-pane module returns to the aggregator (createTuiPanes), the
 * analog of `TuiEditorModule`: its `handleKey` arms (true when the pane consumed the key,
 * false to fall through to the next module in the aggregator's dispatch order), the `enter`
 * half of the Ctrl+T cycle (true when it painted the active pane's cache), the `reset` a Ctrl+T
 * cycle away applies to the pane's own snapshot, the per-roster scope `dropScopes` applies, and
 * the `state` slice the frame merges. Each factory takes the shared `TuiPaneSession` it closes
 * over and owns the state and arms of the views it serves, so a change to one pane's keys or
 * state stays in that pane's module. */
export interface TuiPaneModule {
  handleKey?(
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean;
  /** The pane's half of the Ctrl+T cycle: recompute the active pane's cache if this module
   * serves the newly selected view; true when it painted. */
  enter?(): boolean;
  /** Drop the pane's snapshot state a Ctrl+T cycle away leaves on a view it is leaving. */
  reset?(): void;
  /** Drop the pane's session role scope when the incoming roster no longer names it. */
  dropScopes?(roles: string[]): void;
  /** Repaint a view's cached body after an editor wrote to the disk it renders (the notes
   * view repaints its notebook after a replace/clear). */
  refreshNotes?(role: string): void;
  /** Repaint the Brief view's cached body after a replace write. */
  refreshBrief?(): void;
  /** The pane's slice of the render state the frame merges. */
  state?(): Record<string, unknown>;
}
