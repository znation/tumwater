import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { readEditorPath, type TuiEditorSession } from "./tui-editor-session.js";

/** The Transcript view's Ctrl+L replace-standing-instructions editor on the shared prompt line,
 * the terminal twin of `tumwater role <id> --instructions-file` and the dashboard role drawer's
 * `Instructions override` row. It owns its `instructionsFor` flag, its saved-draft pair, and the
 * role pinned when it opened, so a roster shift cannot redirect the write. Ctrl+L opens it on a
 * role transcript (the same in-range guard every transcript editor arm carries — the
 * instructions row is reachable from the plain transcript, not only the notes mode), flashes the
 * held-editor busy message when another prompt-line editor owns the line, settles the recall
 * draft, blanks the line, and flashes the enter/Esc framing. Enter trims the line as a file
 * path, reads it verbatim with the same readTextIfExists the CLI's non-interactive replacement
 * uses, and writes the BASE role's `roles.<base>.instructions` through the same
 * setConfigKey/unsetConfigKey family the CLI and dashboard drawer use — so validateConfig
 * (naming the dotted key and its ROLE_INSTRUCTIONS_MAX_CHARS cap) owns the value's truth. An
 * empty or whitespace-only file clears the key (unsetConfigKey, the dashboard's empty-clears
 * convention, giving the terminal a way to clear); an over-cap or unknown-role write flashes
 * the returned error and STAYS open. Esc, Ctrl+L again, and Ctrl+T cancel by restoring the
 * prompt draft. On success the notes repaints through the session's refreshNotes seam (the
 * notes view's cached Markdown recomputes the same role-inspection body the `Instructions
 * override` row renders). Unlike quiet hours' director refusal there is none here: the
 * dashboard editor and `--instructions-file` both accept the director, so it edits too. */
export function createInstructionsEditor(session: TuiEditorSession): TuiEditorModule {
  let instructionsFor: string | null = null;
  let restoreDraft: () => void = () => {};

  // Leave the instructions editor (Esc, Ctrl+L again, or Ctrl+T): restore the saved prompt
  // text with no override written.
  const exitInstructionsMode = (): void => {
    if (instructionsFor === null) return;
    instructionsFor = null;
    session.held.instructions = null;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (
      key.ctrl && key.name === "l" &&
      ctx.roleIds.length > 0 && ctx.view >= 1 && ctx.view <= ctx.roleIds.length
    ) {
      // Ctrl+L toggles the replace-instructions editor on a role's Transcript view (mnemonic:
      // the instructions **l**ine, bound on no other TUI view except the Activity view's
      // fallback editor — the in-range role check keeps the arm from firing off a role
      // transcript, and the fallback arm (which runs before this one) keeps Ctrl+L on Activity).
      // The line edits one file path that becomes the viewed role's whole
      // `roles.<base>.instructions` override through the same setConfigKey write the CLI and
      // the dashboard drawer use. Entering saves the prompt draft and blanks the line; leaving
      // restores it.
      if (session.editorEntryDenied("instructions")) return true;
      if (instructionsFor !== null) {
        exitInstructionsMode();
      } else {
        // Mid-recall, hand the arrows' saved draft back before the instructions editor takes
        // the line — the same settle the role editors do — so leaving restores the draft, not
        // a history entry, with no stale recall state riding along.
        const role = ctx.roleIds[ctx.view - 1]!; // defined: the open-arm range guard above pins the view into roleIds
        restoreDraft = session.takeDraft();
        instructionsFor = role;
        session.held.instructions = role;
        session.input = "";
        session.cursor = 0;
        session.flashMessage(`replace ${role}'s instructions from a file — Enter to save, Esc to cancel`);
      }
      return true;
    }
    if (key.name === "escape" && instructionsFor !== null) {
      // Esc cancels the instructions editor, restoring the previous prompt text and writing
      // nothing.
      exitInstructionsMode();
      session.flashMessage("instructions edit cancelled");
      return true;
    }
    if (key.name === "return" && instructionsFor !== null) {
      // Enter reads the typed path whole and writes it through the shared
      // setConfigKey/unsetConfigKey family the CLI's `--instructions-file`/`--clear-instructions`
      // and the dashboard drawer use, so ROLE_INSTRUCTIONS_MAX_CHARS and the unknown-role check
      // (enforced by validateConfig inside writeConfigMutation) and their wording cannot drift.
      // An empty path, a missing file, an unreadable file, an over-cap text, and an unknown id
      // all flash and STAY in the editor so the operator can fix the path; an empty or
      // whitespace-only file clears the override (the dashboard's empty-clears convention). On
      // success the notes repaints the updated `Instructions override` row and the editor
      // exits with the shared success wording.
      const role = instructionsFor;
      const text = readEditorPath(session);
      if (text === null) return true;
      const base = baseRoleOf(role);
      const cfgKey = `roles.${base}.instructions`;
      if (text.trim() === "") {
        const result = unsetConfigKey(session.root, cfgKey);
        if (!result.ok) {
          session.flashMessage(result.error); // broken config or write failure — stay in edit mode
          return true;
        }
        session.refreshNotes(role);
        exitInstructionsMode();
        session.flashMessage(
          result.oldValue === undefined
            ? `${role}: instructions is not set in tumwater.json, so nothing was cleared`
            : `${role}: instructions cleared`,
        );
        return true;
      }
      const result = setConfigKey(session.root, cfgKey, JSON.stringify(text));
      if (!result.ok) {
        session.flashMessage(result.error); // over the cap, unknown id, or write failure — stay in edit mode
        return true;
      }
      session.refreshNotes(role);
      exitInstructionsMode();
      session.flashMessage(
        result.unchanged
          ? `${role}: instructions unchanged, so tumwater.json was not written`
          : `${role}: instructions saved (${text.length} chars)`,
      );
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitInstructionsMode };
}
