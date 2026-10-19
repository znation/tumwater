// vocabulary: plain
import { existsSync } from "node:fs";
import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe, parseJsonConfig } from "../../config/config.js";
import { isJsonObject } from "../../files/json-object.js";
import { CONFIG_BASENAME, configPath } from "../../paths.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+X agent-backends editor on the Activity view's shared prompt line — the terminal
 * twin of the dashboard Settings `Agent backends (JSON)` field and `tumwater config set
 * backends`, completing the run-concurrency knob set `tumwater doctor` and the dashboard
 * point at. It owns its mode flag and its saved-draft pair. Enter writes the top-level
 * `backends` through the shared setConfigKey/unsetConfigKey family the CLI and the dashboard
 * use — so setConfigKey JSON-parses the typed text and validateConfig's section block owns the
 * value's truth (a non-object or a non-object entry is rejected with the file untouched) and
 * the whole-section arm collapses the legacy agentBin/piArgs aliases so a file never holds
 * both spellings — and Esc, Ctrl+X again, and Ctrl+T cancel by restoring the prompt draft.
 * Mutually exclusive with the other editors on the one prompt line via the session's held
 * registry. The Team scope is the only scope, so the editor takes the line on the Activity view
 * (view 0) alone; a role's Transcript, the Backlog, the Inbox and the Health view keep Ctrl+X
 * for their existing arms (clear notes, cancel an entry, retire a role), which run after this
 * arm. */
export function createBackendsEditor(session: TuiEditorSession): TuiEditorModule {
  let backendsMode = false;
  let restoreDraft: () => void = () => {};

  // Leave backends mode (Esc, Ctrl+X again, or Ctrl+T): restore the saved prompt text.
  const exitBackendsMode = (): void => {
    if (!backendsMode) return;
    backendsMode = false;
    session.held.backends = false;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "x") {
      // Ctrl+X edits the team's agent backends on the Activity view (view 0) — the terminal
      // twin of the dashboard Settings `Agent backends (JSON)` field and `tumwater config set
      // backends`, so an operator can point the team at a backend executable without leaving
      // the terminal. On every non-Activity view Ctrl+X keeps its other meaning — the guard
      // lets the key fall through to the retire editor (a role's Transcript and the Health
      // view), the Backlog cancel arm and the Inbox cancel arm, which run after this arm.
      // While open, Ctrl+X toggles the editor out. Entering pre-fills the line from the
      // FILE's top-level `backends` (compact JSON when set, empty when unset — empty means
      // "cleared" on save) and saves the prompt text; leaving restores it. The team key owns
      // no role, so no role is pinned.
      if (backendsMode) {
        exitBackendsMode();
        return true;
      }
      if (ctx.view !== 0) return false;
      const held = session.heldEditorFlash("backends");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out first.
        session.flashMessage(held);
        return true;
      }
      const existing = rawBackends(session.root);
      restoreDraft = session.takeDraft();
      backendsMode = true;
      session.held.backends = true;
      session.input = existing !== undefined ? JSON.stringify(existing) : "";
      session.cursor = session.input.length;
      session.flashMessage(
        "edit the team's agent backends (backends, a JSON object like {\"pi\":{\"bin\":\"/path/to/pi\"}}; empty clears): Enter to save, Esc to cancel",
      );
      return true;
    }
    if (key.name === "escape" && backendsMode) {
      // Esc cancels backends mode, restoring the previous prompt text.
      exitBackendsMode();
      return true;
    }
    if (key.name === "return" && backendsMode) {
      // Enter commits the section through the shared setter family the CLI and the dashboard
      // Settings field use: an empty or whitespace-only line clears the key
      // (`unsetConfigKey`), otherwise `setConfigKey` writes the top-level `backends` as the
      // typed text — setConfigKey JSON-parses it, so `{"pi":{"bin":"…"}}` becomes the object
      // while `pi` collapses to the literal string, and validateConfig's section block owns
      // the value's truth (a non-object or a non-object entry is rejected with nothing
      // written). Because the key is the whole section, the setter's top-level arm runs
      // collapseAgentAliases so a legacy `agentBin`/`piArgs` can never sit beside the new
      // `backends.pi` spelling. Both write tumwater.json atomically and the running
      // orchestrator picks the change up on its next poll. An invalid value flashes and STAYS
      // in edit mode so the operator can fix it; success restores the saved prompt text.
      const text = session.input.trim();
      const result =
        text === ""
          ? unsetConfigKey(session.root, "backends")
          : setConfigKey(session.root, "backends", text);
      if (result.ok) {
        exitBackendsMode();
        session.flashMessage(
          text === ""
            ? "agent backends cleared"
            : `agent backends set to ${text}`,
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
    exit: exitBackendsMode,
  };
}

/** The team's `backends` section as the file spells it, for the editor's pre-fill. The merged
 * config (loadConfigSafe) defaults `backends` to an empty object even when the file leaves the
 * key unset, while the visual twin's "empty when unset" needs to tell a set (even empty)
 * section from an unset one — so read the raw file: unset pre-fills empty, set pre-fills the
 * compact JSON of exactly what the file holds (the same shape `tumwater config get backends`
 * and the dashboard's Settings field show). A broken/missing file falls back to the merged
 * view's value. */
function rawBackends(root: string): unknown {
  const file = configPath(root);
  if (!existsSync(file)) return undefined; // unset: no file, no key
  const safe = loadConfigSafe(root);
  const merged = safe.config?.backends;
  if (safe.error !== undefined) return merged;
  const parsed = parseJsonConfig(file, CONFIG_BASENAME);
  if (parsed.problem !== undefined) return merged;
  const raw = parsed.raw as Record<string, unknown> | undefined;
  if (raw === undefined || typeof raw !== "object" || !("backends" in raw)) return undefined;
  // init/saveConfig write the section as an empty {} even when the operator never set it, so
  // an empty section is indistinguishable from unset — and "empty clears" on save treats them
  // the same anyway, so an empty section pre-fills empty, not "{}".
  const section = raw.backends;
  return isJsonObject(section) && Object.keys(section).length === 0
    ? undefined
    : section;
}
