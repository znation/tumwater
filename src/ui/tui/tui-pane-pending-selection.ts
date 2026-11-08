import { readPostReviews, type PostReview } from "../../review/post-merge-review.js";
import { postReviewStatusLabel } from "../../review/post-merge-review-render.js";
import { acceptPostReview } from "../../review/post-merge-review-accept.js";
import { roleLabel } from "../../roles/role-labels.js";
import { shortSha } from "../../text/format.js";
import { squash } from "../../text/text.js";
import type { TuiPaneCtx } from "./tui-pane-ctx.js";
import { paneAtHead, type TuiPaneSession } from "./tui-pane-session.js";
import { moveEntrySelection } from "./tui-backlog.js";

/** The Pending pane's row selection: a kept post-merge review paired with its 1-based
 * whole-list position — the number `tumwater reviews --accept <n>` takes. */
interface PendingRow {
  kind: "review";
  entry: PostReview;
  position: number;
}

/** The deps the Pending pane wires its row-selection/action subsystem over: the render half's
 * one scoped review traversal (`scopedReviews`), its in-place refresh (`refresh`, called after
 * a settled accept so the pane re-reads the reviews), and its view/prompt guard
 * (`onPendingView`, which every selection arm reports through). */
interface PendingSelectionDeps {
  scopedReviews(): {
    entries: readonly PostReview[];
    scope?: { roles: readonly string[]; positions: readonly number[]; total: number };
  };
  refresh(): void;
  onPendingView(ctx: TuiPaneCtx): boolean;
}

/** The rendered detail of one selected review row — the headline naming the entry with the
 * position `tumwater reviews --accept` takes, then the summary and the status suffix, so an
 * operator deciding whether to accept sees what the entry is about before the second Ctrl+A. */
const rowDetail = (row: PendingRow): string => {
  const e = row.entry;
  const status = postReviewStatusLabel(e);
  return `review #${row.position} (Ctrl+A to accept): ${roleLabel(e.role)} ${shortSha(e.commit)} · ${squash(e.summary, 80)}` + (status === "" ? "" : ` · ${status}`);
};

/** The Pending pane's review row-selection and accept half (src/ui/tui/tui.tsx, view
 * roleIds.length + 5), split out of the createPendingPane closure so the select-accept
 * cluster (`selectedQueue`/`queueRows`/`queueDetail` and the Ctrl+A arm, plus the re-read of
 * the rows on scope change) stops sharing the render/refresh/scope closure.
 * It closes over the three selection variables and implements the arms verbatim, crossing the
 * render half's data back over a `deps` seam (`scopedReviews`/`refresh`/`onPendingView`),
 * so each key keeps its exact guard, flash wording, and arming
 * (`session.reviewArmed`). It returns the arms the pane wires into its
 * `handleKey`, a `rebuild()` entry the pane's repaint/refresh call, and the reset/state
 * snapshots the pane's own reset()/state() proxy. */
export function createPendingSelection(
  session: TuiPaneSession,
  deps: PendingSelectionDeps,
): {
  pendingSelectRow(arrow: "up" | "down", ctx: TuiPaneCtx): boolean;
  pendingClearSelection(ctx: TuiPaneCtx): boolean;
  pendingAcceptReview(ctx: TuiPaneCtx): boolean;
  rebuild(): void;
  reset(): void;
  state(): { selectedQueue: number | null; queueDetail: string };
} {
  const { scopedReviews, refresh, onPendingView } = deps;
  // The Pending pane's row selection (null = list mode): the index into queueRows of the
  // review shown in full, cleared on every Ctrl+T cycle.
  let selectedQueue: number | null = null;
  // The Pending pane's cached rows — the post-merge review rows the pane painted — so a
  // selection addresses an entry's position without re-reading the queue on every frame.
  let queueRows: PendingRow[] = [];
  // The rendered detail of the selected row (the header and summary); the pane body windows it
  // in place of the review list while a row is selected. Empty in list mode.
  let queueDetail = "";

  // Resolve the selected row for a pending-pane action (Ctrl+A accept), or null when nothing
  // is selected: a list-mode press just tells the operator how to select.
  const selectedRow = (): PendingRow | null => {
    if (selectedQueue === null || queueRows.length === 0) {
      session.flashMessage("select a post-merge review with ↑↓ first");
      session.requestRender();
      return null;
    }
    return queueRows[Math.min(selectedQueue, queueRows.length - 1)]!;
  };

  // Re-read the pane's rows after the review queue or the Ctrl+G scope changed (the same
  // traversal the pane's head painted) and clamp the row selection to the new list — a
  // selection past the new end lands on the last remaining entry, never on a stale
  // role/position; an emptied queue clears it back to list mode. The detail is then rebuilt
  // to match the clamped row.
  const rebuildQueueRows = (): void => {
    const reviews = scopedReviews();
    if (reviews.scope) {
      queueRows = reviews.entries.map((entry, i) => ({ kind: "review" as const, entry, position: reviews.scope!.positions[i]! }));
    } else {
      queueRows = reviews.entries.map((entry, i) => ({ kind: "review" as const, entry, position: i + 1 }));
    }
    if (selectedQueue !== null) {
      if (queueRows.length === 0) {
        selectedQueue = null;
        queueDetail = "";
      } else {
        selectedQueue = Math.min(selectedQueue, queueRows.length - 1);
        queueDetail = rowDetail(queueRows[selectedQueue]!);
      }
    }
  };

  // Up/down in the Pending pane select a review row in full (wrapping, the backlog pane's
  // rule) instead of editing the prompt; an empty queue has nothing to select, so
  // moveEntrySelection clears the selection. The selected detail shares paneScroll with the
  // list, so a newly opened row must start at its head, or it renders scrolled into the
  // middle of the previous row's body.
  const pendingSelectRow = (arrow: "up" | "down", ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    selectedQueue = moveEntrySelection(queueRows.length, selectedQueue, arrow);
    const selRow = selectedQueue === null ? undefined : queueRows[selectedQueue];
    queueDetail = selRow ? rowDetail(selRow) : "";
    paneAtHead(session);
    return true;
  };

  // Esc on the Pending pane returns it to list mode; the cached list is untouched (nothing
  // was accepted), so the pane shows the same review list it entered with. The shared
  // paneScroll resets with the body switch, like a selection move.
  const pendingClearSelection = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx) || selectedQueue === null) return false;
    selectedQueue = null;
    queueDetail = "";
    paneAtHead(session);
    return true;
  };

  // Ctrl+A on the Pending pane accepts the selected post-merge review unreviewed (the
  // terminal twin of `tumwater reviews --accept <n>`), once selected and twice pressed:
  // the first press sets reviewArmed, and the second press re-reads the review queue and
  // settles the entry through the CLI's own core, so the pane and the CLI cannot drift.
  const pendingAcceptReview = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const review = selectedRow();
    if (review === null) return true;
    if (session.armedReview?.position === review.position && session.armedReview?.commit === review.entry.commit) {
      const confirm = async (): Promise<void> => {
        const entries = readPostReviews(session.root);
        if (entries[review.position - 1]?.commit !== review.entry.commit) {
          session.flashMessage("the review queue changed — try again");
          refresh();
          session.requestRender();
          return;
        }
        const outcome = acceptPostReview(session.root, review.position);
        if (outcome.status === "accepted") {
          selectedQueue = null;
          queueDetail = "";
          session.flashMessage(`accepted post-merge review of ${shortSha(outcome.commit)} unreviewed — ${outcome.summary}`);
          refresh();
          session.requestRender();
        } else if (outcome.status === "settled") {
          session.flashMessage(`review #${review.position} already merged its fix on main — nothing to accept`);
          refresh();
          session.requestRender();
        } else {
          session.flashMessage("the review queue changed — try again");
          refresh();
          session.requestRender();
        }
      };
      void confirm();
    } else {
      session.reviewArmed = { position: review.position, commit: review.entry.commit };
      session.flashMessage(`press Ctrl+A again to accept review #${review.position} — any other key keeps it`);
      session.requestRender();
    }
    return true;
  };

  // Leaving a view drops any review selection; re-entering starts at the list.
  const reset = (): void => {
    selectedQueue = null;
    queueDetail = "";
  };

  return {
    pendingSelectRow,
    pendingClearSelection,
    pendingAcceptReview,
    rebuild: rebuildQueueRows,
    reset,
    state() {
      return { selectedQueue, queueDetail };
    },
  };
}
