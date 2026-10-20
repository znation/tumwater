import { saveRoleNote } from "../../agent/role-notes-write.js";
import { readTextIfExists } from "../../files/files.js";
import { roleNotesPath } from "../../paths.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The notes view's Ctrl+E replace-notes-from-a-file editor on the shared prompt line, the
 * terminal twin of `tumwater role <id> --notes-file <path>` and the dashboard drawer's
 * textarea. It owns its `notesEditFor` flag, its saved-draft pair, and the handleKey arms for
 * its key (the toggle with the `heldEditorFlash(entering)` guard clause — the shared guard
 * priority lives in the session module — plus Esc, Ctrl+E again, and Enter). Guarded to the
 * notes view (`ctx.noteMode`), so the Report window's Ctrl+E arm keeps the key on its own
 * views. The prompt line is single-line and a note may be multiline up to ROLE_NOTES_MAX_BYTES,
 * so the editor takes a file path and reads it verbatim — exactly the CLI's own
 * non-interactive replacement, the way the Activity view's Ctrl+V attach editor also takes a
 * path. The write goes through saveRoleNote (the same write the CLI and the dashboard drawer
 * make), so the 4 KB cap and its wording cannot drift; the fresh read is repainted through the
 * session's refreshNotes seam. */
export function createNotesEditor(session: TuiEditorSession): TuiEditorModule {
  let notesEditFor: string | null = null;
  let restoreDraft: () => void = () => {};

  // Leave the notes editor (Esc, Ctrl+E again, or Ctrl+T): restore the saved prompt text with
  // no note written.
  const exitNotesMode = (): void => {
    if (notesEditFor === null) return;
    notesEditFor = null;
    session.held.notes = null;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (
      key.ctrl && key.name === "e" && ctx.noteMode &&
      // The pane's noteMode closure goes stale when syncRoster shrinks the roster past the
      // viewed role (it never resets the pane's flags), so the same in-range guard every
      // transcript editor arm carries must hold here too before its view indexes roleIds.
      ctx.roleIds.length > 0 && ctx.view >= 1 && ctx.view <= ctx.roleIds.length
    ) {
      // Ctrl+E toggles the replace-notes editor on the notes view's prompt line (mnemonic:
      // **e**dit notes — the same key the Report window's window-cycle arm and the Queued
      // pane's row-edit arm use on their own views, guarded away here by ctx.noteMode). The
      // line edits one file path that becomes the role's whole note through the same
      // saveRoleNote write the CLI and the dashboard drawer use. Entering saves the prompt
      // draft and blanks the line; leaving restores it.
      const held = session.heldEditorFlash("notes");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping
        // the held mode's saved draft.
        session.flashMessage(held);
        return true;
      }
      if (notesEditFor !== null) {
        exitNotesMode();
      } else {
        // Mid-recall, hand the arrows' saved draft back before the notes editor takes the
        // line — the same settle the role editors do — so leaving restores the
        // draft, not a history entry, with no stale recall state riding along.
        const role = ctx.roleIds[ctx.view - 1]!; // defined: the open-arm range guard above pins the view into roleIds
        restoreDraft = session.takeDraft();
        notesEditFor = role;
        session.held.notes = role;
        session.input = "";
        session.cursor = 0;
        session.flashMessage(`replace ${role}'s notes from a file — Enter to save, Esc to cancel`);
      }
      return true;
    }
    if (key.name === "escape" && notesEditFor !== null) {
      // Esc cancels the notes editor, restoring the previous prompt text and writing nothing.
      exitNotesMode();
      session.flashMessage("notes edit cancelled");
      return true;
    }
    if (key.name === "return" && notesEditFor !== null) {
      // Enter reads the typed path whole and saves it through saveRoleNote — the shared write
      // the CLI's `--notes-file` and the dashboard drawer make, so the 4 KB cap and its wording
      // cannot drift. An empty path, a missing file, an unreadable file, and an over-cap note
      // all flash and STAY in the editor so the operator can fix the path; an empty file
      // clears the note. On success the notes view repaints the new note without leaving and
      // re-entering, and the editor exits with the shared success wording.
      const role = notesEditFor;
      const p = session.input.trim();
      if (p === "") {
        session.flashMessage("a file path is required");
        return true;
      }
      let text: string | null;
      try {
        text = readTextIfExists(p);
      } catch (err) {
        session.flashError(err);
        return true;
      }
      if (text === null) {
        session.flashMessage(`no such file: ${p}`);
        return true;
      }
      try {
        const message = saveRoleNote(roleNotesPath(session.root, role), text);
        session.refreshNotes(role);
        exitNotesMode();
        session.flashMessage(message);
      } catch (err) {
        // The write or the 4 KB cap refused the note: flash the reason and stay in the editor
        // so the operator can fix the path.
        session.flashError(err);
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitNotesMode };
}
