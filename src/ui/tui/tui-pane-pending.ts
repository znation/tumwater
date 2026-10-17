// vocabulary: plain
import { readMergeQueue } from "../../merge/merge-queue.js";
import { renderMergeQueue } from "../../merge/merge-queue-render.js";
import { orchestratorAlive } from "../../team/orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { renderTeamChange } from "../../change/change-render.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The Pending pane (view roleIds.length + 5) of the TUI (src/ui/tui/tui.tsx): the durable
 * merge queue rendered up front plus the git-backed change roster the async collector appends
 * when it resolves. Split out of the pane-navigation monolith; its only key arm is the Ctrl+R
 * in-place refresh, and it has no render state of its own — aside from the enter half of the
 * Ctrl+T cycle. */
export function createPendingPane(session: TuiPaneSession) {
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
  let refreshGen = 0;
  const refresh = (): void => {
    // Generation guard: each refresh bumps the counter, and a resolution paints only if it
    // is the latest request's — Ctrl+R held twice, or a refresh raced with a re-entry,
    // must not let an out-of-order older resolution overwrite the newer result.
    const gen = ++refreshGen;
    const queueView = readMergeQueue(session.root);
    const queueText = renderMergeQueue(queueView, session.now(), queueInFlight(session.root, queueView.entries, orchestratorAlive(session.root)));
    session.paneCache = queueText;
    void session.collectPending(session.root).then(
      (team) => {
        if (gen !== refreshGen || session.view !== session.roleIds.length + 5) return;
        session.paneCache = queueText + "\n\n" + renderTeamChange(team);
        session.requestRender();
      },
      (err: unknown) => {
        if (gen !== refreshGen || session.view !== session.roleIds.length + 5) return;
        // Keep the queue visible rather than replacing it with a loading note: it is
        // already known and unaffected by the git read that failed.
        session.flashError(err);
        session.requestRender();
      },
    );
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "r" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 5) {
      // Ctrl+R on the Pending pane refreshes in place — the terminal twin of the dashboard
      // Pending view's Refresh button: re-read the durable merge queue and restart the
      // change-roster collector, painting what the queue holds now. The pane re-enters at
      // its head so the changed body starts at the top; the roster's git read is a fresh
      // collector run, and a run already in flight is superseded by the new read.
      refresh();
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    // The refresh Ctrl+R arm re-reads the same queue and collector the enter half runs, so
    // entering and refreshing share one body that repaints in place.
    enter() {
      refresh();
      return true;
    },
    state() {
      return {};
    },
  } satisfies TuiPaneModule;
}
