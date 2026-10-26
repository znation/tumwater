import { releaseQuarantinedTest } from "../../review/known-flakes.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Failures view's Ctrl+X release editor on the shared prompt line, the terminal twin of
 * `tumwater quarantine --release <n>` and the dashboard Failures card's Release button. Like
 * the retire editor it owns its `releaseMode` flag, its saved-draft pair, and the handleKey
 * arms for its key (the toggle with the `heldEditorFlash(entering)` guard clause — the shared
 * guard priority lives in the session module — plus Esc and Enter). Guarded to the Failures
 * view (`ctx.view === roleIds.length + 3`), so every other view's Ctrl+X arm (Transcript clears
 * notes, Backlog/Inbox/Pending cancel, History model filter, Activity backends) keeps the key.
 * Enter runs the same `releaseQuarantinedTest(session.root, test)` core the CLI and the
 * dashboard button call, with a typed test path as its confirmation (no two-press arm): the
 * exact path the Failures list shows, Enter to release, Esc to cancel. A success removes the
 * entry from `.tumwater/state/quarantine.json`, exits the editor, flashes the outcome, and
 * repaints the Failures body; a name not in the list flashes `not in the flake quarantine` and
 * STAYS open so the operator can fix the name; an empty name flashes and stays. */
export function createQuarantineReleaseEditor(session: TuiEditorSession): TuiEditorModule {
  let releaseMode = false;
  let restoreDraft: () => void = () => {};

  // Leave release-edit mode (Esc, Enter's success path, or Ctrl+T): restore the saved prompt
  // text.
  const exitReleaseMode = (): void => {
    if (!releaseMode) return;
    releaseMode = false;
    session.held.release = false;
    restoreDraft();
  };

  // Open release-edit mode on the Failures view's prompt line (Ctrl+X). The Failures index
  // guard keeps the same key's other arms (Transcript notes-clear, Backlog cancel, and the
  // like) on their own views; a guard miss returns false so the key falls through. The line
  // edits one quarantined test path, typed exactly as the Failures list shows it; Enter
  // releases that test through the same releaseQuarantinedTest core the CLI and the dashboard
  // button use. Entering saves the prompt draft and blanks the line; leaving restores it.
  const openReleaseEdit = (ctx: TuiEditorCtx): boolean => {
    if (ctx.view !== ctx.roleIds.length + 3 || releaseMode) return false;
    if (session.editorEntryDenied("release")) return true;
    // Mid-recall, hand the arrows' saved draft back before the release editor takes the line —
    // the same settle the retire and role editors do — so leaving restores the draft, not a
    // history entry, with no stale recall state riding along.
    restoreDraft = session.takeDraft();
    releaseMode = true;
    session.held.release = true;
    session.input = "";
    session.cursor = 0;
    session.flashMessage("release a quarantined test: type its test path as the Failures list shows it, Enter to release, Esc to cancel");
    return true;
  };

  // Esc cancels release-edit mode, restoring the previous prompt text and removing nothing.
  const cancelReleaseEdit = (): boolean => {
    exitReleaseMode();
    session.flashMessage("release cancelled");
    return true;
  };

  // Enter releases the typed test path through releaseQuarantinedTest — the same core, and
  // the same single-press confirmation, the CLI's `tumwater quarantine --release <n>` and
  // the dashboard Failures card's Release button use — then flashes the shared outcome
  // wording and repaints the Failures body so the released line is gone. An empty name, or
  // one not in the quarantine, flashes and STAYS in the editor so the operator can fix it.
  const submitReleaseEdit = (): boolean => {
    const test = session.input.trim();
    if (test === "") {
      session.flashMessage("a test name is required");
      return true;
    }
    if (!releaseQuarantinedTest(session.root, test)) {
      session.flashMessage(`not in the flake quarantine: ${test}`);
      return true;
    }
    exitReleaseMode();
    session.flashMessage(`released quarantined test ${test} — the gate no longer excuses it`);
    session.refreshReport();
    return true;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "x") return openReleaseEdit(ctx);
    if (key.name === "escape" && releaseMode) return cancelReleaseEdit();
    if (key.name === "return" && releaseMode) return submitReleaseEdit();
    return false;
  };

  return { handleKey, exit: exitReleaseMode };
}
