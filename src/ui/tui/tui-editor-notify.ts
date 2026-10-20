import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+E notify-hook editor on the Activity view's shared prompt line — the terminal
 * twin of the dashboard Settings `Notify hook` field and `tumwater config set notify`, so an
 * operator can point the orchestrator's notable-event command at a new shell command without
 * leaving the terminal (or test it without guessing). Enter writes the top-level `notify`
 * through the shared setConfigKey/unsetConfigKey family: setConfigKey JSON-parses the typed
 * text (a bare command stays the literal string, while a typed number or object becomes a
 * non-string and validateConfig's notify block rejects it with nothing written). The Team
 * scope is the only scope, so the editor takes the line on the Activity view (view 0) alone;
 * on every other view Ctrl+E keeps its own meaning (the Report window cycle, the Health
 * reclaim, and the notes/Brief file replace). Esc, Ctrl+E again, and Ctrl+T cancel by
 * restoring the prompt draft. Mutually exclusive with the other editors on the one prompt
 * line via the session's held registry. */
export function createNotifyEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "notify",
    openCtrl: "e",
    configKey: "notify",
    prefill: (s) => String(loadConfigSafe(s.root).config?.notify ?? ""),
    openFlash:
      "edit the team's notify hook (notify, the shell command run on notable events; empty clears): Enter to save, Esc to cancel",
    clearedFlash: "notify hook cleared",
    setFlash: (text) => `notify hook set to ${text}`,
  });
}
