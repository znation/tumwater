// vocabulary: plain
import { bodyStructureProblem, fileEntryWithBody, OPERATOR_FILE_KINDS, splitEntryFile, tryEditEntry } from "../../backlog/backlog-write.js";
import { backlogHolds, stillHeldNote } from "../../backlog/backlog-eligibility.js";
import { stripEntryStamp } from "../../backlog/backlog-structure.js";
import { readTextIfExists } from "../../files/files.js";
import { submitRolePromptAndWake } from "../../operator/operator-intent.js";
import { promptLengthProblem } from "../../inbox/inbox-submit.js";
import { collapseWhitespace } from "../../text/text.js";
import { selectedEditableEntry } from "./tui-pane-backlog.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The backlog pane's title editor (Ctrl+N new entry, Ctrl+E on a selected plan or bug) on the
 * shared prompt line. It owns its target (`entryEditFor`), its plan↔bug flip, its saved-draft
 * pair, its exit helper, and the fileEntryWithBody / tryEditEntry / commit arms, plus the
 * position math that counts `plan`/`bug` labels. Mutually exclusive with the other editors via
 * the session's held registry. */
export function createEntryEditor(session: TuiEditorSession): TuiEditorModule {
  let entryEditFor: { kind: "plan" | "bug"; position: number | null; title: string } | null = null;
  let restoreDraft: () => void = () => {};
  // The triple state of the entry editor's prompt line: false (the title field), true (the
  // file-path field whose contents replace the whole entry), and the draft the toggle parks
  // when it hands the line to a different field.
  let entryBodyFile = false;
  let entryBodySavedInput = "";
  let entryBodySavedCursor = 0;

  // Leave the backlog pane's title editor (Esc, a saved edit, or Ctrl+T): the same settle
  // contract as exitAnswerMode. Any open file mode is dropped too, so the editor always lands
  // back in the title state on the next Ctrl+E.
  const exitEntryEdit = (): void => {
    if (!entryEditFor) return;
    entryEditFor = null;
    entryBodyFile = false;
    session.held.entry = null;
    restoreDraft();
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
      // already holding the line) is the notes/change/trail cycle, a pane arm the outer
      // dispatch handles — this factory returns false so it runs.
      if (
        ctx.view === ctx.roleIds.length + 1 &&
        !session.anyEditorHeld()
      ) {
        restoreDraft = session.takeDraft();
        entryEditFor = { kind: "plan", position: null, title: "" };
        session.held.entry = entryEditFor;
        session.input = "";
        session.cursor = 0;
        session.flashMessage("new plan — Enter to file, Ctrl+N switches to bug, Esc cancels");
        return true;
      }
      return false;
    }
    if (key.ctrl && key.name === "e" && entryEditFor !== null && entryEditFor.position !== null) {
      // A second Ctrl+E inside the entry editor toggles the same prompt line into the file
      // field, whose path's contents replace the whole entry (splitEntryFile's rule) through
      // tryEditEntry — the terminal twin of `tumwater plan|bug --edit <n> --file <path>`. A
      // third Ctrl+E returns to the title draft, parked in the saved pair; Esc cancels all.
      entryBodyFile = !entryBodyFile;
      if (entryBodyFile) {
        entryBodySavedInput = session.input;
        entryBodySavedCursor = session.cursor;
        session.input = "";
        session.cursor = 0;
        session.flashMessage(`replace ${entryEditFor.kind} #${entryEditFor.position} from a file — Enter to save, Ctrl+E back to the title, Esc cancels`);
      } else {
        session.input = entryBodySavedInput;
        session.cursor = entryBodySavedCursor;
        session.flashMessage(`editing ${entryEditFor.kind} #${entryEditFor.position} title — Enter to save, Ctrl+E to replace from a file, Esc cancels`);
      }
      return true;
    }
    if (
      key.ctrl && key.name === "e" &&
      !session.anyEditorHeld() &&
      ctx.view === ctx.roleIds.length + 1 && ctx.selectedEntry !== null
    ) {
      // Ctrl+E opens the title editor on the selected plan or bug (mnemonic: **E**dit); Enter
      // saves through tryEditEntry, the non-exiting core the dashboard drawer shares, keeping
      // the body and stamp. The prompt line is single-line, so only the title is editable here.
      try {
        const selected = selectedEditableEntry(session, ctx.selectedEntry, "edited");
        if (selected !== null) {
          const kind = selected.kind;
          const position = selected.position;
          restoreDraft = session.takeDraft();
          entryEditFor = { kind, position, title: selected.picked.title };
          session.held.entry = entryEditFor;
          session.input = stripEntryStamp(selected.picked.title);
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
      // Shared tail of the title and file edit arms: re-read the entry by flat index and
      // title, guard against a concurrent move (so a mismatch is treated as moved, not
      // written), then settle the editor and commit through tryEditEntry. The only thing
      // the two arms pass differently is the (title, body) pair taking the entry's place;
      // an omitted body preserves the matched entry's own body (the title edit arm).
      const applyEntryEdit = (newTitle: string, newBody?: string): void => {
        try {
          // Both call sites (the file arm's and the title arm's Entry-save paths) run only
          // when `target.position` is non-null, so the position math never sees a null.
          const position = target.position!;
          const entries = session.flat();
          const plans = entries.filter((e) => e.label === "plan").length;
          const entry = entries[target.kind === "plan" ? position - 1 : plans + position - 1];
          const outcome =
            entry?.label === target.kind && entry.title === target.title
              ? tryEditEntry(session.root, target.kind, position, target.title, newTitle, newBody ?? entry.body)
              : ({ status: "moved", title: "" } as const);
          exitEntryEdit();
          if (outcome.status === "edited") {
            session.commitBacklogEdit(outcome.file, `Edit ${target.kind}: ${outcome.title}`);
            const holds = backlogHolds(session.root);
            const hold = (target.kind === "bug" ? holds.bugs : holds.plans)[position - 1] ?? null;
            session.flashMessage(`edited ${target.kind} #${target.position}: ${outcome.title}${hold === null ? "" : ` — ${stillHeldNote(hold)}`}`);
          } else if (outcome.status === "unchanged") {
            session.flashMessage(`unchanged ${target.kind} #${target.position}: ${outcome.title}`);
          } else {
            session.clearBacklogSelection();
            session.flashMessage(`that ${target.kind} was already removed or moved — nothing edited`);
          }
        } catch (err) {
          session.flashError(err);
        }
      };

      // File mode: the line holds a path whose contents replace title and body through the
      // same title-checked tryEditEntry core the title edit uses, keeping the entry's
      // position and its (planned …)/(found by …) stamp. A missing file, an empty path, a
      // file with no title line, and a structurally unsound body all flash and stay here.
      if (entryBodyFile && target.position !== null) {
        const p = session.input.trim();
        if (!p) {
          session.flashMessage("a file path is required");
          return true;
        }
        let text: string | null;
        try {
          text = readTextIfExists(p);
        } catch (err) {
          session.flashError(err);
          return true;
        }
        if (text === null) {
          session.flashMessage(`no such file: ${p}`);
          return true;
        }
        const { title: rawTitle, body } = splitEntryFile(text);
        const newTitle = stripEntryStamp(rawTitle);
        if (!newTitle) {
          session.flashMessage("the file needs a title line");
          return true;
        }
        const problem = bodyStructureProblem(body);
        if (problem !== null) {
          session.flashMessage(problem);
          return true;
        }
        applyEntryEdit(newTitle, body);
        return true;
      }

      if (!session.input.trim()) {
        session.flashMessage("an entry needs a title");
        return true;
      }

      if (target.position === null) {
        // New entry (Ctrl+N): file by title with an empty body and wake its role, the same
        // steps handleBacklogFile takes; a length problem or a throw stays in the editor.
        try {
          const { role, wakeText } = OPERATOR_FILE_KINDS[target.kind];
          const problem = promptLengthProblem(wakeText(collapseWhitespace(session.input)), role);
          if (problem) {
            session.flashMessage(problem);
            return true;
          }
          const filed = fileEntryWithBody(session.root, target.kind, session.input, "");
          session.commitBacklogEdit(filed.file, `File ${target.kind}: ${filed.title}`);
          submitRolePromptAndWake(session.root, role, wakeText(filed.title));
          exitEntryEdit();
          session.flashMessage(`filed ${target.kind}: ${filed.title} — woke ${role}`);
        } catch (err) {
          session.flashError(err);
        }
        return true;
      }

      applyEntryEdit(session.input);
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitEntryEdit };
}
