// vocabulary: plain
import { setDailyBudgetUsd } from "../../config/config-write.js";
import { promptLengthProblem, submitPrompt } from "../../inbox/inbox-submit.js";
import { fileEntryWithBody, OPERATOR_FILE_KINDS, tryEditEntry } from "../../backlog/backlog-write.js";
import { stripEntryStamp } from "../../backlog/backlog-structure.js";
import {
  cancelScheduledStopMessage,
  requestAbort,
  requestScheduledStop,
  requestWake,
  cancelWakes,
  submitRolePromptAndWake,
  wakeQuestionAsker,
  rolePauseMessage,
  roleResumeMessage,
} from "../../operator/operator-intent.js";
import {
  isTeamPaused,
  pausedRoles,
  pauseTeam,
  pauseRole,
  resumeTeam,
  resumeRole,
  scheduledStopAt,
} from "../../team/team-state.js";
import { durationLabel } from "../../cli/cli-args.js";
import { questionAsker, tryAnswerQuestion, UNCLOSED_FENCE_MESSAGE } from "../../backlog/question-answer.js";
import { editQueuedFile, readQueuedPromptBody } from "../../inbox/inbox-edit.js";
import { collapseWhitespace } from "../../text/text.js";
import { teamPausePhrase, teamResumePhrase } from "../../text/phrases.js";
import { usdCap } from "../../text/format.js";
import type { QueuedListRow } from "../../inbox/inbox.js";
import type { labeledBacklogEntries } from "./tui-backlog.js";
import {
  applyKey,
  parseBudgetInput,
  parseDeferInput,
  parsePauseInput,
  parseRolePauseInput,
  parseRoleWakeInput,
  parseStopInInput,
  parseRolePromptInput,
} from "./tui-input.js";
import {
  newPromptHistory,
  pushPromptHistory,
  recallPromptHistory,
  resetPromptRecall,
  settlePromptRecall,
  type PromptHistory,
} from "./tui-prompt-history.js";

/** The seams a prompt-line editor cannot own itself: the disk side effects the commit arms
 * trigger (submit, pause, edit, answer, budget), the pane-side results an editor returns to
 * (the flash notice, the refreshed queued/backlog selections, an applied search), and the
 * clock the pause editor reads. Everything here runs on the tui-keys.ts and
 * tui-panes.ts side of the boundary;
 * this factory owns only the one prompt line and the editors that share it. */
interface TuiEditorsDeps {
  root: string;
  /** Injectable clock; the pause/stop editors compute now()+duration from it. */
  now(): number;
  /** The project-status pane's flat entry list (plans, then bugs, then questions), shared with
   * the render so answer/title-editor positions cannot drift. */
  flat(): ReturnType<typeof labeledBacklogEntries>;
  /** Re-read the Queued pane's rows and cached list after a commit/exit that touched the queue. */
  refreshQueued(): void;
  /** Clear the project-status pane's entry selection and its body scroll after a recorded
   * answer/edited entry leaves the list. */
  clearBacklogSelection(): void;
  /** Apply a finished History search on the pane (sets historyGrep, recomputes the cached
   * Markdown, re-enters at the body's head). */
  applyHistorySearch(pattern: string | null): void;
  /** Apply a finished Activity search on the pane (sets activityGrep, resets the scroll to the
   * live tail). */
  applyActivitySearch(pattern: string | null): void;
  /** Flash a one-line notice on the prompt line. */
  flashMessage(message: string): void;
  /** Flash a caught failure as `error: <message>`. */
  flashError(err: unknown): void;
  /** Commit an operator's backlog edit to main and flash when the commit did not land. */
  commitBacklogEdit(file: string, subject: string): void;
}

/** The pane state the editor open arms read and the search editor pre-fills from. The factory
 * receives these per keypress; the pane (`createTuiKeys`) owns them. */
export interface TuiEditorCtx {
  /** The current pane index (the transcript/view window). */
  view: number;
  /** The current roster of loop ids. */
  roleIds: string[];
  /** The project-status pane's entry selection (null = list mode). */
  selectedEntry: number | null;
  /** The Queued pane's row selection (null = list mode). */
  selectedQueued: number | null;
  /** The Queued pane's cached rows, the same list renderQueuedList built. */
  queuedRows: QueuedListRow[];
  /** The History pane's active free-text search (the `/` editor's applied pattern). */
  historyGrep: string | null;
  /** The Activity pane's active free-text search (the `/` editor's applied pattern). */
  activityGrep: string | null;
}

/** The state the render reads back for the prompt line: the shared line itself, the modes it
 * names in the hint line, and the pending defer delay. The pane merges these into the frame. */
interface TuiEditorState {
  input: string;
  cursor: number;
  budgetMode: boolean;
  rolePromptFor: string | null;
  /** Whether the prompt line is editing the next prompt's defer delay (Ctrl+L). */
  deferMode: boolean;
  /** The pending defer delay as a human label (durationLabel), or null when the next prompt
   * delivers immediately. */
  defer: string | null;
  /** Whether the prompt line is editing the team pause's duration and reason (Ctrl+F). */
  pauseEditMode: boolean;
  /** The loop the pause editor pauses, null for the team editor (Ctrl+F). */
  pauseEditRole: string | null;
  /** The per-loop editor schedules a wake (Ctrl+W) rather than a pause (Ctrl+P). */
  pauseEditWake: boolean;
  /** The team editor schedules a stop (Ctrl+Q) rather than a pause (Ctrl+F). */
  pauseEditStop: boolean;
  /** The Queued pane's in-place editor (Ctrl+E): the role and queue-file basename of the entry
   * the prompt line is editing, or null when no edit is open. */
  queuedEditFor: { role: string; file: string } | null;
  /** The shared `/` search editor is open on the prompt line. */
  searchMode: boolean;
  /** The backlog pane's answer editor (Ctrl+A on a selected open question). */
  answerFor: { position: number; title: string } | null;
  /** The backlog pane's title editor (Ctrl+E on a selected plan or bug), a null position being
   * the new-entry form (Ctrl+N). */
  entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null;
}

/** The prompt-line editor subsystem `createTuiKeys` constructs: the factory that owns the one
 * shared prompt line (`input`/`cursor`), every modal editor's active flag and saved-draft pair,
 * and the session history — see createTuiEditors. */
interface TuiEditors {
  /** Route a keypress through the prompt-line editor arms. Returns true when the editor
   * subsystem consumed the key (the outer dispatch then renders and stops); false when the key
   * belongs to a pane arm, which the outer dispatch handles. */
  handleKey(str: string | undefined, key: { ctrl?: boolean; name?: string }, ctx: TuiEditorCtx): boolean;
  /** The Up/Down prompt-history recall, run by the outer dispatch after the pane arrow arms so
   * a backlog/queued selection keeps the arrows. Returns true when it recalled a history entry. */
  onArrow(direction: "up" | "down"): boolean;
  /** The applyKey fallback for keys no arm consumed: regular typing into the prompt line. */
  apply(str: string | undefined, key: { ctrl?: boolean; name?: string }): void;
  /** Exit every open editor (Ctrl+T): the prompt line gives the line back to its saved draft. */
  exitAll(): void;
  /** Sync the snapshot-fed cap/free flag the budget editor reads (and, on Enter, writes). */
  sync(capUsd: number, budgetFree: boolean): void;
  /** The editor-owned slice of the frame render composes. */
  state(): TuiEditorState;
}

/** The prompt-line editor half of the createTuiKeys closure, extracted wholesale: the factory
 * owns the shared line and the set of mutually-exclusive modal editors on it — budget Ctrl+B,
 * role-prompt Ctrl+R, defer Ctrl+L, pause Ctrl+F/Ctrl+Q, answer, entry-edit, queued-edit, and
 * the `/` search — each with its own saved-draft pair and exit helper. The saved-draft
 * invariants (the editors share one line and are mutually exclusive) hold here once, at the
 * module boundary, instead of being re-stated per editor. The disk/commit responsibilities and
 * the pane state stay on the tui-keys.ts and tui-panes.ts side; this
 * factory receives them as deps and the
 * per-keypress pane reads as ctx. */
export function createTuiEditors(deps: TuiEditorsDeps): TuiEditors {
  const { root } = deps;

  let input = "";
  let cursor = 0;
  // Ctrl+B budget-edit mode on the prompt line: while set, the line edits the daily cost cap
  // (pre-filled with the current cap — empty when disabled) instead of a director prompt.
  // The previous prompt text is saved so leaving the mode restores it byte-for-byte.
  let budgetMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // Ctrl+R role-prompt mode on the prompt line: while set (to the viewed loop's role id), the
  // line edits a prompt for that one loop instead of a director prompt. It keeps its OWN saved
  // pair, separate from budget mode's: the two modes are mutually exclusive (each refuses to
  // open while the other holds the line), and with separate pairs neither can clobber the
  // other's saved draft even if a guard is ever loosened.
  let rolePromptFor: string | null = null;
  let roleSavedInput = "";
  let roleSavedCursor = 0;
  // Ctrl+L defer mode on the prompt line: while set, the line edits a duration that rides
  // into the next delivered prompt as the same `tumwater:not-before` marker `tumwater prompt
  // --at` and the dashboard composer write. deferMs is a DURATION, not an epoch: submit
  // computes now() + deferMs, so a prompt queued later still defers by the full span. It is
  // session-only and one-shot: a successful submit or an empty line clears it. Its own saved
  // pair, mutually exclusive with the budget/role/search editors on the one prompt line.
  let deferMs: number | null = null;
  let deferMode = false;
  let deferSavedInput = "";
  let deferSavedCursor = 0;
  let pauseEditMode = false;
  let pauseEditRole: string | null = null;
  let pauseEditWake = false;
  let pauseEditStop = false;
  let pauseSavedInput = "";
  let pauseSavedCursor = 0;
  // The prompt line's session history (tui-prompt-history.ts's rules): every successfully submitted
  // prompt — director and per-role alike — joins it, and Up/Down walk it the way readline
  // does. Not persisted: a TUI session starts blank, like a fresh shell.
  let promptHistory: PromptHistory = newPromptHistory();
  // The last snapshot's cap, synced by render so the Ctrl+B handler can pre-fill without
  // re-reading config itself (render already polls snapshot every second).
  let currentCapUsd = 0;
  // The last snapshot's free flag: true when every model the team could use is unpriced,
  // so a cap could never bind — the Ctrl+B handler flashes a notice instead of opening
  // the editor (BUGS.md 2026-09-14), leaving the prompt line untouched.
  let currentBudgetFree = false;
  // The Queued pane's in-place editor (Ctrl+E): the role and queue-file basename of the row
  // the prompt line is rewriting, with its own saved-draft pair exactly like the budget and
  // role-prompt editors. All four editors share the one prompt line and are mutually exclusive,
  // so no editor can clobber another's saved draft.
  let queuedEditFor: { role: string; file: string } | null = null;
  let queuedSavedInput = "";
  let queuedSavedCursor = 0;
  let answerFor: { position: number; title: string } | null = null;
  let answerSavedInput = "";
  let answerSavedCursor = 0;
  let entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null = null;
  let entryEditSavedInput = "";
  let entryEditSavedCursor = 0;
  // The History search editor on the prompt line: `/` enters it (only on History with an empty
  // line), pre-filling the applied pattern; Enter applies it, Esc restores the draft. Its own
  // saved-draft pair, exactly like the budget and role-prompt editors: the three share one
  // prompt line and are mutually exclusive, so no editor can clobber another's saved draft.
  let searchMode = false;
  // Which pane the shared `/` editor feeds: History's tick search or Activity's event search.
  // The target is captured when `/` opens so a roster change mid-edit cannot retarget Enter.
  let searchFor: "history" | "activity" = "history";
  let searchSavedInput = "";
  let searchSavedCursor = 0;

  // Restore the prompt line's saved draft and reset its recall state — the shared tail of
  // every editor's exit: the restored text becomes the live draft now, so the next Up starts
  // a fresh browse instead of resuming whatever that editor's line had left behind.
  const restorePromptFrom = (text: string, pos: number): void => {
    input = text;
    cursor = pos;
    promptHistory = resetPromptRecall(promptHistory);
  };

  /** The one-line editor's busy-guard wording: entering a mutually-exclusive editor while
   * another holds the prompt line flashes `finish or cancel the <subject> first (Esc
   * cancels)` instead of dropping the held mode's saved draft. Single-homes the sentence
   * across handleKey's mode guards so the "first (Esc cancels)" wording cannot drift. */
  const busyFlash = (subject: string): string =>
    `finish or cancel the ${subject} first (Esc cancels)`;

  /** Which editor currently holds the shared prompt line as the busy-guard flash label, or
   * null when none does. The editors are mutually exclusive — at most one owns the line — so
   * priority order here is cosmetic. `entering` names the editor about to take the line and is
   * excluded: pressing its own key while it already holds the line must toggle/exit it (e.g.
   * Ctrl+B while budget-edit holds the line), not flash the way out. Single-homes the
   * mode-to-wording mapping across the entry guards so the two sites cannot drift. */
  const heldEditorFlash = (entering: "budget" | "defer"): string | null =>
    searchMode
      ? busyFlash("search")
      : pauseEditMode
        ? busyFlash("pause")
        : queuedEditFor
          ? busyFlash("inbox edit")
          : answerFor
            ? busyFlash("answer")
            : entryEditFor
              ? busyFlash("entry edit")
              : rolePromptFor
                ? busyFlash(`prompt for ${rolePromptFor}`)
                : entering === "defer" && budgetMode
                  ? busyFlash("budget edit")
                  : entering === "budget" && deferMode
                    ? busyFlash("send-later edit")
                    : null;

  /** Hand the recall line's current draft back into a caller's editor save slot and reset
   * the recall state — the shared preamble of every mutually-exclusive editor that takes the
   * prompt line. Mid-recall the line holds a history entry while the real draft sits in the
   * recall state, so settle first: the editor saves (and later restores) the draft the
   * operator was writing, with no stale index/draft crossing modes. The save slots are
   * closure `let`s, so they are passed as setters rather than named. */
  const settleDraft = (
    saveInput: (text: string) => void,
    saveCursor: (pos: number) => void,
  ): void => {
    const settled = settlePromptRecall(promptHistory, input, cursor);
    promptHistory = settled.history;
    saveInput(settled.text);
    saveCursor(settled.cursor);
  };

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    restorePromptFrom(savedInput, savedCursor);
  };

  // Leave role-prompt mode (Esc, Ctrl+R again, or Ctrl+T): restore the saved prompt text,
  // and reset the recall state with it — the saved draft was saved settled (see the Ctrl+R
  // handler), so resuming a browse entered in role mode would restore role-mode text onto
  // the director line and lose the director draft the arrows had saved.
  const exitRolePromptMode = (): void => {
    if (!rolePromptFor) return;
    rolePromptFor = null;
    restorePromptFrom(roleSavedInput, roleSavedCursor);
  };

  // Leave defer-edit mode (Esc, Ctrl+L again, or Ctrl+T): restore the saved prompt text. The
  // pending deferMs itself is untouched — Esc cancels the edit, not a delay already saved.
  const exitDeferMode = (): void => {
    if (!deferMode) return;
    deferMode = false;
    restorePromptFrom(deferSavedInput, deferSavedCursor);
  };

  // Leave pause-edit mode (Esc, Ctrl+F again, a written pause, or Ctrl+T): restore the draft.
  const exitPauseEditMode = (): void => {
    if (!pauseEditMode) return;
    pauseEditMode = false;
    pauseEditRole = null;
    pauseEditWake = false;
    pauseEditStop = false;
    restorePromptFrom(pauseSavedInput, pauseSavedCursor);
  };

  // Leave the backlog pane's answer editor (Esc, a recorded answer, or Ctrl+T): restore the
  // saved prompt text and reset the recall state, mirroring exitQueuedEdit.
  const exitAnswerMode = (): void => {
    if (!answerFor) return;
    answerFor = null;
    restorePromptFrom(answerSavedInput, answerSavedCursor);
  };

  // Leave the backlog pane's title editor (Esc, a saved edit, or Ctrl+T): the same settle
  // contract as exitAnswerMode.
  const exitEntryEdit = (): void => {
    if (!entryEditFor) return;
    entryEditFor = null;
    restorePromptFrom(entryEditSavedInput, entryEditSavedCursor);
  };

  // Leave the Queued pane's in-place editor (Esc, a saved edit, or Ctrl+T): restore the saved
  // prompt text, and reset the recall state with it — the same settle contract the other
  // editors honor.
  const exitQueuedEdit = (): void => {
    if (!queuedEditFor) return;
    queuedEditFor = null;
    restorePromptFrom(queuedSavedInput, queuedSavedCursor);
  };

  // Leave the shared search editor (Enter applies, Esc cancels, Ctrl+T cycles): restore the
  // saved prompt text, and reset the recall state with it — the same settle contract the budget
  // and role-prompt editors honor. The applied activityGrep/historyGrep itself persists across
  // view cycling, like historyWindow/historyResult.
  const exitHistorySearch = (): void => {
    if (!searchMode) return;
    searchMode = false;
    restorePromptFrom(searchSavedInput, searchSavedCursor);
  };

  const handleKey = (str: string | undefined, key: { ctrl?: boolean; name?: string }, ctx: TuiEditorCtx): boolean => {
    if (key.ctrl && key.name === "b") {
      // Ctrl+B toggles budget-edit mode on the prompt line (mnemonic for *b*udget): entering
      // pre-fills the current cap (empty when disabled — empty means "no cap" on save) and
      // saves the prompt text; leaving restores it. Esc cancels the same way.
      const held = heldEditorFlash("budget");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping the
        // held mode's saved draft (or parsing its text as a cap on Enter).
        deps.flashMessage(held);
        return true;
      }
      if (budgetMode) {
        exitBudgetMode();
      } else if (currentBudgetFree) {
        // An all-free team has no spend a cap could bind: the editor would pre-fill a
        // value that can never take effect, so Ctrl+B flashes a one-line notice and
        // leaves the prompt line untouched (toggle/Esc logic unchanged).
        deps.flashMessage("budget n/a — all models free");
      } else {
        // Mid-recall, hand the arrows' saved draft back before the cap editor takes the
        // line — the same settle the role editor does — so leaving budget mode restores
        // the draft, not a history entry, with no stale recall state riding along.
        settleDraft((t) => (savedInput = t), (n) => (savedCursor = n));
        budgetMode = true;
        input = currentCapUsd > 0 ? String(currentCapUsd) : "";
        cursor = input.length;
        deps.flashMessage("edit daily cost budget (USD): Enter to save, Esc to cancel");
      }
      return true;
    }
    if (key.ctrl && key.name === "l") {
      // Ctrl+L toggles defer-edit mode on the prompt line (mnemonic: **l**ater): the line edits
      // a duration that rides into the next delivered prompt as the same `tumwater:not-before`
      // marker `tumwater prompt --at` and the dashboard composer write. Entering pre-fills the
      // pending delay (empty when none) and saves the prompt text; leaving restores it. Empty
      // means "deliver now", so Esc cancels the edit without clearing an already-saved delay.
      const held = heldEditorFlash("defer");
      if (held) {
        // Mutually exclusive with the other editors: all share one prompt line, so a mode may
        // not enter while another holds it. Flash the way out instead of silently dropping
        // the held mode's saved draft.
        deps.flashMessage(held);
        return true;
      }
      if (deferMode) {
        exitDeferMode();
      } else {
        // Mid-recall, hand the arrows' saved draft back before the defer editor takes the
        // line — the same settle the budget and role editors do — so leaving restores the
        // draft, not a history entry, with no stale recall state riding along.
        settleDraft((t) => (deferSavedInput = t), (n) => (deferSavedCursor = n));
        deferMode = true;
        input = deferMs === null ? "" : durationLabel(deferMs);
        cursor = input.length;
        deps.flashMessage("send later: a duration like 45m (empty sends now) — Enter to save, Esc to cancel");
      }
      return true;
    }
    if (key.ctrl && key.name === "f" && !budgetMode && !rolePromptFor && !searchMode && !deferMode && !queuedEditFor && !answerFor && !entryEditFor) {
      // Ctrl+F toggles the whole-team pause (mnemonic: **F**leet) through the same
      // pauseTeam/resumeTeam marker writers `tumwater pause`/`resume` and the dashboard's
      // /api/pause call use, so the surfaces cannot drift on marker format or idempotence.
      // The shared teamPausePhrase/teamResumePhrase base lines keep the flash wording the
      // event feed and failure digest already read; a no-op flashes the same
      // already-paused/was-not-paused contract the CLI prints. Guarded out of the budget and
      // role-prompt editors, whose prompt line the team toggle must not disturb — the same
      // inertness the per-loop keys honor below. The write can fail (a lock timeout, a torn
      // fs), so flash the reason instead of letting the throw kill the TUI.
      if (pauseEditMode) {
        exitPauseEditMode();
        return true;
      }
      try {
        if (isTeamPaused(root)) {
          deps.flashMessage(resumeTeam(root) ? teamResumePhrase() : "team was not paused");
        } else {
          // An unpaused team opens the one-line editor: "[duration] [reason]", empty pauses
          // until resumed. A paused team resumes at once.
          settleDraft((t) => (pauseSavedInput = t), (n) => (pauseSavedCursor = n));
          pauseEditMode = true;
          input = "";
          cursor = 0;
          deps.flashMessage('pause the team: [duration] [reason], e.g. "2h deploy freeze" (empty pauses until resumed) — Enter to pause, Esc to cancel');
        }
      } catch (err) {
        deps.flashError(err);
      }
      return true;
    }
    if (key.ctrl && key.name === "q" && !budgetMode && !rolePromptFor && !searchMode && !deferMode && !queuedEditFor && !answerFor && !entryEditFor) {
      // Ctrl+Q (mnemonic: **q**uit later) schedules or cancels a graceful team stop through
      // the same requestScheduledStop/cancelScheduledStopMessage cores `tumwater stop --in` /
      // `--cancel` and the dashboard use. A pending stop cancels at once; otherwise it opens
      // the duration editor. A second press closes any open pause/wake/stop editor unwritten.
      if (pauseEditMode) {
        exitPauseEditMode();
        return true;
      }
      try {
        if (scheduledStopAt(root) !== undefined) {
          deps.flashMessage(cancelScheduledStopMessage(root));
        } else {
          settleDraft((t) => (pauseSavedInput = t), (n) => (pauseSavedCursor = n));
          pauseEditMode = true;
          pauseEditRole = null;
          pauseEditStop = true;
          input = "";
          cursor = 0;
          deps.flashMessage('stop the team later: a duration, e.g. "2h" — current runs finish, then the team stops — Enter to schedule, Esc to cancel');
        }
      } catch (err) {
        deps.flashError(err);
      }
      return true;
    }
    // Per-loop controls on the transcript pane: Ctrl+P toggles the viewed loop's pause,
    // Ctrl+A aborts its in-flight tick, Ctrl+W opens the wake editor, and Ctrl+R opens the
    // role-prompt editor for it.
    // They call the same marker-writing/submit cores the CLI's --role flags do, so the
    // surfaces cannot drift on marker format, idempotence, or wording. Guarded to the
    // transcript views and out of budget-edit mode; everywhere else the keys fall through
    // to applyKey, where only Ctrl+U (kill to line start) and Ctrl+K (kill to line end)
    // edit the prompt line and the rest of these ctrl-key presses stay inert.
    // Every branch is a disk write that can fail (a lock timeout, a torn fs), and an
    // unguarded throw would escape this keypress handler and kill the TUI — flash the
    // reason instead, the same contract the prompt-submit path below honors.
    if (key.ctrl && (key.name === "p" || key.name === "w") && pauseEditRole !== null) {
      // A second Ctrl+P or Ctrl+W closes the per-loop pause/wake editor, mirroring Ctrl+F's
      // second press.
      exitPauseEditMode();
      return true;
    }
    if (
      !budgetMode &&
      !deferMode && !pauseEditMode &&
      !queuedEditFor && !answerFor && !entryEditFor &&
      ctx.roleIds.length > 0 &&
      ctx.view >= 1 && ctx.view <= ctx.roleIds.length &&
      key.ctrl && (key.name === "p" || key.name === "a" || key.name === "w" || key.name === "r")
    ) {
      const role = ctx.roleIds[ctx.view - 1]!; // defined: view is clamped inside the transcript range
      try {
        if (key.name === "r") {
          // Ctrl+R toggles role-prompt mode for the viewed loop (mnemonic: p**R**ompt —
          // Ctrl+P is taken by pause): entering saves the director draft in this mode's own
          // pair and blanks the line; entering again (or Esc) restores it. Mutually
          // exclusive with budget mode by the outer guard and the mirrored refusal in the
          // Ctrl+B branch.
          if (rolePromptFor) {
            exitRolePromptMode();
            deps.flashMessage("role prompt cancelled");
          } else {
            // Mid-recall, the line holds a history entry while the real draft sits in the
            // recall state: settle first, so the role editor saves (and later restores) the
            // draft the operator was writing, and no stale index/draft crosses modes —
            // otherwise Esc here would surface role-mode recalls on the director line.
            settleDraft((t) => (roleSavedInput = t), (n) => (roleSavedCursor = n));
            rolePromptFor = role;
            input = "";
            cursor = 0;
            deps.flashMessage(`prompt for ${role}: Enter to send, Esc to cancel`);
          }
        } else if (key.name === "p") {
          // Toggle by the marker's current state, read fresh: pauseRole/resumeRole's false
          // return means another window raced us to the same state, and the wording
          // helpers render that honestly — the changed-state contract the CLI prints.
          if (pausedRoles(root).includes(role)) {
            deps.flashMessage(roleResumeMessage(root, role, resumeRole(root, role)));
          } else if (rolePromptFor || searchMode) {
            deps.flashMessage(
              rolePromptFor ? busyFlash("role prompt") : busyFlash("search"),
            );
          } else {
            // An unpaused loop opens the one-line duration editor; nothing is written until
            // Enter. Empty pauses until resumed.
            settleDraft((t) => (pauseSavedInput = t), (n) => (pauseSavedCursor = n));
            pauseEditMode = true;
            pauseEditRole = role;
            input = "";
            cursor = 0;
            deps.flashMessage(`pause ${role}: [duration], e.g. "2h" (empty pauses until resumed) — Enter to pause, Esc to cancel`);
          }
        } else if (key.name === "a") {
          const result = requestAbort(root, role);
          deps.flashMessage(result.ok ? result.message : `error: ${result.error}`);
        } else if (rolePromptFor || searchMode) {
          deps.flashMessage(
            rolePromptFor ? busyFlash("role prompt") : busyFlash("search"),
          );
        } else {
          // Ctrl+W opens the one-line wake editor; nothing is written until Enter. Empty wakes now.
          settleDraft((t) => (pauseSavedInput = t), (n) => (pauseSavedCursor = n));
          pauseEditMode = true;
          pauseEditRole = role;
          pauseEditWake = true;
          input = "";
          cursor = 0;
          deps.flashMessage(`wake ${role}: [duration], e.g. "2h", or "cancel" (empty wakes now) — Enter to apply, Esc to cancel`);
        }
      } catch (err) {
        deps.flashError(err);
      }
      return true;
    }
    if (key.ctrl && key.name === "n") {
      // On the Backlog view Ctrl+N files a new entry: it opens the title editor with a null
      // position (new plan), and pressed again inside that editor flips plan <-> bug.
      if (entryEditFor !== null && entryEditFor.position === null) {
        const other = entryEditFor.kind === "plan" ? "bug" : "plan";
        entryEditFor = { ...entryEditFor, kind: other };
        deps.flashMessage(`new ${other} — Enter to file, Ctrl+N switches to ${other === "plan" ? "bug" : "plan"}, Esc cancels`);
        return true;
      }
      // A Ctrl+N on any other state (not the Backlog view's new-entry slot, or an editor
      // already holding the line) is the notebook/change/trail cycle, a pane arm the outer
      // dispatch handles — this factory returns false so it runs.
      if (
        ctx.view === ctx.roleIds.length + 1 &&
        !budgetMode && !rolePromptFor && !searchMode && !deferMode && !pauseEditMode && !queuedEditFor && !answerFor && !entryEditFor
      ) {
        settleDraft((t) => (entryEditSavedInput = t), (n) => (entryEditSavedCursor = n));
        entryEditFor = { kind: "plan", position: null, title: "" };
        input = "";
        cursor = 0;
        deps.flashMessage("new plan — Enter to file, Ctrl+N switches to bug, Esc cancels");
        return true;
      }
      return false;
    }
    if (
      key.ctrl && key.name === "e" &&
      !budgetMode && !rolePromptFor && !searchMode && !deferMode && !pauseEditMode && queuedEditFor === null && !answerFor && !entryEditFor &&
      ctx.view === ctx.roleIds.length + 6 && ctx.selectedQueued !== null
    ) {
      // Ctrl+E opens the Queued pane's in-place editor on the selected row (mnemonic:
      // **E**dit) through the same readQueuedPromptBody/editQueuedFile pair the dashboard's
      // Edit uses: the body is pre-filled marker- and attachment-stripped, and Enter writes
      // it back to the same queue file, so its position, enqueue stamp, deferral, and
      // attached images survive. A row that vanished between selection and this press (the
      // loop dequeued it, or another operator cancelled it) flashes the gone notice and
      // refreshes the list. A no-selection press (list mode) falls through to the report
      // window below, exactly as before.
      try {
        const position = Math.min(ctx.selectedQueued, ctx.queuedRows.length - 1);
        const row = ctx.queuedRows[position];
        if (row !== undefined) {
          const body = readQueuedPromptBody(root, row.role, row.file);
          if (body === null) {
            deps.flashMessage(`inbox message #${row.position} for ${row.role} is gone`);
            deps.refreshQueued();
          } else {
            // Mid-recall, the line holds a history entry while the real draft sits in the
            // recall state: settle first, so the queued editor saves (and later restores)
            // the draft the operator was writing.
            settleDraft((t) => (queuedSavedInput = t), (n) => (queuedSavedCursor = n));
            queuedEditFor = { role: row.role, file: row.file };
            input = body;
            cursor = body.length;
            deps.flashMessage(
              `editing inbox message #${row.position} for ${row.role} — Enter to save, Esc to cancel`,
            );
          }
        }
      } catch (err) {
        deps.flashError(err);
      }
      return true;
    }
    if (
      key.ctrl && key.name === "a" &&
      !budgetMode && !rolePromptFor && !searchMode && !deferMode && !pauseEditMode && !queuedEditFor && !answerFor && !entryEditFor &&
      ctx.view === ctx.roleIds.length + 1 && ctx.selectedEntry !== null
    ) {
      // Ctrl+A opens the answer editor on the selected open question (mnemonic: **A**nswer);
      // Enter records the decision through tryAnswerQuestion, the core `tumwater questions
      // answer` and the dashboard's form share. The position is the question's 1-based index
      // among the open questions: the browsable list puts plans, then bugs, then questions first.
      try {
        const entries = deps.flat();
        const sel = Math.min(ctx.selectedEntry, entries.length - 1);
        const entry = entries[sel];
        if (entry?.label !== "question") {
          deps.flashMessage("only an open question can be answered here");
        } else {
          const position = sel - entries.filter((e) => e.label === "plan" || e.label === "bug").length + 1;
          settleDraft((t) => (answerSavedInput = t), (n) => (answerSavedCursor = n));
          answerFor = { position, title: entry.title };
          input = "";
          cursor = 0;
          deps.flashMessage(`answering question #${position} — Enter to record, Esc to cancel`);
        }
      } catch (err) {
        deps.flashError(err);
      }
      return true;
    }
    if (
      key.ctrl && key.name === "e" &&
      !budgetMode && !rolePromptFor && !searchMode && !deferMode && !pauseEditMode && !queuedEditFor && !answerFor && !entryEditFor &&
      ctx.view === ctx.roleIds.length + 1 && ctx.selectedEntry !== null
    ) {
      // Ctrl+E opens the title editor on the selected plan or bug (mnemonic: **E**dit); Enter
      // saves through tryEditEntry, the non-exiting core the dashboard drawer shares, keeping
      // the body and stamp. The prompt line is single-line, so only the title is editable here.
      try {
        const entries = deps.flat();
        const sel = Math.min(ctx.selectedEntry, entries.length - 1);
        const picked = entries[sel];
        if (picked === undefined) {
          // an emptied list has nothing to edit
        } else if (picked.label === "done" || picked.label === "fixed" || picked.label === "answered") {
          deps.flashMessage("a done plan, fixed bug or answered question is read-only");
        } else if (picked.label === "question") {
          deps.flashMessage("only a plan or open bug can be edited here");
        } else {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
          settleDraft((t) => (entryEditSavedInput = t), (n) => (entryEditSavedCursor = n));
          entryEditFor = { kind, position, title: picked.title };
          input = stripEntryStamp(picked.title);
          cursor = input.length;
          deps.flashMessage(`editing ${kind} #${position} — Enter to save, Esc to cancel`);
        }
      } catch (err) {
        deps.flashError(err);
      }
      return true;
    }
    if (
      !key.ctrl && str === "/" && !searchMode && !budgetMode && !rolePromptFor && !deferMode && !pauseEditMode &&
      !queuedEditFor && !answerFor && !entryEditFor &&
      (ctx.view === 0 || ctx.view === ctx.roleIds.length + 4) && input === ""
    ) {
      // `/` opens a free-text search on the prompt line (the pager's search key; this project
      // already reserves `/` for a meta action): over the History pane's tick rows on History,
      // over the Activity feed's events on Activity. Guarded to those two views and to an empty
      // line, so elsewhere it types into the prompt as today and a director draft is never
      // disturbed. Pre-fills the applied pattern so Enter re-submits it and the operator can
      // edit it; Esc cancels without applying.
      settleDraft((t) => (searchSavedInput = t), (n) => (searchSavedCursor = n));
      searchFor = ctx.view === 0 ? "activity" : "history";
      searchMode = true;
      input = (searchFor === "activity" ? ctx.activityGrep : ctx.historyGrep) ?? "";
      cursor = input.length;
      deps.flashMessage(searchFor === "activity" ? "search events: Enter to filter, Esc to cancel" : "search runs: Enter to filter, Esc to cancel");
      return true;
    }
    if (key.name === "escape" && searchMode) {
      // Esc cancels the History search without applying it; the applied pattern is unchanged.
      exitHistorySearch();
      return true;
    }
    if (key.name === "escape" && budgetMode) {
      // Esc cancels budget-edit mode, restoring the previous prompt text.
      exitBudgetMode();
      return true;
    }
    if (key.name === "escape" && rolePromptFor) {
      // Esc cancels role-prompt mode the same way, restoring the previous prompt text.
      exitRolePromptMode();
      return true;
    }
    if (key.name === "escape" && pauseEditMode) {
      // Esc cancels the pause editor without writing, restoring the previous prompt text.
      exitPauseEditMode();
      return true;
    }
    if (key.name === "escape" && deferMode) {
      // Esc cancels the defer editor, restoring the previous prompt text and leaving any
      // already-saved pending delay untouched.
      exitDeferMode();
      return true;
    }
    if (key.name === "escape" && entryEditFor) {
      // Esc cancels the title editor, restoring the previous prompt text; nothing is written.
      const filing = entryEditFor.position === null;
      exitEntryEdit();
      deps.flashMessage(filing ? "new entry cancelled" : "edit cancelled");
      return true;
    }
    if (key.name === "escape" && answerFor) {
      // Esc cancels the answer editor, restoring the previous prompt text; nothing is written.
      exitAnswerMode();
      deps.flashMessage("answer cancelled");
      return true;
    }
    if (key.name === "escape" && queuedEditFor) {
      // Esc cancels the Queued pane's in-place editor, restoring the previous prompt text.
      exitQueuedEdit();
      return true;
    }
    if (key.name === "return") {
      if (searchMode) {
        // Enter applies the trimmed line to the pane the editor opened over: Activity sets
        // activityGrep (an empty line clears it) and resets the scroll to the live tail — the
        // offset indexed the old filtered list; History recomputes its row cache now (the pane
        // is showing) and re-enters at its head. A successful apply restores the saved prompt
        // draft through exitHistorySearch, the shared editor's exit.
        const pattern = input.trim();
        if (searchFor === "activity") {
          const applied = pattern === "" ? null : pattern;
          deps.applyActivitySearch(applied);
          exitHistorySearch();
          deps.flashMessage(applied === null ? "search cleared" : `search: "${applied}"`);
        } else {
          const applied = pattern === "" ? null : pattern;
          deps.applyHistorySearch(applied);
          exitHistorySearch();
          deps.flashMessage(applied === null ? "search cleared" : `search: "${applied}"`);
        }
      } else if (budgetMode) {
        // Enter in budget mode parses + saves the cap through the shared setter (which
        // writes tumwater.json atomically; the running orchestrator picks it up on its next
        // ~2 s poll). An invalid value flashes and STAYS in edit mode so the operator can
        // fix it; success restores the saved prompt text.
        const parsed = parseBudgetInput(input);
        if (!parsed.ok) {
          deps.flashMessage(parsed.error);
        } else {
          const result = setDailyBudgetUsd(root, parsed.value);
          if (result.ok) {
            exitBudgetMode();
            currentCapUsd = parsed.value; // the next render's snapshot agrees within ~2 s
            deps.flashMessage(
              parsed.value === 0
                ? "budget disabled"
                : `budget set to ${usdCap(parsed.value)}`,
            );
          } else {
            deps.flashMessage(result.error); // broken config or write failure — stay in edit mode
          }
        }
      } else if (pauseEditMode) {
        // Enter in pause-edit mode parses "[duration] [reason]" and writes the same marker
        // `tumwater pause --for/--reason` does. An invalid entry flashes and STAYS in the editor.
        const target = pauseEditRole;
        const stopParsed = pauseEditStop ? parseStopInInput(input) : null;
        const wakeParsed = pauseEditWake && target !== null ? parseRoleWakeInput(input) : null;
        const parsed = target !== null ? parseRolePauseInput(input) : parsePauseInput(input);
        if (stopParsed) {
          if (!stopParsed.ok) {
            deps.flashMessage(stopParsed.error);
          } else {
            try {
              const result = requestScheduledStop(root, stopParsed.inMs);
              exitPauseEditMode();
              deps.flashMessage(result.ok ? result.message : `error: ${result.error}`);
            } catch (err) {
              deps.flashError(err);
            }
          }
        } else if (wakeParsed) {
          if (!wakeParsed.ok) {
            deps.flashMessage(wakeParsed.error);
          } else {
            try {
              const message = wakeParsed.cancel ? cancelWakes(root, target!) : requestWake(root, [target!], wakeParsed.inMs);
              exitPauseEditMode();
              deps.flashMessage(message);
            } catch (err) {
              deps.flashError(err);
            }
          }
        } else if (!parsed.ok) {
          deps.flashMessage(parsed.error);
        } else if (target !== null) {
          try {
            const at = deps.now();
            const until = parsed.forMs === undefined ? undefined : at + parsed.forMs;
            const changed = pauseRole(root, target, until);
            exitPauseEditMode();
            deps.flashMessage(
              rolePauseMessage(
                root,
                target,
                changed,
                until === undefined ? undefined : { ms: parsed.forMs!, untilMs: until },
                at,
              ),
            );
          } catch (err) {
            deps.flashError(err);
          }
        } else {
          const team = parsed as Extract<ReturnType<typeof parsePauseInput>, { ok: true }>;
          try {
            const until = team.forMs === undefined ? undefined : deps.now() + team.forMs;
            const changed = pauseTeam(root, until, team.reason);
            exitPauseEditMode();
            const forSuffix = team.forMs === undefined ? "" : ` for ${durationLabel(team.forMs)}`;
            deps.flashMessage(
              changed || until !== undefined
                ? `${teamPausePhrase()}${forSuffix}${changed && team.reason ? `: ${team.reason}` : ""}`
                : "team is already paused",
            );
          } catch (err) {
            deps.flashError(err);
          }
        }
      } else if (deferMode) {
        // Enter in defer mode parses the duration: empty clears the pending delay (deliver
        // now), a valid value stores the session duration (applied as now() + deferMs at
        // submit), and an invalid spelling or an over-cap value flashes and STAYS in the
        // editor so the operator can fix it. Either way the saved draft is restored.
        const parsed = parseDeferInput(input);
        if (!parsed.ok) {
          deps.flashMessage(parsed.error);
        } else {
          deferMs = parsed.ms;
          exitDeferMode();
          deps.flashMessage(
            deferMs === null ? "send later cleared" : `next prompt delivers in ${durationLabel(deferMs)}`,
          );
        }
      } else if (rolePromptFor) {
        // Enter in role-prompt mode submits for the viewed loop through the same path
        // `tumwater prompt --role` uses: the shared submitRolePromptAndWake enqueues into
        // that loop's own queue (length-capped by the shared rule), logs under the loop,
        // and wakes it so a live team's loop comes in within one poll. An invalid
        // (whitespace-only) line flashes and STAYS in edit mode; a failed queue write
        // flashes the reason and keeps the text, the same contract the director path
        // below honors; success restores the saved draft.
        const parsed = parseRolePromptInput(input);
        if (!parsed.ok) {
          deps.flashMessage(parsed.error);
        } else {
          const role = rolePromptFor;
          try {
            const pending = deferMs;
            submitRolePromptAndWake(
              root,
              role,
              parsed.value,
              undefined,
              pending === null ? undefined : deps.now() + pending,
            );
            promptHistory = pushPromptHistory(promptHistory, parsed.value);
            deferMs = null;
            exitRolePromptMode();
            deps.flashMessage(
              pending === null
                ? `added to ${role}'s inbox`
                : `added to ${role}'s inbox — delivers in ${durationLabel(pending)}`,
            );
          } catch (err) {
            deps.flashError(err);
          }
        }
      } else if (entryEditFor) {
        // Enter saves the new title through tryEditEntry with the body re-read now, so a
        // concurrent body edit is not clobbered by a stale copy. The entry is matched by flat
        // index and title; a mismatch is treated as moved without writing. A blank title and a
        // throw flash and STAY in the editor so the text survives.
        const target = entryEditFor;
        if (!input.trim()) {
          deps.flashMessage("an entry needs a title");
        } else if (target.position === null) {
          // New entry (Ctrl+N): file by title with an empty body and wake its loop, the same
          // steps handleBacklogFile takes; a length problem or a throw stays in the editor.
          try {
            const { role, wakeText } = OPERATOR_FILE_KINDS[target.kind];
            const problem = promptLengthProblem(wakeText(collapseWhitespace(input)), role);
            if (problem) {
              deps.flashMessage(problem);
            } else {
              const filed = fileEntryWithBody(root, target.kind, input, "");
              deps.commitBacklogEdit(filed.file, `File ${target.kind}: ${filed.title}`);
              submitRolePromptAndWake(root, role, wakeText(filed.title));
              exitEntryEdit();
              deps.flashMessage(`filed ${target.kind}: ${filed.title} — woke ${role}`);
            }
          } catch (err) {
            deps.flashError(err);
          }
        } else {
          try {
            const entries = deps.flat();
            const plans = entries.filter((e) => e.label === "plan").length;
            const entry = entries[target.kind === "plan" ? target.position - 1 : plans + target.position - 1];
            const outcome =
              entry?.label === target.kind && entry.title === target.title
                ? tryEditEntry(root, target.kind, target.position, target.title, input, entry.body)
                : ({ status: "moved", title: "" } as const);
            exitEntryEdit();
            if (outcome.status === "edited") {
              deps.commitBacklogEdit(outcome.file, `Edit ${target.kind}: ${outcome.title}`);
              deps.flashMessage(`edited ${target.kind} #${target.position}: ${outcome.title}`);
            } else {
              deps.clearBacklogSelection();
              deps.flashMessage(`that ${target.kind} was already removed or moved — nothing edited`);
            }
          } catch (err) {
            deps.flashError(err);
          }
        }
      } else if (answerFor) {
        // Enter records the answer through tryAnswerQuestion, titled so a question that moved
        // since Ctrl+A is refused. A whitespace-only line, an unclosed fence, and a throw all
        // flash and STAY in the editor so the text survives; answered and missing/moved both
        // leave the editor and return the pane to list mode (the entry left the list).
        const target = answerFor;
        if (!input.trim()) {
          deps.flashMessage("questions answer needs a decision");
        } else {
          try {
            const outcome = tryAnswerQuestion(root, target.position, input, target.title);
            if (outcome.status === "fenced") {
              deps.flashMessage(UNCLOSED_FENCE_MESSAGE);
            } else {
              let woke = "";
              if (outcome.status === "answered") {
                deps.commitBacklogEdit("QUESTIONS.md", `Answer question: ${outcome.title}`);
                if (wakeQuestionAsker(root, outcome.title) !== null) woke = ` · woke ${questionAsker(outcome.title)}`;
              }
              exitAnswerMode();
              deps.clearBacklogSelection();
              deps.flashMessage(
                outcome.status === "answered"
                  ? `answered question #${target.position}: ${outcome.title}${woke}`
                  : "that question was already answered or moved — nothing recorded",
              );
            }
          } catch (err) {
            deps.flashError(err);
          }
        }
      } else if (queuedEditFor) {
        // Enter saves the queued editor's line through the same file-addressed
        // editQueuedFile pair the dashboard's Edit uses: the write targets the queue file
        // the row named, so a concurrent dequeue cannot land it on the wrong prompt. An
        // invalid (whitespace-only) line flashes and STAYS in the editor; a gone outcome
        // is the concurrent-dequeue race, flashed honestly and returned to the list; a
        // throw keeps the text in the editor for a retry.
        const parsed = parseRolePromptInput(input);
        if (!parsed.ok) {
          deps.flashMessage(parsed.error);
        } else {
          const target = queuedEditFor;
          try {
            const outcome = editQueuedFile(root, target.role, target.file, parsed.value);
            exitQueuedEdit();
            deps.refreshQueued();
            deps.flashMessage(
              outcome.status === "edited"
                ? `edited inbox message for ${target.role}`
                : "the inbox message was already gone",
            );
          } catch (err) {
            deps.flashError(err);
          }
        }
      } else {
        const prompt = input.trim();
        if (!prompt) {
          // Whitespace-only input queues nothing; drop it like an empty line.
          input = "";
          cursor = 0;
        } else {
          try {
            const pending = deferMs;
            submitPrompt(root, prompt, undefined, pending === null ? undefined : deps.now() + pending);
            promptHistory = pushPromptHistory(promptHistory, prompt);
            deferMs = null;
            input = "";
            cursor = 0;
            deps.flashMessage(
              pending === null
                ? "added to the director's inbox"
                : `added to the director's inbox — delivers in ${durationLabel(pending)}`,
            );
          } catch (err) {
            // The queue write failed (disk full, permissions): keep the operator's text so
            // it can be resubmitted, and flash the reason — the same contract the GUI's
            // prompt form honors. Clearing the line first would silently lose the prompt,
            // and an unguarded throw would escape the keypress handler and kill the TUI.
            deps.flashError(err);
          }
        }
      }
      return true;
    }
    return false;
  };

  const onArrow = (direction: "up" | "down"): boolean => {
    // Up/Down walk the submitted-prompt history the way readline does (tui-prompt-history.ts's
    // recall rules). The backlog pane keeps the arrows for entry browsing (its branch
    // above already returned), and budget and defer modes keep them out — recalling a
    // prompt into the cap or delay field would be a paste, not a recall. No history in
    // this direction: fall through to applyKey, which ignores arrows as before.
    if (!budgetMode && !deferMode && !pauseEditMode && !searchMode) {
      const recalled = recallPromptHistory(
        promptHistory,
        input,
        cursor,
        direction === "up" ? "older" : "newer",
      );
      if (recalled) {
        promptHistory = recalled.history;
        input = recalled.text;
        cursor = recalled.cursor;
        return true;
      }
    }
    return false;
  };

  const apply = (str: string | undefined, key: { ctrl?: boolean; name?: string }): void => {
    const next = applyKey(input, cursor, str, key);
    input = next.text;
    cursor = next.cursor;
  };

  // Leave every editor (Ctrl+T): view cycling is orthogonal to them, so a cycle never strands
  // an editor's pre-filled text in the prompt line. Each restores its own saved draft.
  const exitAll = (): void => {
    exitBudgetMode();
    exitRolePromptMode();
    exitDeferMode();
    exitPauseEditMode();
    exitHistorySearch();
    exitQueuedEdit();
    exitAnswerMode();
    exitEntryEdit();
  };

  const sync = (capUsd: number, budgetFree: boolean): void => {
    currentCapUsd = capUsd;
    currentBudgetFree = budgetFree;
  };

  return {
    handleKey,
    onArrow,
    apply,
    exitAll,
    sync,
    state(): TuiEditorState {
      return {
        input,
        cursor,
        budgetMode,
        rolePromptFor,
        deferMode,
        defer: deferMs === null ? null : durationLabel(deferMs),
        pauseEditMode,
        pauseEditRole,
        pauseEditWake,
        pauseEditStop,
        queuedEditFor,
        searchMode,
        answerFor,
        entryEditFor,
      };
    },
  };
}
