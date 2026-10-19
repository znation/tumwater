// vocabulary: plain
import { setRoleModelFields } from "../../config/config-write.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import { rawRoleField } from "../../roles/role-view.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+X role-model editor on the Transcript view's shared prompt line, the terminal twin
 * of `tumwater role <id> --model` / `--clear-model` and the dashboard role drawer's Model
 * overrides editor. It owns its mode flag, its saved-draft pair, and the role pinned when it
 * opened, so a roster shift cannot redirect the write. Enter writes the viewed base role's
 * `roles.<base>.model` through the shared setRoleModelFields the CLI and the drawer use — so
 * checkModelTripleField (a non-empty model id or a bare tier name like `strong`) owns the
 * value's truth, and an empty line clears the override — and Esc, Ctrl+X again, and Ctrl+T
 * cancel by restoring the prompt draft. Mutually exclusive with the other editors on the one
 * prompt line via the session's held registry. On the notes view Ctrl+X keeps its clear-notes
 * meaning, and on every non-Transcript view it falls through to its own pane arms, so the arm
 * takes the line only on a role's Transcript when it is not showing notes. */
export function createRoleModelEditor(session: TuiEditorSession): TuiEditorModule {
  let roleModelMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // The role pinned when the editor opened, so Enter writes the same role's override even if
  // syncRoster shrinks or reorders the roster while the editor is open.
  let lockedRole: string | null = null;

  // Leave role-model mode (Esc, Ctrl+X again, or Ctrl+T): restore the saved prompt text.
  const exitRoleModelMode = (): void => {
    if (!roleModelMode) return;
    roleModelMode = false;
    session.held.roleModel = false;
    session.restorePromptFrom(savedInput, savedCursor);
    lockedRole = null;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "x") {
      // Ctrl+X edits the viewed role's own model override on its Transcript view — the
      // terminal twin of `tumwater role <id> --model` and the dashboard role drawer's Model
      // overrides editor. Entering pre-fills the override from the FILE's raw
      // `roles.<base>.model` (empty when unset) and saves the prompt text; leaving restores
      // it. The guard takes the line only on a role's Transcript that is not showing notes
      // (view 1..roleIds.length, !noteMode): on the notes view Ctrl+X keeps clearing notes,
      // and on every other view it falls through to the pane arms (the backlog cancel, the
      // queued cancel, the Health retire). While open, Ctrl+X toggles the editor out.
      if (roleModelMode) {
        exitRoleModelMode();
        return true;
      }
      if (!(ctx.view >= 1 && ctx.view <= ctx.roleIds.length) || ctx.noteMode) return false;
      const role = ctx.roleIds[ctx.view - 1]!;
      const held = session.heldEditorFlash("roleModel");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      // Pin the role first so the write below is safe against a mid-edit roster shift, then
      // pre-fill from the file's own entry — one fresh read per open is the smallest honest
      // source; a broken config degrades to no pre-fill and the write reports the error. The
      // FILE (rawRoleField) is the source of truth, not the merged config: overlayDefaults
      // seeds every built-in role's model from the catalog, so the merged value cannot tell an
      // operator override from a seeded default, and clearing a role that only has the seed
      // would otherwise be a no-op the operator could not see.
      lockedRole = role;
      const base = baseRoleOf(role);
      const existing = rawRoleField(session.root, base, "model");
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      roleModelMode = true;
      session.held.roleModel = true;
      session.input = typeof existing === "string" ? existing : "";
      session.cursor = session.input.length;
      session.flashMessage(
        `edit ${role}'s model override (a model id or tier name like strong; empty clears): Enter to save, Esc to cancel`,
      );
      return true;
    }
    if (key.name === "escape" && roleModelMode) {
      // Esc cancels role-model mode, restoring the previous prompt text.
      exitRoleModelMode();
      return true;
    }
    if (key.name === "return" && roleModelMode) {
      // Enter commits the override through the shared setter the CLI's `--model`/`--clear-model`
      // and the dashboard drawer use: a whitespace-trimmed empty line clears the key
      // (`{ model: "" }`), otherwise the typed text is written as-is — checkModelTripleField
      // (a non-empty model id or a bare tier name like `strong`) owns the value's truth when
      // the write lands. A rejected value flashes and STAYS in edit mode so the operator can
      // fix it; success restores the saved prompt text.
      const role = lockedRole!;
      const text = session.input.trim();
      const result = setRoleModelFields(session.root, baseRoleOf(role), {
        model: text === "" ? "" : text,
      });
      if (result.ok) {
        exitRoleModelMode();
        session.flashMessage(
          text === "" ? `${role}: model override cleared` : `${role}: model override set to ${text}`,
        );
      } else {
        session.flashMessage(result.error); // broken config or write failure — stay in edit mode
      }
      return true;
    }
    return false;
  };

  return {
    handleKey,
    exit: exitRoleModelMode,
  };
}
