// vocabulary: plain
import { fileEntryWithBody, OPERATOR_FILE_KINDS, tryEditEntry } from "../../backlog/backlog-write.js";
import { stripEntryStamp } from "../../backlog/backlog-structure.js";
import { submitRolePromptAndWake } from "../../operator/operator-intent.js";
import { promptLengthProblem } from "../../inbox/inbox-submit.js";
import { collapseWhitespace } from "../../text/text.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The backlog pane's title editor (Ctrl+N new entry, Ctrl+E on a selected plan or bug) on the
 * shared prompt line. It owns its target (`entryEditFor`), its plan↔bug flip, its saved-draft
 * pair, its exit helper, and the fileEntryWithBody / tryEditEntry / commit arms, plus the
 * position math that counts `plan`/`bug` labels. Mutually exclusive with the other editors via
 * the session's held registry. */
export function createEntryEditor(session: TuiEditorSession): TuiEditorModule {
  let entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null = null;
  let entryEditSavedInput = "";
  let entryEditSavedCursor = 0;

  // Leave the backlog pane's title editor (Esc, a saved edit, or Ctrl+T): the same settle
  // contract as exitAnswerMode.
  const exitEntryEdit = (): void => {
    if (!entryEditFor) return;
    entryEditFor = null;
    session.held.entry = null;
    session.restorePromptFrom(entryEditSavedInput, entryEditSavedCursor);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "n") {
      // On the Backlog view Ctrl+N files a new entry: it opens the title editor with a null
      // position (new plan), and pressed again inside that editor flips plan <-> bug.
      if (entryEditFor !== null && entryEditFor.position === null) {
        const other = entryEditFor.kind === "plan" ? "bug" : "plan";
        entryEditFor = { ...entryEditFor, kind: other };
        session.held.entry = entryEditFor;
        session.flashMessage(`new ${other} — Enter to file, Ctrl+N switches to ${other === "plan" ? "bug" : "plan"}, Esc cancels`);
        return true;
      }
      // A Ctrl+N on any other state (not the Backlog view's new-entry slot, or an editor
      // already holding the line) is the notebook/change/trail cycle, a pane arm the outer
      // dispatch handles — this factory returns false so it runs.
      if (
        ctx.view === ctx.roleIds.length + 1 &&
        !session.held.budget && !session.held.rolePromptFor && !session.held.search &&
        !session.held.defer && !session.held.pause && !session.held.queued &&
        !session.held.answer && !entryEditFor
      ) {
        session.settleDraft((t) => (entryEditSavedInput = t), (n) => (entryEditSavedCursor = n));
        entryEditFor = { kind: "plan", position: null, title: "" };
        session.held.entry = entryEditFor;
        session.input = "";
        session.cursor = 0;
        session.flashMessage("new plan — Enter to file, Ctrl+N switches to bug, Esc cancels");
        return true;
      }
      return false;
    }
    if (
      key.ctrl && key.name === "e" &&
      !session.held.budget && !session.held.rolePromptFor && !session.held.search &&
      !session.held.defer && !session.held.pause && !session.held.queued &&
      !session.held.answer && !entryEditFor &&
      ctx.view === ctx.roleIds.length + 1 && ctx.selectedEntry !== null
    ) {
      // Ctrl+E opens the title editor on the selected plan or bug (mnemonic: **E**dit); Enter
      // saves through tryEditEntry, the non-exiting core the dashboard drawer shares, keeping
      // the body and stamp. The prompt line is single-line, so only the title is editable here.
      try {
        const entries = session.flat();
        const sel = Math.min(ctx.selectedEntry, entries.length - 1);
        const picked = entries[sel];
        if (picked === undefined) {
          // an emptied list has nothing to edit
        } else if (picked.label === "done" || picked.label === "fixed" || picked.label === "answered") {
          session.flashMessage("a done plan, fixed bug or answered question is read-only");
        } else if (picked.label === "question") {
          session.flashMessage("only a plan or open bug can be edited here");
        } else {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
          session.settleDraft((t) => (entryEditSavedInput = t), (n) => (entryEditSavedCursor = n));
          entryEditFor = { kind, position, title: picked.title };
          session.held.entry = entryEditFor;
          session.input = stripEntryStamp(picked.title);
          session.cursor = session.input.length;
          session.flashMessage(`editing ${kind} #${position} — Enter to save, Esc to cancel`);
        }
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    if (key.name === "escape" && entryEditFor) {
      // Esc cancels the title editor, restoring the previous prompt text; nothing is written.
      const filing = entryEditFor.position === null;
      exitEntryEdit();
      session.flashMessage(filing ? "new entry cancelled" : "edit cancelled");
      return true;
    }
    if (key.name === "return" && entryEditFor) {
      // Enter saves the new title through tryEditEntry with the body re-read now, so a
      // concurrent body edit is not clobbered by a stale copy. The entry is matched by flat
      // index and title; a mismatch is treated as moved without writing. A blank title and a
      // throw flash and STAY in the editor so the text survives.
      const target = entryEditFor;
      if (!session.input.trim()) {
        session.flashMessage("an entry needs a title");
      } else if (target.position === null) {
        // New entry (Ctrl+N): file by title with an empty body and wake its loop, the same
        // steps handleBacklogFile takes; a length problem or a throw stays in the editor.
        try {
          const { role, wakeText } = OPERATOR_FILE_KINDS[target.kind];
          const problem = promptLengthProblem(wakeText(collapseWhitespace(session.input)), role);
          if (problem) {
            session.flashMessage(problem);
          } else {
            const filed = fileEntryWithBody(session.root, target.kind, session.input, "");
            session.commitBacklogEdit(filed.file, `File ${target.kind}: ${filed.title}`);
            submitRolePromptAndWake(session.root, role, wakeText(filed.title));
            exitEntryEdit();
            session.flashMessage(`filed ${target.kind}: ${filed.title} — woke ${role}`);
          }
        } catch (err) {
          session.flashError(err);
        }
      } else {
        try {
          const entries = session.flat();
          const plans = entries.filter((e) => e.label === "plan").length;
          const entry = entries[target.kind === "plan" ? target.position - 1 : plans + target.position - 1];
          const outcome =
            entry?.label === target.kind && entry.title === target.title
              ? tryEditEntry(session.root, target.kind, target.position, target.title, session.input, entry.body)
              : ({ status: "moved", title: "" } as const);
          exitEntryEdit();
          if (outcome.status === "edited") {
            session.commitBacklogEdit(outcome.file, `Edit ${target.kind}: ${outcome.title}`);
            session.flashMessage(`edited ${target.kind} #${target.position}: ${outcome.title}`);
          } else {
            session.clearBacklogSelection();
            session.flashMessage(`that ${target.kind} was already removed or moved — nothing edited`);
          }
        } catch (err) {
          session.flashError(err);
        }
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitEntryEdit };
}
