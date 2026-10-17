// vocabulary: plain
import { readMergeQueue } from "../../merge/merge-queue.js";
import { renderMergeQueue } from "../../merge/merge-queue-render.js";
import { orchestratorAlive } from "../../team/orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { renderTeamChange } from "../../change/change-render.js";
import type { TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The Pending pane (view roleIds.length + 5) of the TUI (src/ui/tui/tui.tsx): the durable
 * merge queue rendered up front plus the git-backed change roster the async collector appends
 * when it resolves. Split out of the pane-navigation monolith; it has no key arms or
 * render state of its own — only the enter half of the Ctrl+T cycle. */
export function createPendingPane(session: TuiPaneSession) {
  return {
    // Pending is the cycle's one async collector: collectTeamChanges awaits git plumbing,
    // so kick it off fire-and-forget, cache the rendered text when it resolves, and repaint.
    // The durable merge queue needs no git plumbing, so read and render it through the CLI's
    // own pair (`tumwater queue`) UP FRONT: the queue paints on entry, and the git-backed
    // roster is appended below it when the collector resolves, so the three surfaces
    // (CLI, dashboard, TUI) cannot drift on order, age, skips, or wording.
    // Guard on the PENDING pane still being current — view === roleIds.length + 5 — not just
    // on the raw index: an operator who cycled away, or a roster change that shifted which
    // pane the same index names, must not have this resolution overwrite the pane now shown.
    // The default collector degrades rather than throws, so the rejection arm only covers an
    // injected seam (or an unexpected throw).
    enter() {
      const queueView = readMergeQueue(session.root);
      const queueText = renderMergeQueue(queueView, session.now(), queueInFlight(session.root, queueView.entries, orchestratorAlive(session.root)));
      session.paneCache = queueText;
      void session.collectPending(session.root).then(
        (team) => {
          if (session.view !== session.roleIds.length + 5) return;
          session.paneCache = queueText + "\n\n" + renderTeamChange(team);
          session.requestRender();
        },
        (err: unknown) => {
          if (session.view !== session.roleIds.length + 5) return;
          // Keep the queue visible rather than replacing it with a loading note: it is
          // already known and unaffected by the git read that failed.
          session.flashError(err);
          session.requestRender();
        },
      );
      return true;
    },
    state() {
      return {};
    },
  } satisfies TuiPaneModule;
}
