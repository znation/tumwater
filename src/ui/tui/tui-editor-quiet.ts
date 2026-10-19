// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import { DIRECTOR_ROLE } from "../../roles/roles.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+O quiet-hours editor on the shared prompt line, the terminal twin of the dashboard
 * role drawer's `Quiet hours` row and `tumwater role <id> --quiet-hours`. It owns its mode
 * flag, its saved-draft pair, and the role pinned when it opened, so a roster shift cannot
 * redirect the write. Enter writes through the shared setConfigKey/unsetConfigKey family the
 * CLI and the drawer use — so checkQuietHours (naming `quietHoursPerRole.<id>`) and
 * validateConfig own the window's truth — and Esc, Ctrl+O again, and Ctrl+T cancel by
 * restoring the prompt draft. Mutually exclusive with the other editors on the one prompt
 * line via the session's held registry. */
export function createQuietEditor(session: TuiEditorSession): TuiEditorModule {
  let quietMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // The role scope pinned when the editor opened, so Enter writes the same role's window even
  // if syncRoster shrinks or reorders the roster while the editor is open.
  let lockedRole: string | null = null;

  // Leave quiet-edit mode (Esc, Ctrl+O again, or Ctrl+T): restore the saved prompt text.
  const exitQuietMode = (): void => {
    if (!quietMode) return;
    quietMode = false;
    session.held.quiet = false;
    session.restorePromptFrom(savedInput, savedCursor);
    lockedRole = null;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "o") {
      // Ctrl+O edits the viewed role's own quiet-hours window (mnemonic: the silent *o*ur
      // hours) on its Transcript view. Every non-transcript view keeps Ctrl+O — the guard
      // lets the key fall through to the pane arms (Activity's event-type cycle, History's
      // outcome cycle, Health's problems-only toggle) unless the quiet editor already holds
      // the line, in which case Ctrl+O is the toggle-out arm below. Entering pre-fills the
      // window from `quietHoursPerRole.<base>` (empty when unset — empty means "off" on
      // save) and saves the prompt text; leaving restores it. The director is exempt — its
      // quietHoursPerRole.director entry is inert (the gate and doctor both exempt it).
      if (!quietMode && !(ctx.view >= 1 && ctx.view <= ctx.roleIds.length)) return false;
      const role = ctx.roleIds[ctx.view - 1]!;
      const held = session.heldEditorFlash("quiet");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      if (role === DIRECTOR_ROLE) {
        session.flashMessage("the director has no quiet hours");
        return true;
      }
      if (quietMode) {
        exitQuietMode();
        return true;
      }
      // Pin the role first so the write below is safe against a mid-edit roster shift, then
      // pre-fill from the file's own entry — one fresh read per open is the smallest honest
      // source; a broken config degrades to no pre-fill and the write reports the error.
      lockedRole = role;
      const existing =
        loadConfigSafe(session.root).config?.quietHoursPerRole?.[baseRoleOf(role)] ?? "";
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      quietMode = true;
      session.held.quiet = true;
      session.input = existing;
      session.cursor = session.input.length;
      session.flashMessage(
        `edit ${role}'s quiet hours (e.g. 23:00-07:00, empty clears): Enter to save, Esc to cancel`,
      );
      return true;
    }
    if (key.name === "escape" && quietMode) {
      // Esc cancels quiet-edit mode, restoring the previous prompt text.
      exitQuietMode();
      return true;
    }
    if (key.name === "return" && quietMode) {
      // Enter commits the window through the shared setter family the CLI's `--quiet-hours`
      // and the dashboard drawer use: an empty or whitespace-only line clears the key
      // (`unsetConfigKey`), otherwise `setConfigKey` writes the dotted `quietHoursPerRole
      // .<base>` entry as a JSON string. checkQuietHours (naming the dotted key) rejects a
      // malformed window and validateConfig guards the write; both write tumwater.json
      // atomically and the running orchestrator picks the change up on its next poll. An
      // invalid window flashes and STAYS in edit mode so the operator can fix it; success
      // restores the saved prompt text.
      const role = lockedRole!;
      const cfgKey = `quietHoursPerRole.${baseRoleOf(role)}`;
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, cfgKey)
          : setConfigKey(session.root, cfgKey, JSON.stringify(text));
      if (result.ok) {
        exitQuietMode();
        session.flashMessage(
          text === "" ? `${role}: quiet hours cleared` : `${role}: quiet hours set to ${text}`,
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
    exit: exitQuietMode,
  };
}
