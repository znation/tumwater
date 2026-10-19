// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import { rawRoleField } from "../../roles/role-view.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+G parallel-runner-count editor on the shared prompt line, the terminal twin of
 * `tumwater role <id> --instances` and the dashboard role drawer's instance-count editor. It
 * owns its mode flag, its saved-draft pair, and the role pinned when it opened, so a roster
 * shift cannot redirect the write. Enter writes `roles.<base>.instances` through the shared
 * setConfigKey/unsetConfigKey family the CLI and the drawer use — so validateConfig's
 * INSTANCE_COUNT (an integer 1–8) and INSTANCE_ROLES (feature and bugfix) own the value's
 * truth, exactly as the CLI documents — and Esc, Ctrl+G again, and Ctrl+T cancel by restoring
 * the prompt draft. Ctrl+G keeps its scope-cycle meaning on every other view: the arm consumes
 * the key only on a role's Transcript and returns false elsewhere. Mutually exclusive with the
 * other editors on the one prompt line via the session's held registry. */
export function createInstancesEditor(session: TuiEditorSession): TuiEditorModule {
  let instancesMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // The role pinned when the editor opened, so Enter writes the same role's override even if
  // syncRoster shrinks or reorders the roster while the editor is open.
  let lockedRole: string | null = null;

  // Leave instances mode (Esc, Ctrl+G again, or Ctrl+T): restore the saved prompt text.
  const exitInstancesMode = (): void => {
    if (!instancesMode) return;
    instancesMode = false;
    session.held.instances = false;
    session.restorePromptFrom(savedInput, savedCursor);
    lockedRole = null;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "g") {
      // Ctrl+G edits the viewed role's own parallel-runner count on its Transcript view — the
      // last per-role hold `tumwater role <id> --instances` and the dashboard drawer write.
      // Every other view keeps its scope-cycle meaning: the guard below lets the key fall
      // through to the pane arms (Activity's, History's, and the report scope cycles) unless
      // the instances editor already holds the line, in which case Ctrl+G is the toggle-out
      // arm. Entering pre-fills the count from the FILE's raw `roles.<base>.instances` (empty
      // when unset — empty means "cleared, run a single runner" on save) and saves the prompt
      // text; leaving restores it. There is no own range or role check: validateConfig's
      // INSTANCE_COUNT and INSTANCE_ROLES are the value's truth, so `0`, `9`, `1.5` and a
      // non-instance role surface the same error the CLI and the drawer do.
      if (!instancesMode && !(ctx.view >= 1 && ctx.view <= ctx.roleIds.length)) return false;
      const role = ctx.roleIds[ctx.view - 1]!;
      const held = session.heldEditorFlash("instances");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      if (instancesMode) {
        exitInstancesMode();
        return true;
      }
      // Pin the role first so the write below is safe against a mid-edit roster shift, then
      // pre-fill from the file's own entry — one fresh read per open is the smallest honest
      // source; a broken config degrades to no pre-fill and the write reports the error. The
      // FILE (rawRoleField) is the source of truth, not the merged config: config-views.ts's
      // configForRole may default the count, so the merged value cannot tell an operator
      // override from the one-runner default, and clearing a role that never set the key
      // would otherwise be a no-op the operator could not see.
      lockedRole = role;
      const base = baseRoleOf(role);
      const existing = rawRoleField(session.root, base, "instances");
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      instancesMode = true;
      session.held.instances = true;
      session.input = typeof existing === "number" ? String(existing) : "";
      session.cursor = session.input.length;
      session.flashMessage(
        `edit ${role}'s parallel-runner count (an integer 1-8; feature and bugfix only; empty clears): Enter to save, Esc to cancel`,
      );
      return true;
    }
    if (key.name === "escape" && instancesMode) {
      // Esc cancels instances mode, restoring the previous prompt text.
      exitInstancesMode();
      return true;
    }
    if (key.name === "return" && instancesMode) {
      // Enter commits the count through the shared setter family the CLI's `--instances` and
      // the dashboard drawer use: an empty or whitespace-only line clears the key
      // (`unsetConfigKey`), otherwise `setConfigKey` writes `roles.<base>.instances` as the
      // raw text the CLI passes, and validateConfig's INSTANCE_COUNT and INSTANCE_ROLES own
      // the value's truth (a `0`, an `8`-breaker, a `1.5`, an `abc` or a non-instance role is
      // rejected with nothing written). An invalid or rejected value flashes and STAYS in edit
      // mode so the operator can fix it; success restores the saved prompt text. Clearing a
      // key the file never set is a no-op success.
      const role = lockedRole!;
      const cfgKey = `roles.${baseRoleOf(role)}.instances`;
      const text = session.input.trim();
      if (text === "") {
        const result = unsetConfigKey(session.root, cfgKey);
        if (result.ok) {
          exitInstancesMode();
          session.flashMessage(`${role}: instances cleared`);
        } else {
          session.flashMessage(result.error); // broken config or write failure — stay in edit mode
        }
        return true;
      }
      const result = setConfigKey(session.root, cfgKey, text);
      if (result.ok) {
        exitInstancesMode();
        session.flashMessage(`${role}: instances set to ${text}`);
      } else {
        session.flashMessage(result.error); // rejected value or write failure — stay open
      }
      return true;
    }
    return false;
  };

  return {
    handleKey,
    exit: exitInstancesMode,
  };
}
