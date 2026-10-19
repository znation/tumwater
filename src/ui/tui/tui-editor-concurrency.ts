// vocabulary: plain
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+N run-cap editor on the shared prompt line, the terminal twin of the dashboard
 * Settings `Max concurrent runs` field and `tumwater config set maxConcurrent`. It owns its
 * mode flag and its saved-draft pair. On the Activity view (view 0, the team scope) Ctrl+N
 * opens it pre-filled from the file's `maxConcurrent`; every other view keeps its own Ctrl+N.
 * Enter writes through the shared setConfigKey/unsetConfigKey family the CLI and the
 * Settings view use — so validateConfig owns the value's truth — and Esc, Ctrl+N again, and
 * Ctrl+T cancel by restoring the prompt draft. Mutually exclusive with the other editors on
 * the one prompt line via the session's held registry. */
export function createConcurrencyEditor(session: TuiEditorSession): TuiEditorModule {
  let concurrencyMode = false;
  let savedInput = "";
  let savedCursor = 0;

  // Leave run-cap-edit mode (Esc, Ctrl+N again, or Ctrl+T): restore the saved prompt text.
  const exitConcurrencyMode = (): void => {
    if (!concurrencyMode) return;
    concurrencyMode = false;
    session.held.concurrency = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "n") {
      // Ctrl+N opens the team run-cap editor only on the Activity view (view 0, the team
      // scope): on a role's Transcript it cycles the transcript/notes/change panes, on
      // Backlog it files a new plan or bug, and on History/Health it has its own arms — so
      // this arm falls through unless the Activity view is up or the editor already holds
      // the line (in which case Ctrl+N is the toggle-out arm below). Entering pre-fills
      // the line from the file's own `maxConcurrent` (one fresh read per open is the
      // smallest honest source; a broken config degrades to no pre-fill and the write
      // reports the error) and saves the prompt text; leaving restores it.
      if (!concurrencyMode && ctx.view !== 0) return false;
      const held = session.heldEditorFlash("concurrency");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode
        // may not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      if (concurrencyMode) {
        exitConcurrencyMode();
        return true;
      }
      const existing = loadConfigSafe(session.root).config?.maxConcurrent ?? "";
      session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
      concurrencyMode = true;
      session.held.concurrency = true;
      session.input = String(existing);
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's run cap (maxConcurrent, an integer ≥ 1; empty restores the default): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && concurrencyMode) {
      // Esc cancels run-cap-edit mode, restoring the previous prompt text.
      exitConcurrencyMode();
      return true;
    }
    if (key.name === "return" && concurrencyMode) {
      // Enter commits the run cap through the shared setter family the CLI's `config set
      // maxConcurrent` and the dashboard Settings field use: a whitespace-trimmed empty
      // line clears the key (`unsetConfigKey`), otherwise `setConfigKey` writes it — its
      // JSON.value is a number when the operator typed a number, and validateConfig
      // (naming `maxConcurrent`) checks POSITIVE_INTEGER on the way out, so a `0` or
      // non-number fails there and nothing is written. An invalid value flashes and STAYS
      // in edit mode so the operator can fix it; success restores the saved prompt text.
      const text = session.input.trim();
      const value = session.input;
      const result =
        text === ""
          ? unsetConfigKey(session.root, "maxConcurrent")
          : setConfigKey(session.root, "maxConcurrent", session.input);
      if (result.ok) {
        exitConcurrencyMode();
        session.flashMessage(
          text === ""
            ? "max concurrent runs reset to the default"
            : `max concurrent runs set to ${value}`,
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
    exit: exitConcurrencyMode,
  };
}
