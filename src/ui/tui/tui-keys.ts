// vocabulary: plain
import type { TickDetail } from "../../tick/tick-detail-data.js";
import { tickDetailStat } from "../../tick/tick-detail.js";
import { collectTeamChanges, collectRoleChange, type TeamChangeView, type RoleChangeView } from "../../change/change-data.js";
import { runDoctor } from "../../doctor/doctor.js";
import type { DoctorReport } from "../../doctor/doctor-checks.js";
import type { QueuedListRow } from "../../inbox/inbox.js";
import { commitOperatorBacklogEdit } from "../../backlog/backlog-commit.js";
import { stampedSubject } from "../../git/commit-message.js";
import { requestAbort } from "../../operator/operator-intent.js";
import { errorMessage } from "../../text/text.js";
import { DIRECTOR_ROLE } from "../../roles/roles.js";
import { browsableBacklogEntries } from "./tui-backlog.js";
import { arrowDir } from "./tui-keymap.js";
import { createTuiEditors } from "./tui-editors.js";
import { createTuiPanes } from "./tui-panes.js";

/** How long a TUI flash notice stays visible (ms). */
const FLASH_MS = 3000;

/** The seams `createTuiKeys` cannot own itself (the factory's doc names each). */
interface TuiKeysDeps {
  root: string;
  /** Ctrl+D: the caller resolves its main loop (and tears down the terminal) here. */
  quit(): void;
  /** Every branch that used to call render() after a state change calls this instead. */
  requestRender(): void;
  /** Injectable clock for the flash expiry; production uses Date.now. */
  now?(): number;
  /** The Pending pane's async collector; production uses change-data's collectTeamChanges.
   * Injectable so tests can resolve a fixed roster without git plumbing. */
  collectPending?(root: string): Promise<TeamChangeView>;
  /** Seam for the Health tab's checks; defaults to `runDoctor` so tests need not probe
   * binaries or git. */
  runDoctor?(root: string): Promise<DoctorReport>;
  /** The transcript Change mode's async collector; production uses change-data's
   * collectRoleChange. Injectable so tests can resolve a fixed view without git plumbing. */
  collectChange?(root: string, role: string): Promise<RoleChangeView>;
  /** The History trail's per-file stat footer; defaults to tick-detail's tickDetailStat so
   * tests need not shell out to git. */
  tickStat?(root: string, detail: TickDetail): Promise<string>;
}

/** The state render reads back each frame: the prompt line, the modes it names in the hint
 * line, the view/selection/scroll state, the line budgets, and the flash notice — null when
 * expired, so the per-second repaint drops the notice on the same clock it was armed. */
interface TuiKeysState {
  input: string;
  cursor: number;
  budgetMode: boolean;
  rolePromptFor: string | null;
  /** Whether the prompt line is editing the next prompt's defer delay (Ctrl+L). */
  deferMode: boolean;
  /** Whether the prompt line is editing an image path to attach to the next director prompt
   * (Ctrl+V on the Activity view). */
  attachMode: boolean;
  /** The number of pending image attachments the next director prompt will carry. */
  images: number;
  /** Whether the prompt line is editing the team pause's duration and reason (Ctrl+F). */
  pauseEditMode: boolean;
  /** The loop the pause editor pauses, null for the team editor (Ctrl+F). */
  pauseEditRole: string | null;
  /** the per-loop editor schedules a wake (Ctrl+W) rather than a pause (Ctrl+P) */
  pauseEditWake: boolean;
  /** the team editor schedules a stop (Ctrl+Q) rather than a pause (Ctrl+F) */
  pauseEditStop: boolean;
  /** The pending defer delay as a human label (durationLabel), or null when the next prompt
   * delivers immediately; named in the prompt prefix and the Ctrl+L hint. */
  defer: string | null;
  view: number;
  /** The Health pane's problems-only view (Ctrl+O): whether the tab paints only the warn and
   * fail checks, the same trim `tumwater doctor --problems` applies. Session-only like the
   * window/scope state. */
  healthProblems: boolean;
  /** The session-scoped role the Usage and Failures panes collect for (Ctrl+G), null for the
   * team; cleared when the incoming roster no longer names it. */
  scopeRole: string | null;
  /** The History pane's exact-loop scope (Ctrl+G), a raw roster id or null for the team's
   * full read; cleared when the incoming roster no longer names it. Separate from scopeRole:
   * History filters by exact loop (`history --role`), where `feature-2` is its own slot. */
  historyRole: string | null;
  selectedEntry: number | null;
  /** The armed backlog cancel (first Ctrl+X on a selected plan or bug): the entry a second
   * Ctrl+X would cancel, null once any other key lands. */
  cancelArmed: { kind: "plan" | "bug"; position: number; title: string } | null;
  /** The armed backlog release (first Ctrl+R on a selected Refused or Waiting-for-the-next-
   * failure plan or bug): the entry a second Ctrl+R would release, null once any other key
   * lands. */
  releaseArmed: { kind: "plan" | "bug"; position: number; title: string } | null;
  entryScroll: number;
  /** The Queued pane's row selection (null = list mode): the index into queuedRows of the
   * prompt shown in full, cleared on every Ctrl+T cycle like selectedEntry. */
  selectedQueued: number | null;
  /** The Queued pane's in-place editor (Ctrl+E): the role and queue-file basename of the
   * entry the prompt line is editing, or null when no edit is open. The file address (not a
   * position) is what the write targets, so a concurrent dequeue cannot make a stale
   * selection rewrite the wrong prompt. */
  queuedEditFor: { role: string; file: string } | null;
  /** The backlog pane's answer editor (Ctrl+A on a selected open question): the question's
   * 1-based position among the open questions and the title the operator saw, or null when no
   * answer is open. The title rides into tryAnswerQuestion so a question that moved under the
   * editor is refused rather than answered wrongly. */
  answerFor: { position: number; title: string } | null;
  /** The backlog pane's title editor (Ctrl+E on a selected plan or bug): the entry's kind, its
   * 1-based position within its section, and the heading title the operator saw, or null when
   * no edit is open. A null position is the new-entry form (Ctrl+N, title ""): Enter files a new
   * entry of that kind instead of retitling one. The title rides into tryEditEntry so an
   * entry that moved under the editor is refused rather than rewritten. */
  entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null;
  /** The Queued pane's cached rows — the same list renderQueuedList printed — so a selection
   * addresses a row's role/position without re-reading the queue each frame. */
  queuedRows: QueuedListRow[];
  paneCache: string | null;
  /** Whether the viewed loop's pane shows its notebook (Ctrl+N) instead of the transcript —
   * true only on a transcript view. */
  noteMode: boolean;
  /** The notebook view's rendered Markdown, computed once on Ctrl+N entry and windowed by
   * paneBody; null when the live transcript is shown. */
  noteCache: string | null;
  /** Whether the History pane shows one completed tick's full event trail (Ctrl+N) instead
   * of the row list — true only on the History view while its pane holds a trail. */
  trailMode: boolean;
  /** The trail view's rendered TickDetail text (renderTickDetail), computed once on Ctrl+N
   * entry and windowed by paneBody; null while the rows are shown or when the newest
   * completed tick could not be read. */
  trailCache: string | null;
  /** Whether the viewed loop's pane shows the collected unmerged change (the second Ctrl+N
   * step) instead of the transcript — true only on a transcript view. */
  changeMode: boolean;
  /** The change view's rendered text (renderRoleChange), null until its async collector
   * resolves; windowed by paneBody. */
  changeCache: string | null;
  paneScroll: number;
  /** The Activity pane's body-window start into the loaded event tail, or null to follow the
   * live tail. Paged by PgUp/PgDn and reset to null on every Ctrl+T view cycle. */
  activityScroll: number | null;
  /** The Activity pane's session exact-loop scope (Ctrl+G), a raw roster id or null for the
   * team's full tail; cleared when the incoming roster no longer names it. Separate from
   * scopeRole for the same reason historyRole is: the feed filters by exact loop (`eventRole`),
   * where `feature-2` is its own slot. */
  activityRole: string | null;
  /** The Activity pane's active free-text search (the `/` editor), or null when none; matched
   * through eventMatchesGrep, the same rule `tumwater logs --grep` and the dashboard search use. */
  activityGrep: string | null;
  /** The History pane's active trailing window label (Ctrl+S), or null for the default
   * newest-N read; named in the hint line. */
  historySince: string | null;
  /** The Usage and Failures panes' active trailing window label (Ctrl+E), or null for the
   * default day report; named in the hint line. */
  reportSince: string | null;
  /** The History pane's active outcome class label (Ctrl+O), "all" when unfiltered; named in
   * the hint line. */
  historyResult: string | null;
  /** The History pane's active free-text search (the `/` editor), or null when none; named in
   * the pane's own `search:` header and in the hint line. */
  historyGrep: string | null;
  /** The History pane's session Summary toggle (Ctrl+Y): false shows the per-run row list, true
   * the per-loop tally (`history --summary`); named in the hint line. */
  historySummary: boolean;
  eventBudget: number;
  entryBudget: number;
  roleIds: string[];
  /** Whether the director loop currently has a tick in flight (render's feed, Ctrl+C's gate). */
  directorInFlight: boolean;
  /** The live flash notice, or null when none is armed or the clock passed its expiry. */
  flash: string | null;
}

/** The keypress handler's contract as createTuiKeys returns it: the dispatch the caller feeds
 * (handleKey), the per-frame setters it syncs through (syncSnapshot, setLineBudgets), and the
 * state it composes the frame from (state). */
export interface TuiKeys {
  /** The full keypress dispatch — ink's `useInput` (through the tui-keymap.ts adapter)
   * calls into this with the same (str, key) shape the readline "keypress" event delivered. */
  handleKey(str: string | undefined, key: { ctrl?: boolean; name?: string }): void;
  /** Render feeds the snapshot's cap/free flag/roles in each frame (the locals the handler
   * reads without re-reading config itself), plus the director loop's in-flight flag —
   * Ctrl+C's interrupt gate; the view clamps against a changed role count. */
  syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorInFlight?: boolean): void;
  /** Render feeds the activity pane's line budgets in each frame. */
  setLineBudgets(eventBudget: number, entryBudget: number): void;
  /** The state render composes the frame from. */
  state(): TuiKeysState;
}

/** The framework-free owner of the TUI's keypress handling (extracted from runTui, and fed
 * by ink's `useInput` through tui-keymap.ts's inkKeyToReadline adapter): the factory owns
 * every mutable local the keypress dispatch used to keep in runTui's closure — the prompt line
 * and its modal editors (owned by the tui-editors.ts sub-factory it constructs), the view and
 * pane-navigation state, the flash notice, and the line budgets render feeds back. It takes
 * only the seams it cannot own itself: the repo root the disk actions run against, the quit
 * callback (Ctrl+D), a render request callback (every branch that painted a frame), and an
 * injectable clock so the flash expiry is testable without waiting the real 3 s. Rendering
 * (src/ui/tui/tui.tsx) stays the caller: it syncs snapshot data and line budgets in, and reads
 * the resulting state out to compose the frame — the same data flow, one module boundary added.
 * The prompt-line editor half of this closure lives in tui-editors.ts and the pane-navigation
 * half in the tui-panes.ts factory beside its per-pane modules; this file keeps the outer
 * dispatch, the flash notice, and the director gate. */
export function createTuiKeys(deps: TuiKeysDeps): TuiKeys {
  const now = deps.now ?? Date.now;
  const { root } = deps;
  const collectPending = deps.collectPending ?? collectTeamChanges;
  const runDoctorSeam = deps.runDoctor ?? ((r: string) => runDoctor(r, undefined, undefined, "never"));
  const collectChange = deps.collectChange ?? collectRoleChange;
  const tickStat = deps.tickStat ?? tickDetailStat;
  // The project-status pane's flat entry list (plans, bugs, questions, then the newest done plans
  // and fixed bugs), read fresh — tui-backlog.ts's one definition, shared with the render so
  // stale-selection clamping cannot drift.
  const flat = () => browsableBacklogEntries(root);

  let flash = "";
  let flashUntil = 0;
  // Flash a one-line notice on the prompt line: the single owner of the message+expiry
  // pair, so every notice expires on the same clock and no keypress branch grows its
  // own copy of the two assignments.
  const flashMessage = (message: string): void => {
    flash = message;
    flashUntil = now() + FLASH_MS;
  };
  // Flash a caught failure: the one home for the `error: <message>` prefix the TUI's catch
  // arms show, so their wording and formatting stay identical instead of drifting.
  const flashError = (err: unknown): void => {
    flashMessage(`error: ${errorMessage(err)}`);
  };
  // Commit an operator's backlog edit to main and flash when the commit did not land: the
  // one home for the "written but NOT committed" warning every edit, file, cancel, and
  // answer arm shares.
  const commitBacklogEdit = (file: string, subject: string): void => {
    void commitOperatorBacklogEdit(root, file, stampedSubject("operator", subject)).then((committed) => { // vocabulary-ok: the tumwater(operator): commit prefix
      if (!committed) flashMessage(`${file} written but NOT committed to main — commit it before the next fast-forward`);
    });
  };
  // The pane-navigation state is constructed first because the prompt-line editors take its
  // leaves (the queued refresh, the selection clear, the applied searches).
  const panes = createTuiPanes({
    root,
    now,
    requestRender: deps.requestRender,
    flat,
    flashMessage,
    flashError,
    commitBacklogEdit,
    collectPending,
    runDoctor: runDoctorSeam,
    collectChange,
    tickStat,
  });
  // Whether the director's status row is in flight, fed by render each frame: the gate for
  // Ctrl+C's interrupt — with no director tick running, Ctrl+C flashes a notice instead of
  // writing an abort marker nothing would consume.
  let directorInFlight = false;

  // The prompt-line editors, constructed with the pane-side leaves they call on commit/exit:
  // the disk writes, the flash pair, the selections/caches they return to, and the clock.
  const editors = createTuiEditors({
    root,
    now,
    flat,
    refreshQueued: panes.refreshQueued,
    clearBacklogSelection: panes.clearBacklogSelection,
    applyHistorySearch: panes.applyHistorySearch,
    applyActivitySearch: panes.applyActivitySearch,
    flashMessage,
    flashError,
    commitBacklogEdit,
  });

  const handleKey = (str: string | undefined, key: { ctrl?: boolean; name?: string }): void => {
    // Every key starts disarmed, whichever arm then consumes it.
    panes.beginKey();
    if (key.ctrl && key.name === "d") {
      deps.quit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      // Ctrl+C interrupts the director's in-flight tick (shell-EOF behavior moved to
      // Ctrl+D): when the director row is in flight, write the same abort marker the
      // CLI's `abort --role director` does, through the shared requestAbort core so the
      // marker format and wording cannot drift; when none is, flash a notice and leave
      // the team untouched. A failed marker write flashes the reason instead of
      // escaping the handler — the same contract the per-loop controls above honor.
      if (!directorInFlight) {
        flashMessage("no director task in flight");
        deps.requestRender();
        return;
      }
      try {
        const result = requestAbort(root, DIRECTOR_ROLE);
        flashMessage(result.ok ? result.message : `error: ${result.error}`);
      } catch (err) {
        flashError(err);
      }
      deps.requestRender();
      return;
    }
    // The prompt-line editors own every arm that reads or writes the one prompt line — the
    // toggles and per-loop controls that open them, the escape/Enter arms that close and
    // commit them, and the `/` search. Route the key to them first; when they consumed it,
    // the dispatch is done (they always render on a handled key).
    if (editors.handleKey(str, key, panes.editorCtx())) {
      deps.requestRender();
      return;
    }
    if (key.ctrl && key.name === "t") {
      // Ctrl+T exits every open editor too — view cycling is orthogonal to them, so a cycle
      // never strands an editor's pre-filled text in the prompt line. Each editor restores its
      // saved draft. Role-prompt mode composes the same way: cycling away restores the saved
      // director draft.
      editors.exitAll();
      panes.cycleView();
      return;
    }
    if (panes.handleKey(key, editors.state())) return;
    const arrow = arrowDir(key.name);
    if (arrow !== null && editors.onArrow(arrow)) {
      deps.requestRender();
      return;
    }
    editors.apply(str, key);
    deps.requestRender();
  };

  return {
    handleKey,
    syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorRunning = false): void {
      editors.sync(capUsd, budgetFree);
      directorInFlight = directorRunning;
      panes.syncRoster(roles);
    },
    setLineBudgets: panes.setLineBudgets,
    state(): TuiKeysState {
      return {
        ...editors.state(),
        ...panes.state(),
        directorInFlight,
        flash: flash && now() < flashUntil ? flash : null,
      };
    },
  };
}
