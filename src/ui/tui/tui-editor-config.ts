import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The team-scope config-key editor arm (Ctrl+N run cap, Ctrl+W worktree slots, Ctrl+E
 * notify hook, Ctrl+P provider concurrency caps, Ctrl+L fallback, Ctrl+Y claude window reserve,
 * Ctrl+A team model) on the shared prompt line —
 * the terminal twins of the dashboard Settings fields and their `tumwater config set <key>`
 * commands.
 * One factory serves the team-scope editors because they share the whole shape: a mode
 * flag plus a saved-draft pair, the mutually-exclusive held registry, the Activity-view
 * (view 0, the team scope) scope pin, a pre-fill read from the file, and an Enter that
 * writes through the shared setConfigKey/unsetConfigKey family (so validateConfig owns the
 * value's truth) — the only differences are the key, its held name, the pre-fill source,
 * and the flash strings. Each team key owns no role, so no role is pinned on open. Esc, the
 * key again, and Ctrl+T cancel by restoring the saved prompt draft. */
interface TeamConfigKeySpec {
  /** The session's mutually-exclusive-held registry name this editor owns (and toggles on
   * the `held` object as it enters and leaves). */
  mode: "concurrency" | "slots" | "notify" | "providerCaps" | "fallback" | "claudeReserve" | "model";
  /** The Ctrl+<key> arm that opens (and, while open, toggles out of) the editor. */
  openCtrl: string;
  /** The tumwater.json key the editor writes on Enter — cleared (`unsetConfigKey`) on an
   * empty or whitespace-only line, otherwise `setConfigKey` recanonicalizes and
   * JSON-parses the line so validateConfig owns the value's truth. */
  configKey: string;
  /** The line the editor opens pre-filled with — one fresh read per open is the smallest
   * honest source, and a broken config degrades to no pre-fill with the write reporting
   * the error. */
  prefill: (session: TuiEditorSession) => string;
  /** Message flashed when the editor opens. */
  openFlash: string;
  /** Message flashed when a whitespace-only line clears the key. */
  clearedFlash: string;
  /** Message flashed when a non-empty line writes the key. */
  setFlash: (trimmed: string) => string;
}

/** Build a team-scope config-key editor. The editor owns its mode flag and saved-draft pair
 * in a closure; it may take the line only on the Activity view (view 0, the team scope) or
 * when it already holds it (the toggle-out arm), and only while no other editor holds the
 * line — the held-registry guard flashes the way out first. Enter commits through the shared
 * setter family: an invalid value flashes and STAYS in edit mode so the operator can fix it
 * (the file is untouched), success restores the saved prompt text. */
export function createTeamConfigKeyEditor(
  session: TuiEditorSession,
  spec: TeamConfigKeySpec,
): TuiEditorModule {
  let mode = false;
  let restoreDraft: () => void = () => {};

  // Leave the editor (Esc, the key again, or Ctrl+T): restore the saved prompt text.
  const exit = (): void => {
    if (!mode) return;
    mode = false;
    session.held[spec.mode] = false;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === spec.openCtrl) {
      // The key opens this team-scope editor only on the Activity view (view 0, the team
      // scope): on the other views the key keeps its own meaning and this arm falls through
      // so the later guards run. While open, the key toggles the editor out. Entering saves
      // the prompt draft; leaving restores it.
      if (mode) {
        exit();
        return true;
      }
      if (ctx.view !== 0) return false;
      const held = session.heldEditorFlash(spec.mode);
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode
        // may not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      const existing = spec.prefill(session);
      restoreDraft = session.takeDraft();
      mode = true;
      session.held[spec.mode] = true;
      session.input = existing;
      session.cursor = session.input.length;
      session.flashMessage(spec.openFlash);
      return true;
    }
    if (key.name === "escape" && mode) {
      // Esc cancels the editor, restoring the previous prompt text.
      exit();
      return true;
    }
    if (key.name === "return" && mode) {
      // Enter commits through the shared setter family the config CLI and the dashboard
      // Settings use: a whitespace-trimmed empty line clears the key (`unsetConfigKey`),
      // otherwise `setConfigKey` writes the trimmed line — it JSON-parses the text, so a
      // bare command or typed value stays the literal while a typed number becomes a number
      // — and validateConfig owns the value's truth (naming `configKey`) on the way out. An
      // invalid value flashes and STAYS in edit mode so the operator can fix it (the file is
      // untouched); success restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, spec.configKey)
          : setConfigKey(session.root, spec.configKey, text);
      if (result.ok) {
        exit();
        const noop = text === "" ? result.oldValue === undefined : "unchanged" in result;
        session.flashMessage(
          noop
            ? text === ""
              ? `${spec.configKey} is not set in tumwater.json, so nothing was cleared`
              : `${spec.configKey} is already ${text}, so tumwater.json was not written`
            : text === ""
              ? spec.clearedFlash
              : spec.setFlash(text),
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
    exit,
  };
}
