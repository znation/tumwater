import { readMergeQueue } from "../../merge/merge-queue.js";
import { renderMergeQueue } from "../../merge/merge-queue-render.js";
import { orchestratorAlive } from "../../team/orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { renderChangeOverlaps, renderRoleChanges, renderTeamChange } from "../../change/change-render.js";
import { scopeChangeOverlaps, type ChangeOverlapsView } from "../../change/change-data.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

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

/** The heading over one overlap's drill-down: its place in the list and the path. */
export function overlapDrillHeading(index: number, total: number, path: string): string {
  return `overlap ${index + 1}/${total}: ${path} (Ctrl+N next)`;
}

/** The Pending pane (view roleIds.length + 5) of the TUI (src/ui/tui/tui.tsx): the durable
 * merge queue rendered up front plus the git-backed change roster the async collector appends
 * when it resolves. Split out of the pane-navigation monolith; its key arms are the Ctrl+R
 * in-place refresh, the Ctrl+N overlap drill-down, and the Ctrl+G overlap role scope, and it has
 * no render state of its own — aside from the enter half of the Ctrl+T cycle. */
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
  // return to after the last one. Ctrl+G cycles overlapScope through each holding role and back
  // to all (the `diff --overlaps --role <id>` view); Ctrl+N then steps through only the scoped
  // files, and the scope survives a refresh.
  let refreshGen = 0;
  let base = "";
  let lastOverlaps: ChangeOverlapsView | null = null;
  let overlapIndex = -1;
  let drillGen = 0;
  let overlapScope: string | null = null;
  let head = "";
  const compose = (): void => {
    const block = lastOverlaps ? pendingOverlapsText(lastOverlaps, overlapScope ?? undefined) : "";
    base = head + (block ? "\n\n" + block : "");
  };
  const refresh = (): void => {
    // Generation guard: each refresh bumps the counter, and a resolution paints only if it
    // is the latest request's — Ctrl+R held twice, or a refresh raced with a re-entry,
    // must not let an out-of-order older resolution overwrite the newer result.
    const gen = ++refreshGen;
    overlapIndex = -1;
    lastOverlaps = null;
    ++drillGen;
    const queueView = readMergeQueue(session.root);
    const queueText = renderMergeQueue(queueView, session.now(), queueInFlight(session.root, queueView.entries, orchestratorAlive(session.root)));
    head = queueText;
    session.paneCache = base = head;
    void Promise.all([session.collectPending(session.root), session.collectOverlaps(session.root)]).then(
      ([team, overlaps]) => {
        if (gen !== refreshGen || session.view !== session.roleIds.length + 5) return;
        lastOverlaps = overlaps;
        head = queueText + "\n\n" + renderTeamChange(team);
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
      const holders = lastOverlaps?.state === "ready" ? overlapHolders(lastOverlaps) : [];
      if (holders.length === 0) {
        overlapScope = null;
        compose();
        session.flashMessage("no overlapping files to scope");
        return true;
      }
      const slots = [null, ...holders];
      const at = overlapScope === null ? 0 : slots.indexOf(overlapScope);
      overlapScope = slots[(at + 1) % slots.length] ?? null;
      overlapIndex = -1;
      ++drillGen;
      compose();
      session.paneCache = base;
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "n" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 5) {
      const overlaps = lastOverlaps && overlapScope !== null ? scopeChangeOverlaps(lastOverlaps, [overlapScope]) : lastOverlaps;
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
