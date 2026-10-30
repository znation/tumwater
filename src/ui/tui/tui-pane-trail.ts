import { LOGS_SINCE_MAX_MS } from "../../events/event-window.js";
import { HISTORY_MAX_RUNS, type HistoryResultClass, type RunRow } from "../../history/history-data.js";
import { renderRunDetail, runTranscriptLines } from "../../run/run-detail-render.js";
import { readRunDetail, type RunDetail } from "../../run/run-detail-data.js";
import { revertFollowUp, runRevertSha } from "../../operator/operator-revert.js";
import { shortSha } from "../../text/format.js";
import { plural } from "../../text/phrases.js";
import { pageMarkdownBody } from "./tui-backlog.js";
import { guardError, flashReject } from "./tui-guard.js";
import { promptLineFree, type TuiPaneCtx } from "./tui-pane-ctx.js";
import { paneAtHead, cycleLabel, HISTORY_WINDOWS, type TuiPaneSession } from "./tui-pane-session.js";

/** The pane's row selection read over the seam: the same window/result/role/grep/model/step
 * `selectPaneRows` reads, so the trail's `loadTrail` and window-step re-read the rows the pane
 * is showing. `step` is both read and written by the trail (the Ctrl+P window step); the rest
 * are read. The pane owns these closure vars; the trail borrows them. */
export interface RunTrailSelection {
  window: number | null;
  result: HistoryResultClass | null;
  role: string | null;
  grep: string | null;
  model: string | null;
  step: number;
}

/** The pane's row selection over the seam, fixed by the pane so the trail reads the same rows
 * without owning the selection: the same collector the pane's own cache uses, returning the
 * run at `index` (the pane-scoped newest-first set) for `loadTrail`. */
type RunTrailSelectPaneRows = (
  sinceMs: number | null,
  resultClass: HistoryResultClass | null,
  role: string | null,
  grep: string | null,
  model: string | null,
  limit: number,
  step: number,
) => { covered: boolean; afterGrep: number; afterResult: number; filtered: RunRow[] };

/** The shared deps the pane wires the trail into: the seam the trail borrows the pane's row
 * selection and recompute over. */
interface RunTrailDeps {
  /** The pane's current row selection the trail reads and (the window step) writes. */
  selection: RunTrailSelection;
  /** The pane's row selection closure (`selectPaneRows`), so `loadTrail` reads the same rows
   * the pane's cache shows without owning the selection. */
  selectPaneRows: RunTrailSelectPaneRows;
  /** Reset the pane's row selection to the team-wide newest-failing-problems scope (the Ctrl+L
   * jump) and recompute the pane, so a second Ctrl+L re-jumps to the newest failure. */
  resetToNewestFailure(): void;
  /** Recompute the pane's cached body; true when it painted. */
  recompute(): boolean;
}

/** The run-trail snapshot slice the pane's `state()` reports. */
interface RunTrailSnapshot {
  trailMode: boolean;
  trailIndex: number;
  trailCache: string | null;
  trailTranscript: "off" | "plain" | "prompts";
  trailPatch: boolean;
  trailGrep: string | null;
}

/** The History pane's run-trail subsystem (src/ui/tui/tui.tsx, view roleIds.length + 4), split
 * out of the createHistoryPane monolith (the landed per-arm-createHistoryPane split) so the
 * trail's state and its read/arm functions stop sharing one closure with the pane's row and
 * window/filter selection. It closes over the trail's 14 state variables and implements the
 * trail reads and the Ctrl+N/Ctrl+L/Ctrl+P/Ctrl+R/Ctrl+W/Ctrl+V arms, returning a small
 * surface the pane wires into its `handleKey`. Session-owned bits stay in the session:
 * `session.paneScroll`/`session.armedRevert`/`session.revertArmed`/`session.flashMessage`/
 * `session.requestRender`. The pane's row selection and `recompute` cross over the `deps`
 * seam, so the trail reads the same rows the pane shows without owning the selection. */
export function createRunTrail(
  session: TuiPaneSession,
  deps: RunTrailDeps,
): {
  snapshot(): RunTrailSnapshot;
  trailToggle(ctx: TuiPaneCtx): boolean;
  newestFailure(ctx: TuiPaneCtx): boolean;
  stepBack(ctx: TuiPaneCtx): boolean;
  transcriptCycle(ctx: TuiPaneCtx): boolean;
  patchToggle(ctx: TuiPaneCtx): boolean;
  revertArm(ctx: TuiPaneCtx): boolean;
  page(page: "up" | "down"): boolean;
  dropTrail(): void;
  refreshTrail(): void;
  applyTrailSearch(pattern: string): boolean;
} {
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

  /** Drop the on-screen run trail and its snapshot: the shared teardown the pane's three
   * History-only exits run — the Ctrl+N toggle-off arm, the Ctrl+L newest-failure jump, and
   * the pane's reset on a view cycle. It bumps trailGen so an in-flight stat resolution from
   * the closed trail cannot repaint the pane. */
  const dropTrail = (): void => {
    trailGen++;
    trailMode = false;
    trailCache = null;
    trailIndex = 0;
    trailTranscript = "off";
    trailPatch = false;
    trailPatchText = null;
    trailGrep = null;
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
    const run = trailRun;
    if (run === null || trailTranscript === "off") return;
    guardError(session, () => {
      const { found, note } = runTranscriptLines(session.root, run.role, run.run, run.detail, {
        includePrompts: trailTranscript === "prompts",
        grep: trailGrep ?? undefined,
      });
      trailTranscriptText = found.length > 0 ? found.join("\n") : note;
    });
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
      const unfiltered = deps.selection.window === null && deps.selection.result === null && deps.selection.grep === null && deps.selection.model === null;
      const limit = unfiltered ? index + 1 : HISTORY_MAX_RUNS;
      const row = deps.selectPaneRows(deps.selection.window, deps.selection.result, deps.selection.role, deps.selection.grep, deps.selection.model, limit, deps.selection.step).filtered[index];
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
      flashReject(session),
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
      flashReject(session),
    ).finally(() => {
      reverting = false;
      session.requestRender();
    });
  };

  const trailToggle = (ctx: TuiPaneCtx): boolean => {
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
      dropTrail();
    } else {
      // Toggle the trail on: read the pane-scoped newest completed run. A scope holding
      // none flashes (loadTrail's onEmpty) and leaves the rows; one holding a run turns
      // the trail on (a log holding none is the only path that does not).
      const filtered = deps.selection.window !== null || deps.selection.result !== null || deps.selection.grep !== null || deps.selection.model !== null;
      const empty = filtered ? "no completed runs match the pane's filters" : "no completed runs to inspect";
      if (loadTrail(() => session.flashMessage(empty))) trailMode = true;
    }
    paneAtHead(session);
    return true;
  };

  const newestFailure = (ctx: TuiPaneCtx): boolean => {
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
    // Reset the pane's selection to the team-wide problems scope and recompute it (the
    // summary, a pane-only value, resets there too).
    deps.resetToNewestFailure();
    // Drop any on-screen trail the way Ctrl+N's toggle-off arm does (the gen bump keeps an
    // in-flight stat from the old trail from repainting).
    dropTrail();
    // historyWindow null + historyResult "problems": loadTrail reads
    // readRunRows(root, HISTORY_MAX_RUNS, null) and takes .filtered[0] — the newest failing
    // run of any role, exactly what the dashboard's Newest failure button and the CLI open.
    if (loadTrail(() => session.flashMessage("no failing run in the scanned window"))) trailMode = true;
    paneAtHead(session);
    return true;
  };

  const stepBack = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+P steps an on-screen trail back to the next older run in the pane's scope,
    // wrapping to the newest after the oldest. Anywhere else it falls through (false) to the
    // Activity caps and Transcript pause editors' routing.
    if (session.view !== session.roleIds.length + 4) return false;
    if (!trailMode) {
      // Trail off: step the window back one window length, wrapping to the trailing window once
      // the next window would start past the 7-day cap `history --since` rides.
      if (promptLineFree(ctx.es)) {
        if (deps.selection.window === null) {
          session.flashMessage("pick a window with Ctrl+S to step back through earlier windows");
        } else if ((deps.selection.step + 2) * deps.selection.window <= LOGS_SINCE_MAX_MS) {
          deps.selection.step += 1;
          deps.recompute();
        } else {
          deps.selection.step = 0;
          session.flashMessage(
            "oldest window reached; back to the last " + cycleLabel(HISTORY_WINDOWS, deps.selection.window),
          );
          deps.recompute();
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

  const transcriptCycle = (ctx: TuiPaneCtx): boolean => {
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

  const patchToggle = (ctx: TuiPaneCtx): boolean => {
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
    paneAtHead(session);
    return true;
  };

  const revertArm = (ctx: TuiPaneCtx): boolean => {
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

  const trailPage = (page: "up" | "down"): boolean => {
    if (trailMode) {
      // Within-body scroll in the run-trail view: PgDn/PgUp page the cached trail Markdown,
      // clamped at both ends, exactly like the notes/change and usage/failures panes.
      session.paneScroll = pageMarkdownBody(session.paneScroll, trailCache, session.eventBudget, page);
      session.requestRender();
      return true;
    }
    return false;
  };

  const applyTrailSearch = (pattern: string): boolean => {
    // A finished History search when the trail's transcript is showing narrows its entries
    // (the pane's `/` editor calls this before its own row-grep). The run rows stay as they
    // are; true says the trail handled the search so the pane does not re-filter its rows.
    if (trailMode && trailTranscript !== "off") {
      trailGrep = pattern;
      loadTranscript();
      composeTrail();
      session.paneScroll = 0;
      return true;
    }
    return false;
  };

  const snapshot = (): RunTrailSnapshot => ({
    trailMode,
    trailIndex,
    trailCache,
    trailTranscript,
    trailPatch,
    trailGrep,
  });

  return {
    snapshot,
    trailToggle,
    newestFailure,
    stepBack,
    transcriptCycle,
    patchToggle,
    revertArm,
    page: trailPage,
    dropTrail,
    refreshTrail,
    applyTrailSearch,
  };
}
