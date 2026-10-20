import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+A team-model editor on the Activity view's shared prompt line, the terminal twin
 * of the dashboard Settings `Model` field and `tumwater config set model`. Enter writes the
 * top-level `model` through the shared setConfigKey/unsetConfigKey family — setConfigKey
 * JSON-parses the text, so a bare model id stays a literal string while a `{"strong":"..."}`
 * map becomes the map, and validateConfig owns the value's truth (a number like `42` flashes
 * the model validator's message and stays open). The editor opens only on view 0: on a role's
 * Transcript Ctrl+A keeps its per-role abort meaning, and on Backlog it keeps the answer
 * editor's key. */
export function createModelEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "model",
    openCtrl: "a",
    configKey: "model",
    // A selector string as-is, a tier map as compact JSON, empty when unset.
    prefill: (s) => {
      const existing = loadConfigSafe(s.root).config?.model;
      return existing === undefined
        ? ""
        : typeof existing === "string"
          ? existing
          : JSON.stringify(existing);
    },
    openFlash:
      "edit the team's model (model, a model id or a JSON map by tier like {\"strong\":\"...\"}; empty clears): Enter to save, Esc to cancel",
    clearedFlash: "team model cleared",
    setFlash: (text) => `team model set to ${text}`,
  });
}
