
/** The prompt-line editor state the pane arms read (es.*). The mutual-exclusion guard reads
 * the shared held-editor registry (`anyEditorHeld`) rather than restating each per-editor
 * mode, so a newly added editor holds the line in every arm without touching them; the
 * remaining fields are the ones a pane arm still reads directly. */
export interface TuiPaneEditorState {
  /** The Queued pane's in-place editor (Ctrl+E): the role and queue-file basename of the entry
   * the prompt line is editing, or null when no edit is open. */
  queuedEditFor: { role: string; file: string } | null;
  /** The backlog pane's answer editor (Ctrl+A on a selected open question). */
  answerFor: { position: number; title: string } | null;
  /** The backlog pane's title editor (Ctrl+E on a selected plan or bug), a null position being
   * the new-entry form (Ctrl+N). */
  entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null;
  /** The shared held-editor registry read (`TuiEditorSession.anyEditorHeld`): true while any
   * prompt-line editor holds the line. `promptLineFree` reads this one flag instead of
   * restating each per-editor mode, so a newly added editor holds the line here without
   * touching the guard. */
  anyEditorHeld: boolean;
  /** The prompt line's typed text, when the caller carries it (the editors' state does). */
  input?: string;
}

/** The per-keypress read `createTuiKeys` passes to every pane arm — the held-editor registry
 * plus the editor fields a pane arm still reads directly — the analog of the per-module `ctx`
 * argument in `TuiEditorModule.handleKey`. The view-index and roster live on the shared
 * session, so the per-key read carries only what the editors own. */
export interface TuiPaneCtx {
  es: TuiPaneEditorState;
}

/** Whether no editor currently holds the prompt line — the mutual-exclusion contract the pane
 * arms ask before running their own one-line editors. It reads the shared held-editor registry
 * (`anyEditorHeld`), the one flag `TuiEditorSession.anyEditorHeld` maintains over every
 * prompt-line editor, so a newly added editor holds the line here without touching this check.
 * The editors consume every key that reads or writes the line and return true while one is open,
 * so by the time the pane fallback runs no editor holds the line; the explicit read keeps each
 * arm's exclusion legible instead of leaning on the routing order. */
export function promptLineFree(es: TuiPaneEditorState): boolean {
  return !es.anyEditorHeld;
}

/** The shared Ctrl+letter dispatch guard the panes that carry a one-argument ctrl route table
 * restate inline: a non-Ctrl key, or a Ctrl key whose name the table lacks, routes nowhere
 * (null), otherwise the named route runs against the pane ctx and its boolean result passes
 * through. The 2-arg-route variant in tui-panes.ts (its routes take the key too) is a
 * different shape and stays local there. */
export function ctrlRouteFor(
  ctrlRoutes: Record<string, (ctx: TuiPaneCtx) => boolean>,
  key: { ctrl?: boolean; name?: string },
  ctx: TuiPaneCtx,
): boolean | null {
  if (!key.ctrl || key.name === undefined) return null;
  const route = ctrlRoutes[key.name];
  return route === undefined ? null : route(ctx);
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
   * view repaints its notes after a replace/clear). */
  refreshNotes?(role: string): void;
  /** Repaint the Brief view's cached body after a replace write. */
  refreshBrief?(): void;
  /** The pane's slice of the render state the frame merges. */
  state?(): Record<string, unknown>;
}
