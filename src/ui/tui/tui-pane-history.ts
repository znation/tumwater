import { SPARSE_WINDOW_NOTE } from "../../events/event-window.js";
import { betweenWindow } from "../../cli/cli-args.js";
import {
  HISTORY_DEFAULT_RUNS,
  historyClass,
  readRunRows,
  readRunRowsSince,
  summarizeRunRows,
  summarizeRunRowsByModel,
  runRowsMatchingGrep,
  runRowsOnModels,
  type HistoryResultClass,
  type HistorySummaryGroup,
  type RunRow,
} from "../../history/history-data.js";
import { renderModelSummary, renderSummary } from "../../history/history-render.js";
import { historyPaneText } from "./tui-history.js";
import { pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { nextInCycle, cycleLabel, steppedWindowBounds, HISTORY_WINDOWS, HISTORY_RESULTS, type TuiPaneSession } from "./tui-pane-session.js";
import { createRunTrail, type RunTrailSelection } from "./tui-pane-trail.js";

/** The bounds `readRunRowsSince` reads for a trailing window of `windowMs` stepped `step` window
 * lengths back: step 0 (or no window) is the trailing window, step k the window (k+1)*len to k*len
 * ago, the `history --since --until` pair. The step math delegates to the panes' shared
 * `steppedWindowBounds`, mapping its absent `undefined` upper bound back to this signature's
 * `null` (the collectors' default either way, and what readRunRowsSince's own tests pin), so the
 * History and Usage/Failures panes cannot drift on what a stepped window means. */
export function historyWindowBounds(
  windowMs: number | null,
  step: number,
): { sinceMs: number | null; untilMs: number | null } {
  const b = steppedWindowBounds(windowMs, step);
  return { sinceMs: b.sinceMs, untilMs: b.untilMs ?? null };
}

/** The History pane (view roleIds.length + 4) of the TUI (src/ui/tui/tui.tsx): the session
 * window (Ctrl+S), outcome filter (Ctrl+O), model filter (Ctrl+X), summary toggle (Ctrl+Y),
 * exact-role scope (Ctrl+G), free-text search (`/`), the one-press newest-failure jump
 * (Ctrl+L), and the Ctrl+N completed-run trail (Ctrl+P steps it to older runs, Ctrl+R cycles
 * its agent transcript, Ctrl+W shows its commit patch, Ctrl+V twice reverts the shown run's
 * merged change), each with its cache and body window. With the trail off, Ctrl+P steps the
 * window back by its own length (the `history --since --until` window) and Ctrl+S returns to
 * the trailing window. Split out of the pane-navigation monolith; it owns the pane's
 * window/result/model/summary/scope/search state and the arms that touch them, while the
 * run-trail subsystem (its 14 state vars and the read/arm functions that serve it) lives in
 * the dedicated tui-pane-trail.ts module wired in below through a small seam. */
export function createHistoryPane(
  session: TuiPaneSession,
) {
  // The History pane's session trailing window (Ctrl+S), a HISTORY_WINDOWS length or null for
  // the default newest-N read. Session-only like the view/scroll state; the next Ctrl+T into
  // History computes the cache with it.
  let historyWindow: number | null = null;
  // How many window lengths back the window ends (Ctrl+P off the trail); session-only like the
  // window, and 0 means the trailing window. Ctrl+S resets it.
  let historyStep = 0;
  // The History pane's session outcome filter (Ctrl+O), a HISTORY_RESULTS class or null for no
  // filter. Session-only like the window; the next Ctrl+T into History computes with it.
  let historyResult: HistoryResultClass | null = null;
  // The History pane's session model filter (Ctrl+X), a model id the pane's rows ran on or null
  // for every model. Session-only like the result; the next Ctrl+T into History computes with it.
  let historyModel: string | null = null;
  // The History pane's session exact-role scope (Ctrl+G), a raw roster id or null for the
  // team's full read. Session-only like the window/result; syncSnapshot clears it when the
  // roster drops the id. The raw ids, not scopeCycle's base roles: History filters by exact
  // role (`history --role`), where `feature-2` is its own slot.
  let historyRole: string | null = null;
  // The History pane's session free-text search (the `/` prompt-line editor), a
  // case-insensitive substring over history-data.ts's runRowGrepHaystack — the same rule
  // `tumwater history --grep` and the dashboard search use. null is no search; session-only
  // like the window/result/role, so the next Ctrl+T into History computes the cache with it.
  let historyGrep: string | null = null;
  // The History pane's session Summary toggle (Ctrl+Y): null shows the per-run row list, "role"
  // the per-role tally (`history --summary`), "model" the per-model one (`--summary --by model`).
  // Session-only like the window/result/role/search, so the next Ctrl+T into History
  // computes the cache with it.
  let historySummary: HistorySummaryGroup | null = null;

  /** The pane's row selection: scope, then window, then search, then outcome class — the order
   * `tumwater history` applies them. Returns the raw read's coverage flag, the count after the
   * search (so an empty body can blame the filter that emptied the set: `afterGrep > 0` means
   * rows matched the pattern and the class then removed them), the count after the class
   * (`afterResult > 0` means rows passed it and the model then removed them) and the rows after
   * the model filter, applied last like the CLI's `--model`. The
   * search applies history-data.ts's shared run-grep rule (runRowsMatchingGrep), the same one
   * the CLI and the dashboard use, so the surfaces cannot disagree. `limit` bounds a windowless
   * read; a window reads through readRunRowsSince. */
  const selectPaneRows = (
    sinceMs: number | null,
    resultClass: HistoryResultClass | null,
    role: string | null,
    grep: string | null,
    model: string | null,
    limit: number,
    step: number,
  ): { covered: boolean; afterGrep: number; afterResult: number; filtered: RunRow[] } => {
    const bounds = historyWindowBounds(sinceMs, step);
    const { rows, covered } = bounds.sinceMs === null
      ? { rows: readRunRows(session.root, limit, role), covered: true }
      : readRunRowsSince(session.root, bounds.sinceMs, role, bounds.untilMs);
    const grepped = grep === null ? rows : runRowsMatchingGrep(rows, grep);
    const classed = resultClass === null ? grepped : grepped.filter((r) => historyClass(r.result) === resultClass);
    const filtered = model === null ? classed : runRowsOnModels(classed, [model]);
    return { covered, afterGrep: grepped.length, afterResult: classed.length, filtered };
  };

  /** The History pane's body for one trailing window, one outcome class, one exact-role scope,
   * and one free-text search: the paneCache the Ctrl+T/Ctrl+S/Ctrl+O/Ctrl+G/`/` handlers store.
   * The default (null/null/null/null) read is byte-for-byte the newest-N pane that predates the
   * window, outcome, role, and search cycles — readRunRows with HISTORY_DEFAULT_RUNS,
   * unfiltered. A trailing window reads through the same readRunRowsSince collector `tumwater
   * history --since` uses, a class filters through history-data.ts's canonical historyClass rule,
   * and the search filters through runRowGrepHaystack — the same haystack and case-insensitive
   * substring rule `tumwater history --grep` and the dashboard's History search use — so the TUI,
   * the CLI, and the dashboard cannot disagree about the rows. The role is the exact role id the
   * raw roster (and `history --role`, and the dashboard picker) names — readRunRows filters
   * `e.source === role`, an instance id is its own scope, never folded into a base role. An empty
   * read with no class and no search returns "" so the pane keeps its own no-runs note instead of
   * a lone header; when a class or a search is active and the read returned rows, an empty
   * filtered body names whichever filter the CLI's precedence blames, so the pane states the
   * filter instead of claiming the log is empty. Otherwise the body is prefixed with the active
   * role/window/result/search labels and, when the read cannot prove full coverage, the same
   * sparse-window note every windowed render prints (SPARSE_WINDOW_NOTE). */
  const historyPaneCache = (
    sinceMs: number | null,
    resultClass: HistoryResultClass | null,
    role: string | null,
    grep: string | null,
    model: string | null,
    summary: HistorySummaryGroup | null,
    step: number,
  ): string => {
    const { covered, afterGrep, afterResult, filtered } = selectPaneRows(
      sinceMs,
      resultClass,
      role,
      grep,
      model,
      HISTORY_DEFAULT_RUNS,
      step,
    );
    // The session Summary toggle (Ctrl+Y) swaps the row list for the same per-role tally the CLI's
    // `history --summary` and the dashboard History view print (summarizeRunRows → renderSummary),
    // folded over exactly the rows the window/scope/result/search selected, so the three surfaces
    // cannot disagree. The non-empty guard matters: renderSummary always prints a header, so
    // without it an empty read would bypass the pane's no-rows / no-runs wording below.
    const body =
      summary === "role" && filtered.length > 0
        ? renderSummary(summarizeRunRows(filtered))
        : summary === "model" && filtered.length > 0
          ? renderModelSummary(summarizeRunRowsByModel(filtered))
          : historyPaneText(filtered);
    // null when no class is active, so the header/empty-body paths below only name a result
    // filter the session actually holds (cycleLabel(HISTORY_RESULTS, null) is the "all" label).
    const resultLabel = resultClass === null ? null : cycleLabel(HISTORY_RESULTS, resultClass);
    // The role first, then the window/result/search labels: the role is the coarsest cut, and a
    // role-only read (no window, no class) still prints its scope line above the rows.
    const header = [
      ...(role === null ? [] : ["role: " + role]),
      ...(sinceMs === null
        ? []
        : step > 0
          ? ["window: " + betweenWindow((step + 1) * sinceMs, step * sinceMs)]
          : ["window: last " + (cycleLabel(HISTORY_WINDOWS, sinceMs) ?? "default")]),
      ...(resultLabel === null ? [] : ["result: " + resultLabel]),
      ...(model === null ? [] : ["model: " + model]),
      ...(grep === null ? [] : ["search: " + grep]),
    ].join("\n");
    if (!body) {
      // The class names itself only when it emptied a set grep admitted (`afterGrep > 0`) — the
      // CLI's condition and the dashboard's `hasRows` draw the same line — so an empty log or
      // window keeps the pane's own no-runs note instead of blaming a filter that removed
      // nothing. A pattern that admitted nothing names itself next, with the CLI's wording. An
      // empty read with neither filter returns "" so the pane keeps its own note, and an
      // role-only empty read returns "" too (the CLI's empty-state wording does not name --role),
      // so the pane never grows a lone `role:` header.
      if (model !== null && afterResult > 0) return header + "\nno runs on model \"" + model + "\"";
      if (resultClass !== null && afterGrep > 0) {
        return header + "\nno runs with result \"" + resultLabel + "\"";
      }
      if (grep !== null) return header + "\nno runs matching \"" + grep + "\"";
      return "";
    }
    return (header ? header + "\n" : "") + body + (sinceMs !== null && !covered ? "\n" + SPARSE_WINDOW_NOTE : "");
  };

  /** Recompute the History pane's cached body if it is the current view, re-entering at its
   * head; true when it painted (the "history" arm of the shared refresh the panes and the
   * roster sync share). */
  const recompute = (): boolean => {
    if (session.view !== session.roleIds.length + 4) return false;
    session.paneCache = historyPaneCache(historyWindow, historyResult, historyRole, historyGrep, historyModel, historySummary, historyStep);
    session.paneScroll = 0;
    return true;
  };

  // The row selection the run-trail subsystem borrows: live getters over the same closure
  // vars (and a setter for the Ctrl+P window step), so a scope or filter change the trail
  // re-reads matches whatever the pane currently holds.
  const selection: RunTrailSelection = {
    get window() {
      return historyWindow;
    },
    get result() {
      return historyResult;
    },
    get role() {
      return historyRole;
    },
    get grep() {
      return historyGrep;
    },
    get model() {
      return historyModel;
    },
    get step() {
      return historyStep;
    },
    set step(v: number) {
      historyStep = v;
    },
  };

  const trail = createRunTrail(session, {
    selection,
    selectPaneRows,
    resetToNewestFailure() {
      // The Ctrl+L newest-failure jump clears every filter the operator left set — role scope,
      // trailing window, search, model, summary — and recomputes the pane.
      historyRole = null;
      historyResult = "problems";
      historyWindow = null;
      historyStep = 0;
      historyGrep = null;
      historyModel = null;
      historySummary = null;
      recompute();
    },
    recompute,
  });

  /** The History pane's cycle handlers share one close: after they mutate the pane's session
   * filter/window/scope, any open trail follows the change (a scope or filter change re-reads
   * the new selection's newest run), the rows/cache are recomputed, and a render is requested.
   * Folding the tail keeps the four handlers from drifting on which steps run — a filter
   * change must refresh the trail and re-read rows the same way every time. Returns true so
   * each handler reports it handled the key up the aggregator. Ctrl+Y toggles only the summary
   * view (rows never re-follow a closed trail), so it passes withTrail=false. */
  const commitHistoryChange = (withTrail = true): boolean => {
    if (withTrail && trail.snapshot().trailMode) trail.refreshTrail();
    recompute();
    session.requestRender();
    return true;
  };

  const historyScopeCycle = (ctx: TuiPaneCtx): boolean => {
    if (!promptLineFree(ctx.es)) return false;
    // Routed here only for the History view; every other view's scope arm is Activity (0) or
    // the report panes, which the aggregator routes ahead of this module.
    if (session.view !== session.roleIds.length + 4) return false;
    // The History scope walks the raw roster ids (`[null, ...roleIds]`) so an instance id is
    // its own slot, matching `history --role` and the dashboard picker. A trail already on
    // screen follows the scope: re-read the new scope's newest completed run (or drop to the
    // pane's no-trail note when it has none) so the trail and the tab strip cannot name
    // different roles.
    const slots: Array<string | null> = [null, ...session.roleIds];
    const slot = slots.indexOf(historyRole);
    historyRole = slots[(slot + 1) % slots.length] ?? null;
    return commitHistoryChange();
  };

  const historyWindowCycle = (ctx: TuiPaneCtx): boolean => {
    if (!promptLineFree(ctx.es)) return false;
    // Ctrl+S advances the History pane's trailing window (mnemonic: **S**ince). Guarded out
    // of budget-edit and role-prompt modes like the other mode-sensitive keys. The window is
    // session state: advancing it off the History view only changes the label, and the next
    // Ctrl+T into History computes the cache with it; on the History view this handler
    // re-reads the rows now and resets the scroll so the changed body re-enters at its head.
    historyStep = 0;
    historyWindow = nextInCycle(HISTORY_WINDOWS, historyWindow);
    return commitHistoryChange();
  };

  const historyResultCycle = (ctx: TuiPaneCtx): boolean => {
    if (!promptLineFree(ctx.es)) return false;
    // Ctrl+O advances the History pane's outcome filter (mnemonic: **O**utcome). Guarded out
    // of budget-edit and role-prompt modes like Ctrl+S beside it. (The Health pane's
    // problems-only Ctrl+O is handled ahead of this module by the aggregator when that view is
    // current.) The class is session state: advancing it off the History view only changes the
    // label, and the next Ctrl+T into History computes the cache with it; on the History view
    // this handler re-reads and re-filters the rows now and resets the scroll so the changed
    // body re-enters at its head.
    historyResult = nextInCycle(HISTORY_RESULTS, historyResult);
    return commitHistoryChange();
  };

  const historyModelCycle = (ctx: TuiPaneCtx): boolean => {
    if (!promptLineFree(ctx.es)) return false;
    // Ctrl+X advances the History pane's model filter — all, each model the pane's rows ran on
    // (in the Ctrl+Y by-model table's order), all — the twin of `tumwater history --model`.
    // False off the History view so the other Ctrl+X arms keep their keys.
    if (session.view !== session.roleIds.length + 4) return false;
    const rows = selectPaneRows(historyWindow, historyResult, historyRole, historyGrep, null, HISTORY_DEFAULT_RUNS, historyStep).filtered;
    const list = summarizeRunRowsByModel(rows).models.flatMap((m) => (m.model === null ? [] : [m.model]));
    if (list.length === 0 && historyModel === null) {
      session.flashMessage("no runs with a model in this view");
      return true;
    }
    const i = list.indexOf(historyModel ?? "");
    historyModel = i + 1 < list.length ? list[i + 1]! : null;
    return commitHistoryChange();
  };

  const historySummaryCycle = (ctx: TuiPaneCtx): boolean => {
    if (!promptLineFree(ctx.es)) return false;
    // Ctrl+Y cycles the History pane's views — rows, per-role Summary, per-model Summary,
    // rows (mnemonic: summar**Y**) — the same tallies `tumwater history --summary [--by model]`
    // and the dashboard History view print,
    // folded over the pane's already-selected rows. Guarded out of budget-edit and
    // role-prompt modes like Ctrl+S/O beside it. The class is session state: toggling it off
    // the History view only changes the label, and the next Ctrl+T into History computes the
    // cache with it; on the History view this handler re-reads and re-renders now and resets
    // the scroll so the changed body re-enters at its head.
    historySummary = historySummary === null ? "role" : historySummary === "role" ? "model" : null;
    return commitHistoryChange(false);
  };

  const ctrlRoutes: Record<string, (ctx: TuiPaneCtx) => boolean> = {
    n: trail.trailToggle,
    l: trail.newestFailure,
    p: trail.stepBack,
    r: trail.transcriptCycle,
    w: trail.patchToggle,
    v: trail.revertArm,
    g: historyScopeCycle,
    s: historyWindowCycle,
    o: historyResultCycle,
    x: historyModelCycle,
    y: historySummaryCycle,
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
    const page = pageDir(key.name);
    if (page !== null) return trail.page(page);
    return false;
  };

  return {
    handleKey,
    enter: recompute,
    reset() {
      // A cycle away leaves the run trail (which is History-only) and drops its snapshot too.
      trail.dropTrail();
      session.revertArmed = null;
      session.armedRevert = null;
    },
    dropScopes(roles) {
      // The same drop for History's exact-role scope: a retired or renamed role must not keep
      // labeling an empty pane. An on-screen History pane recomputes from the team-wide read
      // so its rows and its `role:` header clear together.
      if (historyRole !== null && !roles.includes(historyRole)) {
        historyRole = null;
        recompute();
        // The retired scope may have been feeding an on-screen trail: re-read it from the
        // team so the pane and the tab strip cannot name a role the roster no longer has.
        if (trail.snapshot().trailMode) trail.refreshTrail();
      }
    },
    applySearch(pattern: string | null) {
      // Apply a finished History search on the pane: set the grep, recompute the cached rows
      // now (the pane is showing), and re-enter at the body's head — the leaf the search
      // editor's Enter calls through its applyHistorySearch dep.
      if (trail.applyTrailSearch(pattern ?? "")) {
        // The transcript is showing: the trail narrowed its entries; the run rows stay.
        return;
      }
      historyGrep = pattern;
      if (trail.snapshot().trailMode) trail.refreshTrail();
      session.paneCache = historyPaneCache(historyWindow, historyResult, historyRole, historyGrep, historyModel, historySummary, historyStep);
      session.paneScroll = 0;
    },
    state() {
      const snap = trail.snapshot();
      return {
        historyRole,
        historySince: historyWindow === null ? null : cycleLabel(HISTORY_WINDOWS, historyWindow),
        historyStep,
        historyResult: cycleLabel(HISTORY_RESULTS, historyResult),
        historyGrep,
        historyModel,
        historySummary,
        trailMode: snap.trailMode,
        trailIndex: snap.trailIndex,
        trailCache: snap.trailCache,
        trailTranscript: snap.trailTranscript,
        trailPatch: snap.trailPatch,
        trailGrep: snap.trailGrep,
      };
    },
  } satisfies TuiPaneModule & { applySearch(pattern: string | null): void };
}
