import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+Y claude subscription-window reserve editor on the Activity view's shared prompt
 * line — the terminal twin of the dashboard Settings `Claude window reserve
 * (backends.claude.windowReserve)` field and `tumwater config set claudeWindowReserve`. Enter
 * writes the top-level `claudeWindowReserve`
 * through the shared setConfigKey/unsetConfigKey family, so validateConfig's claudeWindowReserve
 * block owns the value's truth. The team scope is the only scope, so the editor takes the line
 * on the Activity view (view 0) alone; a History pane keeps Ctrl+Y for its per-role Summary
 * toggle, which runs after this arm. */
export function createClaudeReserveEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "claudeReserve",
    openCtrl: "y",
    configKey: "claudeWindowReserve",
    prefill: (s) => {
      const existing = loadConfigSafe(s.root).config?.claudeWindowReserve;
      return existing !== undefined ? JSON.stringify(existing) : "";
    },
    openFlash:
      "edit the team's claude subscription-window reserve (backends.claude.windowReserve, a JSON object like {\"seven_day\":0.8}; empty clears): Enter to save, Esc to cancel",
    clearedFlash: "claude window reserve cleared",
    setFlash: (text) => `claude window reserve set to ${text}`,
  });
}
