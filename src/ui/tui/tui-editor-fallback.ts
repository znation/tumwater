// vocabulary: plain
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+L fallback editor on the Activity view's shared prompt line — the terminal twin of
 * the dashboard Settings `Fallback (free at the spend cap)` field and `tumwater config set
 * fallback`, completing the team-config knob set the model field and the budget gate point at.
 * On the Activity view (view 0, the team scope) Ctrl+L opens it pre-filled from the file's
 * top-level `fallback` (a bare selector string as-is, an array or map as compact JSON, empty
 * when unset — empty means "no fallback" on save); a role's Transcript keeps Ctrl+L for its
 * instructions editor, which runs after this arm. Enter writes through the shared
 * setConfigKey/unsetConfigKey family — so setConfigKey JSON-parses the typed text (a
 * `["omlx/..."]` becomes the step list, `omlx/...` the literal selector) and validateConfig
 * owns the value's truth. The skeleton (mode flag, held registry, Esc/Ctrl+L/Ctrl+T exit) is
 * createTeamConfigKeyEditor's. */
export function createFallbackEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "fallback",
    openCtrl: "l",
    configKey: "fallback",
    prefill: (s) => {
      const existing = loadConfigSafe(s.root).config?.fallback;
      return typeof existing === "string"
        ? existing
        : existing && typeof existing === "object"
          ? JSON.stringify(existing)
          : "";
    },
    openFlash:
      "edit the team's fallback model (fallback, a model id or a JSON map by tier; empty clears): Enter to save, Esc to cancel",
    clearedFlash: "team fallback cleared",
    setFlash: (text) => `team fallback set to ${text}`,
  });
}
