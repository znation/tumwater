// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+E notify-hook editor on the Activity view's shared prompt line — the terminal twin
 * of the dashboard Settings `Notify hook` field and `tumwater config set notify`, so an
 * operator can point the orchestrator's notable-event command at a new shell command without
 * leaving the terminal (or test it without guessing, the way the Health view's Ctrl+N test
 * lets them). It owns its mode flag and its saved-draft pair. Enter writes the top-level
 * `notify` through the shared setConfigKey/unsetConfigKey family the CLI and the dashboard
 * use — so setConfigKey JSON-parses the typed text (a bare command stays the literal string,
 * while a typed number or object becomes a non-string and validateConfig owns the value's
 * truth) — and Esc, Ctrl+E again, and Ctrl+T cancel by restoring the prompt draft. Mutually
 * exclusive with the other editors on the one prompt line via the session's held registry.
 * The Team scope is the only scope, so the editor takes the line on the Activity view
 * (view 0) alone; on every other view Ctrl+E keeps its own meaning (the Report window cycle,
 * the Health reclaim, the notes/Brief file replace). */
export function createNotifyEditor(session: TuiEditorSession): TuiEditorModule {
  let notifyMode = false;
  let savedInput = "";
  let savedCursor = 0;

  // Leave notify-edit mode (Esc, Ctrl+E again, or Ctrl+T): restore the saved prompt text.
  const exitNotifyMode = (): void => {
    if (!notifyMode) return;
    notifyMode = false;
    session.held.notify = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "e") {
      // Ctrl+E edits the team's notify hook on the Activity view (view 0) — the terminal
      // twin of the dashboard Settings `Notify hook` field and `tumwater config set
      // notify`, so an operator can change the shell command the orchestrator runs on a
      // notable event without leaving the terminal. On every non-Activity view Ctrl+E keeps
      // its other meaning — the guard lets the key fall through to the Report-window cycle,
      // the Health reclaim and the notes/Brief file replace, which run after this arm.
      // While open, Ctrl+E toggles the editor out. Entering pre-fills the line from the
      // FILE's `notify` (one fresh read per open is the smallest honest source; a broken
      // config degrades to no pre-fill and the write reports the error) and saves the
      // prompt text; leaving restores it. The team key owns no role, so no role is pinned.
      if (notifyMode) {
        exitNotifyMode();
        return true;
      }
      if (ctx.view !== 0) return false;
      const held = session.heldEditorFlash("notify");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode
        // may not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      const existing = loadConfigSafe(session.root).config?.notify ?? "";
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      notifyMode = true;
      session.held.notify = true;
      session.input = existing;
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's notify hook (notify, the shell command run on notable events; empty clears): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && notifyMode) {
      // Esc cancels notify-edit mode, restoring the previous prompt text.
      exitNotifyMode();
      return true;
    }
    if (key.name === "return" && notifyMode) {
      // Enter commits the hook through the shared setter family the CLI and the dashboard
      // Settings field use: a whitespace-trimmed empty line clears the key
      // (`unsetConfigKey`), otherwise `setConfigKey` writes the top-level `notify` as the
      // typed text — setConfigKey JSON-parses it, so a bare command like `notify-me`
      // stays the literal string while a typed `42` or `{"a":1}` becomes a non-string —
      // and validateConfig's notify block owns the value's truth, rejecting a non-string
      // with nothing written. An invalid value flashes and STAYS in edit mode so the
      // operator can fix it; success restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, "notify")
          : setConfigKey(session.root, "notify", session.input.trim());
      if (result.ok) {
        exitNotifyMode();
        session.flashMessage(
          text === "" ? "notify hook cleared" : `notify hook set to ${text}`,
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
    exit: exitNotifyMode,
  };
}
