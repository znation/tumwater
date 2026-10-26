import { defaultConfig, knownRoleIds, loadConfigSafe } from "../../config/config.js";
import { setConfigKey } from "../../config/config-write.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../../roles/roles.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Health view's Ctrl+V enable/disable editor on the shared prompt line, the terminal twin
 * of the dashboard Settings card's Enable and the role drawer's two-click Disable (and of the
 * CLI's `tumwater role <id> --enable`/`--disable`). It owns its `roleEnabledMode` flag, its
 * saved-draft pair, and the handleKey arms for its key (the toggle with the
 * `heldEditorFlash(entering)` guard clause — the shared guard priority lives in the session
 * module — plus Esc and Enter). Guarded to the Health view (`ctx.view === roleIds.length + 7`),
 * so every other view's Ctrl+V arm (Activity image attach, Pending move-to-front, History
 * revert, Inbox move-to-top, Transcript reset-counters) keeps the key. Enter reads the typed
 * role id and toggles its `roles.<base>.enabled` through the same setConfigKey core the CLI,
 * the Settings card and the drawer use: a config-disabled role is enabled at once, an enabled
 * one is armed for a second Enter (the drawer's two-click confirm), and the director cannot be
 * disabled. A rejected id, an unknown id, or a write failure flashes and stays open so the
 * operator can fix the id; Esc, Ctrl+V again, and Ctrl+T cancel by restoring the draft. */
export function createRoleEnabledEditor(session: TuiEditorSession): TuiEditorModule {
  let roleEnabledMode = false;
  let confirmBase: string | null = null;
  let restoreDraft: () => void = () => {};

  // Leave enable/disable mode (Esc, Enter's success path, or Ctrl+T): restore the saved prompt
  // text and drop the armed disable confirm (the line no longer names it).
  const exitRoleEnabledMode = (): void => {
    if (!roleEnabledMode) return;
    roleEnabledMode = false;
    confirmBase = null;
    session.held.roleEnabled = false;
    restoreDraft();
  };

  // Ctrl+V toggles enable/disable-edit mode on the Health view's prompt line (the same key
  // the Activity attach, Pending top, History revert, Inbox top, and Transcript
  // reset-counters arms use on their own views, guarded away here by the Health index). The
  // line edits one role id; Enter toggles that role's `roles.<base>.enabled` through the
  // same setConfigKey core the CLI, the Settings card and the drawer use. Entering saves
  // the prompt draft and blanks the line; leaving restores it. While open, Ctrl+V again
  // exits.
  const roleEnabledKey = (ctx: TuiEditorCtx): boolean => {
    if (roleEnabledMode) {
      exitRoleEnabledMode();
      return true;
    }
    if (ctx.view !== ctx.roleIds.length + 7) return false; // off Health, keep the key's other meanings
    if (session.editorEntryDenied("roleEnabled")) return true;
    restoreDraft = session.takeDraft();
    roleEnabledMode = true;
    session.held.roleEnabled = true;
    session.input = "";
    session.cursor = 0;
    session.flashMessage("enable or disable a role: type the role id, Enter to toggle, Esc to cancel");
    return true;
  };

  // Esc cancels enable/disable-edit mode, restoring the previous prompt text and toggling
  // nothing.
  const cancelRoleEnabledEdit = (): boolean => {
    exitRoleEnabledMode();
    session.flashMessage("enable/disable cancelled");
    return true;
  };

  // Enter toggles the typed role's base role's `roles.<base>.enabled` — the same core, and
  // the same director/safety rules, the CLI's `tumwater role <id> --enable|--disable`, the
  // dashboard Settings card's Enable and the role drawer's two-click Disable use. A
  // config-disabled role is enabled at once; an enabled one is armed (this is the first of
  // the drawer's two clicks) and a second Enter on the same base disables it. An empty id,
  // an unknown id, a director disable, or a failed write flashes and STAYS in the editor so the
  // operator can fix the id.
  const commitRoleEnabledEntry = (): boolean => {
    const role = session.input.trim();
    if (role === "") {
      session.flashMessage("a role id is required");
      return true;
    }
    const cfg = loadConfigSafe(session.root).config ?? defaultConfig();
    const validIds = knownRoleIds(cfg);
    if (!validIds.includes(role)) {
      session.flashMessage(unknownRoleMessage(role, validIds));
      return true;
    }
    const base = baseRoleOf(role);
    const enabled = cfg.roles[base]?.enabled !== false;
    if (base === DIRECTOR_ROLE && enabled) {
      // Only disabling is refused, matching the CLI (`--disable` fails for the director, while
      // `--enable` stays allowed) and the Settings card. The director is always enabled (the
      // CLI and this editor never write it disabled), so an enabled director is refused before
      // the disable arm is offered; a config-disabled director would still enable at once below.
      session.flashMessage("the director cannot be disabled");
      return true;
    }
    if (!enabled) {
      // A config-disabled role: enable it at once (the Settings card's Enable and the CLI's
      // --enable both enable directly, with no confirm step).
      const result = setConfigKey(session.root, `roles.${base}.enabled`, "true");
      if (!result.ok) {
        session.flashMessage(result.error);
        return true;
      }
      exitRoleEnabledMode();
      flashRoleEnabled(base, true);
      return true;
    }
    // An enabled role: the drawer's two-click Disable — the first Enter arms, a second Enter
    // on the same base writes `false`. The confirm is keyed to the base the line currently
    // names, so an id changed — or a key that edits it — between the two Enters re-arms
    // rather than disabling what the line no longer shows.
    if (confirmBase !== base) {
      confirmBase = base;
      session.flashMessage(`press Enter again to disable ${base} — any other role id or Esc keeps it enabled`);
      return true;
    }
    const result = setConfigKey(session.root, `roles.${base}.enabled`, "false");
    if (!result.ok) {
      session.flashMessage(result.error);
      return true;
    }
    exitRoleEnabledMode();
    flashRoleEnabled(base, false);
    return true;
  };

  // The Enter success flash: names the base and which way it was toggled.
  const flashRoleEnabled = (base: string, enabled: boolean): void => {
    session.flashMessage(enabled ? `${base}: enabled` : `${base}: disabled`);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "v") return roleEnabledKey(ctx);
    if (key.name === "escape" && roleEnabledMode) return cancelRoleEnabledEdit();
    if (key.name === "return" && roleEnabledMode) return commitRoleEnabledEntry();
    return false;
  };

  return { handleKey, exit: exitRoleEnabledMode };
}
