import { editQueuedFile, readQueuedPromptBody } from "../../inbox/inbox-edit.js";
import { parseRolePromptInput } from "./tui-input.js";
import { guardError } from "./tui-guard.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { savedPromptDraft, type TuiEditorSession } from "./tui-editor-session.js";

/** The Queued pane's in-place row editor (Ctrl+E) on the shared prompt line. It owns its target
 * (`queuedEditFor`), its saved-draft pair, its exit helper, and the readQueuedPromptBody /
 * editQueuedFile leaves that pre-fill the line and write it back. Mutually exclusive with the
 * other editors via the session's held registry. */
export function createQueuedEditor(session: TuiEditorSession): TuiEditorModule {
  let queuedEditFor: { role: string; file: string } | null = null;
  const draft = savedPromptDraft(session);


  // Leave the Queued pane's in-place editor (Esc, a saved edit, or Ctrl+T): restore the saved
  // prompt text, and reset the recall state with it — the same settle contract the other
  // editors honor.
  const exitQueuedEdit = (): void => {
    if (!queuedEditFor) return;
    queuedEditFor = null;
    session.held.queued = null;
    draft.restore();
  };

  // Ctrl+E opens the Queued pane's in-place editor on the selected row (mnemonic:
  // **E**dit) through the same readQueuedPromptBody/editQueuedFile pair the dashboard's
  // Edit uses: the body is pre-filled marker- and attachment-stripped, and Enter writes
  // it back to the same queue file, so its position, enqueue stamp, deferral, and
  // attached images survive. A row that vanished between selection and this press (the
  // role dequeued it, or another operator cancelled it) flashes the gone notice and
  // refreshes the list. A no-selection press (list mode) falls through to the report
  // window below, exactly as before.
  const queuedOpenEdit = (ctx: TuiEditorCtx): boolean => {
    if (
      session.anyEditorHeld() ||
      ctx.view !== ctx.roleIds.length + 6 ||
      ctx.selectedQueued === null
    ) {
      return false;
    }
    const selected = ctx.selectedQueued; // narrowed to number by the guard above
    guardError(session, () => {
      const position = Math.min(selected, ctx.queuedRows.length - 1);
      const row = ctx.queuedRows[position];
      if (row !== undefined) {
        const body = readQueuedPromptBody(session.root, row.role, row.file);
        if (body === null) {
          session.flashMessage(`inbox message #${row.position} for ${row.role} is gone`);
          session.refreshQueued();
        } else {
          // Mid-recall, the line holds a history entry while the real draft sits in the
          // recall state: settle first, so the queued editor saves (and later restores)
          // the draft the operator was writing.
          draft.save();
          queuedEditFor = { role: row.role, file: row.file };
          session.held.queued = queuedEditFor;
          session.input = body;
          session.cursor = body.length;
          session.flashMessage(
            `editing inbox message #${row.position} for ${row.role} — Enter to save, Esc to cancel`,
          );
        }
      }
    });
    return true;
  };

  // Esc cancels the Queued pane's in-place editor, restoring the previous prompt text.
  const cancelQueuedEdit = (): boolean => {
    exitQueuedEdit();
    return true;
  };

  // Enter saves the queued editor's line through the same file-addressed
  // editQueuedFile pair the dashboard's Edit uses: the write targets the queue file
  // the row named, so a concurrent dequeue cannot land it on the wrong prompt. An
  // invalid (whitespace-only) line flashes and STAYS in the editor; a gone outcome
  // is the concurrent-dequeue race, flashed honestly and returned to the list; a
  // throw keeps the text in the editor for a retry.
  const commitQueuedEdit = (): boolean => {
    const parsed = parseRolePromptInput(session.input);
    if (!parsed.ok) {
      session.flashMessage(parsed.error);
    } else {
      // The dispatch guards on `queuedEditFor`, so it is never null when this arm runs.
      const target = queuedEditFor!;
      guardError(session, () => {
        const outcome = editQueuedFile(session.root, target.role, target.file, parsed.value);
        exitQueuedEdit();
        session.refreshQueued();
        session.flashMessage(
          outcome.status === "edited"
            ? `edited inbox message for ${target.role}`
            : "the inbox message was already gone",
        );
      });
    }
    return true;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "e") return queuedOpenEdit(ctx);
    if (key.name === "escape" && queuedEditFor) return cancelQueuedEdit();
    if (key.name === "return" && queuedEditFor) return commitQueuedEdit();
    return false;
  };

  return { handleKey, exit: exitQueuedEdit };
}
