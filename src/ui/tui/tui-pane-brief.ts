// vocabulary: plain
import { readBrief, renderBrief } from "../../brief/brief.js";
import type { TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The Brief pane (view roleIds.length + 8) of the TUI (src/ui/tui/tui.tsx): reads and renders
 * the brief file `tumwater brief` prints. Split out of the pane-navigation monolith; it has
 * no key arms or render state of its own — only the enter half of the Ctrl+T cycle and the
 * repaint an editor-triggered brief replace (the Brief view's Ctrl+E) asks for. */
export function createBriefPane(session: TuiPaneSession) {
  const refreshBrief = (): boolean => {
    // Brief is a synchronous fresh read of the file `tumwater brief` prints. Repaint only when
    // the Brief view is actually up (mirroring the notes refresh's view guard): a replace whose
    // async write resolves or commits after the operator cycles away must not overwrite the
    // shared paneCache with the brief body (or null) — the wrong pane's content until re-entry —
    // or repaint a stale frame. requestRender paints the new body immediately on the async arms.
    if (session.view !== session.roleIds.length + 8) return false;
    const brief = readBrief(session.root);
    session.paneCache = brief ? renderBrief(brief) : null;
    session.requestRender();
    return true;
  };
  return {
    enter() {
      return refreshBrief();
    },
    refreshBrief,
    state() {
      return {};
    },
  } satisfies TuiPaneModule;
}
