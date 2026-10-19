// vocabulary: plain
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+P provider-concurrency-caps editor on the Activity view's shared prompt line — the
 * terminal twin of the dashboard Settings `Provider concurrency caps (JSON)` field and
 * `tumwater config set maxConcurrentPerProvider`, completing the run-concurrency knob set
 * `tumwater doctor`'s checkProviderContention points at. Enter writes the top-level
 * `maxConcurrentPerProvider` through the shared setConfigKey/unsetConfigKey family the CLI and
 * the dashboard use — so setConfigKey JSON-parses the typed text and validateConfig's map block
 * owns the value's truth — and Esc, Ctrl+P again, and Ctrl+T cancel by restoring the prompt
 * draft. Mutually exclusive with the other editors on the one prompt line via the session's
 * held registry. The Team scope is the only scope, so the editor takes the line on the Activity
 * view (view 0) alone; a role's Transcript keeps Ctrl+P for its pause editor, which runs after
 * this arm. */
export function createProviderCapsEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "providerCaps",
    openCtrl: "p",
    configKey: "maxConcurrentPerProvider",
    prefill: (s) => {
      const existing = loadConfigSafe(s.root).config?.maxConcurrentPerProvider;
      return existing !== undefined ? JSON.stringify(existing) : "";
    },
    openFlash:
      "edit the team's provider concurrency caps (maxConcurrentPerProvider, a JSON object like {\"anthropic\":2}; empty clears): Enter to save, Esc to cancel",
    clearedFlash: "provider concurrency caps cleared",
    setFlash: (text) => `provider concurrency caps set to ${text}`,
  });
}
