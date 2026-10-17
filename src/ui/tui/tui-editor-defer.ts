// vocabulary: plain
import { durationLabel } from "../../cli/cli-args.js";
import { parseDeferInput } from "./tui-input.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The Ctrl+L defer editor on the shared prompt line. It owns its mode flag, its saved-draft
 * pair, and the handleKey arms for its key (the toggle with the `heldEditorFlash(entering)`
 * guard clause — the shared guard priority lives in the session module — plus Esc and Enter).
 * The pending delay itself (`deferMs`) is session state the role-prompt and director submits
 * also read, so it lives in the session, not here. */
export function createDeferEditor(session: TuiEditorSession): TuiEditorModule {
  let deferMode = false;
  let deferSavedInput = "";
  let deferSavedCursor = 0;

  // Leave defer-edit mode (Esc, Ctrl+L again, or Ctrl+T): restore the saved prompt text. The
  // pending deferMs itself is untouched — Esc cancels the edit, not a delay already saved.
  const exitDeferMode = (): void => {
    if (!deferMode) return;
    deferMode = false;
    session.held.defer = false;
    session.restorePromptFrom(deferSavedInput, deferSavedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    _ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "l") {
      // Ctrl+L toggles defer-edit mode on the prompt line (mnemonic: **l**ater): the line edits
      // a duration that rides into the next delivered prompt as the same `tumwater:not-before`
      // marker `tumwater prompt --at` and the dashboard composer write. Entering pre-fills the
      // pending delay (empty when none) and saves the prompt text; leaving restores it. Empty
      // means "deliver now", so Esc cancels the edit without clearing an already-saved delay.
      const held = session.heldEditorFlash("defer");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping
        // the held mode's saved draft.
        session.flashMessage(held);
        return true;
      }
      if (deferMode) {
        exitDeferMode();
      } else {
        // Mid-recall, hand the arrows' saved draft back before the defer editor takes the
        // line — the same settle the budget and role editors do — so leaving restores the
        // draft, not a history entry, with no stale recall state riding along.
        session.settleDraft((t) => (deferSavedInput = t), (n) => (deferSavedCursor = n));
        deferMode = true;
        session.held.defer = true;
        session.input = session.deferMs === null ? "" : durationLabel(session.deferMs);
        session.cursor = session.input.length;
        session.flashMessage("send later: a duration like 45m (empty sends now) — Enter to save, Esc to cancel");
      }
      return true;
    }
    if (key.name === "escape" && deferMode) {
      // Esc cancels the defer editor, restoring the previous prompt text and leaving any
      // already-saved pending delay untouched.
      exitDeferMode();
      return true;
    }
    if (key.name === "return" && deferMode) {
      // Enter in defer mode parses the duration: empty clears the pending delay (deliver
      // now), a valid value stores the session duration (applied as now() + deferMs at
      // submit), and an invalid spelling or an over-cap value flashes and STAYS in the
      // editor so the operator can fix it. Either way the saved draft is restored.
      const parsed = parseDeferInput(session.input);
      if (!parsed.ok) {
        session.flashMessage(parsed.error);
      } else {
        session.deferMs = parsed.ms;
        exitDeferMode();
        session.flashMessage(
          session.deferMs === null ? "send later cleared" : `next prompt delivers in ${durationLabel(session.deferMs)}`,
        );
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitDeferMode };
}
