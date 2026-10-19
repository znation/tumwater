// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+P provider-concurrency-caps editor on the Activity view's shared prompt line — the
 * terminal twin of the dashboard Settings `Provider concurrency caps (JSON)` field and
 * `tumwater config set maxConcurrentPerProvider`, completing the run-concurrency knob set
 * `tumwater doctor`'s checkProviderContention points at. It owns its mode flag and its
 * saved-draft pair. Enter writes the top-level `maxConcurrentPerProvider` through the shared
 * setConfigKey/unsetConfigKey family the CLI and the dashboard use — so setConfigKey
 * JSON-parses the typed text and validateConfig's map block owns the value's truth — and Esc,
 * Ctrl+P again, and Ctrl+T cancel by restoring the prompt draft. Mutually exclusive with the
 * other editors on the one prompt line via the session's held registry. The Team scope is the
 * only scope, so the editor takes the line on the Activity view (view 0) alone; a role's
 * Transcript keeps Ctrl+P for its pause editor, which runs after this arm. */
export function createProviderCapsEditor(session: TuiEditorSession): TuiEditorModule {
  let providerCapsMode = false;
  let savedInput = "";
  let savedCursor = 0;

  // Leave provider-caps mode (Esc, Ctrl+P again, or Ctrl+T): restore the saved prompt text.
  const exitProviderCapsMode = (): void => {
    if (!providerCapsMode) return;
    providerCapsMode = false;
    session.held.providerCaps = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "p") {
      // Ctrl+P edits the team's per-provider run caps on the Activity view (view 0) — the
      // terminal twin of the dashboard Settings `Provider concurrency caps (JSON)` field and
      // `tumwater config set maxConcurrentPerProvider`, so an operator can raise the cap
      // `tumwater doctor` names without leaving the terminal. On every non-Activity view Ctrl+P
      // keeps its other meaning — the guard lets the key fall through to the pause editor (a
      // role's Transcript), which runs after this arm. While open, Ctrl+P toggles the editor out.
      // Entering pre-fills the line from the FILE's top-level `maxConcurrentPerProvider`
      // (compact JSON when set, empty when unset — empty means "no caps" on save) and saves the
      // prompt text; leaving restores it. The team key owns no role, so no role is pinned.
      if (providerCapsMode) {
        exitProviderCapsMode();
        return true;
      }
      if (ctx.view !== 0) return false;
      const held = session.heldEditorFlash("providerCaps");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      const existing = loadConfigSafe(session.root).config?.maxConcurrentPerProvider;
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      providerCapsMode = true;
      session.held.providerCaps = true;
      session.input = existing !== undefined ? JSON.stringify(existing) : "";
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's provider concurrency caps (maxConcurrentPerProvider, a JSON object like {\"anthropic\":2}; empty clears): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && providerCapsMode) {
      // Esc cancels provider-caps mode, restoring the previous prompt text.
      exitProviderCapsMode();
      return true;
    }
    if (key.name === "return" && providerCapsMode) {
      // Enter commits the map through the shared setter family the CLI and the dashboard
      // Settings field use: an empty or whitespace-only line clears the key
      // (`unsetConfigKey`), otherwise `setConfigKey` writes the top-level
      // `maxConcurrentPerProvider` as the typed text — setConfigKey JSON-parses it, so
      // `{"anthropic":2}` becomes the object while `anthropic` collapses to the literal
      // string — and validateConfig's map block owns the value's truth (a non-object or a
      // non-positive-integer cap is rejected with nothing written). Both write tumwater.json
      // atomically and the running orchestrator picks the change up on its next poll. An
      // invalid value flashes and STAYS in edit mode so the operator can fix it; success
      // restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, "maxConcurrentPerProvider")
          : setConfigKey(session.root, "maxConcurrentPerProvider", text);
      if (result.ok) {
        exitProviderCapsMode();
        session.flashMessage(
          text === ""
            ? "provider concurrency caps cleared"
            : `provider concurrency caps set to ${text}`,
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
    exit: exitProviderCapsMode,
  };
}
