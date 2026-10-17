// vocabulary: plain
import { readBrief, renderBrief } from "../../brief/brief.js";
import type { TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The Brief pane (view roleIds.length + 8) of the TUI (src/ui/tui/tui.tsx): reads and renders
 * the brief file `tumwater brief` prints. Split out of the pane-navigation monolith; it has
 * no key arms or render state of its own — only the enter half of the Ctrl+T cycle. */
export function createBriefPane(session: TuiPaneSession) {
  return {
    enter() {
      // Brief is a synchronous fresh read of the file `tumwater brief` prints.
      const brief = readBrief(session.root);
      session.paneCache = brief ? renderBrief(brief) : null;
      return true;
    },
    state() {
      return {};
    },
  } satisfies TuiPaneModule;
}
