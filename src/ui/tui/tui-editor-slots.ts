import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+W worktree-pool editor on the shared prompt line, the terminal twin of the
 * dashboard Settings `Worktree slots` field and `tumwater config set worktreeSlots`. It owns
 * its mode flag and its saved-draft pair. Enter writes through the shared
 * setConfigKey/unsetConfigKey family the CLI and the dashboard use — so validateConfig owns
 * the value's truth (`worktreeSlots must be an integer of at least 1`) — and Esc, Ctrl+W
 * again, and Ctrl+T cancel by restoring the prompt draft. On the Activity view (view 0) it
 * opens pre-filled from the file's `worktreeSlots` (empty when unset — the default is
 * `maxConcurrent + 1`); on a role's Transcript view (where the shared pause editor's wake arm
 * pins Ctrl+W) it falls through so the wake editor keeps the key. Mutually exclusive with the
 * other editors on the one prompt line via the session's held registry. */
export function createSlotsEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "slots",
    openCtrl: "w",
    configKey: "worktreeSlots",
    plainIntegerKey: true,
    prefill: (s) => String(loadConfigSafe(s.root).config?.worktreeSlots ?? ""),
    openFlash:
      "edit the team's worktree pool size (worktreeSlots, an integer ≥ 1; empty restores the default of maxConcurrent + 1): Enter to save, Esc to cancel",
    clearedFlash: "worktree slots reset to the default",
    setFlash: (text) => `worktree slots set to ${text}`,
  });
}
