import { setConfigKey, setDailyBudgetUsd } from "../../config/config-write.js";
import { loadConfigSafe } from "../../config/config.js";
import { usdCap } from "../../text/format.js";
import { DIRECTOR_ROLE } from "../../roles/roles.js";
import { baseRoleOf } from "../../roles/runner-ids.js";
import { parseBudgetInput } from "./tui-input.js";
import { viewedRoleOrNull, type TuiEditorCtx, type TuiEditorModule } from "./tui-editor-ctx.js";
import { savedPromptDraft, type TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+B budget editor on the shared prompt line. It owns its mode flag, its saved-draft
 * pair, the snapshot-fed cap/free flags `sync` drives, and the handleKey arms for its key: the
 * toggle (with the `heldEditorFlash(entering)` guard clause, which keeps the shared guard
 * priority in the session module), Esc, and Enter. Mutually exclusive with the other editors on
 * the one prompt line via the session's held registry. */
export function createBudgetEditor(session: TuiEditorSession): TuiEditorModule {
  let budgetMode = false;
  const draft = savedPromptDraft(session);
  // The last snapshot's cap, synced by render so the Ctrl+B handler can pre-fill without
  // re-reading config itself (render already polls snapshot every second).
  let currentCapUsd = 0;
  // The last snapshot's free flag: true when every model the team could use is unpriced,
  // so a cap could never bind — the Ctrl+B handler flashes a notice instead of opening
  // the editor (BUGS.md 2026-09-14), leaving the prompt line untouched.
  let currentBudgetFree = false;
  // The role scope pinned when the editor opened, so Enter writes the same role's cap even if
  // syncRoster shrinks or reorders the roster while the editor is open; null in team scope.
  let lockedRole: string | null = null;

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    session.held.budget = false;
    draft.restore();
    lockedRole = null;
  };

  // Enter budget-edit mode (the shared entry, whether the team cap or a role's own cap is
  // being edited): save the prompt text and its cursor as the exit draft, claim the held slot,
  // pre-fill the line from the cap (empty string when disabled — empty means "no cap"), and
  // announce the mode. Only the cap source and the announcement differ between the two scopes.
  const enterBudgetMode = (cap: number, message: string): void => {
    draft.save();
    budgetMode = true;
    session.held.budget = true;
    session.input = cap > 0 ? String(cap) : "";
    session.cursor = session.input.length;
    session.flashMessage(message);
  };

  // Ctrl+B toggles budget-edit mode on the prompt line (mnemonic for *b*udget): on the
  // Activity view it edits the team's cap as today, and on a role's Transcript (or notes)
  // view it edits that role's own `maxDailyCostUsdPerRole.<role>` cap — the terminal
  // control for the amber role-cap alert. On the Health view, though, Ctrl+B is the
  // archive-backlog arm (tui-pane-health.ts): fall through so the pane router's arm can
  // consume it, exactly as Ctrl+A/Ctrl+U let the pane arms ahead of the editors keep
  // their Health meanings while the editors keep the key where it applies.
  const budgetKey = (ctx: TuiEditorCtx): boolean => {
    if (ctx.view === ctx.roleIds.length + 7) return false;
    // Entering pre-fills the current cap (empty when
    // disabled — empty means "no cap" on save) and saves the prompt text; leaving restores
    // it. Esc cancels the same way. One budgetMode flag, one held slot and one saved-draft
    // pair serve both scopes: only the pre-fill read and the write differ.
    // The viewed role when a role's pane is up (the same in-range guard tui-editor-notes
    // carries, which also keeps roleIds[ctx.view - 1] safe when syncRoster shrinks the
    // roster); null on the Activity view, where the arm takes the team branch below.
    const role = viewedRoleOrNull(ctx);
    if (session.editorEntryDenied("budget")) return true;
    if (role === DIRECTOR_ROLE) {
      // The cap exempts the director (role-view.ts's rule), so there is nothing to edit.
      session.flashMessage("the director has no daily cap");
      return true;
    }
    if (budgetMode) {
      exitBudgetMode();
    } else if (role !== null) {
      // Role scope: pre-fill from the file's own cap entry — the snapshot carries
      // capPaused but no cap values, so one fresh read per open is the smallest honest
      // source; a broken config degrades to no pre-fill and the write reports the error.
      lockedRole = role;
      const roleCap =
        loadConfigSafe(session.root).config?.maxDailyCostUsdPerRole?.[
          baseRoleOf(role)
        ] ?? 0;
      enterBudgetMode(
        roleCap,
        `edit ${role}'s daily cost cap (USD): Enter to save, Esc to cancel`,
      );
    } else if (currentBudgetFree) {
      session.flashMessage("budget n/a — all models free");
    } else {
      // Mid-recall, hand the arrows' saved draft back before the cap editor takes the
      // line — the same settle the role editor does — so leaving budget mode restores
      // the draft, not a history entry, with no stale recall state riding along.
      enterBudgetMode(currentCapUsd, "edit daily cost budget (USD): Enter to save, Esc to cancel");
    }
    return true;
  };

  // Esc cancels budget-edit mode, restoring the previous prompt text.
  const cancelBudgetEdit = (): boolean => {
    exitBudgetMode();
    return true;
  };

  // The shared success-path flash for a committed save: the unchanged/no-op wording (the
  // subject/off/what computation) for both scopes, the role branch's cap removed/set flash,
  // and the team branch's next-render currentCapUsd hint plus its disabled/set flash.
  const flashBudgetOutcome = (
    role: string | null,
    value: number,
    result: { unchanged?: true },
  ): void => {
    if (result.unchanged) {
      const off = role !== null ? "removed" : "disabled";
      const what = value === 0 ? off : usdCap(value);
      const subject = role !== null ? `${role}: cap` : "budget";
      session.flashMessage(`${subject} is already ${what}, so tumwater.json was not written`);
      return;
    }
    if (role !== null) {
      // A role-cap write does not move the team cap the snapshot feeds, so the
      // currentCapUsd next-render hint stays put.
      session.flashMessage(
        value === 0
          ? `${role}: cap removed`
          : `${role}: cap set to ${usdCap(value)}`,
      );
    } else {
      currentCapUsd = value; // the next render's snapshot agrees within ~2 s
      session.flashMessage(
        value === 0
          ? "budget disabled"
          : `budget set to ${usdCap(value)}`,
      );
    }
  };

  // Enter in budget mode parses + saves the cap through the shared setter family: the
  // team's setDailyBudgetUsd, or a role's setConfigKey dotted `maxDailyCostUsdPerRole
  // .<role>` write — the same write `tumwater config set` (and the dashboard's role
  // drawer) make, whose checkDailyBudgetUsd screen and validateConfig role-id check the
  // team arm shares. Both write tumwater.json atomically; the running orchestrator
  // picks the change up on its next ~2 s poll. An invalid value flashes and STAYS in
  // edit mode so the operator can fix it; success restores the saved prompt text.
  const commitBudgetEntry = (): boolean => {
    const parsed = parseBudgetInput(session.input);
    if (!parsed.ok) {
      session.flashMessage(parsed.error);
      return true;
    }
    // The role scope is the one pinned when the editor opened: syncRoster may shrink or
    // reorder the roster while it is open, and Enter must still write the same role's cap.
    const role = lockedRole;
    const result =
      role !== null
        ? setConfigKey(
            session.root,
            `maxDailyCostUsdPerRole.${baseRoleOf(role)}`,
            JSON.stringify(parsed.value),
          )
        : setDailyBudgetUsd(session.root, parsed.value);
    if (!result.ok) {
      // Broken config or write failure — stay in edit mode.
      session.flashMessage(result.error);
      return true;
    }
    exitBudgetMode();
    flashBudgetOutcome(role, parsed.value, result);
    return true;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "b") return budgetKey(ctx);
    if (key.name === "escape" && budgetMode) return cancelBudgetEdit();
    if (key.name === "return" && budgetMode) return commitBudgetEntry();
    return false;
  };

  return {
    handleKey,
    exit: exitBudgetMode,
    sync(capUsd: number, budgetFree: boolean): void {
      currentCapUsd = capUsd;
      currentBudgetFree = budgetFree;
    },
  };
}
