import { submitRolePromptAndWake } from "../../operator/operator-intent.js";
import { pushPromptHistory } from "./tui-prompt-history.js";
import { parseRolePromptInput } from "./tui-input.js";
import { viewedRole, type TuiEditorCtx, type TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The per-role prompt Ctrl+R editor on the shared prompt line. It owns its mode flag (the
 * viewed role's role id), its saved-draft pair, its exit helper, and the handleKey arms for its
 * key: the per-role toggle (guarded out of the other editors' prompt line) and its Esc/Enter
 * leaves. Mutually exclusive with the other editors via the session's held registry. */
export function createPromptEditor(session: TuiEditorSession): TuiEditorModule {
  let rolePromptFor: string | null = null;
  let restoreDraft: () => void = () => {};

  // Leave role-prompt mode (Esc, Ctrl+R again, or Ctrl+T): restore the saved prompt text,
  // and reset the recall state with it — the saved draft was saved settled (see the Ctrl+R
  // handler), so resuming a browse entered in role mode would restore role-mode text onto
  // the director line and lose the director draft the arrows had saved.
  const exitRolePromptMode = (): void => {
    if (!rolePromptFor) return;
    rolePromptFor = null;
    session.held.rolePromptFor = null;
    restoreDraft();
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    // Ctrl+R toggles role-prompt mode for the viewed role (mnemonic: p**R**ompt — Ctrl+P is
    // taken by pause): entering saves the director draft in this mode's own pair and blanks
    // the line; entering again (or Esc) restores it. Mutually exclusive with budget mode by
    // the outer guard and the mirrored refusal in the Ctrl+B branch. Rides the same per-role
    // guard as the Ctrl+P/A/W pause controls so an editor's prompt line is never disturbed.
    if (
      !session.anyEditorHeld("rolePromptFor") &&
      ctx.roleIds.length > 0 &&
      ctx.view >= 1 && ctx.view <= ctx.roleIds.length &&
      key.ctrl && key.name === "r"
    ) {
      const role = viewedRole(ctx); // defined: view is clamped inside the transcript range
      try {
        if (rolePromptFor) {
          exitRolePromptMode();
          session.flashMessage("role prompt cancelled");
        } else {
          // Mid-recall, the line holds a history entry while the real draft sits in the
          // recall state: settle first, so the role editor saves (and later restores) the
          // draft the operator was writing, and no stale index/draft crosses modes —
          // otherwise Esc here would surface role-mode recalls on the director line.
          restoreDraft = session.takeDraft();
          rolePromptFor = role;
          session.held.rolePromptFor = role;
          session.input = "";
          session.cursor = 0;
          session.flashMessage(`prompt for ${role}: Enter to send, Esc to cancel`);
        }
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    if (key.name === "escape" && rolePromptFor) {
      // Esc cancels role-prompt mode the same way, restoring the previous prompt text.
      exitRolePromptMode();
      return true;
    }
    if (key.name === "return" && rolePromptFor) {
      // Enter in role-prompt mode submits for the viewed role through the same path
      // `tumwater prompt --role` uses: the shared submitRolePromptAndWake enqueues into
      // that role's own queue (length-capped by the shared rule), logs under the role,
      // and wakes it so a live team's role comes in within one poll. An invalid
      // (whitespace-only) line flashes and STAYS in edit mode; a failed queue write
      // flashes the reason and keeps the text, the same contract the director path
      // honors; success restores the saved draft.
      const parsed = parseRolePromptInput(session.input);
      if (!parsed.ok) {
        session.flashMessage(parsed.error);
      } else {
        const role = rolePromptFor;
        try {
          submitRolePromptAndWake(session.root, role, parsed.value, undefined);
          session.promptHistory = pushPromptHistory(session.promptHistory, parsed.value);
          exitRolePromptMode();
          session.flashMessage(`added to ${role}'s inbox`);
        } catch (err) {
          session.flashError(err);
        }
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitRolePromptMode };
}
