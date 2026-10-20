// vocabulary: plain
import { SPARSE_WINDOW_NOTE } from "../../events/event-window.js";
import {
  HISTORY_DEFAULT_RUNS,
  HISTORY_MAX_RUNS,
  historyClass,
  readTickRows,
  readTickRowsSince,
  summarizeTickRows,
  summarizeTickRowsByModel,
  runRowsMatchingGrep,
  type HistoryResultClass,
  type HistorySummaryGroup,
  type TickRow,
} from "../../history/history-data.js";
import { renderModelSummary, renderSummary } from "../../history/history-render.js";
import { historyPaneText } from "./tui-history.js";
import { readTickDetail, type TickDetail } from "../../run/run-detail-data.js";
import { renderTickDetail, runTranscriptLines } from "../../run/run-detail.js";
import { pageMarkdownBody } from "./tui-backlog.js";
import { pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { nextInCycle, cycleLabel, HISTORY_WINDOWS, HISTORY_RESULTS, type TuiPaneSession } from "./tui-pane-session.js";

/** The History pane (view roleIds.length + 4) of the TUI (src/ui/tui/tui.tsx): the session
 * window (Ctrl+S), outcome filter (Ctrl+O), exact-role scope (Ctrl+G), free-text search (`/`),
 * and the Ctrl+N completed-tick trail (Ctrl+P steps it to older runs), each with its cache and
 * body window. Split out of the pane-navigation monolith; it owns the pane's
 * window/result/scope/search/trail state and
 * the arms that touch them. */
export function createHistoryPane(
  session: TuiPaneSession,
) {
  // The History pane's session trailing window (Ctrl+S), a HISTORY_WINDOWS length or null for
  // the default newest-N read. Session-only like the view/scroll state; the next Ctrl+T into
  // History computes the cache with it.
  let historyWindow: number | null = null;
  // The History pane's session outcome filter (Ctrl+O), a HISTORY_RESULTS class or null for no
  // filter. Session-only like the window; the next Ctrl+T into History computes with it.
  let historyResult: HistoryResultClass | null = null;
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
  // Ctrl+N on the History pane swaps the row list for the newest completed tick's full event
  // trail (renderTickDetail over readTickDetail) — the same text `tumwater tick --last` and
  // the dashboard's History drill-down serve. Session-only like the other pane snapshots:
  // computed once on entry and only re-windowed each frame.
  // Ctrl+P steps the trail back one run: trailIndex is the shown run's 0-based newest-first
  // position in the pane's selection (scope, window, search, outcome class; 0 = newest), reset
  // to 0 whenever the trail opens, closes or follows a scope or filter change.
  let trailMode = false;
  let trailIndex = 0;
  let trailCache: string | null = null;
  // Ctrl+R cycles the shown run's agent transcript off -> plain -> prompts -> off, the terminal
  // twin of `history <role> <n> --transcript [--prompt]`. trailCache is composed from the parts
  // below (detail, stat, transcript, in `tumwater tick`'s order) for the run in trailRun.
  let trailTranscript: "off" | "plain" | "prompts" = "off";
  let trailText = "";
  let trailStat: string | null = null;
  let trailTranscriptText: string | null = null;
  let trailRun: { role: string; run: number; detail: TickDetail } | null = null;
  let trailGen = 0; // bumped at every trail read or reset; a stat resolution applies only to its own gen

  /** The pane's row selection: scope, then window, then search, then outcome class — the order
   * `tumwater history` applies them. Returns the raw read's coverage flag, the count after the
   * search (so an empty body can blame the filter that emptied the set: `afterGrep > 0` means
   * rows matched the pattern and the class then removed them) and the class-filtered rows. The
   * search applies history-data.ts's shared tick-grep rule (runRowsMatchingGrep), the same one
   * the CLI and the dashboard use, so the surfaces cannot disagree. `limit` bounds a windowless
   * read; a window reads through readTickRowsSince. */
  const selectPaneRows = (
    sinceMs: number | null,
    resultClass: HistoryResultClass | null,
    role: string | null,
    grep: string | null,
    limit: number,
  ): { covered: boolean; afterGrep: number; filtered: TickRow[] } => {
    const { rows, covered } = sinceMs === null
      ? { rows: readTickRows(session.root, limit, role), covered: true }
      : readTickRowsSince(session.root, sinceMs, role);
    const grepped = grep === null ? rows : runRowsMatchingGrep(rows, grep);
    const filtered = resultClass === null ? grepped : grepped.filter((r) => historyClass(r.result) === resultClass);
    return { covered, afterGrep: grepped.length, filtered };
  };

  /** The History pane's body for one trailing window, one outcome class, one exact-role scope,
   * and one free-text search: the paneCache the Ctrl+T/Ctrl+S/Ctrl+O/Ctrl+G/`/` handlers store.
   * The default (null/null/null/null) read is byte-for-byte the newest-N pane that predates the
   * window, outcome, role, and search cycles — readTickRows with HISTORY_DEFAULT_RUNS,
   * unfiltered. A trailing window reads through the same readTickRowsSince collector `tumwater
   * history --since` uses, a class filters through history-data.ts's canonical historyClass rule,
   * and the search filters through runRowGrepHaystack — the same haystack and case-insensitive
   * substring rule `tumwater history --grep` and the dashboard's History search use — so the TUI,
   * the CLI, and the dashboard cannot disagree about the rows. The role is the exact role id the
   * raw roster (and `history --role`, and the dashboard picker) names — readTickRows filters
   * `e.loop === role`, so an instance id is its own scope, never folded into a base role. An empty
   * read with no class and no search returns "" so the pane keeps its own no-ticks note instead of
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
    summary: HistorySummaryGroup | null,
  ): string => {
    const { covered, afterGrep, filtered } = selectPaneRows(sinceMs, resultClass, role, grep, HISTORY_DEFAULT_RUNS);
    // The session Summary toggle (Ctrl+Y) swaps the row list for the same per-role tally the CLI's
    // `history --summary` and the dashboard History view print (summarizeTickRows → renderSummary),
    // folded over exactly the rows the window/scope/result/search selected, so the three surfaces
    // cannot disagree. The non-empty guard matters: renderSummary always prints a header, so
    // without it an empty read would bypass the pane's no-rows / no-runs wording below.
    const body =
      summary === "role" && filtered.length > 0
        ? renderSummary(summarizeTickRows(filtered))
        : summary === "model" && filtered.length > 0
          ? renderModelSummary(summarizeTickRowsByModel(filtered))
          : historyPaneText(filtered);
    // null when no class is active, so the header/empty-body paths below only name a result
    // filter the session actually holds (cycleLabel(HISTORY_RESULTS, null) is the "all" label).
    const resultLabel = resultClass === null ? null : cycleLabel(HISTORY_RESULTS, resultClass);
    // The role first, then the window/result/search labels: the role is the coarsest cut, and a
    // role-only read (no window, no class) still prints its scope line above the rows.
    const header = [
      ...(role === null ? [] : ["role: " + role]),
      ...(sinceMs === null ? [] : ["window: last " + (cycleLabel(HISTORY_WINDOWS, sinceMs) ?? "default")]),
      ...(resultLabel === null ? [] : ["result: " + resultLabel]),
      ...(grep === null ? [] : ["search: " + grep]),
    ].join("\n");
    if (!body) {
      // The class names itself only when it emptied a set grep admitted (`afterGrep > 0`) — the
      // CLI's condition and the dashboard's `hasRows` draw the same line — so an empty log or
      // window keeps the pane's own no-ticks note instead of blaming a filter that removed
      // nothing. A pattern that admitted nothing names itself next, with the CLI's wording. An
      // empty read with neither filter returns "" so the pane keeps its own note, and an
      // role-only empty read returns "" too (the CLI's empty-state wording does not name --role),
      // so the pane never grows a lone `role:` header.
      if (resultClass !== null && afterGrep > 0) {
        return header + "\nno runs with result \"" + resultLabel + "\"";
      }
      if (grep !== null) return header + "\nno runs matching \"" + grep + "\"";
      return "";
    }
    return (header ? header + "\n" : "") + body + (sinceMs !== null && !covered ? "\n" + SPARSE_WINDOW_NOTE : "");
  };

  // Re-read the pane-scoped newest completed tick into trailCache for an on-screen trail
  // (Ctrl+N), so the trail cannot keep showing a retired role's tick after Ctrl+G or a roster
  // change drops the History scope. The reader throw is caught and flashed rather than escaping
  // a key or sync path, the same guard the initial Ctrl+N entry uses.
  // Append the tick commit's per-file stat to the trail text once it resolves — the join
  // `tumwater tick --stat` uses. Applies only while the trail is still on and no read or reset
  // bumped trailGen since the request, so an older tick's stat never overwrites a newer view.
  const composeTrail = (): void => {
    trailCache = [trailText, trailStat, trailTranscriptText].filter((part) => part !== null).join("\n\n");
  };

  // Read the shown run's transcript at the chosen level into trailTranscriptText (null when off
  // or on a throw, which is flashed): the two outputs `tumwater history --transcript` prints.
  const loadTranscript = (): void => {
    trailTranscriptText = null;
    if (trailTranscript === "off" || trailRun === null) return;
    try {
      const { found, note } = runTranscriptLines(session.root, trailRun.role, trailRun.run, trailRun.detail, {
        includePrompts: trailTranscript === "prompts",
      });
      trailTranscriptText = found.length > 0 ? found.join("\n") : note;
    } catch (err) {
      session.flashError(err);
    }
  };

  const loadTrailStat = (detail: TickDetail): void => {
    const gen = trailGen;
    void session.tickStat(session.root, detail).then(
      (stat) => {
        if (!trailMode || gen !== trailGen) return;
        trailStat = stat;
        composeTrail();
        session.requestRender();
      },
      (err: unknown) => {
        if (!trailMode || gen !== trailGen) return;
        session.flashError(err);
        session.requestRender();
      },
    );
  };

  /** Re-read the pane's `index`-th newest completed tick (its scope, window, search and outcome
   * class, as the rows show them) into trailCache, appending the tick commit's per-file stat
   * once it resolves — the reader both the initial Ctrl+N toggle and the scope-change refreshes
   * share, so the trail cannot keep showing a retired role's tick after Ctrl+G or a roster change
   * drops the History scope.
   * `index` is the 0-based newest-first position to read (Ctrl+P steps it). Returns true when a
   * tick actually rendered (the caller turns the trail on); a scope holding none leaves
   * trailCache null and, when `onEmpty` is given, runs it (the Ctrl+N toggle's
   * "no completed runs to inspect" flash) so the user learns why nothing changed. The reader
   * throw is caught and flashed rather than escaping a key or sync path — the guard the two
   * original readers each carried. */
  const loadTrail = (onEmpty: (() => void) | null, index = 0): boolean => {
    trailGen++;
    try {
      const unfiltered = historyWindow === null && historyResult === null && historyGrep === null;
      const limit = unfiltered ? index + 1 : HISTORY_MAX_RUNS;
      const row = selectPaneRows(historyWindow, historyResult, historyRole, historyGrep, limit).filtered[index];
      if (row === undefined) {
        if (onEmpty !== null) onEmpty();
        return false;
      }
      const detail = readTickDetail(session.root, row.role, row.run);
      trailStat = null;
      trailTranscriptText = null;
      trailRun = detail === null ? null : { role: row.role, run: row.run, detail };
      if (detail === null) {
        trailCache = null;
      } else {
        trailText = renderTickDetail(detail);
        loadTranscript();
        composeTrail();
        loadTrailStat(detail);
      }
      trailIndex = index;
      return true;
    } catch (err) {
      trailCache = null;
      session.flashError(err);
      return false;
    }
  };

  /** Re-read the trail after a scope change (Ctrl+G advances, a roster drop prunes the role):
   * refresh the cache from the new scope, or clear it when the scope now holds no tick. */
  const refreshTrail = (): void => {
    if (!loadTrail(null)) trailCache = null;
  };

  /** Recompute the History pane's cached body if it is the current view, re-entering at its
   * head; true when it painted (the "history" arm of the shared refresh the panes and the
   * roster sync share). */
  const recompute = (): boolean => {
    if (session.view !== session.roleIds.length + 4) return false;
    session.paneCache = historyPaneCache(historyWindow, historyResult, historyRole, historyGrep, historySummary);
    session.paneScroll = 0;
    return true;
  };

  const applySearch = (pattern: string | null): void => {
    // Apply a finished History search on the pane: set the grep, recompute the cached rows now
    // (the pane is showing), and re-enter at the body's head — the leaf the search editor's
    // Enter calls through its applyHistorySearch dep.
    historyGrep = pattern;
    if (trailMode) refreshTrail();
    session.paneCache = historyPaneCache(historyWindow, historyResult, historyRole, historyGrep, historySummary);
    session.paneScroll = 0;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "n") {
      // On the History pane Ctrl+N swaps the row list for one tick's full event trail instead
      // (the CLI's `tumwater tick --last` text). Routed here only for the History view, ahead
      // of the transcript pane's notebook/change arm; a non-History view falls through to it.
      if (session.view !== session.roleIds.length + 4) return false;
      if (!promptLineFree(ctx.es)) {
        // The transcript guard would consume the key; keep Ctrl+N consumed on the History view.
        session.requestRender();
        return true;
      }
      if (trailMode) {
        // Toggle the trail off (Ctrl+N on the trail view): drop the trail snapshot. The
        // trailGen bump keeps an in-flight stat from the old trail from repainting.
        trailGen++;
        trailMode = false;
        trailCache = null;
        trailIndex = 0;
        trailTranscript = "off";
      } else {
        // Toggle the trail on: read the pane-scoped newest completed tick. A scope holding
        // none flashes (loadTrail's onEmpty) and leaves the rows; one holding a tick turns
        // the trail on (a log holding none is the only path that does not).
        const filtered = historyWindow !== null || historyResult !== null || historyGrep !== null;
        const empty = filtered ? "no completed runs match the pane's filters" : "no completed runs to inspect";
        if (loadTrail(() => session.flashMessage(empty))) trailMode = true;
      }
      session.paneScroll = 0; // either way the pane starts at its head
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "p") {
      // Ctrl+P steps an on-screen trail back to the next older run in the pane's scope,
      // wrapping to the newest after the oldest. Anywhere else it falls through (false) to the
      // Activity caps and Transcript pause editors' routing.
      if (session.view !== session.roleIds.length + 4 || !trailMode) return false;
      if (promptLineFree(ctx.es)) {
        const next = trailIndex + 1;
        if (!(next < HISTORY_MAX_RUNS && loadTrail(null, next))) {
          loadTrail(null, 0);
          session.flashMessage("oldest run reached; back to the newest");
        }
        session.paneScroll = 0;
      }
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "r") {
      // Ctrl+R cycles the trail's agent transcript: off -> plain -> prompts -> off. Anywhere
      // else (no History view, no trail) it falls through to the other panes' Ctrl+R arms. The
      // run is unchanged, so trailGen stays and an in-flight stat still lands on it.
      if (session.view !== session.roleIds.length + 4 || !trailMode) return false;
      if (promptLineFree(ctx.es)) {
        trailTranscript = trailTranscript === "off" ? "plain" : trailTranscript === "plain" ? "prompts" : "off";
        loadTranscript();
        composeTrail();
        session.paneScroll = 0;
      }
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "g" && promptLineFree(ctx.es)) {
      // Routed here only for the History view; every other view's scope arm is Activity (0) or
      // the report panes, which the aggregator routes ahead of this module.
      if (session.view !== session.roleIds.length + 4) return false;
      // The History scope walks the raw roster ids (`[null, ...roleIds]`) so an instance id is
      // its own slot, matching `history --role` and the dashboard picker. A trail already on
      // screen follows the scope: re-read the new scope's newest completed tick (or drop to the
      // pane's no-trail note when it has none) so the trail and the tab strip cannot name
      // different roles.
      const slots: Array<string | null> = [null, ...session.roleIds];
      const slot = slots.indexOf(historyRole);
      historyRole = slots[(slot + 1) % slots.length] ?? null;
      if (trailMode) refreshTrail();
      recompute();
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "s" && promptLineFree(ctx.es)) {
      // Ctrl+S advances the History pane's trailing window (mnemonic: **S**ince). Guarded out
      // of budget-edit and role-prompt modes like the other mode-sensitive keys. The window is
      // session state: advancing it off the History view only changes the label, and the next
      // Ctrl+T into History computes the cache with it; on the History view this handler
      // re-reads the rows now and resets the scroll so the changed body re-enters at its head.
      historyWindow = nextInCycle(HISTORY_WINDOWS, historyWindow);
      if (trailMode) refreshTrail();
      recompute();
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "o" && promptLineFree(ctx.es)) {
      // Ctrl+O advances the History pane's outcome filter (mnemonic: **O**utcome). Guarded out
      // of budget-edit and role-prompt modes like Ctrl+S beside it. (The Health pane's
      // problems-only Ctrl+O is handled ahead of this module by the aggregator when that view is
      // current.) The class is session state: advancing it off the History view only changes the
      // label, and the next Ctrl+T into History computes the cache with it; on the History view
      // this handler re-reads and re-filters the rows now and resets the scroll so the changed
      // body re-enters at its head.
      historyResult = nextInCycle(HISTORY_RESULTS, historyResult);
      if (trailMode) refreshTrail();
      recompute();
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "y" && promptLineFree(ctx.es)) {
      // Ctrl+Y cycles the History pane's views — rows, per-role Summary, per-model Summary,
      // rows (mnemonic: summar**Y**) — the same tallies `tumwater history --summary [--by model]`
      // and the dashboard History view print,
      // folded over the pane's already-selected rows. Guarded out of budget-edit and
      // role-prompt modes like Ctrl+S/O beside it. The class is session state: toggling it off
      // the History view only changes the label, and the next Ctrl+T into History computes the
      // cache with it; on the History view this handler re-reads and re-renders now and resets
      // the scroll so the changed body re-enters at its head.
      historySummary = historySummary === null ? "role" : historySummary === "role" ? "model" : null;
      recompute();
      session.requestRender();
      return true;
    }
    const page = pageDir(key.name);
    if (page !== null && trailMode) {
      // Within-body scroll in the tick-trail view: PgDn/PgUp page the cached trail Markdown,
      // clamped at both ends, exactly like the notebook/change and usage/failures panes.
      session.paneScroll = pageMarkdownBody(session.paneScroll, trailCache, session.eventBudget, page);
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    enter: recompute,
    reset() {
      // A cycle away leaves the tick trail (which is History-only) and drops its snapshot too.
      trailGen++;
      trailMode = false;
      trailCache = null;
      trailIndex = 0;
      trailTranscript = "off";
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
        if (trailMode) refreshTrail();
      }
    },
    applySearch,
    state() {
      return {
        historyRole,
        historySince: historyWindow === null ? null : cycleLabel(HISTORY_WINDOWS, historyWindow),
        historyResult: cycleLabel(HISTORY_RESULTS, historyResult),
        historyGrep,
        historySummary,
        trailMode,
        trailIndex,
        trailCache,
        trailTranscript,
      };
    },
  } satisfies TuiPaneModule & { applySearch(pattern: string | null): void };
}
