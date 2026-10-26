import { baseRoleOf } from "../../roles/runner-ids.js";
import { viewedRole, type TuiEditorCtx, type TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The role-pinned editor arm (Ctrl+X role model, Ctrl+G parallel-runner count, Ctrl+S min
 * run interval) on the shared prompt line — the terminal twins of the dashboard role drawer's
 * fields and their `tumwater role <id>` flags. One factory serves all three because they share
 * the whole shape: a mode flag plus a saved-draft pair, the role pinned when the editor opened
 * (so a roster shift cannot redirect the write), the mutually-exclusive held registry, a pre-fill
 * read from the FILE's raw `roles.<base>.<field>`, and an Enter that writes through a shared
 * setter so validation owns the value's truth — the differences are the key, the held name, the
 * pre-fill formatting, the setter, and the flash strings (a no-op commit may flash its own). Esc,
 * the key again, and Ctrl+T cancel by restoring the draft. */
interface RoleKeySpec {
  /** The session's mutually-exclusive-held registry name this editor owns. */
  mode: "roleModel" | "instances" | "interval";
  /** The Ctrl+<key> arm that opens (and, while open, toggles out of) the editor. */
  openCtrl: string;
  /** True when the key must fall through to the pane arms on a role's Transcript — the
   * role-model editor yields on the notes view, where Ctrl+X clears notes. */
  yieldsOn?: (ctx: TuiEditorCtx) => boolean;
  /** The line the editor opens pre-filled with, from the file's raw entry for `base` (the
   * file, not the merged config, which cannot tell an override from a seeded default). */
  prefill: (session: TuiEditorSession, base: string) => string;
  /** Message flashed when the editor opens on `role`. */
  openFlash: (role: string) => string;
  /** Commit the trimmed line (empty means clear) for the pinned `base` role. */
  commit: (
    session: TuiEditorSession,
    base: string,
    text: string,
  ) => { ok: true; noop?: true } | { ok: false; error: string };
  /** Message flashed when the commit succeeds for `role`; `text` is empty for a clear. */
  savedFlash: (role: string, text: string) => string;
  /** Message flashed instead when the commit succeeded as a no-op (the key was already
   * unset or already held the value, so nothing was written). */
  noopFlash?: (role: string, text: string) => string;
}

/** Build a role-pinned editor. It may take the line only on a role's Transcript view
 * (view 1..roleIds.length) or when it already holds it (the toggle-out arm), and only while no
 * other editor holds the line. An invalid value flashes and STAYS in edit mode so the operator
 * can fix it; success restores the saved prompt text. */
export function createRoleKeyEditor(
  session: TuiEditorSession,
  spec: RoleKeySpec,
): TuiEditorModule {
  let mode = false;
  let restoreDraft: () => void = () => {};
  // The role pinned when the editor opened, so Enter writes the same role's key even if
  // syncRoster shrinks or reorders the roster while the editor is open.
  let lockedRole: string | null = null;

  // Leave the editor (Esc, the key again, or Ctrl+T): restore the saved prompt text.
  const exit = (): void => {
    if (!mode) return;
    mode = false;
    session.held[spec.mode] = false;
    restoreDraft();
    lockedRole = null;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === spec.openCtrl) {
      // While open the key toggles the editor out. Otherwise it opens only on a role's
      // Transcript view; elsewhere it keeps its own meaning and falls through to the pane arms.
      if (mode) {
        exit();
        return true;
      }
      if (!(ctx.view >= 1 && ctx.view <= ctx.roleIds.length) || spec.yieldsOn?.(ctx)) return false;
      const role = viewedRole(ctx);
      if (session.editorEntryDenied(spec.mode)) return true;
      // Pin the role first so the write below is safe against a mid-edit roster shift, then
      // pre-fill from the file's own entry — one fresh read per open is the smallest honest
      // source; a broken config degrades to no pre-fill and the write reports the error.
      lockedRole = role;
      const existing = spec.prefill(session, baseRoleOf(role));
      restoreDraft = session.takeDraft();
      mode = true;
      session.held[spec.mode] = true;
      session.input = existing;
      session.cursor = session.input.length;
      session.flashMessage(spec.openFlash(role));
      return true;
    }
    if (key.name === "escape" && mode) {
      // Esc cancels the editor, restoring the previous prompt text.
      exit();
      return true;
    }
    if (key.name === "return" && mode) {
      // Enter commits the whitespace-trimmed line through the spec's shared setter. A rejected
      // value flashes and STAYS in edit mode so the operator can fix it; success restores the
      // saved prompt text.
      const role = lockedRole!;
      const text = session.input.trim();
      const result = spec.commit(session, baseRoleOf(role), text);
      if (result.ok) {
        exit();
        session.flashMessage(
          result.noop && spec.noopFlash ? spec.noopFlash(role, text) : spec.savedFlash(role, text),
        );
      } else {
        session.flashMessage(result.error); // broken config or write failure — stay in edit mode
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit };
}
