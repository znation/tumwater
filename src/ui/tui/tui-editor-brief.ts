import { editBriefText } from "../../brief/brief-edit.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { readEditorPath, type TuiEditorSession } from "./tui-editor-session.js";

/** The Brief view's Ctrl+E replace-the-brief-from-a-file editor on the shared prompt line, the
 * terminal twin of `tumwater brief --file <path>` and the dashboard's Brief card. It owns its
 * `briefEdit` flag, its saved-draft pair, and the handleKey arms for its key (the toggle with
 * the `heldEditorFlash(entering)` guard clause — the shared guard priority lives in the session
 * module — plus Esc and Enter). Guarded to the Brief view (`ctx.briefMode`), so the Health
 * reclaim and Report window Ctrl+E arms keep the key on their own views. The prompt line is
 * single-line and a brief may run to BRIEF_TEXT_MAX_CHARS, so the editor takes a file path
 * and reads it verbatim, then replaces the brief through editBriefText — the same core and
 * the same checks (non-empty, at most BRIEF_TEXT_MAX_CHARS, no prompt marker) the CLI and
 * the dashboard's Brief card use, so the wording cannot drift. On success the Brief view
 * repaints the new brief in place through the session's refreshBrief seam, without leaving and
 * re-entering. */
export function createBriefEditor(session: TuiEditorSession): TuiEditorModule {
  let briefEdit = false;
  let restoreDraft: () => void = () => {};

  // Leave the brief editor (Esc or a successful Enter): restore the saved prompt text.
  const exitBriefMode = (): void => {
    if (!briefEdit) return;
    briefEdit = false;
    session.held.brief = false;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "e" && ctx.briefMode && !briefEdit) {
      // Ctrl+E opens the replace-the-brief editor on the Brief view's prompt line (mnemonic:
      // **e**dit brief — the same key the Health reclaim, Report window-cycle, Queued row-edit
      // and Backlog entry-edit arms use on their own views, guarded away here by ctx.briefMode).
      // The line edits one file path that becomes the whole brief through the same
      // editBriefText write the CLI and the dashboard's Brief card use. Entering saves the
      // prompt draft and blanks the line; leaving restores it.
      const held = session.heldEditorFlash("brief");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping
        // the held mode's saved draft.
        session.flashMessage(held);
        return true;
      }
      // Mid-recall, hand the arrows' saved draft back before the brief editor takes the line —
      // the same settle the other editors do — so leaving restores the draft, not a history
      // entry, with no stale recall state riding along.
      restoreDraft = session.takeDraft();
      briefEdit = true;
      session.held.brief = true;
      session.input = "";
      session.cursor = 0;
      session.flashMessage("replace the brief from a file — Enter to save, Esc to cancel");
      return true;
    }
    if (key.name === "escape" && briefEdit) {
      // Esc cancels the brief editor, restoring the previous prompt text and writing nothing.
      exitBriefMode();
      session.flashMessage("brief edit cancelled");
      return true;
    }
    if (key.name === "return" && briefEdit) {
      // Enter reads the typed path whole and replaces the brief through editBriefText — the
      // shared write the CLI's `--file` and the dashboard's Brief card make, so the 4096 cap,
      // the marker check and its wording cannot drift. An empty path, a missing file, an
      // unreadable file, and a refused replacement all flash and STAY in the editor so the
      // operator can pick another file; only a successful replacement exits, repainting the
      // Brief pane in place with the shared outcome wording.
      const text = readEditorPath(session);
      if (text === null) return true;
      void editBriefText(session.root, text).then(
        (outcome) => {
          if (!outcome.ok) {
            // The core refused the replacement (empty, over the cap, a marker, no prompt
            // block): flash the reason and stay so the operator can pick another file.
            session.flashMessage(outcome.error);
            return;
          }
          session.refreshBrief();
          exitBriefMode();
          session.flashMessage(
            outcome.changed
              ? `brief updated in ${outcome.file}${outcome.committed ? " (committed to main)" : ""}`
              : "brief unchanged",
          );
        },
        (err: unknown) => {
          // The read/replace/commit threw: flash the reason and stay in the editor so the
          // operator can fix things, as the other editor Enter arms do.
          session.flashError(err);
        },
      );
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitBriefMode };
}
