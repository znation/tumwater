import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { isExponentSpelling } from "../../text/text.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { savedPromptDraft, type TuiEditorSession } from "./tui-editor-session.js";

/** The team-scope config-key editor arm (Ctrl+N run cap, Ctrl+W worktree slots, Ctrl+E
 * notify hook, Ctrl+L fallback,
 * Ctrl+A team model, Ctrl+U declared check) on the shared prompt line —
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
  mode: "concurrency" | "slots" | "notify" | "fallback" | "model" | "checks" | "check";
  /** The Ctrl+<key> arm that opens (and, while open, toggles out of) the editor. */
  openCtrl: string;
  /** The tumwater.json key the editor writes on Enter — cleared (`unsetConfigKey`) on an
   * empty or whitespace-only line, otherwise `setConfigKey` recanonicalizes and
   * JSON-parses the line so validateConfig owns the value's truth. */
  configKey: string;
  /** Set for the team keys whose value is a plain integer (maxConcurrent, worktreeSlots):
   * an exponent spelling like "2e0" is itself a JSON number (2) that setConfigKey's
   * JSON.parse would read past validateConfig's integer check and silently write — the
   * same silent misread the per-role instances/interval/cap guards refuse — so this
   * refuses it here, naming the key and staying in edit mode. A non-exponent spelling
   * falls through to validateConfig, whose message names the key. */
  plainIntegerKey?: boolean;
  /** Set for the team keys that must not disturb a typed prompt line: the editor opens only
   * while the prompt line is empty, so the key falls through to applyKey's kill/edit when the
   * operator has typed text. The Ctrl+K check-cap editor is the only team key that needs this. */
  requireEmptyPrompt?: boolean;
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
  const draft = savedPromptDraft(session);

  // Leave the editor (Esc, the key again, or Ctrl+T): restore the saved prompt text.
  const exit = (): void => {
    if (!mode) return;
    mode = false;
    session.held[spec.mode] = false;
    draft.restore();
  };

  // The key opens this team-scope editor only on the Activity view (view 0, the team
  // scope): on the other views the key keeps its own meaning and this arm falls through
  // so the later guards run. While open, the key toggles the editor out. Entering saves
  // the prompt draft; leaving restores it.
  const openOrToggle = (ctx: TuiEditorCtx): boolean => {
    if (mode) {
      exit();
      return true;
    }
    if (ctx.view !== 0) return false;
    // A check-cap editor with text on the line must fall through to applyKey's kill before the
    // hold-guard runs: while another editor holds the (non-empty) line, Ctrl+K should still
    // kill from the cursor to the line end rather than be consumed by the mutual-exclusion
    // flash, and a typed draft must never be swallowed. Only Ctrl+K sets `requireEmptyPrompt`,
    // so only it takes this fall-through.
    if (spec.requireEmptyPrompt && session.input !== "") return false;
    if (session.editorEntryDenied(spec.mode)) return true;
    const existing = spec.prefill(session);
    draft.save();
    mode = true;
    session.held[spec.mode] = true;
    session.input = existing;
    session.cursor = session.input.length;
    session.flashMessage(spec.openFlash);
    return true;
  };

  // Esc cancels the editor, restoring the previous prompt text.
  const cancel = (): boolean => {
    exit();
    return true;
  };

  // The four-way message a successful commit flashes: an empty-line no-op clear, a real
  // clear, an unchanged set, and a real set.
  const commitFlash = (result: { ok: true; oldValue?: unknown }, text: string): string => {
    const noop = text === "" ? result.oldValue === undefined : "unchanged" in result;
    return noop
      ? text === ""
        ? `${spec.configKey} is not set in tumwater.json, so nothing was cleared`
        : `${spec.configKey} is already ${text}, so tumwater.json was not written`
      : text === ""
        ? spec.clearedFlash
        : spec.setFlash(text);
  };

  // Enter commits through the shared setter family the config CLI and the dashboard
  // Settings use: a whitespace-trimmed empty line clears the key (`unsetConfigKey`),
  // otherwise `setConfigKey` writes the trimmed line — it JSON-parses the text, so a
  // bare command or typed value stays the literal while a typed number becomes a number
  // — and validateConfig owns the value's truth (naming `configKey`) on the way out. An
  // invalid value flashes and STAYS in edit mode so the operator can fix it (the file is
  // untouched); success restores the saved prompt text.
  const commit = (): boolean => {
    const text = session.input.trim();
    // Shape, before the write, for the plain-integer team keys: an exponent spelling is
    // itself a JSON number that setConfigKey's JSON.parse would read past validateConfig
    // and silently write, so refuse it here and stay in edit mode (the twin of the per-role
    // instances/interval guards); a non-exponent invalid falls through to validateConfig.
    if (spec.plainIntegerKey && text !== "" && isExponentSpelling(text)) {
      session.flashMessage(`${spec.configKey} must be a plain integer — no exponent notation`);
      return true;
    }
    const result =
      text === ""
        ? unsetConfigKey(session.root, spec.configKey)
        : setConfigKey(session.root, spec.configKey, text);
    if (result.ok) {
      exit();
      session.flashMessage(commitFlash(result, text));
    } else {
      session.flashMessage(result.error); // broken config or write failure — stay in edit mode
    }
    return true;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === spec.openCtrl) return openOrToggle(ctx);
    if (key.name === "escape" && mode) return cancel();
    if (key.name === "return" && mode) return commit();
    return false;
  };

  return {
    handleKey,
    exit,
  };
}
