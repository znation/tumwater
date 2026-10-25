import { saveRoleNote } from "../../agent/role-notes-write.js";
import { roleNotesPath } from "../../paths.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createRoleFileEditor } from "./tui-editor-role-file.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The notes view's Ctrl+E replace-notes-from-a-file editor on the shared prompt line, the
 * terminal twin of `tumwater role <id> --notes-file <path>` and the dashboard drawer's
 * textarea. Guarded to the notes view (`ctx.noteMode`), so the Report window's Ctrl+E arm keeps
 * the key on its own views. The prompt line is single-line and a note may be multiline up to
 * ROLE_NOTES_MAX_BYTES, so the editor takes a file path and reads it verbatim — exactly the
 * CLI's own non-interactive replacement, the way the Activity view's Ctrl+V attach editor also
 * takes a path. The write goes through saveRoleNote (the same write the CLI and the dashboard
 * drawer make), so the 4 KB cap and its wording cannot drift; the fresh read is repainted
 * through the session's refreshNotes seam. The open/exit/read framing lives in the shared
 * createRoleFileEditor helper that also serves the instructions editor. */
export function createNotesEditor(session: TuiEditorSession): TuiEditorModule {
  return createRoleFileEditor(session, {
    held: "notes",
    openCtrl: "e",
    mayOpen: (ctx) =>
      // The pane's noteMode closure goes stale when syncRoster shrinks the roster past the
      // viewed role (it never resets the pane's flags), so the same in-range guard every
      // transcript editor arm carries must hold here too before its view indexes roleIds.
      ctx.noteMode && ctx.roleIds.length > 0 && ctx.view >= 1 && ctx.view <= ctx.roleIds.length,
    openFlash: (role) => `replace ${role}'s notes from a file — Enter to save, Esc to cancel`,
    cancelFlash: "notes edit cancelled",
    commit: (s, role, text) => {
      try {
        return { ok: true, message: saveRoleNote(roleNotesPath(s.root, role), text) };
      } catch (err) {
        // The write or the 4 KB cap refused the note: return the reason so the caller flashes
        // it and stays in the editor for the operator to fix the path.
        return { ok: false, reason: err };
      }
    },
    flashFailure: (s, reason) => s.flashError(reason),
    refresh: (s, role) => s.refreshNotes(role),
  });
}
