// vocabulary: plain
import {
  newPromptHistory,
  resetPromptRecall,
  settlePromptRecall,
  type PromptHistory,
} from "./tui-prompt-history.js";
import type { PromptImageInput } from "../../inbox/inbox-attachments.js";
import type { TuiEditorsDeps } from "./tui-editors.js";
import type { labeledBacklogEntries } from "./tui-backlog.js";

/** Which modal editor currently holds the shared prompt line, mirrored by each editor module as
 * its mode changes. The editors are mutually exclusive — at most one owns the line — so at most
 * one of these is truthy at a time. The modules read the flags of the OTHER editors through this
 * object to apply their entry guards (a mode may not enter while another holds the line), and
 * write their own flag as they enter and leave. */
interface TuiHeld {
  /** Ctrl+B budget-edit mode. */
  budget: boolean;
  /** Ctrl+R per-role prompt mode: the viewed loop's role id, or null when closed. */
  rolePromptFor: string | null;
  /** The shared `/` search editor is open. */
  search: boolean;
  /** Ctrl+F/Ctrl+Q/Ctrl+P/Ctrl+W pause/stop/wake editor is open. */
  pause: boolean;
  /** The loop the pause editor pauses, null for the team editors (Ctrl+F/Ctrl+Q). */
  pauseEditRole: string | null;
  /** The per-loop editor schedules a wake (Ctrl+W) rather than a pause (Ctrl+P). */
  pauseEditWake: boolean;
  /** The team editor schedules a stop (Ctrl+Q) rather than a pause (Ctrl+F). */
  pauseEditStop: boolean;
  /** The Queued pane's in-place editor (Ctrl+E): the row's role and queue-file basename. */
  queued: { role: string; file: string } | null;
  /** The backlog pane's answer editor (Ctrl+A on a selected open question). */
  answer: { position: number; title: string } | null;
  /** The backlog pane's title editor (Ctrl+E on a selected plan or bug), a null position being
   * the new-entry form (Ctrl+N). */
  entry: { kind: "plan" | "bug"; position: number | null; title: string } | null;
  /** The Activity view's Ctrl+V image-attach mode on the prompt line. */
  attach: boolean;
  /** The notes view's Ctrl+E replace-notes editor: the role whose notes the prompt line
   * is replacing from a typed file path, or null when closed. */
  notes: string | null;
  /** The Brief view's Ctrl+E replace-the-brief editor holds the prompt line. */
  brief: boolean;
  /** The Health view's Ctrl+X retire editor holds the prompt line, editing a role id. */
  retire: boolean;
  /** The Transcript view's Ctrl+O quiet-hours editor holds the prompt line. */
  quiet: boolean;
  /** Whether the open quiet editor is editing the team-wide `quietHours` window (Ctrl+S on the
   * Activity view) rather than a role's own `quietHoursPerRole.<base>` window (Ctrl+O). Only
   * meaningful while `quiet` is true. */
  quietTeam: boolean;
  /** The Transcript view's Ctrl+S min-run-interval editor holds the prompt line. */
  interval: boolean;
  /** The Transcript view's Ctrl+L replace-standing-instructions editor: the role whose
   * `roles.<base>.instructions` override the prompt line is replacing from a typed file path,
   * or null when closed. */
  instructions: string | null;
  /** The Activity view's Ctrl+P provider-concurrency-caps editor holds the prompt line. */
  providerCaps: boolean;
  /** The Activity view's Ctrl+N run-cap (`maxConcurrent`) editor holds the prompt line. */
  concurrency: boolean;
}

/** The shared mutable prompt-line session every per-editor module takes (plus the per-key
 * `TuiEditorCtx`) instead of the whole `TuiEditorsDeps`: the one prompt line (`input`/`cursor`),
 * the session history, the mutually-exclusive-mode registry, the
 * shared deps the modules call, and the shared helpers whose invariants hold here once — at the
 * module boundary — rather than being re-stated per editor. */
export interface TuiEditorSession {
  /** The shared prompt-line text (the live draft a given editor is editing). */
  input: string;
  /** The shared prompt-line caret position. */
  cursor: number;
  /** The prompt line's session history (tui-prompt-history.ts's rules). */
  promptHistory: PromptHistory;
  /** The pending image attachments the next director prompt will carry (Ctrl+V on the Activity
   * view's prompt line). This is submit-time state the director submit reads, so it lives in the
   * session. */
  images: PromptImageInput[];
  /** The mutually-exclusive editor modes, mirrored here as they change (see TuiHeld). */
  held: TuiHeld;
  root: string;
  /** Injectable clock; the pause/stop editors compute now()+duration from it. */
  now(): number;
  /** The project-status pane's flat entry list (plans, then bugs, then questions), shared so
   * answer/title-editor positions cannot drift. */
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
  /** Apply a finished History search on the pane. */
  applyHistorySearch(pattern: string | null): void;
  /** Apply a finished Activity search on the pane. */
  applyActivitySearch(pattern: string | null): void;
  /** Apply a finished Backlog search on the pane. */
  applyBacklogSearch(pattern: string | null): void;
  /** Flash a one-line notice on the prompt line. */
  flashMessage(message: string): void;
  /** Flash a caught failure as `error: <message>`. */
  flashError(err: unknown): void;
  /** Commit an operator's backlog edit to main and flash when the commit did not land. */
  commitBacklogEdit(file: string, subject: string): void;
  /** Restore the prompt line's saved draft and reset its recall state — the shared tail of every
   * editor's exit. */
  restorePromptFrom(text: string, pos: number): void;
  /** Hand the recall line's current draft back into a caller's editor save slot and reset the
   * recall state — the shared preamble of every editor that takes the prompt line. */
  settleDraft(saveInput: (text: string) => void, saveCursor: (pos: number) => void): void;
  /** The one-line editor's busy-guard wording. */
  busyFlash(subject: string): string;
  /** Which editor currently holds the shared prompt line as the busy-guard flash label, or null
   * when none does. `entering` names the editor about to take the line and is excluded: pressing
   * its own key while it already holds the line must toggle/exit it, not flash the way out. */
  heldEditorFlash(entering: "budget" | "attach" | "notes" | "brief" | "retire" | "quiet" | "interval" | "instructions" | "providerCaps" | "concurrency"): string | null;
}

/** Build the shared prompt-line session from the disk-side deps the aggregator received. The
 * editor modules then take this session plus each keypress's `TuiEditorCtx`. */
export function createTuiEditorSession(deps: TuiEditorsDeps): TuiEditorSession {
  const session: TuiEditorSession = {
    input: "",
    cursor: 0,
    promptHistory: newPromptHistory(),
    images: [],
    held: {
      budget: false,
      rolePromptFor: null,
      search: false,
      pause: false,
      pauseEditRole: null,
      pauseEditWake: false,
      pauseEditStop: false,
      queued: null,
      answer: null,
      entry: null,
      attach: false,
      notes: null,
      brief: false,
      retire: false,
      quiet: false,
      quietTeam: false,
      interval: false,
      instructions: null,
      providerCaps: false,
      concurrency: false,
    },
    root: deps.root,
    now: deps.now,
    flat: deps.flat,
    refreshQueued: deps.refreshQueued,
    refreshNotes: deps.refreshNotes,
    refreshBrief: deps.refreshBrief,
    clearBacklogSelection: deps.clearBacklogSelection,
    applyHistorySearch: deps.applyHistorySearch,
    applyActivitySearch: deps.applyActivitySearch,
    applyBacklogSearch: deps.applyBacklogSearch,
    flashMessage: deps.flashMessage,
    flashError: deps.flashError,
    commitBacklogEdit: deps.commitBacklogEdit,
    restorePromptFrom(text, pos) {
      session.input = text;
      session.cursor = pos;
      session.promptHistory = resetPromptRecall(session.promptHistory);
    },
    settleDraft(saveInput, saveCursor) {
      const settled = settlePromptRecall(session.promptHistory, session.input, session.cursor);
      session.promptHistory = settled.history;
      saveInput(settled.text);
      saveCursor(settled.cursor);
    },
    busyFlash(subject) {
      return `finish or cancel the ${subject} first (Esc cancels)`;
    },
    heldEditorFlash(entering) {
      const h = session.held;
      if (h.search) return session.busyFlash("search");
      if (h.pause) return session.busyFlash("pause");
      if (h.queued) return session.busyFlash("inbox edit");
      if (h.answer) return session.busyFlash("answer");
      if (h.entry) return session.busyFlash("entry edit");
      if (h.rolePromptFor) return session.busyFlash(`prompt for ${h.rolePromptFor}`);
      if (h.attach && entering !== "attach") return session.busyFlash("image attach");
      if (h.notes && entering !== "notes") return session.busyFlash("notes edit");
      if (h.brief && entering !== "brief") return session.busyFlash("brief edit");
      if (h.retire && entering !== "retire") return session.busyFlash("retire role");
      if (h.quiet && entering !== "quiet") return session.busyFlash("quiet hours");
      if (h.interval && entering !== "interval") return session.busyFlash("min run interval");
      if (h.instructions && entering !== "instructions") return session.busyFlash("instructions edit");
      if (h.providerCaps && entering !== "providerCaps") return session.busyFlash("provider caps");
      if (h.concurrency && entering !== "concurrency") return session.busyFlash("run cap edit");
      if (entering === "attach" && h.budget) return session.busyFlash("budget edit");
      if (entering === "notes" && (h.attach || h.budget)) return session.busyFlash(h.attach ? "image attach" : "budget edit");
      if (entering === "brief" && h.budget) return session.busyFlash("budget edit");
      if (entering === "retire" && (h.attach || h.notes || h.budget)) return session.busyFlash(h.attach ? "image attach" : h.notes ? "notes edit" : "budget edit");
      if (entering === "quiet" && (h.attach || h.notes || h.budget || h.brief || h.retire)) return session.busyFlash(h.attach ? "image attach" : h.notes ? "notes edit" : h.brief ? "brief edit" : h.retire ? "retire role" : "budget edit");
      if (entering === "interval" && (h.attach || h.notes || h.budget || h.brief || h.retire || h.quiet)) return session.busyFlash(h.attach ? "image attach" : h.notes ? "notes edit" : h.brief ? "brief edit" : h.retire ? "retire role" : h.quiet ? "quiet hours" : "budget edit");
      if (entering === "instructions" && (h.attach || h.notes || h.budget || h.brief || h.retire || h.quiet || h.interval)) return session.busyFlash(h.attach ? "image attach" : h.notes ? "notes edit" : h.brief ? "brief edit" : h.retire ? "retire role" : h.quiet ? "quiet hours" : h.interval ? "min run interval" : "budget edit");
      if (entering === "providerCaps" && (h.attach || h.notes || h.budget || h.brief || h.retire || h.quiet || h.interval || h.instructions)) return session.busyFlash(h.attach ? "image attach" : h.notes ? "notes edit" : h.brief ? "brief edit" : h.retire ? "retire role" : h.quiet ? "quiet hours" : h.interval ? "min run interval" : h.instructions ? "instructions edit" : "budget edit");
      if (entering === "concurrency" && (h.attach || h.notes || h.budget || h.brief || h.retire || h.quiet || h.interval || h.instructions)) return session.busyFlash(h.attach ? "image attach" : h.notes ? "notes edit" : h.budget ? "budget edit" : h.brief ? "brief edit" : h.retire ? "retire role" : h.quiet ? "quiet hours" : h.interval ? "min run interval" : "instructions edit");
      return null;
    },
  };
  return session;
}
