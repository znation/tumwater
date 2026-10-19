// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+W worktree-pool editor on the shared prompt line, the terminal twin of the
 * dashboard Settings `Worktree slots` field and `tumwater config set worktreeSlots`. It owns
 * its mode flag and its saved-draft pair. Enter writes through the shared
 * setConfigKey/unsetConfigKey family the CLI and the dashboard use — so validateConfig owns
 * the value's truth (`worktreeSlots must be an integer of at least 1`) — and Esc, Ctrl+W
 * again, and Ctrl+T cancel by restoring the prompt draft. Mutually exclusive with the other
 * editors on the one prompt line via the session's held registry. */
export function createSlotsEditor(session: TuiEditorSession): TuiEditorModule {
  let slotsMode = false;
  let savedInput = "";
  let savedCursor = 0;

  // Leave slots-edit mode (Esc, Ctrl+W again, or Ctrl+T): restore the saved prompt text.
  const exitSlotsMode = (): void => {
    if (!slotsMode) return;
    slotsMode = false;
    session.held.slots = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "w") {
      // Ctrl+W edits the team's worktree pool size on the Activity view (view 0, the team
      // scope) — the terminal twin of the dashboard Settings `Worktree slots` field and
      // `tumwater config set worktreeSlots`. On a role's Transcript view (where the shared
      // pause editor's wake arm pins Ctrl+W and `pauseEditRole !== null`), fall through so
      // the wake editor keeps the key — a role's transcript has no team scope to edit.
      if (!slotsMode && ctx.view !== 0) return false;
      const held = session.heldEditorFlash("slots");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      if (slotsMode) {
        exitSlotsMode();
        return true;
      }
      // Pre-fill from the file's own `worktreeSlots` (empty when unset — empty restores the
      // `maxConcurrent + 1` default). One fresh read per open is the smallest honest source;
      // a broken config degrades to no pre-fill and the write reports the error.
      const existing =
        loadConfigSafe(session.root).config?.worktreeSlots ?? "";
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      slotsMode = true;
      session.held.slots = true;
      session.input = String(existing);
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's worktree pool size (worktreeSlots, an integer ≥ 1; empty restores the default of maxConcurrent + 1): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && slotsMode) {
      // Esc cancels slots-edit mode, restoring the previous prompt text.
      exitSlotsMode();
      return true;
    }
    if (key.name === "return" && slotsMode) {
      // Enter commits the pool size through the shared setter family the config CLI and the
      // dashboard Settings use: an empty or whitespace-only line clears the key
      // (`unsetConfigKey`, restoring the default), otherwise `setConfigKey` writes the
      // top-level `worktreeSlots` as a JSON number. setConfigKey JSON-parses the text
      // (so "5" writes the number 5) and validateConfig owns the value's truth; both write
      // tumwater.json atomically and the running orchestrator picks the change up on its
      // next poll. An invalid value flashes and STAYS in edit mode so the operator can fix
      // it (the file is untouched); success restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, "worktreeSlots")
          : setConfigKey(session.root, "worktreeSlots", text);
      if (result.ok) {
        exitSlotsMode();
        session.flashMessage(
          text === "" ? "worktree slots reset to the default" : `worktree slots set to ${text}`,
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
    exit: exitSlotsMode,
  };
}
