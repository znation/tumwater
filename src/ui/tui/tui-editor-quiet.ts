import { setConfigKey, unsetConfigKey } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import { DIRECTOR_ROLE } from "../../roles/roles.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import { viewedRole, type TuiEditorCtx, type TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+O per-role / Ctrl+S team-wide quiet-hours editor on the shared prompt line, the
 * terminal twin of the dashboard's `Quiet hours` rows and `tumwater role <id> --quiet-hours`
 * / `tumwater config set quietHours`. It owns its mode flags, its saved-draft pair, and the
 * role pinned when it opened (per-role scope only), so a roster shift cannot redirect the
 * write. Enter writes through the shared setConfigKey/unsetConfigKey family the CLI and the
 * drawer use — so checkQuietHours (naming `quietHoursPerRole.<id>`) and validateConfig (naming
 * `quietHours` for the team key) own the window's truth — and Esc, the matching Ctrl again,
 * and Ctrl+T cancel by restoring the prompt draft. Mutually exclusive with the other editors
 * on the one prompt line via the session's held registry. The two scopes never overlap: Ctrl+O
 * opens only on a role's Transcript and toggles only the per-role scope, Ctrl+S only on the
 * Activity view and toggles only the team scope, so a view change cannot leave a half-open
 * editor pointing at the wrong window. */
export function createQuietEditor(session: TuiEditorSession): TuiEditorModule {
  let quietMode = false;
  let quietTeam = false;
  let restoreDraft: () => void = () => {};
  // The role scope pinned when the editor opened (per-role scope only), so Enter writes the
  // same role's window even if syncRoster shrinks or reorders the roster while the editor is
  // open. The team scope pins no role: it writes the top-level `quietHours` key.
  let lockedRole: string | null = null;

  // Leave quiet-edit mode (Esc, the matching Ctrl again, or Ctrl+T): restore the saved prompt
  // text. Clears both scope flags; the caller's arm decides which scope to wake next.
  const exitQuietMode = (): void => {
    if (!quietMode) return;
    quietMode = false;
    quietTeam = false;
    session.held.quiet = false;
    session.held.quietTeam = false;
    restoreDraft();
    lockedRole = null;
  };

  // The shared way both open paths put the editor on the line: take the prompt draft to
  // restore on exit, raise the mode flags and the held registry for the chosen scope, pre-fill
  // the prompt text (cursor at its end) and flash the guidance line.
  const openQuietEditor = (team: boolean, existing: string, message: string): void => {
    restoreDraft = session.takeDraft();
    quietMode = true;
    quietTeam = team;
    session.held.quiet = true;
    session.held.quietTeam = team;
    session.input = existing;
    session.cursor = session.input.length;
    session.flashMessage(message);
  };

  // The Ctrl+O arm: edits the viewed role's own quiet-hours window (mnemonic: the silent *o*ur
  // hours) on its Transcript view. Every non-transcript view keeps Ctrl+O — the guard lets the
  // key fall through to the pane arms (Activity's event-type cycle, History's outcome cycle,
  // Health's problems-only toggle) unless the quiet editor already holds the line. While a
  // scope is open, Ctrl+O toggles only the per-role scope out; in the team scope it is consumed
  // and does nothing. Entering pre-fills the window from `quietHoursPerRole.<base>` (empty when
  // unset — empty means "off" on save) and saves the prompt text; leaving restores it. The
  // director is exempt — its quietHoursPerRole.director entry is inert (the gate and doctor
  // both exempt it).
  const roleQuietKey = (ctx: TuiEditorCtx): boolean => {
    if (quietMode) {
      // Consumed either way: in the per-role scope it toggles the editor out, in the team
      // scope Ctrl+O leaves the team editor open.
      if (!quietTeam) exitQuietMode();
      return true;
    }
    if (!(ctx.view >= 1 && ctx.view <= ctx.roleIds.length)) return false;
    const role = viewedRole(ctx);
    if (session.editorEntryDenied("quiet")) return true;
    if (role === DIRECTOR_ROLE) {
      session.flashMessage("the director has no quiet hours");
      return true;
    }
    // Pin the role first so the write below is safe against a mid-edit roster shift, then
    // pre-fill from the file's own entry — one fresh read per open is the smallest honest
    // source; a broken config degrades to no pre-fill and the write reports the error.
    lockedRole = role;
    const existing =
      loadConfigSafe(session.root).config?.quietHoursPerRole?.[baseRoleOf(role)] ?? "";
    openQuietEditor(
      false,
      existing,
      `edit ${role}'s quiet hours (e.g. 23:00-07:00, empty clears): Enter to save, Esc to cancel`,
    );
    return true;
  };

  // The Ctrl+S arm: edits the team-wide quiet-hours window on the Activity view (view 0) — the
  // terminal twin of the dashboard Settings `quietHours` row and `tumwater config set
  // quietHours`, so an operator can put the whole team to sleep for a nightly window. On every
  // non-Activity view Ctrl+S keeps its other meaning — the guard lets the key fall through to
  // the interval editor (a role's Transcript) and the pane arms (History's trailing-window
  // cycle). While a scope is open, Ctrl+S toggles only the team scope out; in the per-role
  // scope it is consumed and does nothing (so it never opens the interval editor over the
  // quiet editor). Entering pre-fills the window from the FILE's top-level `quietHours` (empty
  // when unset — empty means "off" on save) and saves the prompt text; leaving restores it.
  // The team window owns no role, so lockedRole stays null.
  const teamQuietKey = (ctx: TuiEditorCtx): boolean => {
    if (quietMode) {
      // In the team scope Ctrl+S toggles the editor out. In the per-role scope it must not
      // touch the per-role editor, but it also must not silently vanish: fall through so the
      // interval editor (the other Ctrl+S arm, which runs after this one) flashes the way out,
      // naming the per-role quiet editor as the holder.
      if (!quietTeam) return false;
      exitQuietMode();
      return true;
    }
    if (ctx.view !== 0) return false;
    if (session.editorEntryDenied("quiet")) return true;
    const existing = loadConfigSafe(session.root).config?.quietHours ?? "";
    openQuietEditor(
      true,
      existing,
      "edit the team's quiet hours (e.g. 23:00-07:00, empty clears): Enter to save, Esc to cancel",
    );
    return true;
  };

  // The Esc arm: cancels quiet-edit mode, restoring the previous prompt text.
  const cancelQuietEdit = (): boolean => {
    exitQuietMode();
    return true;
  };

  // The Enter arm: commits the window through the shared setter family the CLI's `--quiet-hours`
  // and `tumwater config set quietHours` / the dashboard rows use: an empty or whitespace-only
  // line clears the key (`unsetConfigKey`), otherwise `setConfigKey` writes the dotted
  // `quietHoursPerRole.<base>` entry (per-role scope) or the top-level `quietHours` (team scope)
  // as a JSON string. checkQuietHours (naming the dotted key) rejects a malformed per-role
  // window and validateConfig guards the team write; both write tumwater.json atomically and the
  // running orchestrator picks the change up on its next poll. An invalid window flashes and
  // STAYS in edit mode so the operator can fix it; success restores the saved prompt text.
  const commitQuietEntry = (): boolean => {
    const cfgKey = quietTeam ? "quietHours" : `quietHoursPerRole.${baseRoleOf(lockedRole!)}`;
    const text = session.input.trim();
    const result =
      text === ""
        ? unsetConfigKey(session.root, cfgKey)
        : setConfigKey(session.root, cfgKey, JSON.stringify(text));
    if (result.ok) {
      flashQuietOutcome(result, text);
      return true;
    }
    session.flashMessage(result.error); // broken config or write failure — stay in edit mode
    return true;
  };

  // The one success flash, shared by both scopes: reads the scope and role before exiting so
  // the message still names the window that was just written, computes the no-op case (nothing
  // was set and an empty line was cleared, or the value was already in place) and flashes the
  // matching line. Both setConfigKey's and unsetConfigKey's success members carry `oldValue`, so
  // the shared structural type accepts either branch's `result`.
  const flashQuietOutcome = (
    result: { ok: true; oldValue: unknown; unchanged?: true },
    text: string,
  ): void => {
    const team = quietTeam;
    const role = lockedRole;
    exitQuietMode();
    const scope = team ? "team" : `${role}`;
    const noop = text === "" ? result.oldValue === undefined : "unchanged" in result;
    session.flashMessage(
      noop
        ? text === ""
          ? `${scope}: quiet hours is not set in tumwater.json, so nothing was cleared`
          : `${scope}: quiet hours is already ${text}, so tumwater.json was not written`
        : text === ""
          ? `${scope}: quiet hours cleared`
          : `${scope}: quiet hours set to ${text}`,
    );
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "o") return roleQuietKey(ctx);
    if (key.ctrl && key.name === "s") return teamQuietKey(ctx);
    if (key.name === "escape" && quietMode) return cancelQuietEdit();
    if (key.name === "return" && quietMode) return commitQuietEntry();
    return false;
  };

  return {
    handleKey,
    exit: exitQuietMode,
  };
}
