import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import type { TuiEditorModule } from "./tui-editor-ctx.js";
import { createRoleFileEditor } from "./tui-editor-role-file.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Transcript view's Ctrl+L replace-standing-instructions editor on the shared prompt line,
 * the terminal twin of `tumwater role <id> --instructions-file` and the dashboard role drawer's
 * `Instructions override` row. Ctrl+L opens it on a role transcript (the same in-range guard
 * every transcript editor arm carries — the instructions row is reachable from the plain
 * transcript, not only the notes mode). Enter trims the line as a file path, reads it verbatim
 * with the same readTextIfExists the CLI's non-interactive replacement uses, and writes the
 * BASE role's `roles.<base>.instructions` through the same setConfigKey/unsetConfigKey family
 * the CLI and dashboard drawer use — so validateConfig (naming the dotted key and its
 * ROLE_INSTRUCTIONS_MAX_CHARS cap) owns the value's truth. An empty or whitespace-only file
 * clears the key (unsetConfigKey, the dashboard's empty-clears convention, giving the terminal
 * a way to clear); an over-cap or unknown-role write flashes the returned error and STAYS open.
 * On success the notes repaints through the session's refreshNotes seam (the notes view's
 * cached Markdown recomputes the same role-inspection body the `Instructions override` row
 * renders). Unlike quiet hours' director refusal there is none here: the dashboard editor and
 * `--instructions-file` both accept the director, so it edits too. The open/exit/read framing
 * lives in the shared createRoleFileEditor helper that also serves the notes editor. */
export function createInstructionsEditor(session: TuiEditorSession): TuiEditorModule {
  return createRoleFileEditor(session, {
    held: "instructions",
    openCtrl: "l",
    mayOpen: (ctx) =>
      // The in-range role guard every transcript editor arm carries: Ctrl+L is bound on no
      // other TUI view except the Activity view's fallback editor and the Health view's
      // retire-leftovers arm, and those other arms (which run before this one) keep Ctrl+L on
      // Activity and Health — so no extra view restriction is needed here beyond the roster
      // guard that keeps the arm from firing off a role transcript.
      ctx.roleIds.length > 0 && ctx.view >= 1 && ctx.view <= ctx.roleIds.length,
    openFlash: (role) =>
      `replace ${role}'s instructions from a file — Enter to save, Esc to cancel`,
    cancelFlash: "instructions edit cancelled",
    commit: (s, role, text) => {
      const base = baseRoleOf(role);
      const cfgKey = `roles.${base}.instructions`;
      if (text.trim() === "") {
        const result = unsetConfigKey(s.root, cfgKey);
        if (!result.ok) return { ok: false, reason: result.error };
        return {
          ok: true,
          message:
            result.oldValue === undefined
              ? `${role}: instructions is not set in tumwater.json, so nothing was cleared`
              : `${role}: instructions cleared`,
        };
      }
      const result = setConfigKey(s.root, cfgKey, JSON.stringify(text));
      if (!result.ok) return { ok: false, reason: result.error };
      return {
        ok: true,
        message: result.unchanged
          ? `${role}: instructions unchanged, so tumwater.json was not written`
          : `${role}: instructions saved (${text.length} chars)`,
      };
    },
    flashFailure: (s, reason) => s.flashMessage(reason as string),
    refresh: (s, role) => s.refreshNotes(role),
  });
}
