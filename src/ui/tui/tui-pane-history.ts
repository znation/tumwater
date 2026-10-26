import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../../events/event-window.js";
import { betweenWindow } from "../../cli/cli-args.js";
import {
  HISTORY_DEFAULT_RUNS,
  HISTORY_MAX_RUNS,
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
import { readRunDetail, type RunDetail } from "../../run/run-detail-data.js";
import { renderRunDetail, runTranscriptLines } from "../../run/run-detail-render.js";
import { revertFollowUp, runRevertSha } from "../../operator/revert.js";
import { shortSha } from "../../text/format.js";
import { plural } from "../../text/phrases.js";
import { pageMarkdownBody } from "./tui-backlog.js";
import { pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { nextInCycle, cycleLabel, HISTORY_WINDOWS, HISTORY_RESULTS, type TuiPaneSession } from "./tui-pane-session.js";

/** The bounds `readRunRowsSince` reads for a trailing window of `windowMs` stepped `step` window
 * lengths back: step 0 (or no window) is the trailing window, step k the window (k+1)*len to k*len
 * ago, the `history --since --until` pair. */
export function historyWindowBounds(
  windowMs: number | null,
  step: number,
): { sinceMs: number | null; untilMs: number | null } {
  if (windowMs === null || step === 0) return { sinceMs: windowMs, untilMs: null };
  return { sinceMs: (step + 1) * windowMs, untilMs: step * windowMs };
}

/** The History pane (view roleIds.length + 4) of the TUI (src/ui/tui/tui.tsx): the session
 * window (Ctrl+S), outcome filter (Ctrl+O), exact-role scope (Ctrl+G), free-text search (`/`),
 * and the Ctrl+N completed-run trail (Ctrl+P steps it to older runs, Ctrl+W shows its commit
 * patch, Ctrl+V twice reverts the shown run's merged change), each with its cache and
 * body window. With the trail off, Ctrl+P steps the window back by its own length (the
 * `history --since --until` window) and Ctrl+S returns to the trailing window. Split out of the
 * pane-navigation monolith; it owns the pane's window/result/scope/search/trail state and the
 * arms that touch them. */
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
  // Ctrl+N on the History pane swaps the row list for the newest completed run's full event
  // trail (renderRunDetail over readRunDetail) — the same text `tumwater run --last` and
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
  // below (detail, stat, transcript, in `tumwater run`'s order) for the run in trailRun.
  let trailTranscript: "off" | "plain" | "prompts" = "off";
  // The transcript search (`/` while it shows); set only while trailTranscript !== "off".
  let trailGrep: string | null = null;
  let trailText = "";
  let trailStat: string | null = null;
  // Whether the trail shows the run's commit patch (Ctrl+W), and the patch once it resolves.
  let trailPatch = false;
  let trailPatchText: string | null = null;
  let trailTranscriptText: string | null = null;
  let trailRun: { role: string; run: number; detail: RunDetail } | null = null;
  let reverting = false; // a revert preview or commit is in flight; a held Ctrl+V starts no second
  let trailGen = 0; // bumped at every trail read or reset; a stat resolution applies only to its own gen

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

  // Re-read the pane-scoped newest completed run into trailCache for an on-screen trail
  // (Ctrl+N), so the trail cannot keep showing a retired role's run after Ctrl+G or a roster
  // change drops the History scope. The reader throw is caught and flashed rather than escaping
  // a key or sync path, the same guard the initial Ctrl+N entry uses.
  // Append the run commit's per-file stat to the trail text once it resolves — the join
  // `tumwater run --stat` uses. Applies only while the trail is still on and no read or reset
  // bumped trailGen since the request, so an older run's stat never overwrites a newer view.
  const composeTrail = (): void => {
    trailCache = [trailText, trailStat, trailPatchText, trailTranscriptText].filter((part) => part !== null).join("\n\n");
  };

  // Read the shown run's transcript at the chosen level into trailTranscriptText (null when off
  // or on a throw, which is flashed): the two outputs `tumwater history --transcript` prints.
  const loadTranscript = (): void => {
    trailTranscriptText = null;
    if (trailTranscript === "off" || trailRun === null) return;
    try {
      const { found, note } = runTranscriptLines(session.root, trailRun.role, trailRun.run, trailRun.detail, {
        includePrompts: trailTranscript === "prompts",
        grep: trailGrep ?? undefined,
      });
      trailTranscriptText = found.length > 0 ? found.join("\n") : note;
    } catch (err) {
      session.flashError(err);
    }
  };

  // Resolve one async trail part (the run commit's stat or patch) through the session, and, if
  // the trail is still current (`trailMode`, not superseded by a newer `trailGen`, and `keep`
  // still true), fold its text in. Shared by the stat and patch loaders so the staleness guard
  // and the flash/render on both error and success cannot drift between them.
  const loadTrailPart = (
    call: () => Promise<string>,
    keep: boolean,
    set: (value: string) => void,
  ): void => {
    const gen = trailGen;
    void call().then(
      (value) => {
        if (!trailMode || !keep || gen !== trailGen) return;
        set(value);
        composeTrail();
        session.requestRender();
      },
      (err: unknown) => {
        if (!trailMode || !keep || gen !== trailGen) return;
        session.flashError(err);
        session.requestRender();
      },
    );
  };

  const loadTrailStat = (detail: RunDetail): void =>
    loadTrailPart(() => session.runStat(session.root, detail), true, (stat) => {
      trailStat = stat;
    });

  const loadTrailPatch = (detail: RunDetail): void =>
    loadTrailPart(() => session.runPatch(session.root, detail), trailPatch, (patch) => {
      trailPatchText = patch;
    });

  /** Re-read the pane's `index`-th newest completed run (its scope, window, search and outcome
   * class, as the rows show them) into trailCache, appending the run commit's per-file stat
   * once it resolves — the reader both the initial Ctrl+N toggle and the scope-change refreshes
   * share, so the trail cannot keep showing a retired role's run after Ctrl+G or a roster change
   * drops the History scope.
   * `index` is the 0-based newest-first position to read (Ctrl+P steps it). Returns true when a
   * run actually rendered (the caller turns the trail on); a scope holding none leaves
   * trailCache null and, when `onEmpty` is given, runs it (the Ctrl+N toggle's
   * "no completed runs to inspect" flash) so the user learns why nothing changed. The reader
   * throw is caught and flashed rather than escaping a key or sync path — the guard the two
   * original readers each carried. */
  const loadTrail = (onEmpty: (() => void) | null, index = 0): boolean => {
    trailGen++;
    try {
      const unfiltered = historyWindow === null && historyResult === null && historyGrep === null && historyModel === null;
      const limit = unfiltered ? index + 1 : HISTORY_MAX_RUNS;
      const row = selectPaneRows(historyWindow, historyResult, historyRole, historyGrep, historyModel, limit, historyStep).filtered[index];
      if (row === undefined) {
        if (onEmpty !== null) onEmpty();
        return false;
      }
      const detail = readRunDetail(session.root, row.role, row.run);
      trailStat = null;
      trailPatchText = null;
      trailTranscriptText = null;
      trailRun = detail === null ? null : { role: row.role, run: row.run, detail };
      if (detail === null) {
        trailCache = null;
      } else {
        trailText = renderRunDetail(detail);
        loadTranscript();
        composeTrail();
        loadTrailStat(detail);
        if (trailPatch) loadTrailPatch(detail);
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
   * refresh the cache from the new scope, or clear it when the scope now holds no run. */
  const refreshTrail = (): void => {
    if (!loadTrail(null)) trailCache = null;
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

  const applySearch = (pattern: string | null): void => {
    // Apply a finished History search on the pane: set the grep, recompute the cached rows now
    // (the pane is showing), and re-enter at the body's head — the leaf the search editor's
    // Enter calls through its applyHistorySearch dep.
    if (trailMode && trailTranscript !== "off") {
      // The transcript is showing: the search narrows its entries, the run rows stay as they are.
      trailGrep = pattern;
      loadTranscript();
      composeTrail();
      session.paneScroll = 0;
      return;
    }
    historyGrep = pattern;
    if (trailMode) refreshTrail();
    session.paneCache = historyPaneCache(historyWindow, historyResult, historyRole, historyGrep, historyModel, historySummary, historyStep);
    session.paneScroll = 0;
  };

  // The second Ctrl+V: commit the revert of `sha` through the same core the CLI calls and flash
  // the CLI's lines joined with "; ".
  const revertRun = (sha: string): void => {
    reverting = true;
    session.flashMessage(`reverting ${shortSha(sha)} …`);
    void session.revertCommit(session.root, sha).then(
      (r) => {
        if (!r.ok) {
          session.flashMessage(r.error);
          return;
        }
        const followUp = revertFollowUp(r.subject);
        session.flashMessage(`reverted ${shortSha(sha)}: main is now ${shortSha(r.headSha)}${followUp === null ? "" : `; ${followUp}`}`);
      },
      (err: unknown) => session.flashError(err),
    ).finally(() => {
      reverting = false;
      session.armedRevert = null;
      session.requestRender();
    });
  };

  // The first Ctrl+V: preview the revert and arm the second press only when it applies cleanly
  // to a clean checkout. A trail closed or stepped since (trailGen) gets no stale arm.
  const previewRun = (sha: string): void => {
    reverting = true;
    const gen = trailGen;
    session.flashMessage(`previewing the revert of ${shortSha(sha)} …`);
    void session.previewRevert(session.root, sha).then(
      (p) => {
        if (gen !== trailGen) return;
        if (!p.ok) session.flashMessage(p.error);
        else if (!p.applies) session.flashMessage(`would conflict on ${p.primary} (HEAD ${shortSha(p.head)}); nothing was written`);
        else if (p.dirty)
          session.flashMessage("the checkout has staged or unstaged changes, so tumwater revert would refuse until they are committed or stashed; nothing was written");
        else {
          session.revertArmed = p.sha;
          session.flashMessage(`press Ctrl+V again to revert ${shortSha(p.sha)} ${p.subject} (${plural(p.paths.length, "file")}) on ${p.primary} — any other key cancels`);
        }
      },
      (err: unknown) => session.flashError(err),
    ).finally(() => {
      reverting = false;
      session.requestRender();
    });
  };

  // One named arm per History key, so a key's rule is found by name instead of by scanning one
  // long dispatch body (the same move as the landed resolveRunVerdict split). Each arm reads the
  // same closure locals the old inline arm read, in the same order, and returns the same boolean.
  const historyTrailToggle = (ctx: TuiPaneCtx): boolean => {
    // On the History pane Ctrl+N swaps the row list for one run's full event trail instead
    // (the CLI's `tumwater run --last` text). Routed here only for the History view, ahead
    // of the transcript pane's notes/change arm; a non-History view falls through to it.
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
      trailPatch = false;
      trailPatchText = null;
      trailGrep = null;
    } else {
      // Toggle the trail on: read the pane-scoped newest completed run. A scope holding
      // none flashes (loadTrail's onEmpty) and leaves the rows; one holding a run turns
      // the trail on (a log holding none is the only path that does not).
      const filtered = historyWindow !== null || historyResult !== null || historyGrep !== null || historyModel !== null;
      const empty = filtered ? "no completed runs match the pane's filters" : "no completed runs to inspect";
      if (loadTrail(() => session.flashMessage(empty))) trailMode = true;
    }
    session.paneScroll = 0; // either way the pane starts at its head
    session.requestRender();
    return true;
  };

  const historyNewestFailure = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+L on the History pane (mnemonic: the **l**atest failing run) resets the pane to
    // the team-wide problems scope and opens the trail — the terminal twin of the dashboard
    // History view's Newest failure button and `tumwater history --last --result problems`
    // (newestRunRow(root, null, ["problems"], null)). It clears every filter the operator
    // left set — role scope, trailing window, search, model, summary — and the trail, so a
    // second press re-jumps to the newest failure. Routed here only for the History view;
    // every other view keeps its own Ctrl+L meaning (Health's retire-leftovers ahead of this
    // router, Activity's fallback editor and a Transcript's instructions editor in the
    // editors).
    if (session.view !== session.roleIds.length + 4) return false;
    if (!promptLineFree(ctx.es)) {
      // The editor would consume the key; keep Ctrl+L consumed on the History view.
      session.requestRender();
      return true;
    }
    historyRole = null;
    historyResult = "problems";
    historyWindow = null;
    historyStep = 0;
    historyGrep = null;
    historyModel = null;
    historySummary = null;
    // Drop any on-screen trail the way Ctrl+N's toggle-off arm does (the gen bump keeps an
    // in-flight stat from the old trail from repainting).
    trailGen++;
    trailMode = false;
    trailCache = null;
    trailIndex = 0;
    trailTranscript = "off";
    trailPatch = false;
    trailPatchText = null;
    trailGrep = null;
    recompute();
    // historyWindow null + historyResult "problems": loadTrail reads
    // readRunRows(root, HISTORY_MAX_RUNS, null) and takes .filtered[0] — the newest failing
    // run of any role, exactly what the dashboard's Newest failure button and the CLI open.
    if (loadTrail(() => session.flashMessage("no failing run in the scanned window"))) trailMode = true;
    session.paneScroll = 0;
    session.requestRender();
    return true;
  };

  const historyStepBack = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+P steps an on-screen trail back to the next older run in the pane's scope,
    // wrapping to the newest after the oldest. Anywhere else it falls through (false) to the
    // Activity caps and Transcript pause editors' routing.
    if (session.view !== session.roleIds.length + 4) return false;
    if (!trailMode) {
      // Trail off: step the window back one window length, wrapping to the trailing window once
      // the next window would start past the 7-day cap `history --since` rides.
      if (promptLineFree(ctx.es)) {
        if (historyWindow === null) {
          session.flashMessage("pick a window with Ctrl+S to step back through earlier windows");
        } else if ((historyStep + 2) * historyWindow <= LOGS_SINCE_MAX_MS) {
          historyStep += 1;
          recompute();
        } else {
          historyStep = 0;
          session.flashMessage(
            "oldest window reached; back to the last " + cycleLabel(HISTORY_WINDOWS, historyWindow),
          );
          recompute();
        }
      }
      session.requestRender();
      return true;
    }
    if (promptLineFree(ctx.es)) {
      const next =trailIndex + 1;
      if (!(next < HISTORY_MAX_RUNS && loadTrail(null, next))) {
        loadTrail(null, 0);
        session.flashMessage("oldest run reached; back to the newest");
      }
      session.paneScroll = 0;
    }
    session.requestRender();
    return true;
  };

  const historyTranscriptCycle = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+R cycles the trail's agent transcript: off -> plain -> prompts -> off. Anywhere
    // else (no History view, no trail) it falls through to the other panes' Ctrl+R arms. The
    // run is unchanged, so trailGen stays and an in-flight stat still lands on it.
    if (session.view !== session.roleIds.length + 4 || !trailMode) return false;
    if (promptLineFree(ctx.es)) {
      trailTranscript = trailTranscript === "off" ? "plain" : trailTranscript === "plain" ? "prompts" : "off";
      if (trailTranscript === "off") trailGrep = null;
      loadTranscript();
      composeTrail();
      session.paneScroll = 0;
    }
    session.requestRender();
    return true;
  };

  const historyPatchToggle = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+W on a run trail shows or hides the shown run's full commit patch below its stat:
    // the terminal twin of `tumwater history <role> <n> --patch`. Off the History view it
    // falls through to the other panes' Ctrl+W arms.
    if (session.view !== session.roleIds.length + 4) return false;
    if (!promptLineFree(ctx.es)) {
      session.requestRender();
      return true;
    }
    if (!trailMode || trailRun === null) {
      session.flashMessage("open a run's trail with Ctrl+N to show its patch");
      session.requestRender();
      return true;
    }
    trailPatch = !trailPatch;
    if (trailPatch) {
      loadTrailPatch(trailRun.detail);
    } else {
      // The bump keeps an in-flight patch from repainting; it also drops an in-flight stat.
      trailGen++;
      trailPatchText = null;
      if (trailStat === null) loadTrailStat(trailRun.detail);
      composeTrail();
    }
    session.paneScroll = 0;
    session.requestRender();
    return true;
  };

  const historyRevertArm = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+V on a run trail reverts the shown run's merged change: the terminal twin of
    // `tumwater revert <role> <n>` and the dashboard History drill-down's Revert. The first
    // press previews (previewRevert) and arms only a clean, applying revert; a second press
    // right after commits it through revertMergedCommit, and any other key disarms it.
    if (session.view !== session.roleIds.length + 4) return false;
    if (promptLineFree(ctx.es)) {
      if (!trailMode || trailRun === null) {
        session.flashMessage("open a run's trail with Ctrl+N to revert its change");
      } else if (reverting) {
        session.flashMessage("a revert is already running");
      } else {
        const found = runRevertSha(trailRun.role, trailRun.run, trailRun.detail);
        if (!found.ok) session.flashMessage(found.error);
        else if (session.armedRevert === found.sha) revertRun(found.sha);
        else previewRun(found.sha);
      }
    }
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
    if (trailMode) refreshTrail();
    recompute();
    session.requestRender();
    return true;
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
    if (trailMode) refreshTrail();
    recompute();
    session.requestRender();
    return true;
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
    if (trailMode) refreshTrail();
    recompute();
    session.requestRender();
    return true;
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
    if (trailMode) refreshTrail();
    recompute();
    session.requestRender();
    return true;
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
    recompute();
    session.requestRender();
    return true;
  };

  const historyTrailPage = (page: "up" | "down"): boolean => {
    if (trailMode) {
      // Within-body scroll in the run-trail view: PgDn/PgUp page the cached trail Markdown,
      // clamped at both ends, exactly like the notes/change and usage/failures panes.
      session.paneScroll = pageMarkdownBody(session.paneScroll, trailCache, session.eventBudget, page);
      session.requestRender();
      return true;
    }
    return false;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "n") return historyTrailToggle(ctx);
    if (key.ctrl && key.name === "l") return historyNewestFailure(ctx);
    if (key.ctrl && key.name === "p") return historyStepBack(ctx);
    if (key.ctrl && key.name === "r") return historyTranscriptCycle(ctx);
    if (key.ctrl && key.name === "w") return historyPatchToggle(ctx);
    if (key.ctrl && key.name === "v") return historyRevertArm(ctx);
    if (key.ctrl && key.name === "g") return historyScopeCycle(ctx);
    if (key.ctrl && key.name === "s") return historyWindowCycle(ctx);
    if (key.ctrl && key.name === "o") return historyResultCycle(ctx);
    if (key.ctrl && key.name === "x") return historyModelCycle(ctx);
    if (key.ctrl && key.name === "y") return historySummaryCycle(ctx);
    const page = pageDir(key.name);
    if (page !== null) return historyTrailPage(page);
    return false;
  };

  return {
    handleKey,
    enter: recompute,
    reset() {
      // A cycle away leaves the run trail (which is History-only) and drops its snapshot too.
      trailGen++;
      trailMode = false;
      trailCache = null;
      trailIndex = 0;
      trailTranscript = "off";
      trailPatch = false;
      trailPatchText = null;
      trailGrep = null;
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
        if (trailMode) refreshTrail();
      }
    },
    applySearch,
    state() {
      return {
        historyRole,
        historySince: historyWindow === null ? null : cycleLabel(HISTORY_WINDOWS, historyWindow),
        historyStep,
        historyResult: cycleLabel(HISTORY_RESULTS, historyResult),
        historyGrep,
        historyModel,
        historySummary,
        trailMode,
        trailIndex,
        trailCache,
        trailTranscript,
        trailPatch,
        trailGrep,
      };
    },
  } satisfies TuiPaneModule & { applySearch(pattern: string | null): void };
}
