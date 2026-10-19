// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+L fallback editor on the Activity view's shared prompt line — the terminal twin of
 * the dashboard Settings `Fallback (free at the spend cap)` field and `tumwater config set
 * fallback`, completing the team-config knob set the model field and the budget gate point at.
 * It owns its mode flag and its saved-draft pair. Enter writes the top-level `fallback` through
 * the shared setConfigKey/unsetConfigKey family the CLI and the dashboard use — so setConfigKey
 * JSON-parses the typed text and validateConfig owns the value's truth — and Esc, Ctrl+L again,
 * and Ctrl+T cancel by restoring the prompt draft. Mutually exclusive with the other editors on
 * the one prompt line via the session's held registry. The Team scope is the only scope, so the
 * editor takes the line on the Activity view (view 0) alone; a role's Transcript keeps Ctrl+L
 * for its instructions editor, which runs after this arm. The team key owns no role, so no role
 * is pinned. */
export function createFallbackEditor(session: TuiEditorSession): TuiEditorModule {
  let fallbackMode = false;
  let savedInput = "";
  let savedCursor = 0;

  // Leave fallback mode (Esc, Ctrl+L again, or Ctrl+T): restore the saved prompt text.
  const exitFallbackMode = (): void => {
    if (!fallbackMode) return;
    fallbackMode = false;
    session.held.fallback = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "l") {
      // Ctrl+L edits the team's fallback model on the Activity view (view 0) — the terminal
      // twin of the dashboard Settings `Fallback (free at the spend cap)` field and `tumwater
      // config set fallback`, so an operator can point a role's work where it goes when a
      // model fails or the spend cap is reached without leaving the terminal. On every
      // non-Activity view Ctrl+L keeps its other meaning — the guard lets the key fall through
      // to the instructions editor (a role's Transcript), which runs after this arm. While
      // open, Ctrl+L toggles the editor out. Entering pre-fills the line from the FILE's
      // top-level `fallback` (a bare selector string as-is, an array or map as compact JSON,
      // empty when unset — empty means "no fallback" on save) and saves the prompt text;
      // leaving restores it. The team key owns no role, so no role is pinned.
      if (fallbackMode) {
        exitFallbackMode();
        return true;
      }
      if (ctx.view !== 0) return false;
      const held = session.heldEditorFlash("fallback");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      const existing = loadConfigSafe(session.root).config?.fallback;
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      fallbackMode = true;
      session.held.fallback = true;
      session.input =
        typeof existing === "string"
          ? existing
          : existing && typeof existing === "object"
            ? JSON.stringify(existing)
            : "";
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's fallback model (fallback, a model id or a JSON map by tier; empty clears): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && fallbackMode) {
      // Esc cancels fallback mode, restoring the previous prompt text.
      exitFallbackMode();
      return true;
    }
    if (key.name === "return" && fallbackMode) {
      // Enter commits the value through the shared setter family the CLI and the dashboard
      // Settings field use: an empty or whitespace-only line clears the key
      // (`unsetConfigKey`), otherwise `setConfigKey` writes the top-level `fallback` as the
      // typed text — setConfigKey JSON-parses it, so `["omlx/..."]` becomes the step list and
      // `{"strong":{"model":"omlx/..."}}` the tier map while `omlx/...` collapses to the
      // literal selector string — and validateConfig owns the value's truth (a number is
      // rejected with nothing written). Both write tumwater.json atomically and the running
      // orchestrator picks the change up on its next poll. An invalid value flashes and STAYS
      // in edit mode so the operator can fix it; success restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, "fallback")
          : setConfigKey(session.root, "fallback", text);
      if (result.ok) {
        exitFallbackMode();
        session.flashMessage(
          text === ""
            ? "team fallback cleared"
            : `team fallback set to ${text}`,
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
    exit: exitFallbackMode,
  };
}
