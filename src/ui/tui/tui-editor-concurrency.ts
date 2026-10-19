// vocabulary: plain
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+N run-cap editor on the shared prompt line, the terminal twin of the dashboard
 * Settings `Max concurrent runs` field and `tumwater config set maxConcurrent`. It owns its
 * mode flag and its saved-draft pair. On the Activity view (view 0, the team scope) Ctrl+N
 * opens it pre-filled from the file's `maxConcurrent`; every other view keeps its own Ctrl+N.
 * Enter writes through the shared setConfigKey/unsetConfigKey family the CLI and the
 * Settings view use — so validateConfig owns the value's truth (a `0` or non-number fails
 * there and nothing is written: `maxConcurrent` must be a positive integer) — and Esc,
 * Ctrl+N again, and Ctrl+T cancel by restoring the prompt draft. Mutually exclusive with the
 * other editors on the one prompt line via the session's held registry. On Enter the factory
 * trims the line before writing it and flashing the value, so a typed ` 9 ` saves and reports
 * as `9` — the OLD pass-through editor flashed the raw line; the four share the trimmed path. */
export function createConcurrencyEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "concurrency",
    openCtrl: "n",
    configKey: "maxConcurrent",
    prefill: (s) => String(loadConfigSafe(s.root).config?.maxConcurrent ?? ""),
    openFlash:
      "edit the team's run cap (maxConcurrent, an integer ≥ 1; empty restores the default): Enter to save, Esc to cancel",
    clearedFlash: "max concurrent runs reset to the default",
    setFlash: (text) => `max concurrent runs set to ${text}`,
  });
}
