import { queuedMergeFiles, type MergeEntry, type MergeQueueView } from "../../merge/merge-queue.js";
import { revisionNote, retryNote, scopeMergeQueue } from "../../merge/merge-queue-render.js";
import { cancelQueuedMerge } from "../../merge/merge-cancel.js";
import { moveQueuedMergeToTop } from "../../merge/merge-top.js";
import { mergeHoldsSha } from "../../merge/merge-slot.js";
import { orchestratorAlive } from "../../team/team-orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { roleLabel } from "../../roles/role-labels.js";
import { shortSha } from "../../text/format.js";
import { humanAgo } from "../../text/datetime.js";
import { readPostReviews, type PostReview } from "../../review/post-merge-review.js";
import { postReviewStatusLabel, type PostReviewState } from "../../review/post-merge-review-render.js";
import { acceptPostReview } from "../../review/post-merge-review-accept.js";
import { squash } from "../../text/text.js";
import type { TuiPaneCtx } from "./tui-pane-ctx.js";
import { paneAtHead, type TuiPaneSession } from "./tui-pane-session.js";
import { moveEntrySelection } from "./tui-backlog.js";

/** The Pending pane's row selection: a kept queued merge or a post-merge review, each paired
 * with its 1-based whole-list position — the number `tumwater queue --cancel <n>` and
 * `tumwater reviews --accept <n>` take. */
type PendingRow =
  | { kind: "merge"; entry: MergeEntry; position: number }
  | { kind: "review"; entry: PostReview; position: number };

/** The render half's data the selection reads to rebuild rows: re-read each press so a cancel,
 * accept, or top acts on the queue the pane is showing, and the rows follow the Ctrl+G role
 * scope / Ctrl+O review-state filter the pane owns. */
interface PendingSelectionInputs {
  lastQueue: MergeQueueView | null;
  lastReviews: PostReview[];
  roleScope: string | null;
  reviewState: PostReviewState | null;
}

/** The deps the Pending pane wires its row-selection/action subsystem over: the render half's
 * live data (`inputs`), its one scoped review traversal (`scopedReviews`), its in-place
 * refresh (`refresh`, called after a settled cancel/accept/top so the pane re-reads the queue),
 * and its view/prompt guard (`onPendingView`, which every selection arm reports through). */
interface PendingSelectionDeps {
  inputs(): PendingSelectionInputs;
  scopedReviews(): {
    entries: readonly PostReview[];
    scope?: { roles: readonly string[]; positions: readonly number[]; total: number };
  };
  refresh(): void;
  onPendingView(ctx: TuiPaneCtx): boolean;
}

/** The rendered detail of one selected row — the headline naming the entry with the position
 * its kind's CLI command takes, then the summary and (for a merge) the body/revision/retry
 * notes, so an operator deciding whether to cancel or accept sees what the entry is about
 * before the second Ctrl+X/Ctrl+A. A review row never has a body or revision note: it names
 * the accept action, the status suffix, and for a rejected entry why it cannot be accepted. */
const rowDetail = (row: PendingRow, now: number): string => {
  if (row.kind === "merge") {
    const e = row.entry;
    const note = revisionNote(e);
    const retry = retryNote(e, now);
    const lines = [
      `merge #${row.position} (Ctrl+X to cancel, Ctrl+V to top): ${roleLabel(e.role)} run #${e.run} · ${shortSha(e.sha)} · ${humanAgo(e.enqueuedAt, now)}`,
      e.summary,
    ];
    if (e.body) lines.push("", e.body);
    if (note) lines.push("", note);
    if (retry) lines.push("", retry);
    return lines.join("\n");
  }
  const e = row.entry;
  const status = postReviewStatusLabel(e);
  const lines = [
    `review #${row.position} (Ctrl+A to accept): ${roleLabel(e.role)} ${shortSha(e.commit)} · ${squash(e.summary, 80)}` + (status === "" ? "" : ` · ${status}`),
  ];

  return lines.join("\n");
};

/** The Pending pane's queue-and-review row-selection and action half (src/ui/tui/tui.tsx, view
 * roleIds.length + 5), split out of the createPendingPane closure so the select-cancel-accept-
 * move cluster (`selectedQueue`/`queueRows`/`queueDetail` and the Ctrl+X/Ctrl+V/Ctrl+A arms,
 * plus the re-read of the rows on scope change) stops sharing the render/refresh/scope closure.
 * It closes over the three selection variables and implements the arms verbatim, crossing the
 * render half's data back over a `deps` seam (`inputs`/`scopedReviews`/`refresh`/
 * `onPendingView`), so each key keeps its exact guard, flash wording, and arming
 * (`session.queueArmed`/`session.reviewArmed`). It returns the arms the pane wires into its
 * `handleKey`, a `rebuild()` entry the pane's repaint/refresh call, and the reset/state
 * snapshots the pane's own reset()/state() proxy. */
export function createPendingSelection(
  session: TuiPaneSession,
  deps: PendingSelectionDeps,
): {
  pendingSelectRow(arrow: "up" | "down", ctx: TuiPaneCtx): boolean;
  pendingClearSelection(ctx: TuiPaneCtx): boolean;
  pendingCancelMerge(ctx: TuiPaneCtx): boolean;
  pendingAcceptReview(ctx: TuiPaneCtx): boolean;
  pendingMoveToTop(ctx: TuiPaneCtx): boolean;
  rebuild(): void;
  reset(): void;
  state(): { selectedQueue: number | null; queueDetail: string };
} {
  const { inputs, scopedReviews, refresh, onPendingView } = deps;
  // The Pending pane's row selection (null = list mode): the index into queueRows of the
  // merge shown in full, cleared on every Ctrl+T cycle like selectedQueued. Each row pairs a
  // kept entry with its 1-based whole-queue position (or the scope's kept positions when a
  // Ctrl+G role scope is active), so a cancel addresses the entry `tumwater queue --cancel`
  // numbers — the position the CLI's queue line printed.
  let selectedQueue: number | null = null;
  // The Pending pane's cached rows — the same whole-queue traversal renderMergeQueue painted,
  // plus the post-merge review rows appended after them — so a selection addresses an entry's
  // position without re-reading the queue on every frame.
  let queueRows: PendingRow[] = [];
  // The rendered detail of the selected row (the header, summary, and when present the
  // entry's body and revision note); the pane body windows it in place of the queue list
  // while a row is selected. Empty in list mode.
  let queueDetail = "";

  // Resolve the selected row for a pending-pane action (Ctrl+X cancel, Ctrl+V top, Ctrl+A
  // accept), or null when nothing is selected: a list-mode press just tells the operator how
  // to select. Shared by the cancel, top, and accept handlers so the prompt and the row bound
  // stay in one place.
  const selectedRow = (): PendingRow | null => {
    if (selectedQueue === null || queueRows.length === 0) {
      session.flashMessage("select a merge with ↑↓ first");
      session.requestRender();
      return null;
    }
    return queueRows[Math.min(selectedQueue, queueRows.length - 1)]!;
  };

  // True when the queue shifted under the selection (a concurrent drain or another cancel)
  // moved this entry away from `row.position`: refuse rather than act on the wrong entry.
  // Shared by the cancel and top handlers for the one "the merge queue changed" wording.
  const queueShiftedAway = (row: { entry: MergeEntry; position: number }): boolean => {
    if (queuedMergeFiles(session.root)[row.position - 1]?.entry.sha !== row.entry.sha) {
      session.flashMessage("the merge queue changed — try again");
      session.requestRender();
      return true;
    }
    return false;
  };

  // Guard the cancel/top actions against racing a merge that just entered the slot: the
  // selected entry (or one its changes touch) is heading into the merge right now, so acting
  // on it would race the drain. Flash the pane's "being merged" message and return true so
  // the caller aborts; otherwise false.
  const guardMergeInFlight = (row: { entry: MergeEntry; position: number }): boolean => {
    const inFlight = queueInFlight(session.root, inputs().lastQueue?.entries ?? [], orchestratorAlive(session.root));
    if (inFlight && mergeHoldsSha(inFlight, row.entry.sha)) {
      session.flashMessage(`merge #${row.position} is being merged right now — wait for it to land, then \`tumwater revert ${shortSha(row.entry.sha)}\``);
      session.requestRender();
      return true;
    }
    return false;
  };
  // Re-read the pane's rows after the queue or the Ctrl+G scope changed (the same traversal
  // queueHead painted) and clamp the row selection to the new list — a selection past the new
  // end lands on the last remaining entry, never on a stale role/position; an emptied queue
  // clears it back to list mode. The detail is then rebuilt to match the clamped row.
  const rebuildQueueRows = (): void => {
    const { lastQueue, roleScope } = inputs();
    if (lastQueue === null) {
      queueRows = [];
      selectedQueue = null;
      queueDetail = "";
      return;
    }
    if (roleScope === null) {
      queueRows = lastQueue.entries.map((entry, i) => ({ kind: "merge" as const, entry, position: i + 1 }));
    } else {
      const { view, scope } = scopeMergeQueue(lastQueue, [roleScope], (r) => r === roleScope);
      queueRows = view.entries.map((entry, i) => ({ kind: "merge" as const, entry, position: scope.positions[i]! }));
    }
    // The review block follows the same scope the painted head used, so a review row's
    // position is its 1-based whole-queue position — the one `tumwater reviews` and
    // `tumwater reviews --accept <n>` number — whether unscoped (i + 1) or kept by the scope's
    // positions. Reviews follow the merge rows in the pane, exactly as the traversal painted.
    const reviews = scopedReviews();
    if (reviews.scope) {
      reviews.entries.forEach((entry, i) => queueRows.push({ kind: "review" as const, entry, position: reviews.scope!.positions[i]! }));
    } else {
      reviews.entries.forEach((entry, i) => queueRows.push({ kind: "review" as const, entry, position: i + 1 }));
    }
    if (selectedQueue !== null) {
      if (queueRows.length === 0) {
        selectedQueue = null;
        queueDetail = "";
      } else {
        selectedQueue = Math.min(selectedQueue, queueRows.length - 1);
        queueDetail = rowDetail(queueRows[selectedQueue]!, session.now());
      }
    }
  };

  // Up/down in the Pending pane select a queued merge row in full (wrapping, the backlog
  // pane's rule) instead of editing the prompt; an empty queue has nothing to select, so
  // moveEntrySelection clears the selection. The selected detail shares paneScroll with the
  // list, so a newly opened row must start at its head, or it renders scrolled into the
  // middle of the previous row's body.
  const pendingSelectRow = (arrow: "up" | "down", ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    selectedQueue = moveEntrySelection(queueRows.length, selectedQueue, arrow);
    const selRow = selectedQueue === null ? undefined : queueRows[selectedQueue];
    queueDetail = selRow ? rowDetail(selRow, session.now()) : "";
    paneAtHead(session);
    return true;
  };

  // Esc on the Pending pane returns it to list mode; the cached list is untouched (nothing
  // was cancelled), so the pane shows the same renderMergeQueue it entered with. The shared
  // paneScroll resets with the body switch, like a selection move.
  const pendingClearSelection = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx) || selectedQueue === null) return false;
    selectedQueue = null;
    queueDetail = "";
    paneAtHead(session);
    return true;
  };

  // Ctrl+X on the Pending pane cancels the selected queued merge (the terminal twin of
  // `tumwater queue --cancel <n>`): a review row names its own action, the first press on a
  // merge arms it (any other key keeps it), and the second press re-reads the queue, guards
  // the in-flight and shifted-away races, then removes the entry through the CLI's own core.
  const pendingCancelMerge = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const row = selectedRow();
    if (row === null) return true;
    if (row.kind === "review") {
      session.flashMessage("that row is a post-merge review — Ctrl+A accepts it");
      session.requestRender();
      return true;
    }
    if (session.armedQueue?.sha === row.entry.sha && session.armedQueue?.position === row.position) {
      // Second press on the same entry: re-read the queue, guard the in-flight race, then
      // remove it through the CLI's own core (`tumwater queue --cancel <n>`), so the pane,
      // the CLI, and the dashboard cancel cannot drift.
      const confirm = async (): Promise<void> => {
        if (queueShiftedAway(row)) return;
        if (guardMergeInFlight(row)) return;
        const outcome = await cancelQueuedMerge(session.root, row.position);
        if (outcome.status === "cancelled") {
          selectedQueue = null;
          queueDetail = "";
          session.flashMessage(`cancelled queue entry ${row.position}: ${roleLabel(outcome.role)} ${shortSha(outcome.sha)} — ${outcome.summary}`);
          refresh();
          session.requestRender();
        } else {
          selectedQueue = null;
          queueDetail = "";
          session.flashMessage("that merge already left the queue");
          refresh();
          session.requestRender();
        }
      };
      void confirm();
    } else {
      session.queueArmed = { position: row.position, sha: row.entry.sha };
      session.flashMessage(`press Ctrl+X again to cancel merge #${row.position} — any other key keeps it`);
      session.requestRender();
    }
    return true;
  };

  // Ctrl+A on the Pending pane accepts the selected post-merge review unreviewed (the
  // terminal twin of `tumwater reviews --accept <n>`), once selected and twice pressed
  // like the queue's Ctrl+X cancel. A merge row names its own action instead; an unarmed
  // press sets reviewArmed, and the second press re-reads the queue and settles the entry
  // through the CLI's own core, so the pane and the CLI cannot drift.
  const pendingAcceptReview = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const review = selectedRow();
    if (review === null) return true;
    if (review.kind === "merge") {
      session.flashMessage("that row is a queued merge — Ctrl+X cancels it");
      session.requestRender();
      return true;
    }
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

  // Ctrl+V moves the selected merge to the head of the queue — the pane's twin of `tumwater
  // queue --top <n>`, through the same core the CLI and the dashboard use, so the three
  // cannot drift on the rename or the already-first/out-of-range outcomes. A single
  // keypress is enough because the move is reversible and non-destructive (unlike
  // Ctrl+X's two-step cancel arm); a review row names its own action instead.
  const pendingMoveToTop = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const row = selectedRow();
    if (row === null) return true;
    if (row.kind === "review") {
      session.flashMessage("that row is a post-merge review — Ctrl+A accepts it");
      session.requestRender();
      return true;
    }
    const top = async (): Promise<void> => {
      if (row.position === 1) {
        session.flashMessage(`merge #${row.position} is already at the front`);
        session.requestRender();
        return;
      }
      if (queueShiftedAway(row)) return;
      if (guardMergeInFlight(row)) return;
      const outcome = moveQueuedMergeToTop(session.root, row.position);
      if (outcome.status === "topped") {
        selectedQueue = null;
        queueDetail = "";
        session.flashMessage(`moved merge #${row.position} to the front: ${roleLabel(outcome.role)} ${shortSha(outcome.sha)} — ${outcome.summary}`);
        refresh();
        session.requestRender();
      } else if (outcome.status === "already-first") {
        session.flashMessage(`merge #${row.position} is already at the front`);
        refresh();
        session.requestRender();
      } else if (outcome.status === "out-of-range") {
        session.flashMessage("the merge queue changed — try again");
        refresh();
        session.requestRender();
      } else {
        session.flashMessage("that merge already left the queue");
        refresh();
        session.requestRender();
      }
    };
    void top();
    return true;
  };

  // Leaving a view drops any queued-merge selection; re-entering starts at the list.
  const reset = (): void => {
    selectedQueue = null;
    queueDetail = "";
  };

  return {
    pendingSelectRow,
    pendingClearSelection,
    pendingCancelMerge,
    pendingAcceptReview,
    pendingMoveToTop,
    rebuild: rebuildQueueRows,
    reset,
    state() {
      return { selectedQueue, queueDetail };
    },
  };
}
