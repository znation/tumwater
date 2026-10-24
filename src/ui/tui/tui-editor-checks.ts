import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createTeamConfigKeyEditor } from "./tui-editor-config.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+K check-cap editor on the shared prompt line, the terminal twin of the dashboard
 * Settings `Max concurrent checks` field and `tumwater config set maxConcurrentChecks`. It owns
 * its mode flag and its saved-draft pair. On the Activity view (view 0, the team scope) with an
 * empty prompt line Ctrl+K opens it pre-filled from `loadConfigSafe`'s resolved
 * `maxConcurrentChecks` (default-filled, so an unset key pre-fills 2, never an empty line — the
 * plan's 'empty when unset' never occurs); with text typed the same Ctrl+K still kills from the
 * cursor to the line end, and every other view keeps its own Ctrl+K (the Health orphan kill).
 * Enter writes through the shared setConfigKey/unsetConfigKey family the CLI and the Settings
 * view use — so validateConfig owns the value's truth (a `0` or non-number fails there and
 * nothing is written: `maxConcurrentChecks` must be a positive integer) — and Esc, Ctrl+K again,
 * and Ctrl+T cancel by restoring the prompt draft. Plain-integer spellings are refused before the
 * write, so an exponent like `2e0` cannot slip past validateConfig's integer check. Mutually
 * exclusive with the other editors on the one prompt line via the session's held registry. */
export function createChecksEditor(session: TuiEditorSession): TuiEditorModule {
  return createTeamConfigKeyEditor(session, {
    mode: "checks",
    openCtrl: "k",
    configKey: "maxConcurrentChecks",
    plainIntegerKey: true,
    requireEmptyPrompt: true,
    prefill: (s) => String(loadConfigSafe(s.root).config?.maxConcurrentChecks ?? ""),
    openFlash:
      "edit the team's check cap (maxConcurrentChecks, an integer ≥ 1; empty restores the default): Enter to save, Esc to cancel",
    clearedFlash: "max concurrent checks reset to the default",
    setFlash: (text) => `max concurrent checks set to ${text}`,
  });
}
