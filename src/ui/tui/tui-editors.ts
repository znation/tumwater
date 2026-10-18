// vocabulary: plain
import { submitPrompt } from "../../inbox/inbox-submit.js";
import { applyKey } from "./tui-input.js";
import { pushPromptHistory, recallPromptHistory } from "./tui-prompt-history.js";
import { createTuiEditorSession } from "./tui-editor-session.js";
import { createBudgetEditor } from "./tui-editor-budget.js";
import { createQuietEditor } from "./tui-editor-quiet.js";
import { createAttachEditor } from "./tui-editor-attach.js";
import { createNotesEditor } from "./tui-editor-notes.js";
import { createBriefEditor } from "./tui-editor-brief.js";
import { createRetireEditor } from "./tui-editor-retire.js";
import { createPromptEditor } from "./tui-editor-prompt.js";
import { createPauseEditor } from "./tui-editor-pause.js";
import { createQueuedEditor } from "./tui-editor-queued.js";
import { createAnswerEditor } from "./tui-editor-answer.js";
import { createEntryEditor } from "./tui-editor-entry.js";
import { createSearchEditor } from "./tui-editor-search.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { labeledBacklogEntries } from "./tui-backlog.js";

export type { TuiEditorCtx } from "./tui-editor-ctx.js";

/** The seams a prompt-line editor cannot own itself: the disk side effects the commit arms
 * trigger (submit, pause, edit, answer, budget), the pane-side results an editor returns to
 * (the flash notice, the refreshed queued/backlog selections, an applied search), and the
 * clock the pause editor reads. Everything here runs on the tui-keys.ts and
 * tui-panes.ts side of the boundary; the editor subsystem owns only the one prompt line and
 * the editors that share it. */
export interface TuiEditorsDeps {
  root: string;
  /** Injectable clock; the pause/stop editors compute now()+duration from it. */
  now(): number;
  /** The project-status pane's flat entry list (plans, then bugs, then questions), shared with
   * the render so answer/title-editor positions cannot drift. */
  flat(): ReturnType<typeof labeledBacklogEntries>;
  /** Re-read the Queued pane's rows and cached list after a commit/exit that touched the queue. */
  refreshQueued(): void;
  /** Repaint the notes view's cached notebook after a replace/clear write. */
  refreshNotes(role: string): void;
  /** Repaint the Brief view's cached body after a replace write. */
  refreshBrief(): void;
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

/** The state the render reads back for the prompt line: the shared line itself and the modes
 * it names in the hint line. The pane merges these into the frame. */
interface TuiEditorState {
  input: string;
  cursor: number;
  budgetMode: boolean;
  rolePromptFor: string | null;
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
  /** The Activity view's Ctrl+V image-attach mode holds the prompt line. */
  attachMode: boolean;
  /** The number of pending image attachments the next director prompt will carry. */
  images: number;
  /** The notes view's Ctrl+E replace-notes mode holds the prompt line: the role whose notes
   * the prompt line is replacing from a typed file path, or null when closed. */
  notesEditFor: string | null;
  /** The Brief view's Ctrl+E replace-the-brief mode holds the prompt line, editing one typed
   * file path that becomes the whole brief through editInitialPrompt. */
  briefEditMode: boolean;
  /** The Health view's Ctrl+X retire mode holds the prompt line, editing a role id. */
  retireMode: boolean;
  /** The Transcript view's Ctrl+O quiet-hours mode holds the prompt line. */
  quietMode: boolean;
}

/** The prompt-line editor subsystem `createTuiKeys` constructs: the aggregator that owns the
 * one shared prompt line (`input`/`cursor`), every modal editor's active flag and saved-draft
 * pair, and the session history — see createTuiEditors. */
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

/** The prompt-line editor half of the createTuiKeys closure: a thin aggregator that builds the
 * shared prompt-line session (tui-editor-session.ts) and the set of mutually-exclusive modal
 * editors on it — budget Ctrl+B, quiet-hours Ctrl+O, role-prompt Ctrl+R, pause
 * Ctrl+F/Ctrl+Q, answer, entry-edit, queued-edit, and the `/` search — each with its own
 * saved-draft pair and exit
 * helper in its own module beside the session. `handleKey` routes each key to the editors in
 * today's priority order (each module returns true when it consumed the key and false to fall
 * through, so the mutually-exclusive/busy-guard ordering is preserved exactly); the session's
 * `held` registry and `heldEditorFlash` hold the exclusive-line invariants once, at the module
 * boundary, instead of being re-stated per editor. The disk/commit responsibilities and the pane
 * state stay on the tui-keys.ts and tui-panes.ts side; this factory receives them as deps and
 * the per-keypress pane reads as ctx. */
export function createTuiEditors(deps: TuiEditorsDeps): TuiEditors {
  const session = createTuiEditorSession(deps);
  const editors: TuiEditorModule[] = [
    createBudgetEditor(session),
    createQuietEditor(session),
    createAttachEditor(session),
    createNotesEditor(session),
    createPauseEditor(session),
    createPromptEditor(session),
    createQueuedEditor(session),
    createAnswerEditor(session),
    createEntryEditor(session),
    createSearchEditor(session),
    createBriefEditor(session),
    createRetireEditor(session),
  ];

  const handleKey = (
    str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    // Route the key to each editor in today's priority order; each module returns true when it
    // consumed the key (the mutually-exclusive/busy-guard ordering is preserved exactly) and
    // false to fall through to the next.
    for (const editor of editors) {
      if (editor.handleKey(str, key, ctx)) return true;
    }
    // The Enter key submits the director prompt when no modal editor holds the line — the
    // shared/none case of the Enter arm. Only reached when the key was "return" and no editor
    // consumed it; any other unhandled key falls through to the pane arms.
    if (key.name === "return") {
      const prompt = session.input.trim();
      if (!prompt) {
        // Whitespace-only input queues nothing; drop it like an empty line.
        session.input = "";
        session.cursor = 0;
      } else {
        const images = session.images.length > 0 ? session.images : undefined;
        try {
          submitPrompt(session.root, prompt, images);
          session.promptHistory = pushPromptHistory(session.promptHistory, prompt);
          // A successful send consumes the pending image attachments; a thrown submit below
          // keeps them so the operator can resubmit with the images still attached.
          session.images = [];
          session.input = "";
          session.cursor = 0;
          session.flashMessage("added to the director's inbox");
        } catch (err) {
          // The queue write failed (disk full, permissions): keep the operator's text so
          // it can be resubmitted, and flash the reason — the same contract the GUI's
          // prompt form honors. Clearing the line first would silently lose the prompt,
          // and an unguarded throw would escape the keypress handler and kill the TUI.
          session.flashError(err);
        }
      }
      return true;
    }
    return false;
  };

  const onArrow = (direction: "up" | "down"): boolean => {
    // Up/Down walk the submitted-prompt history the way readline does (tui-prompt-history.ts's
    // recall rules). The backlog pane keeps the arrows for entry browsing (its branch
    // above already returned), and budget, pause and search modes keep them out —
    // recalling a prompt into the cap/field text would be a paste, not a recall. No
    // history in this direction: fall through to applyKey, which ignores arrows as before.
    if (!session.held.budget && !session.held.quiet && !session.held.attach && !session.held.pause && !session.held.search && !session.held.notes && !session.held.brief && !session.held.retire) {
      const recalled = recallPromptHistory(
        session.promptHistory,
        session.input,
        session.cursor,
        direction === "up" ? "older" : "newer",
      );
      if (recalled) {
        session.promptHistory = recalled.history;
        session.input = recalled.text;
        session.cursor = recalled.cursor;
        return true;
      }
    }
    return false;
  };

  const apply = (str: string | undefined, key: { ctrl?: boolean; name?: string }): void => {
    const next = applyKey(session.input, session.cursor, str, key);
    session.input = next.text;
    session.cursor = next.cursor;
  };

  // Leave every editor (Ctrl+T): view cycling is orthogonal to them, so a cycle never strands
  // an editor's pre-filled text in the prompt line. Each restores its own saved draft.
  const exitAll = (): void => {
    for (const editor of editors) editor.exit();
  };

  const sync = (capUsd: number, budgetFree: boolean): void => {
    // Only the budget editor reads the snapshot-fed cap/free flags.
    editors.forEach((editor) => editor.sync?.(capUsd, budgetFree));
  };

  return {
    handleKey,
    onArrow,
    apply,
    exitAll,
    sync,
    state(): TuiEditorState {
      return {
        input: session.input,
        cursor: session.cursor,
        budgetMode: session.held.budget,
        rolePromptFor: session.held.rolePromptFor,
        pauseEditMode: session.held.pause,
        pauseEditRole: session.held.pauseEditRole,
        pauseEditWake: session.held.pauseEditWake,
        pauseEditStop: session.held.pauseEditStop,
        queuedEditFor: session.held.queued,
        searchMode: session.held.search,
        answerFor: session.held.answer,
        entryEditFor: session.held.entry,
        attachMode: session.held.attach,
        images: session.images.length,
        notesEditFor: session.held.notes,
        briefEditMode: session.held.brief,
        retireMode: session.held.retire,
        quietMode: session.held.quiet,
      };
    },
  };
}
