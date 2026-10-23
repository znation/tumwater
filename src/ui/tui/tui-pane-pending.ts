import { readMergeQueue, queuedMergeFiles, type MergeEntry, type MergeQueueView } from "../../merge/merge-queue.js";
import { renderMergeQueue, revisionNote, retryNote, scopeMergeQueue } from "../../merge/merge-queue-render.js";
import { cancelQueuedMerge } from "../../merge/merge-cancel.js";
import { moveQueuedMergeToTop } from "../../merge/merge-top.js";
import { mergeChanges } from "../../merge/merge-slot.js";
import { orchestratorAlive } from "../../team/orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { renderChangeOverlaps, renderRoleChanges, renderTeamChange } from "../../change/change-render.js";
import { scopeChangeOverlaps, type ChangeOverlapsView } from "../../change/change-data.js";
import { roleLabel } from "../../roles/role-labels.js";
import { shortSha } from "../../text/format.js";
import { humanAgo } from "../../text/datetime.js";
import { readPostReviews, type PostReview } from "../../review/post-merge-review.js";
import { renderPostReviews } from "../../review/post-review-render.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";
import { arrowDir } from "./tui-keymap.js";
import { moveEntrySelection } from "./tui-backlog.js";

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
  const seen: string[] = [];
  for (const o of view.overlaps) for (const r of o.roles) if (!seen.includes(r)) seen.push(r);
  return seen;
}

/** The distinct roles named across the merge queue, in first-seen (queue) order; empty for an
 * empty queue. The queue's own roles lead the pane's Ctrl+G scope cycle, before the overlap
 * holders — the queue scope is the `tumwater queue --role <id>` twin. */
export function mergeQueueRoles(view: MergeQueueView): string[] {
  const seen: string[] = [];
  for (const e of view.entries) if (!seen.includes(e.role)) seen.push(e.role);
  return seen;
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
 * in-place refresh, the Ctrl+N overlap drill-down, and the Ctrl+G role scope (narrowing the
 * merge queue as well as the overlapping files), and it has no render state of its own —
 * aside from the enter half of the Ctrl+T cycle. Its queue arms: Ctrl+X twice cancels a
 * selected merge, Ctrl+V moves it to the front. */
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
  // return to after the last one. Ctrl+G cycles roleScope through each role the queue and the
  // overlaps name and back to all (the `queue --role <id>` and `diff --overlaps --role <id>`
  // twins, one scope covering both surfaces); Ctrl+N then steps through only the scoped files,
  // and the scope survives a refresh. The queue's roles lead the cycle, the overlap holders
  // that are not also queued follow, and each kept merge holds its whole-queue position.
  let refreshGen = 0;
  let base = "";
  let lastOverlaps: ChangeOverlapsView | null = null;
  let lastQueue: MergeQueueView | null = null;
  let lastReviews: PostReview[] = [];
  let rosterText = "";
  let overlapIndex = -1;
  let drillGen = 0;
  let roleScope: string | null = null;
  let head = "";
  // The Pending pane's row selection (null = list mode): the index into queueRows of the
  // merge shown in full, cleared on every Ctrl+T cycle like selectedQueued. Each row pairs a
  // kept entry with its 1-based whole-queue position (or the scope's kept positions when a
  // Ctrl+G role scope is active), so a cancel addresses the entry `tumwater queue --cancel`
  // numbers — the position the CLI's queue line printed.
  let selectedQueue: number | null = null;
  // The Pending pane's cached rows — the same whole-queue traversal renderMergeQueue painted —
  // so a selection addresses an entry's position without re-reading the queue on every frame.
  let queueRows: { entry: MergeEntry; position: number }[] = [];
  // The rendered detail of the selected row (the header, summary, and when present the
  // entry's body and revision note); the pane body windows it in place of the queue list
  // while a row is selected. Empty in list mode.
  let queueDetail = "";
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
  // The post-merge review block the pane paints under the merge queue and above the change
  // roster: `tumwater reviews`' own renderer over the queue `readPostReviews` reads, so the
  // TUI, the CLI, and the dashboard cannot drift on order or wording. Empty when the queue is
  // empty (no block, no header).
  const reviewsHead = (): string => (lastReviews.length === 0 ? "" : renderPostReviews(lastReviews));
  const queueAndReviews = (): string => {
    const q = queueHead();
    const r = reviewsHead();
    return r === "" ? q : q + "\n\n" + r;
  };
  // The rendered detail of one selected queue row — the headline naming the entry with the
  // position `tumwater queue --cancel` takes and the cancel hint, then the summary and (when
  // the entry carries them) its body and revision note, so an operator deciding whether to
  // cancel sees what the entry is about before the second Ctrl+X.
  const mergeDetail = (row: { entry: MergeEntry; position: number }): string => {
    const e = row.entry;
    const note = revisionNote(e);
    const retry = retryNote(e, session.now());
    const lines = [
      `merge #${row.position} (Ctrl+X to cancel, Ctrl+V to top): ${roleLabel(e.role)} run #${e.run} · ${shortSha(e.sha)} · ${humanAgo(e.enqueuedAt, session.now())}`,
      e.summary,
    ];
    if (e.body) lines.push("", e.body);
    if (note) lines.push("", note);
    if (retry) lines.push("", retry);
    return lines.join("\n");
  };
  // Guard the cancel/top actions against racing a merge that just entered the slot: the
  // selected entry (or one its changes touch) is heading into the merge right now, so acting
  // on it would race the drain. Flash the pane's "being merged" message and return true so
  // the caller aborts; otherwise false.
  const guardMergeInFlight = (row: { entry: MergeEntry; position: number }): boolean => {
    const inFlight = queueInFlight(session.root, lastQueue?.entries ?? [], orchestratorAlive(session.root));
    if (inFlight && (inFlight.sha === row.entry.sha || mergeChanges(inFlight).some((c) => c.sha === row.entry.sha))) {
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
    if (lastQueue === null) {
      queueRows = [];
      selectedQueue = null;
      queueDetail = "";
      return;
    }
    if (roleScope === null) {
      queueRows = lastQueue.entries.map((entry, i) => ({ entry, position: i + 1 }));
    } else {
      const { view, scope } = scopeMergeQueue(lastQueue, [roleScope], (r) => r === roleScope);
      queueRows = view.entries.map((entry, i) => ({ entry, position: scope.positions[i]! }));
    }
    if (selectedQueue !== null) {
      if (queueRows.length === 0) {
        selectedQueue = null;
        queueDetail = "";
      } else {
        selectedQueue = Math.min(selectedQueue, queueRows.length - 1);
        queueDetail = mergeDetail(queueRows[selectedQueue]!);
      }
    }
  };
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
    rebuildQueueRows();
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
    if (key.ctrl && key.name === "g" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 5) {
      const queueRoles = lastQueue ? mergeQueueRoles(lastQueue) : [];
      const holders = lastOverlaps?.state === "ready" ? overlapHolders(lastOverlaps) : [];
      const roles = [...queueRoles, ...holders.filter((h) => !queueRoles.includes(h))];
      if (roles.length === 0) {
        roleScope = null;
        rebuildQueueRows();
        head = queueAndReviews() + rosterText;
        compose();
        session.paneCache = base;
        session.flashMessage("no queued merges or overlapping files to scope");
        return true;
      }
      const slots = [null, ...roles];
      const at = roleScope === null ? 0 : slots.indexOf(roleScope);
      roleScope = slots[(at + 1) % slots.length] ?? null;
      rebuildQueueRows();
      overlapIndex = -1;
      ++drillGen;
      head = queueAndReviews() + rosterText;
      compose();
      session.paneCache = base;
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "n" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 5) {
      const overlaps = lastOverlaps && roleScope !== null ? scopeChangeOverlaps(lastOverlaps, [roleScope]) : lastOverlaps;
      if (overlaps?.state !== "ready" || overlaps.overlaps.length === 0) {
        session.flashMessage("no overlapping files to step through");
        return true;
      }
      if (++overlapIndex >= overlaps.overlaps.length) {
        overlapIndex = -1;
        ++drillGen;
        session.paneCache = base;
        session.paneScroll = 0;
        session.requestRender();
        return true;
      }
      const { path, roles } = overlaps.overlaps[overlapIndex]!;
      const heading = overlapDrillHeading(overlapIndex, overlaps.overlaps.length, path);
      session.paneCache = heading + "\n\nloading…";
      session.paneScroll = 0;
      session.requestRender();
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
    }
    const arrow = arrowDir(key.name);
    if (session.view === session.roleIds.length + 5 && arrow !== null && promptLineFree(ctx.es)) {
      // In the Pending pane, up/down select a queued merge row in full (wrapping, the backlog
      // pane's rule) instead of editing the prompt; an empty queue has nothing to select, so
      // moveEntrySelection clears the selection. The selected detail shares paneScroll with the
      // list, so a newly opened row must start at its head, or it renders scrolled into the
      // middle of the previous row's body.
      selectedQueue = moveEntrySelection(queueRows.length, selectedQueue, arrow);
      const selRow = selectedQueue === null ? undefined : queueRows[selectedQueue];
      queueDetail = selRow ? mergeDetail(selRow) : "";
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    if (key.name === "escape" && session.view === session.roleIds.length + 5 && selectedQueue !== null && promptLineFree(ctx.es)) {
      // Esc on the Pending pane returns it to list mode; the cached list is untouched (nothing
      // was cancelled), so the pane shows the same renderMergeQueue it entered with. The shared
      // paneScroll resets with the body switch, like a selection move.
      selectedQueue = null;
      queueDetail = "";
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "x" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 5) {
      if (selectedQueue === null || queueRows.length === 0) {
        // A list-mode press (or any other view) just tells the operator how to select; the
        // queue is untouched. The first press of the two-step arm is disarmed by beginKey.
        session.flashMessage("select a merge with ↑↓ first");
        session.requestRender();
        return true;
      }
      const row = queueRows[Math.min(selectedQueue, queueRows.length - 1)]!;
      if (session.armedQueue?.sha === row.entry.sha && session.armedQueue?.position === row.position) {
        // Second press on the same entry: re-read the queue, guard the in-flight race, then
        // remove it through the CLI's own core (`tumwater queue --cancel <n>`), so the pane,
        // the CLI, and the dashboard cancel cannot drift.
        const confirm = async (): Promise<void> => {
          const files = queuedMergeFiles(session.root);
          const target = files[row.position - 1];
          if (target?.entry.sha !== row.entry.sha) {
            // A queue that shifted under the selection (a concurrent drain or another cancel)
            // moved this entry: refuse rather than remove the wrong one.
            session.flashMessage("the merge queue changed — try again");
            session.requestRender();
            return;
          }
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
    }
    if (key.ctrl && key.name === "v" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 5) {
      // Move the selected merge to the head of the queue — the pane's twin of `tumwater
      // queue --top <n>`, through the same core the CLI and the dashboard use, so the three
      // cannot drift on the rename or the already-first/out-of-range outcomes. A single
      // keypress is enough because the move is reversible and non-destructive (unlike
      // Ctrl+X's two-step cancel arm).
      if (selectedQueue === null || queueRows.length === 0) {
        session.flashMessage("select a merge with ↑↓ first");
        session.requestRender();
        return true;
      }
      const row = queueRows[Math.min(selectedQueue, queueRows.length - 1)]!;
      const top = async (): Promise<void> => {
        if (row.position === 1) {
          session.flashMessage("merge #1 is already at the front");
          session.requestRender();
          return;
        }
        const files = queuedMergeFiles(session.root);
        if (files[row.position - 1]?.entry.sha !== row.entry.sha) {
          // A queue that shifted under the selection moved this entry: refuse rather than
          // move the wrong one.
          session.flashMessage("the merge queue changed — try again");
          session.requestRender();
          return;
        }
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
    reset() {
      // Leaving a view drops any queued-merge selection; re-entering starts at the list.
      selectedQueue = null;
      queueDetail = "";
    },
    state() {
      return { selectedQueue, queueDetail };
    },
  } satisfies TuiPaneModule;
}
