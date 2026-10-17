// vocabulary: plain
import { setDailyBudgetUsd } from "../../config/config-write.js";
import { usdCap } from "../../text/format.js";
import { parseBudgetInput } from "./tui-input.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+B budget editor on the shared prompt line. It owns its mode flag, its saved-draft
 * pair, the snapshot-fed cap/free flags `sync` drives, and the handleKey arms for its key: the
 * toggle (with the `heldEditorFlash(entering)` guard clause, which keeps the shared guard
 * priority in the session module), Esc, and Enter. Mutually exclusive with the other editors on
 * the one prompt line via the session's held registry. */
export function createBudgetEditor(session: TuiEditorSession): TuiEditorModule {
  let budgetMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // The last snapshot's cap, synced by render so the Ctrl+B handler can pre-fill without
  // re-reading config itself (render already polls snapshot every second).
  let currentCapUsd = 0;
  // The last snapshot's free flag: true when every model the team could use is unpriced,
  // so a cap could never bind — the Ctrl+B handler flashes a notice instead of opening
  // the editor (BUGS.md 2026-09-14), leaving the prompt line untouched.
  let currentBudgetFree = false;

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    session.held.budget = false;
    session.restorePromptFrom(savedInput, savedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    _ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "b") {
      // Ctrl+B toggles budget-edit mode on the prompt line (mnemonic for *b*udget): entering
      // pre-fills the current cap (empty when disabled — empty means "no cap" on save) and
      // saves the prompt text; leaving restores it. Esc cancels the same way.
      const held = session.heldEditorFlash("budget");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping the
        // held mode's saved draft (or parsing its text as a cap on Enter).
        session.flashMessage(held);
        return true;
      }
      if (budgetMode) {
        exitBudgetMode();
      } else if (currentBudgetFree) {
        session.flashMessage("budget n/a — all models free");
      } else {
        // Mid-recall, hand the arrows' saved draft back before the cap editor takes the
        // line — the same settle the role editor does — so leaving budget mode restores
        // the draft, not a history entry, with no stale recall state riding along.
        session.settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
        budgetMode = true;
        session.held.budget = true;
        session.input = currentCapUsd > 0 ? String(currentCapUsd) : "";
        session.cursor = session.input.length;
        session.flashMessage("edit daily cost budget (USD): Enter to save, Esc to cancel");
      }
      return true;
    }
    if (key.name === "escape" && budgetMode) {
      // Esc cancels budget-edit mode, restoring the previous prompt text.
      exitBudgetMode();
      return true;
    }
    if (key.name === "return" && budgetMode) {
      // Enter in budget mode parses + saves the cap through the shared setter (which
      // writes tumwater.json atomically; the running orchestrator picks it up on its next
      // ~2 s poll). An invalid value flashes and STAYS in edit mode so the operator can
      // fix it; success restores the saved prompt text.
      const parsed = parseBudgetInput(session.input);
      if (!parsed.ok) {
        session.flashMessage(parsed.error);
      } else {
        const result = setDailyBudgetUsd(session.root, parsed.value);
        if (result.ok) {
          exitBudgetMode();
          currentCapUsd = parsed.value; // the next render's snapshot agrees within ~2 s
          session.flashMessage(
            parsed.value === 0
              ? "budget disabled"
              : `budget set to ${usdCap(parsed.value)}`,
          );
        } else {
          session.flashMessage(result.error); // broken config or write failure — stay in edit mode
        }
      }
      return true;
    }
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
