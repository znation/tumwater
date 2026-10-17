// vocabulary: plain
import {
  questionAsker,
  tryAnswerQuestion,
  UNCLOSED_FENCE_MESSAGE,
} from "../../backlog/question-answer.js";
import { wakeQuestionAsker } from "../../operator/operator-intent.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The backlog pane's answer editor (Ctrl+A on a selected open question) on the shared prompt
 * line. It owns its target (`answerFor`), its saved-draft pair, its exit helper, and the
 * tryAnswerQuestion / wake arms that record the decision. Mutually exclusive with the other
 * editors via the session's held registry. */
export function createAnswerEditor(session: TuiEditorSession): TuiEditorModule {
  let answerFor: { position: number; title: string } | null = null;
  let answerSavedInput = "";
  let answerSavedCursor = 0;

  // Leave the backlog pane's answer editor (Esc, a recorded answer, or Ctrl+T): restore the
  // saved prompt text and reset the recall state, mirroring exitQueuedEdit.
  const exitAnswerMode = (): void => {
    if (!answerFor) return;
    answerFor = null;
    session.held.answer = null;
    session.restorePromptFrom(answerSavedInput, answerSavedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (
      key.ctrl && key.name === "a" &&
      !session.held.budget && !session.held.rolePromptFor && !session.held.search &&
      !session.held.defer && !session.held.pause && !session.held.queued &&
      !session.held.answer && !session.held.entry &&
      ctx.view === ctx.roleIds.length + 1 && ctx.selectedEntry !== null
    ) {
      // Ctrl+A opens the answer editor on the selected open question (mnemonic: **A**nswer);
      // Enter records the decision through tryAnswerQuestion, the core `tumwater questions
      // answer` and the dashboard's form share. The position is the question's 1-based index
      // among the open questions: the browsable list puts plans, then bugs, then questions first.
      try {
        const entries = session.flat();
        const sel = Math.min(ctx.selectedEntry, entries.length - 1);
        const entry = entries[sel];
        if (entry?.label !== "question") {
          session.flashMessage("only an open question can be answered here");
        } else {
          const position = sel - entries.filter((e) => e.label === "plan" || e.label === "bug").length + 1;
          session.settleDraft((t) => (answerSavedInput = t), (n) => (answerSavedCursor = n));
          answerFor = { position, title: entry.title };
          session.held.answer = answerFor;
          session.input = "";
          session.cursor = 0;
          session.flashMessage(`answering question #${position} — Enter to record, Esc to cancel`);
        }
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    if (key.name === "escape" && answerFor) {
      // Esc cancels the answer editor, restoring the previous prompt text; nothing is written.
      exitAnswerMode();
      session.flashMessage("answer cancelled");
      return true;
    }
    if (key.name === "return" && answerFor) {
      // Enter records the answer through tryAnswerQuestion, titled so a question that moved
      // since Ctrl+A is refused. A whitespace-only line, an unclosed fence, and a throw all
      // flash and STAY in the editor so the text survives; answered and missing/moved both
      // leave the editor and return the pane to list mode (the entry left the list).
      const target = answerFor;
      if (!session.input.trim()) {
        session.flashMessage("questions answer needs a decision");
      } else {
        try {
          const outcome = tryAnswerQuestion(session.root, target.position, session.input, target.title);
          if (outcome.status === "fenced") {
            session.flashMessage(UNCLOSED_FENCE_MESSAGE);
          } else {
            let woke = "";
            if (outcome.status === "answered") {
              session.commitBacklogEdit("QUESTIONS.md", `Answer question: ${outcome.title}`);
              if (wakeQuestionAsker(session.root, outcome.title) !== null) woke = ` · woke ${questionAsker(outcome.title)}`;
            }
            exitAnswerMode();
            session.clearBacklogSelection();
            session.flashMessage(
              outcome.status === "answered"
                ? `answered question #${target.position}: ${outcome.title}${woke}`
                : "that question was already answered or moved — nothing recorded",
            );
          }
        } catch (err) {
          session.flashError(err);
        }
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitAnswerMode };
}
