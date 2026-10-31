import { readMergeQueue, type MergeQueueView } from "../../merge/merge-queue.js";
import { renderMergeQueue, scopeMergeQueue } from "../../merge/merge-queue-render.js";
import { orchestratorAlive } from "../../team/team-orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { renderChangeOverlaps, renderRoleChanges, renderTeamChange } from "../../change/change-render.js";
import { scopeChangeOverlaps, type ChangeOverlapsView } from "../../change/change-data.js";
import { readPostReviews, type PostReview } from "../../review/post-merge-review.js";
import { renderPostReviews, scopePostReviews, POST_REVIEW_STATES, postReviewState, type PostReviewState } from "../../review/post-merge-review-render.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { paneAtHead, type TuiPaneSession } from "./tui-pane-session.js";
import { arrowDir } from "./tui-keymap.js";
import { distinctOrdered } from "../../collections.js";
import { createPendingSelection } from "./tui-pane-pending-selection.js";

/** The overlapping-files block under the roster: empty for a no-base view (the roster above
 * already says the main branch is missing), else the CLI's renderChangeOverlaps under a
 * "overlapping files (N):" heading shaped like the queue's. */
export function pendingOverlapsText(view: ChangeOverlapsView, scope?: string): string {
  if (view.state === "no-base") return "";
  if (scope !== undefined) {
    const narrowed = scopeChangeOverlaps(view, [scope]);
    if (narrowed.overlaps.length === 0) return renderChangeOverlaps(narrowed, [scope]);
    return `overlapping files held by ${scope} (${narrowed.overlaps.length}):\n` + renderChangeOverlaps(narrowed);
  }
  if (view.overlaps.length === 0) return renderChangeOverlaps(view);
  return `overlapping files (${view.overlaps.length}):\n` + renderChangeOverlaps(view);
}

/** The distinct roles named across the overlaps, in first-seen order; empty for a no-base view. */
export function overlapHolders(view: ChangeOverlapsView): string[] {
  if (view.state === "no-base") return [];
  return distinctOrdered(view.overlaps.flatMap((o) => o.roles));
}

/** The distinct roles named across the merge queue, in first-seen (queue) order; empty for an
 * empty queue. The queue's own roles lead the pane's Ctrl+G scope cycle, before the overlap
 * holders — the queue scope is the `tumwater queue --role <id>` twin. */
export function mergeQueueRoles(view: MergeQueueView): string[] {
  return distinctOrdered(view.entries.map((e) => e.role));
}

/** The distinct roles named across the post-merge review queue, in first-seen (FIFO) order;
 * empty for an empty queue. The review block's contribution to the pane's Ctrl+G scope cycle,
 * after the queue's roles — the review scope is the `tumwater reviews --role <id>` twin. */
export function postReviewRoles(entries: readonly PostReview[]): string[] {
  return distinctOrdered(entries.map((e) => e.role));
}

/** The heading over one overlap's drill-down: its place in the list and the path. */
export function overlapDrillHeading(index: number, total: number, path: string): string {
  return `overlap ${index + 1}/${total}: ${path} (Ctrl+N next)`;
}

/** The Pending pane (view roleIds.length + 5) of the TUI (src/ui/tui/tui.tsx): the durable
 * merge queue rendered up front plus the git-backed change roster the async collector appends
 * when it resolves, and the post-merge review queue (`tumwater reviews`) painted between them
 * from the same `readPostReviews`/`renderPostReviews` pair the CLI prints. Split out of the
 * pane-navigation monolith; its key arms are the Ctrl+R
 * in-place refresh, the Ctrl+N overlap drill-down, the Ctrl+O review-state filter, and the
 * Ctrl+G role scope (narrowing the merge queue, the post-merge reviews and the overlapping
 * files), and it has no render state of its own —
 * aside from the enter half of the Ctrl+T cycle. Its queue arms: Ctrl+X twice cancels a
 * selected merge, Ctrl+V moves it to the front, and the post-merge review rows it appends
 * after the merges are selectable too, so Ctrl+A twice accepts the selected review — the
 * terminal twin of `tumwater reviews --accept <n>`.
 * Each key arm lives in its own named inner const below (pendingRefresh, pendingScopeCycle,
 * pendingReviewStateCycle, pendingOverlapDrill — the row-selection/action arms live in
 * tui-pane-pending-selection.ts, wired in below through a small seam), so its guard, flash
 * wording, arming state and repaint are found by name; handleKey is only the ordered dispatch. */
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
  // The overlaps are read by the same collectChangeOverlaps that `tumwater diff --overlaps`
  // and `GET /api/diff?overlaps=1` serve, and rendered through the CLI's renderChangeOverlaps.
  // The default collector degrades rather than throws, so the rejection arm only covers an
  // injected seam (or an unexpected throw).
  // Ctrl+N steps through the overlapping files, painting each holder's change limited to that
  // file (the `tumwater diff --role a,b --path <path>` view); `base` is the pane text to
  // return to after the last one. Ctrl+G cycles roleScope through each role the queue, the
  // post-merge reviews and the overlaps name and back to all (the `queue --role <id>`,
  // `reviews --role <id>` and `diff --overlaps --role <id>` twins, one scope covering all three
  // surfaces); Ctrl+N then steps through only the scoped files,
  // and the scope survives a refresh. The queue's roles lead the cycle, the review-only roles
  // follow, then the overlap holders that are in neither, and each kept merge and each kept
  // review holds its whole-queue position.
  let refreshGen = 0;
  let base = "";
  let lastOverlaps: ChangeOverlapsView | null = null;
  let lastQueue: MergeQueueView | null = null;
  let lastReviews: PostReview[] = [];
  let rosterText = "";
  let overlapIndex = -1;
  let drillGen = 0;
  let roleScope: string | null = null;
  // The pane-local `--status` filter (the Ctrl+O twin of `tumwater reviews --status` and the
  // dashboard State picker): null means all, otherwise one of waiting/failing/rejected. It
  // composes with the Ctrl+G role scope in the review block's filter text but is surfaced only
  // by that header, and it never moves the History pane's outcome filter (the Pending arm in
  // tui-panes.ts is routed ahead of History's).
  let reviewState: PostReviewState | null = null;
  let head = "";
  const compose = (): void => {
    const block = lastOverlaps ? pendingOverlapsText(lastOverlaps, roleScope ?? undefined) : "";
    base = head + (block ? "\n\n" + block : "");
  };
  const queueHead = (): string => {
    if (lastQueue === null) return "";
    const inFlight = queueInFlight(session.root, lastQueue.entries, orchestratorAlive(session.root));
    if (roleScope === null) return renderMergeQueue(lastQueue, session.now(), inFlight);
    const { view, scope } = scopeMergeQueue(lastQueue, [roleScope], (r) => r === roleScope);
    return renderMergeQueue(view, session.now(), inFlight, scope);
  };
  // The one scoped traversal the review block's painting and the row selection both use, so
  // the painted block and the selected row's accept position cannot drift: the whole list with
  // no scope when neither the Ctrl+G role scope nor the Ctrl+O state filter is active, else
  // `scopePostReviews`'s kept entries and scope (each kept review keeping its whole-queue
  // position, the `tumwater reviews --role <id>` / `--status <state>` / composed twin). The
  // whole-list path stays byte-identical so an unfiltered pane reads unchanged.
  const scopedReviews = (): { entries: readonly PostReview[]; scope?: { roles: readonly string[]; positions: readonly number[]; total: number } } => {
    if (roleScope === null && reviewState === null) return { entries: lastReviews };
    const keep = (r: PostReview): boolean => (roleScope === null || r.role === roleScope) && (reviewState === null || postReviewState(r) === reviewState);
    // The `--status <state>` filter text (or `--role <id> --status <state>` when composed with a
    // Ctrl+G scope), passed only when a state filter is active: a role-only scope passes no filter
    // so it keeps the `tumwater reviews --role <id>` twin's `no post-merge reviews for <id> …`
    // no-match line (the CLI shares this path and passes no filter for `--role` alone).
    const filterText = reviewState === null ? undefined : [roleScope !== null ? `--role ${roleScope}` : "", `--status ${reviewState}`].filter(Boolean).join(" ");
    return scopePostReviews(lastReviews, roleScope === null ? [] : [roleScope], keep, filterText);
  };
  // The post-merge review block the pane paints under the merge queue and above the change
  // roster: `tumwater reviews`' own renderer over the queue `readPostReviews` reads, so the
  // TUI, the CLI, and the dashboard cannot drift on order or wording. Under a Ctrl+G scope it
  // narrows to the scoped role's entries, each kept under its whole-queue position. Empty only
  // when the whole queue is empty (no block, no header); a scope that keeps nothing still
  // prints `renderPostReviews`'s no-match line — `no post-merge reviews for <id> …` for a
  // role-only scope, `no post-merge reviews matching <filter> …` once a state filter joins.
  const reviewsHead = (): string => {
    if (lastReviews.length === 0) return "";
    const scoped = scopedReviews();
    return renderPostReviews(scoped.entries, scoped.scope, session.now());
  };
  const queueAndReviews = (): string => {
    const q = queueHead();
    const r = reviewsHead();
    return r === "" ? q : q + "\n\n" + r;
  };

  // The shared Pending-pane key-arm guard: the prompt line is free (an editor would keep the
  // key for its own view's meaning) and the Pending view (roleIds.length + 5) is current. True
  // means the arm may run.
  const onPendingView = (ctx: TuiPaneCtx): boolean =>
    promptLineFree(ctx.es) && session.view === session.roleIds.length + 5;

  const refresh = (): void => {
    // Generation guard: each refresh bumps the counter, and a resolution paints only if it
    // is the latest request's — Ctrl+R held twice, or a refresh raced with a re-entry,
    // must not let an out-of-order older resolution overwrite the newer result.
    const gen = ++refreshGen;
    overlapIndex = -1;
    lastOverlaps = null;
    ++drillGen;
    lastQueue = readMergeQueue(session.root);
    lastReviews = readPostReviews(session.root);
    rosterText = "";
    selection.rebuild();
    const queueText = queueAndReviews();
    head = queueText;
    session.paneCache = base = head;
    void Promise.all([session.collectPending(session.root), session.collectOverlaps(session.root)]).then(
      ([team, overlaps]) => {
        if (gen !== refreshGen || session.view !== session.roleIds.length + 5) return;
        lastOverlaps = overlaps;
        rosterText = "\n\n" + renderTeamChange(team);
        head = queueAndReviews() + rosterText;
        compose();
        session.paneCache = base;
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

  // The row-selection/action half (the select-cancel-accept-move cluster) lives in its own
  // module, wired in through the deps seam: it owns the three row-selection variables and the
  // Ctrl+arrow/Esc/Ctrl+X/Ctrl+A/Ctrl+V arms, borrowing the pane's render inputs, the
  // shared scoped review traversal, the pane's refresh and the view guard.
  const selection = createPendingSelection(session, {
    inputs() {
      return { lastQueue, lastReviews, roleScope, reviewState };
    },
    scopedReviews,
    refresh,
    onPendingView,
  });

  // Re-render the whole queue body from scratch after a filter (Ctrl+G role scope, Ctrl+O
  // review state) cycled: rebuild the rows off the current filter, drop any overlap drill,
  // reset the composed body and the pane cache to the new content, and repaint from the top.
  // The shared tail of the two filter-cycle arms, so both filters repaint identically.
  const repaintQueueBody = (): void => {
    selection.rebuild();
    overlapIndex = -1;
    ++drillGen;
    head = queueAndReviews() + rosterText;
    compose();
    session.paneCache = base;
    paneAtHead(session);
  };

  // Ctrl+R on the Pending pane refreshes in place — the terminal twin of the dashboard
  // Pending view's Refresh button: re-read the durable merge queue and restart the
  // change-roster collector, painting what the queue holds now. The pane re-enters at
  // its head so the changed body starts at the top; the roster's git read is a fresh
  // collector run, and a run already in flight is superseded by the new read.
  const pendingRefresh = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    refresh();
    paneAtHead(session);
    return true;
  };

  // Ctrl+G on the Pending pane cycles roleScope through each role the merge queue, the
  // post-merge reviews and the overlapping files name and back to all (the `queue --role <id>`,
  // `reviews --role <id>` and `diff --overlaps --role <id>` twins, one scope covering all three
  // surfaces); with nothing to scope it resets to null and flashes the empty message. Rebounds
  // the queue and review rows off the new scope and repaints from the top.
  const pendingScopeCycle = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const queueRoles = lastQueue ? mergeQueueRoles(lastQueue) : [];
    const reviewRoles = postReviewRoles(lastReviews);
    const holders = lastOverlaps?.state === "ready" ? overlapHolders(lastOverlaps) : [];
    const roles = [
      ...queueRoles,
      ...reviewRoles.filter((r) => !queueRoles.includes(r)),
      ...holders.filter((h) => !queueRoles.includes(h) && !reviewRoles.includes(h)),
    ];
    if (roles.length === 0) {
      roleScope = null;
      selection.rebuild();
      head = queueAndReviews() + rosterText;
      compose();
      session.paneCache = base;
      session.flashMessage("no queued merges, post-merge reviews or overlapping files to scope");
      return true;
    }
    const slots = [null, ...roles];
    const at = roleScope === null ? 0 : slots.indexOf(roleScope);
    roleScope = slots[(at + 1) % slots.length] ?? null;
    repaintQueueBody();
    return true;
  };

  // Ctrl+O on the Pending pane cycles the post-merge review state filter through all,
  // waiting, failing and rejected and back — the `tumwater reviews --status` twin and the
  // dashboard Post-merge reviews State picker, meaning the full state vocabulary even when
  // the queue holds none of a state (the renderer's `no post-merge reviews matching
  // --status …` line is the empty-selection state). Each kept review keeps its whole-queue
  // position, so Ctrl+A still accepts the right entry under any filter. The pane's own arm
  // is routed ahead of History's in tui-panes.ts, so it never advances the History outcome
  // filter; the Ctrl+G role scope composes with this filter in the block's header.
  const pendingReviewStateCycle = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const slots = [null, ...POST_REVIEW_STATES];
    const at = reviewState === null ? 0 : slots.indexOf(reviewState);
    reviewState = slots[(at + 1) % slots.length] ?? null;
    repaintQueueBody();
    return true;
  };

  // Ctrl+N on the Pending pane steps through the overlapping files, painting each holder's
  // change limited to that file (the `tumwater diff --role a,b --path <path>` view), scoped
  // by the Ctrl+G role selection; an exhausted list returns to the composed base. Each step
  // re-runs the collector guarded against a stale resolution (drill/refresh generation and
  // the view still being current).
  const pendingOverlapDrill = (ctx: TuiPaneCtx): boolean => {
    if (!onPendingView(ctx)) return false;
    const overlaps = lastOverlaps && roleScope !== null ? scopeChangeOverlaps(lastOverlaps, [roleScope]) : lastOverlaps;
    if (overlaps?.state !== "ready" || overlaps.overlaps.length === 0) {
      session.flashMessage("no overlapping files to step through");
      return true;
    }
    if (++overlapIndex >= overlaps.overlaps.length) {
      overlapIndex = -1;
      ++drillGen;
      session.paneCache = base;
      paneAtHead(session);
      return true;
    }
    const { path, roles } = overlaps.overlaps[overlapIndex]!;
    const heading = overlapDrillHeading(overlapIndex, overlaps.overlaps.length, path);
    session.paneCache = heading + "\n\nloading…";
    paneAtHead(session);
    const gen = ++drillGen;
    const refresh0 = refreshGen;
    const current = (): boolean => gen === drillGen && refresh0 === refreshGen && session.view === session.roleIds.length + 5;
    void Promise.all(roles.map((r) => session.collectChange(session.root, r, { path }))).then(
      (views) => {
        if (!current()) return;
        session.paneCache = heading + "\n\n" + renderRoleChanges({ mainBranch: overlaps.mainBranch, roles: views });
        session.requestRender();
      },
      (err: unknown) => {
        if (!current()) return;
        session.flashError(err);
        session.requestRender();
      },
    );
    return true;
  };

  const ctrlRoutes: Record<string, (ctx: TuiPaneCtx) => boolean> = {
    r: pendingRefresh,
    g: pendingScopeCycle,
    o: pendingReviewStateCycle,
    n: pendingOverlapDrill,
    x: selection.pendingCancelMerge,
    a: selection.pendingAcceptReview,
    v: selection.pendingMoveToTop,
  };
  const ctrlRoute = (key: { ctrl?: boolean; name?: string }, ctx: TuiPaneCtx): boolean | null => {
    if (!key.ctrl || key.name === undefined) return null;
    const route = ctrlRoutes[key.name];
    return route === undefined ? null : route(ctx);
  };
  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    const ctrl = ctrlRoute(key, ctx);
    if (ctrl !== null) return ctrl;
    const arrow = arrowDir(key.name);
    if (arrow !== null) return selection.pendingSelectRow(arrow, ctx);
    if (key.name === "escape") return selection.pendingClearSelection(ctx);
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
    reset() {
      // Leaving a view drops any queued-merge selection; re-entering starts at the list.
      selection.reset();
    },
    state() {
      return selection.state();
    },
  } satisfies TuiPaneModule;
}
