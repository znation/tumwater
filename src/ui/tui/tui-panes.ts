import { arrowDir, pageDir } from "./tui-keymap.js";
import { createTuiPaneSession, type TuiPanesDeps } from "./tui-pane-session.js";
import { createActivityPane } from "./tui-pane-activity.js";
import { createTranscriptPane } from "./tui-pane-transcript.js";
import { createBacklogPane } from "./tui-pane-backlog.js";
import { createReportPane } from "./tui-pane-report.js";
import { createHistoryPane } from "./tui-pane-history.js";
import { createPendingPane } from "./tui-pane-pending.js";
import { createQueuedPane } from "./tui-pane-queued.js";
import { createHealthPane } from "./tui-pane-health.js";
import { createBriefPane } from "./tui-pane-brief.js";
import type { TuiEditorCtx } from "./tui-editor-ctx.js";
import type { TuiPaneCtx, TuiPaneEditorState } from "./tui-pane-ctx.js";

/** The pane-navigation half of the createTuiKeys closure (the prompt-line editors are the other
 * half, in tui-editors.ts). This file is now a thin aggregator: the shared pane session and the
 * per-pane factories live beside it in tui-pane-session.ts and the tui-pane-*.ts modules, each
 * owning the state and the handler arms of the views it serves. This factory builds the session
 * and the modules, then owns the cross-cutting seams the shell calls: beginKey (the armed
 * two-step Ctrl+X and Ctrl+R targets), editorCtx (the per-keypress pane read the editors'
 * open arms use), cycleView (routing each view's enter in today's view order), handleKey
 * (routing each key to the matching pane module in today's dispatch order), syncRoster (the
 * roster shift/clamp and the per-module scope drops), setLineBudgets, and state (merging each
 * module's slice in view order). Export names and TuiPanesDeps are unchanged, so tui-keys.ts
 * and tui-editors.ts keep their call sites. */
export function createTuiPanes(deps: TuiPanesDeps) {
  const session = createTuiPaneSession(deps);
  const activity = createActivityPane(session);
  const transcript = createTranscriptPane(session);
  const backlog = createBacklogPane(session);
  const report = createReportPane(session);
  const history = createHistoryPane(session);
  const pending = createPendingPane(session);
  const queued = createQueuedPane(session);
  const health = createHealthPane(session);
  const brief = createBriefPane(session);

  /** Every key starts disarmed; only the backlog Ctrl+X/Ctrl+R branches read `armed`/
   * `armedRelease`, only the notes Ctrl+X branch reads `armedNotes`, and only the Health
   * Ctrl+K branch reads `armedKillOrphans`. */
  const beginKey = (): void => {
    session.armed = session.cancelArmed;
    session.cancelArmed = null;
    session.armedRelease = session.releaseArmed;
    session.releaseArmed = null;
    session.armedNotes = session.notesClearArmed;
    session.notesClearArmed = null;
    session.armedKillOrphans = session.killOrphansArmed;
    session.killOrphansArmed = false;
    session.armedRevert = session.revertArmed;
    session.revertArmed = null;
    session.armedQueue = session.queueArmed;
    session.queueArmed = null;
  };

  /** The per-key pane snapshot the editors' open arms read. */
  const editorCtx = (): TuiEditorCtx => {
    const s = state();
    return {
      view: s.view,
      roleIds: s.roleIds,
      selectedEntry: s.selectedEntry,
      selectedQueued: s.selectedQueued,
      queuedRows: s.queuedRows,
      historyGrep: s.historyGrep,
      trailSearch: s.trailMode && s.trailTranscript !== "off",
      trailGrep: s.trailGrep,
      activityGrep: s.activityGrep,
      backlogGrep: s.backlogGrep,
      queuedGrep: s.queuedGrep,
      transcriptGrep: s.transcriptGrep,
      noteMode: s.noteMode,
      changeMode: s.changeMode,
      briefMode: s.view === s.roleIds.length + 8,
    };
  };

  /** The pane half of Ctrl+T: the shell has already exited every open editor. */
  const cycleView = (): void => {
    // A cycle away drops each pane's leaving-view snapshot first, so re-entering any pane
    // starts at today's list/head/live tail (the notes/change/trail modes, the entry and
    // queued-row selections, and the activity scroll all reset here).
    activity.reset?.();
    transcript.reset?.();
    backlog.reset?.();
    history.reset?.();
    pending.reset?.();
    queued.reset?.();
    // Advance the view: events → each role's transcript → project status → usage report →
    // failures → history → pending → queued → health → brief → events.
    session.view = (session.view + 1) % (session.roleIds.length + 9);
    session.paneScroll = 0; // the Markdown panes always re-enter at their head
    // Compute the pane's Markdown once per activation (this handler renders immediately), and
    // drop it on leaving — a visit's first frame is fresh, later frames only re-window. The
    // usage/failures/history panes paint through their enter; pending, queued, health, and
    // brief have their own enter bodies; every other view clears the cache.
    if (report.enter?.() || history.enter?.()) {
      // a usage/failures/history pane painted its cached body
    } else if (session.view === session.roleIds.length + 5) {
      pending.enter?.();
    } else if (session.view === session.roleIds.length + 6) {
      queued.enter?.();
    } else if (session.view === session.roleIds.length + 7) {
      health.enter?.();
    } else if (session.view === session.roleIds.length + 8) {
      brief.enter?.();
    } else {
      session.paneCache = null;
    }
    session.requestRender();
  };

  /** Run the pane arms of the key dispatch; true when one consumed the key. `es` is the
   * editors' state, so the exclusion guards read the flags the editors hold. Each pane module
   * checks its own view/guard and returns true only when it consumed the key; this router keeps
   * the keys that multiple panes serve in today's priority order. */
  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    es: TuiPaneEditorState,
  ): boolean => {
    // The editor flags below are all false here — the editors consume every key that reads or
    // writes the line and return true whenever one is open — but each module restates its
    // mutual-exclusion guard so it reads on its own instead of leaning on the routing order.
    const ctx: TuiPaneCtx = { es };
    if (key.ctrl && key.name === "n") {
      // Ctrl+N means four different things. The Health arm is routed first so its notify-test
      // action is reachable on Health; the History trail arm second, which falls through
      // (returns false) unless the History view is selected; the Pending overlap drill-down
      // third, with the same fall-through; the transcript pane's notes/change arm last.
      // The order among them is NOT immaterial: the transcript arm
      // consumes Ctrl+N whenever it is reached — it returns true with a render even off a
      // transcript view — so it must sit last, as the fallback, or it would swallow the key
      // before the Health or History arm ever saw it.
      if (health.handleKey?.(key, ctx)) return true;
      if (history.handleKey?.(key, ctx)) return true;
      if (pending.handleKey?.(key, ctx)) return true;
      return transcript.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "g") {
      // Ctrl+G's scope arm is routed by view: Activity on 0, the History exact-role scope on
      // N+4, the Pending overlap scope on N+5, and the report team/base-role scope
      // everywhere else — the priority the original else-branch chain kept, so the
      // report arm never steals the History view's slot.
      if (session.view === 0) return activity.handleKey?.(key, ctx) ?? false;
      if (session.view === session.roleIds.length + 4) return history.handleKey?.(key, ctx) ?? false;
      if (session.view === session.roleIds.length + 5) return pending.handleKey?.(key, ctx) ?? false;
      return report.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "e") {
      // Ctrl+E's Health reclaim arm is routed ahead of the report panes' trailing-window
      // cycle; the Health arm's own view guard keeps Usage/Failures on their cycle, and the
      // Backlog/Inbox edit arms (which live in the editors) are untouched.
      if (health.handleKey?.(key, ctx)) return true;
      return report.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "k") return health.handleKey?.(key, ctx) ?? false;
    if (key.ctrl && key.name === "w") return history.handleKey?.(key, ctx) ?? false;
    if (key.ctrl && key.name === "s") return history.handleKey?.(key, ctx) ?? false;
    // Ctrl+P on Usage/Failures steps the report window back; every other view is History's.
    if (key.ctrl && key.name === "p" && (session.view === session.roleIds.length + 2 || session.view === session.roleIds.length + 3)) {
      return report.handleKey?.(key, ctx) ?? false;
    }
    // Health owns Ctrl+P (re-probe image-input models) ahead of History's fallback.
    if (key.ctrl && key.name === "p" && session.view === session.roleIds.length + 7) return health.handleKey?.(key, ctx) ?? false;
    if (key.ctrl && key.name === "p") return history.handleKey?.(key, ctx) ?? false;
    if (key.ctrl && key.name === "y") {
      // Ctrl+Y's transcript change-step arm (the diffstat toggle) is routed first and falls
      // through off it, so History keeps its Summary cycle on every other view.
      if (transcript.handleKey?.(key, ctx)) return true;
      return history.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "o") {
      // The Activity type cycle is routed first on its own view (0); on the Health view the
      // problems-only toggle precedes the History outcome cycle, and every other view keeps
      // the History outcome cycle.
      if (session.view === 0) return activity.handleKey?.(key, ctx) ?? false;
      if (session.view === session.roleIds.length + 7) return health.handleKey?.(key, ctx) ?? false;
      return history.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "x") {
      // The armed-clear Ctrl+X arms: the transcript notes first, then the History model filter,
      // then the queued cancel, then the Pending merge cancel, then the backlog cancel — each
      // returns false when its view/selection does not apply.
      if (transcript.handleKey?.(key, ctx)) return true;
      if (history.handleKey?.(key, ctx)) return true;
      if (queued.handleKey?.(key, ctx)) return true;
      if (pending.handleKey?.(key, ctx)) return true;
      return backlog.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "r") {
      // The Ctrl+R arms: the Pending pane's queue/roster re-read, the Health pane's doctor
      // re-run, the History trail's transcript cycle, then the backlog's release — each returns
      // false when its view does not apply, so the order among them is immaterial.
      if (pending.handleKey?.(key, ctx)) return true;
      if (health.handleKey?.(key, ctx)) return true;
      if (history.handleKey?.(key, ctx)) return true;
      return backlog.handleKey?.(key, ctx) ?? false;
    }
    if (key.ctrl && key.name === "v") {
      // The Ctrl+V arms, routed like Ctrl+X's: the History trail's revert, then the queued
      // prompt's and the backlog entry's move-to-top — each returns false when its
      // view/selection does not apply. The
      // Activity attach editor's own Ctrl+V arm is guarded to view 0, so it still fires
      // there ahead of this router.
      if (history.handleKey?.(key, ctx)) return true;
      if (queued.handleKey?.(key, ctx)) return true;
      return backlog.handleKey?.(key, ctx) ?? false;
    }
    const arrow = arrowDir(key.name);
    if (arrow !== null) {
      // Entry-browse arrows: the backlog pane, then the Pending pane (merge-row selection),
      // then the queued pane; every other view falls through so the editors' prompt-history
      // recall keeps the arrows.
      if (backlog.handleKey?.(key, ctx)) return true;
      if (pending.handleKey?.(key, ctx)) return true;
      if (queued.handleKey?.(key, ctx)) return true;
      return false;
    }
    const page = pageDir(key.name);
    if (page !== null) {
      // Within-body page routing in today's order: the Activity tail, the notes/change
      // (transcript) and run-trail (history) bodies, the Markdown panes from report on, then
      // the backlog entry body.
      if (activity.handleKey?.(key, ctx)) return true;
      if (transcript.handleKey?.(key, ctx)) return true;
      if (history.handleKey?.(key, ctx)) return true;
      if (report.handleKey?.(key, ctx)) return true;
      if (backlog.handleKey?.(key, ctx)) return true;
      return false;
    }
    if (key.name === "escape") {
      if (pending.handleKey?.(key, ctx)) return true;
      return queued.handleKey?.(key, ctx) ?? false;
    }
    return false;
  };

  /** Shift, clamp, and prune the pane state against a new roster. */
  const syncRoster = (roles: string[]): void => {
    const previousCount = session.roleIds.length;
    session.roleIds = roles;
    // The panes from project status on are anchored at roleIds.length, so a roster-size
    // change moves every one of their indices by the same delta: shift the view with them,
    // or an unadjusted index silently renames to a different pane while its cached body
    // stays, showing the wrong body under the tab now selected. A transcript view
    // (1..previousCount) keeps its index — it does not depend on the roster size — and the
    // clamp below handles one the shrunken roster no longer has.
    if (session.roleIds.length !== previousCount && session.view > previousCount) {
      session.view += session.roleIds.length - previousCount;
    }
    session.view = Math.min(session.view, session.roleIds.length + 8); // clamp a stale index if roles changed
    // A retired or renamed role must not leave a scope pane silently scoped to an absent role:
    // each pane drops (and recomputes) its own scope with the stale view index.
    report.dropScopes?.(roles);
    history.dropScopes?.(roles);
    activity.dropScopes?.(roles);
  };

  const setLineBudgets = (evBudget: number, enBudget: number): void => {
    session.eventBudget = evBudget;
    session.entryBudget = enBudget;
  };

  /** The state render reads back each frame, merging each pane module's slice in view order
   * over the session's shared fields. */
  const state = () => {
    const act = activity.state?.() ?? {};
    const tra = transcript.state?.() ?? {};
    const back = backlog.state?.() ?? {};
    const rep = report.state?.() ?? {};
    const hist = history.state?.() ?? {};
    const que = queued.state?.() ?? {};
    const pend = pending.state?.() ?? {};
    const heal = health.state?.() ?? {};
    return {
      view: session.view,
      cancelArmed: session.cancelArmed,
      releaseArmed: back.releaseArmed,
      paneCache: session.paneCache,
      paneScroll: session.paneScroll,
      eventBudget: session.eventBudget,
      entryBudget: session.entryBudget,
      roleIds: session.roleIds,
      activityScroll: act.activityScroll,
      activityRole: act.activityRole,
      activityGrep: act.activityGrep,
      activityType: act.activityType,
      noteMode: tra.noteMode,
      noteCache: tra.noteCache,
      changeMode: tra.changeMode,
      changeCache: tra.changeCache,
      changeStat: tra.changeStat,
      transcriptGrep: tra.transcriptGrep,
      selectedEntry: back.selectedEntry,
      entryScroll: back.entryScroll,
      backlogGrep: back.backlogGrep,
      scopeRole: rep.scopeRole,
      reportSince: rep.reportSince,
      reportStep: rep.reportStep,
      historyRole: hist.historyRole,
      historySince: hist.historySince,
      historyStep: hist.historyStep,
      historyResult: hist.historyResult,
      historyGrep: hist.historyGrep,
      historyModel: hist.historyModel,
      historySummary: hist.historySummary,
      trailMode: hist.trailMode,
      trailIndex: hist.trailIndex,
      trailCache: hist.trailCache,
      trailTranscript: hist.trailTranscript,
      trailPatch: hist.trailPatch,
      trailGrep: hist.trailGrep,
      selectedQueued: que.selectedQueued,
      queuedRows: que.queuedRows,
      queuedGrep: que.queuedGrep,
      selectedQueue: pend.selectedQueue,
      queueDetail: pend.queueDetail,
      healthProblems: heal.healthProblems,
    };
  };

  return {
    refreshQueued: queued.refreshQueued,
    refreshNotes: (role: string) => transcript.refreshNotes?.(role),
    refreshBrief: () => brief.refreshBrief?.(),
    clearBacklogSelection: backlog.clearBacklogSelection,
    applyHistorySearch: history.applySearch,
    applyActivitySearch: activity.applySearch,
    applyBacklogSearch: backlog.applySearch,
    applyQueuedSearch: queued.applySearch,
    applyTranscriptSearch: transcript.applySearch,
    beginKey,
    editorCtx,
    cycleView,
    handleKey,
    syncRoster,
    setLineBudgets,
    state,
  };
}
