// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+A team-model editor on the Activity view's shared prompt line, the terminal twin
 * of the dashboard Settings `Model` field and `tumwater config set model` — the one Settings
 * row the Activity view could edit but did not (the daily cap via Ctrl+B and the team's quiet
 * hours via Ctrl+S already had editors). It owns its mode flag and its saved-draft pair; it
 * pins no role, because the team key owns no role. Enter writes through the shared
 * setConfigKey/unsetConfigKey family the CLI and the drawer use — setConfigKey JSON-parses
 * the text, so a bare model id stays a literal string while a `{"strong":"..."}` map becomes
 * the map, and validateConfig owns the value's truth (a number like `42` flashes the model
 * validator's message and stays open) — and Esc, Ctrl+A again, and Ctrl+T cancel by restoring
 * the prompt draft. The editor opens only on view 0: on a role's Transcript Ctrl+A keeps its
 * per-loop abort meaning, and on Backlog it keeps the answer editor's key, both guarded by the
 * `ctx.view === 0` condition that makes this arm fall through everywhere else. Mutually
 * exclusive with the other editors on the one prompt line via the session's held registry. */
export function createModelEditor(session: TuiEditorSession): TuiEditorModule {
  let modelMode = false;
  let savedInput = "";
  let savedCursor = 0;

  // Leave model-edit mode (Esc, Ctrl+A again, or Ctrl+T): restore the saved prompt text.
  const exitModelMode = (): void => {
    if (!modelMode) return;
    modelMode = false;
    session.held.model = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "a") {
      // Ctrl+A edits the team's top-level `model` on the Activity view (view 0) — the
      // terminal twin of the dashboard Settings `Model` field and `tumwater config set
      // model`. Every other view keeps Ctrl+A: a role's Transcript keeps it for the
      // per-loop abort, Backlog keeps it for answering a selected question, so this arm
      // falls through (returns false) off view 0. While open, Ctrl+A toggles the editor
      // out. Entering pre-fills the line from one fresh read of the FILE's top-level
      // `model` — a selector string as-is, a tier map as compact JSON, empty when unset —
      // and saves the prompt text; leaving restores it.
      if (modelMode) {
        exitModelMode();
        return true;
      }
      if (ctx.view !== 0) return false;
      const held = session.heldEditorFlash("model");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode
        // may not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      const existing = loadConfigSafe(session.root).config?.model;
      const prefill =
        existing === undefined
          ? ""
          : typeof existing === "string"
            ? existing
            : JSON.stringify(existing);
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      modelMode = true;
      session.held.model = true;
      session.input = prefill;
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's model (model, a model id or a JSON map by tier like {\"strong\":\"...\"}; empty clears): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && modelMode) {
      // Esc cancels model-edit mode, restoring the previous prompt text.
      exitModelMode();
      return true;
    }
    if (key.name === "return" && modelMode) {
      // Enter commits the model through the shared setter family the CLI's `config set
      // model` and the dashboard Settings field use: an empty or whitespace-only line
      // clears the key (`unsetConfigKey`), otherwise `setConfigKey` writes the top-level
      // `model`, which JSON-parses the text — a bare selector id stays a literal string
      // while a `{"strong":"..."}` map becomes the map. validateConfig (via
      // writeConfigMutation) owns the value's truth, so a number like `42` flashes its
      // `model must be a model id or a map by tier (small, default, strong)` message and
      // stays in edit mode with the text kept; both writes write tumwater.json atomically.
      // An invalid value flashes and STAYS in edit mode so the operator can fix it;
      // success restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, "model")
          : setConfigKey(session.root, "model", text);
      if (result.ok) {
        exitModelMode();
        session.flashMessage(
          text === "" ? "team model cleared" : `team model set to ${text}`,
        );
      } else {
        // Broken config or write failure — stay in edit mode.
        session.flashMessage(result.error);
      }
      return true;
    }
    return false;
  };

  return {
    handleKey,
    exit: exitModelMode,
  };
}
