import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+U declared-check editor on the shared prompt line, the terminal twin of the dashboard
 * Settings `Declared check (JSON)` field and `tumwater config set check`. On the Activity view
 * (view 0, the team scope) with an empty prompt line Ctrl+U opens it pre-filled from
 * `loadConfigSafe`'s resolved `check` (compact JSON so it round-trips the line; an unset key
 * pre-fills empty, unlike `maxConcurrentChecks` there is no default); with text typed the same
 * Ctrl+U still kills from the line start to the cursor, and every other view keeps its own
 * Ctrl+U (the Health re-sync-install). Enter writes through the shared
 * setConfigKey/unsetConfigKey family the CLI and the Settings view use — so validateConfig owns
 * the value's truth (malformed JSON or an unknown field fails there and nothing is written) —
 * and Esc, Ctrl+U again, and Ctrl+T cancel by restoring the prompt draft. The value is an
 * object, not an integer, so there is no plain-integer arm. Mutually exclusive with the other
 * editors on the one prompt line via the session's held registry. */
export function createCheckEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "check",
    openCtrl: "u",
    configKey: "check",
    requireEmptyPrompt: true,
    prefill: (s) => {
      const existing = loadConfigSafe(s.root).config?.check;
      return existing !== undefined ? JSON.stringify(existing) : "";
    },
    openFlash:
      "edit the project's declared check (check, a JSON object like {\"command\":\"npm test\"}; empty clears): Enter to save, Esc to cancel",
    clearedFlash: "declared check cleared",
    setFlash: (text) => `declared check set to ${text}`,
  });
}
