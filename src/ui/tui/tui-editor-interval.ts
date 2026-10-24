import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { checkMinRunInterval } from "../../config/config-keys.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import { rawRoleField } from "../../roles/role-view.js";
import { gotSuffix } from "../../text/text.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+S min-run-interval editor on the shared prompt line, the terminal twin of
 * `tumwater role <id> --min-run-interval` and the dashboard role drawer's `Min run interval`
 * row. It owns its mode flag, its saved-draft pair, and the role pinned when it opened, so a
 * roster shift cannot redirect the write. Enter writes through the shared
 * setConfigKey/unsetConfigKey family the CLI and the drawer use — so checkMinRunInterval
 * (naming `roles.<base>.minRunIntervalSeconds`) and validateConfig own the value's truth — a
 * non-plain-decimal spelling (hex/exponent, negative, or non-numeric) flashes the editor's own
 * shape message first, mirroring the budget editor's plain-decimal rule, and stays open — and
 * Esc, Ctrl+S again, and Ctrl+T cancel by restoring the prompt draft. Unlike the quiet editor
 * there is no director refusal: `tumwater role director --min-run-interval` is accepted, so the
 * director edits too. Mutually exclusive with the other editors on the one prompt line via the
 * session's held registry. */
export function createIntervalEditor(session: TuiEditorSession): TuiEditorModule {
  let intervalMode = false;
  let restoreDraft: () => void = () => {};
  // The role pinned when the editor opened, so Enter writes the same role's override even if
  // syncRoster shrinks or reorders the roster while the editor is open.
  let lockedRole: string | null = null;

  // Leave min-run-interval mode (Esc, Ctrl+S again, or Ctrl+T): restore the saved prompt text.
  const exitIntervalMode = (): void => {
    if (!intervalMode) return;
    intervalMode = false;
    session.held.interval = false;
    restoreDraft();
    lockedRole = null;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "s") {
      // Ctrl+S edits the viewed role's own min-run-interval override on its Transcript view.
      // Every non-transcript view keeps Ctrl+S — the guard below lets the key fall through to
      // the pane arms (History's trailing-window cycle) unless the interval editor already
      // holds the line, in which case Ctrl+S is the toggle-out arm. Entering pre-fills the
      // override from the FILE's raw `roles.<base>.minRunIntervalSeconds` (empty when unset —
      // empty means "clear it, fall back to the team-wide interval" on save) and saves the
      // prompt text; leaving restores it. There is no director exemption: the director runs
      // on the same clock, so `--min-run-interval` is accepted for it too.
      if (!intervalMode && !(ctx.view >= 1 && ctx.view <= ctx.roleIds.length)) return false;
      const role = ctx.roleIds[ctx.view - 1]!;
      if (session.editorEntryDenied("interval")) return true;
      if (intervalMode) {
        exitIntervalMode();
        return true;
      }
      // Pin the role first so the write below is safe against a mid-edit roster shift, then
      // pre-fill from the file's own entry — one fresh read per open is the smallest honest
      // source; a broken config degrades to no pre-fill and the write reports the error. The
      // FILE (rawRoleField) is the source of truth, not the merged config: overlayDefaults
      // seeds every built-in role's minRunIntervalSeconds from the catalog, so the merged
      // value cannot tell an operator override from a seeded default, and clearing a role that
      // only has the seed would otherwise be a no-op the operator could not see.
      lockedRole = role;
      const base = baseRoleOf(role);
      const existing = rawRoleField(session.root, base, "minRunIntervalSeconds");
      restoreDraft = session.takeDraft();
      intervalMode = true;
      session.held.interval = true;
      session.input = typeof existing === "number" ? String(existing) : "";
      session.cursor = session.input.length;
      session.flashMessage(
        `edit ${role}'s min run interval in seconds (0 allows back-to-back runs, empty clears): Enter to save, Esc to cancel`,
      );
      return true;
    }
    if (key.name === "escape" && intervalMode) {
      // Esc cancels min-run-interval mode, restoring the previous prompt text.
      exitIntervalMode();
      return true;
    }
    if (key.name === "return" && intervalMode) {
      // Enter commits the override through the shared setter family the CLI's
      // `--min-run-interval` and the dashboard drawer use: an empty or whitespace-only line
      // clears the key (`unsetConfigKey`), otherwise checkMinRunInterval (naming the dotted
      // key) screens the value and `setConfigKey` writes `roles.<base>.minRunIntervalSeconds`
      // as a JSON number. An invalid or rejected value flashes and STAYS in edit mode so the
      // operator can fix it; success restores the saved prompt text.
      const role = lockedRole!;
      const cfgKey = `roles.${baseRoleOf(role)}.minRunIntervalSeconds`;
      const text = session.input.trim();
      if (text === "") {
        const result = unsetConfigKey(session.root, cfgKey);
        if (result.ok) {
          exitIntervalMode();
          session.flashMessage(
            result.oldValue === undefined
              ? `${role}: min run interval is not set in tumwater.json, so nothing was cleared`
              : `${role}: min run interval cleared`,
          );
        } else {
          session.flashMessage(result.error); // broken config or write failure — stay in edit mode
        }
        return true;
      }
      // Plain decimal seconds only — bare Number() would also read hex ("0x10" → 16) and
      // exponent ("1e2" → 100) as an interval, neither of which an operator means when
      // typing a second count; the budget editor's parseBudgetInput applies the same
      // plain-decimal rule in the TUI, the CLI's --min-run-interval uses plainDecimalToJson,
      // and the GUI drawer's interval-save arm applies the same shape guard.
      // Non-plain spellings flash their own shape message — which, like checkMinRunInterval's
      // bounds wording below, names cfgKey so a rejected entry tells which per-role key the
      // editor was about to write — and STAY in edit mode (negative and non-numeric text hit
      // this shape arm too, so the operator sees one consistent message).
      if (!/^\d*\.?\d+$/.test(text)) {
        session.flashMessage(`${cfgKey} must be a plain second count like 300, 0.5, or .5 — no +/-, exponent, or hex notation${gotSuffix(text)}`);
        return true;
      }
      const value = Number(text);
      const invalid = checkMinRunInterval(value, cfgKey);
      if (invalid) {
        session.flashMessage(invalid); // name the rejected value and stay open
        return true;
      }
      const result = setConfigKey(session.root, cfgKey, JSON.stringify(value));
      if (result.ok) {
        exitIntervalMode();
        session.flashMessage(
          result.unchanged
            ? `${role}: min run interval is already ${text}s, so tumwater.json was not written`
            : `${role}: min run interval set to ${text}s`,
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
    exit: exitIntervalMode,
  };
}
