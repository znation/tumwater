import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { readEditorPath, type TuiEditorSession } from "./tui-editor-session.js";

/** The role-located file-read editor arm (Ctrl+E replace-notes, Ctrl+L replace-standing-
 * instructions) on the shared prompt line — the terminal twin of the `tumwater role <id>
 * --notes-file`/`--instructions-file` CLI flags and the dashboard drawer's rows. One factory
 * serves both because they share the whole shape: the role pinned when the editor opened (so a
 * roster shift cannot redirect the write), the mutually-exclusive held registry slot, a prompt
 * line that takes one typed file PATH read verbatim through the shared readEditorPath (the same
 * read the CLI's non-interactive replacements make), a write through the caller's shared
 * setter, a repaint of the notes view on success, and an Esc/return framing. The differences
 * are the key, the held name, the open guard (the notes editor additionally requires the notes
 * view), the flash strings, and the write — which the caller owns so its success wording and
 * its refusal (flashed by the caller's chosen channel) cannot drift. */
interface RoleFileEditorSpec {
  /** The session's mutually-exclusive-held registry slot this editor owns: the role being
   * edited, or null when closed. */
  held: "notes" | "instructions";
  /** The Ctrl+<key> arm that opens (and, while open, toggles out of) the editor. */
  openCtrl: string;
  /** True when the key may open on this view — the in-range role guard every transcript arm
   * carries, plus any view restriction (the notes editor additionally requires the notes
   * mode). Only consulted before the editor is open, so it may assume the roster guard. */
  mayOpen: (ctx: TuiEditorCtx) => boolean;
  /** Message flashed when the editor opens on `role`. */
  openFlash: (role: string) => string;
  /** Message flashed when the editor is cancelled with Esc. */
  cancelFlash: string;
  /** Commit the read file text for `role` through the caller's shared setter. A refused write
   * returns `{ok:false}` and STAYS in the editor so the operator can fix the path; a success
   * returns the message flashed after the caller's repaint and the editor's exit. */
  commit: (
    session: TuiEditorSession,
    role: string,
    text: string,
  ) => { ok: true; message: string } | { ok: false; reason: unknown };
  /** Flash a refused commit's reason — flashMessage for a config-family error, flashError for
   * a thrown write — whichever says what the caller's write failed with. */
  flashFailure: (session: TuiEditorSession, reason: unknown) => void;
  /** Repaint the notes view after a successful write. */
  refresh: (session: TuiEditorSession, role: string) => void;
}

/** Build a role-located file-read editor. It takes the line only on a role's Transcript /
 * notes view (the caller's mayOpen guard) and only while no other editor holds the line, reads
 * the typed path whole, and writes through the caller's shared setter. A refused write flashes
 * and STAYS in edit mode so the operator can fix the path; success repaints the notes and
 * restores the saved prompt text. */
export function createRoleFileEditor(
  session: TuiEditorSession,
  spec: RoleFileEditorSpec,
): TuiEditorModule {
  // The role pinned when the editor opened, or null when closed.
  let editFor: string | null = null;
  let restoreDraft: () => void = () => {};

  // Leave the editor (Esc, the key again, or a successful Enter): restore the saved prompt
  // text with no write.
  const exit = (): void => {
    if (editFor === null) return;
    editFor = null;
    session.held[spec.held] = null;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === spec.openCtrl && spec.mayOpen(ctx)) {
      // The key toggles the editor out while open; otherwise it opens on the guarded view and
      // elsewhere keeps its own meaning and falls through to the pane arms.
      if (session.editorEntryDenied(spec.held)) return true;
      if (editFor !== null) {
        exit();
      } else {
        // Mid-recall, hand the arrows' saved draft back before the editor takes the line — the
        // same settle the role editors do — so leaving restores the draft, not a history entry,
        // with no stale recall state riding along.
        const role = ctx.roleIds[ctx.view - 1]!; // defined: the open-arm range guard above pins the view into roleIds
        restoreDraft = session.takeDraft();
        editFor = role;
        session.held[spec.held] = role;
        session.input = "";
        session.cursor = 0;
        session.flashMessage(spec.openFlash(role));
      }
      return true;
    }
    if (key.name === "escape" && editFor !== null) {
      // Esc cancels the editor, restoring the previous prompt text and writing nothing.
      exit();
      session.flashMessage(spec.cancelFlash);
      return true;
    }
    if (key.name === "return" && editFor !== null) {
      // Enter reads the typed path whole and commits it through the caller's shared setter —
      // the same setConfigKey/saveRoleNote write the CLI's non-interactive replacements and the
      // dashboard drawer make, so the caps and their wording cannot drift. A missing or
      // unreadable path (readEditorPath) or a refused write flashes and STAYS in the editor so
      // the operator can fix the path; success repaints the notes and exits with the shared
      // success wording.
      const role = editFor;
      const text = readEditorPath(session);
      if (text === null) return true;
      const outcome = spec.commit(session, role, text);
      if (outcome.ok) {
        spec.refresh(session, role);
        exit();
        session.flashMessage(outcome.message);
      } else {
        spec.flashFailure(session, outcome.reason);
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit };
}
