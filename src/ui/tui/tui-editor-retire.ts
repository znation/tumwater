// vocabulary: plain
import { artifactPhrase, retireRole } from "../../operator/retire.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Health view's Ctrl+X retire editor on the shared prompt line, the terminal twin of
 * `tumwater retire --role <id>` and the dashboard Settings card's Retire button. It owns its
 * `retireMode` flag, its saved-draft pair, and the handleKey arms for its key (the toggle with
 * the `heldEditorFlash(entering)` guard clause — the shared guard priority lives in the session
 * module — plus Esc and Enter). Guarded to the Health view (`ctx.view === roleIds.length + 7`),
 * so every other view's Ctrl+X arm (Transcript clears notes, Backlog cancels an entry, Inbox
 * cancels a queued prompt) keeps the key. Enter runs the same `retireRole(session.root, role,
 * {})` core the CLI and dashboard call, with the same never-force policy, and flashes the
 * dashboard's own outcome wording; a safety-rail refusal or an empty id flashes and stays open
 * so the operator can fix the id, Esc cancels and restores the draft. */
export function createRetireEditor(session: TuiEditorSession): TuiEditorModule {
  let retireMode = false;
  let retireSavedInput = "";
  let retireSavedCursor = 0;

  // Leave retire-edit mode (Esc, Enter's success path, or Ctrl+T): restore the saved prompt text.
  const exitRetireMode = (): void => {
    if (!retireMode) return;
    retireMode = false;
    session.held.retire = false;
    session.restorePromptFrom(retireSavedInput, retireSavedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "x" && ctx.view === ctx.roleIds.length + 7 && !retireMode) {
      // Ctrl+X toggles retire-edit mode on the Health view's prompt line (mnemonic: **x**
      // remove — the same key the Transcript notebook-clear, Backlog cancel, and Inbox cancel
      // arms use on their own views, guarded away here by the Health index). The line edits one
      // role id; Enter retires that role's leftovers through the same retireRole core the CLI
      // and the dashboard button use. Entering saves the prompt draft and blanks the line;
      // leaving restores it.
      const held = session.heldEditorFlash("retire");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping
        // the held mode's saved draft.
        session.flashMessage(held);
        return true;
      }
      // Mid-recall, hand the arrows' saved draft back before the retire editor takes the line —
      // the same settle the role editors do — so leaving restores the draft, not a
      // history entry, with no stale recall state riding along.
      session.settleDraft((t) => (retireSavedInput = t), (n) => (retireSavedCursor = n));
      retireMode = true;
      session.held.retire = true;
      session.input = "";
      session.cursor = 0;
      session.flashMessage("retire a disabled role's leftovers: type the role id, Enter to retire, Esc to cancel");
      return true;
    }
    if (key.name === "escape" && retireMode) {
      // Esc cancels retire-edit mode, restoring the previous prompt text and removing nothing.
      exitRetireMode();
      session.flashMessage("retire cancelled");
      return true;
    }
    if (key.name === "return" && retireMode) {
      // Enter retires the typed role id through retireRole — the same core, and the same
      // never-force policy, the CLI's `tumwater retire --role <id>` and the dashboard's Retire
      // button use — then flashes the dashboard's own outcome wording. An empty id flashes and
      // STAYS in the editor so the operator can type one; a safety-rail refusal throws (the
      // role still enabled, unmerged commits, a dirty or unusable worktree, a run in progress)
      // and the cursor stays so the operator can fix the id or reach for the CLI's --force.
      const role = session.input.trim();
      if (role === "") {
        session.flashMessage("a role id is required");
        return true;
      }
      void retireRole(session.root, role, {}).then(
        ({ removed }) => {
          exitRetireMode();
          session.flashMessage(
            removed.length === 0
              ? `nothing to remove for role ${role}`
              : removed.map((a) => `removed ${artifactPhrase(a, role)}`).join("; "),
          );
        },
        (err: unknown) => {
          session.flashError(err);
        },
      );
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitRetireMode };
}
