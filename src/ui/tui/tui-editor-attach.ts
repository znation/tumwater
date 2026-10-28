import path from "node:path";
import { imagePromptGuidance } from "../../inbox/inbox-submit.js";
import { promptImagesCountProblem, readPromptImageFiles, type PromptImageInput } from "../../inbox/inbox-attachments.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { savedPromptDraft, type TuiEditorSession } from "./tui-editor-session.js";

/** The Activity view's Ctrl+V image-attach editor on the shared prompt line, the terminal
 * twin of `tumwater prompt --attach <path>` and the dashboard composer's drop/paste. It owns
 * its `attachMode` flag, its saved-draft pair, and the handleKey arms for its key (the toggle
 * with the `heldEditorFlash(entering)` guard clause — the shared guard priority lives in the
 * session module — plus Esc, Ctrl+V again, and Enter). The pending attachments themselves
 * (`session.images`) are session state the director submit also reads, so they live in the
 * session, not here. Guarded to the Activity view (`ctx.view === 0`), so the Transcript reset
 * arm, the Backlog move-to-top arm, and the Queued pane's move-to-top arm keep `Ctrl+V` on
 * their views. */
export function createAttachEditor(session: TuiEditorSession): TuiEditorModule {
  let attachMode = false;
  const draft = savedPromptDraft(session);

  // Leave attach mode (Esc, Ctrl+V again, or Ctrl+T): restore the saved prompt text. The
  // pending session.images are untouched — Esc cancels the path edit, not an attachment
  // already saved.
  const exitAttachMode = (): void => {
    if (!attachMode) return;
    attachMode = false;
    session.held.attach = false;
    draft.restore();
  };

  // Ctrl+V toggles image-attach mode on the Activity view's prompt line (mnemonic: attach
  // **v**ia the same key the reset-counters and move-to-top arms use on their own views):
  // the line edits one image path that rides into the next director prompt as the same
  // `[image attached: …]` `tumwater prompt --attach <path>` and the dashboard composer
  // write. Entering saves the director draft and blanks the line; leaving restores it.
  // Guarded to the Activity view (`ctx.view === 0`), so the Transcript reset arm, the
  // Backlog move-to-top arm, and the Queued pane's move-to-top arm keep `Ctrl+V` on their
  // views: a guard miss returns false and falls through the dispatch.
  const toggleAttachEdit = (ctx: TuiEditorCtx): boolean => {
    if (ctx.view !== 0) return false;
    if (session.editorEntryDenied("attach")) return true;
    if (attachMode) {
      exitAttachMode();
      session.flashMessage("image attach cancelled");
    } else {
      // Mid-recall, hand the arrows' saved draft back before the attach editor takes the
      // line — the same settle the role editors do — so leaving restores the
      // draft, not a history entry, with no stale recall state riding along.
      draft.save();
      attachMode = true;
      session.held.attach = true;
      session.input = "";
      session.cursor = 0;
      session.flashMessage("attach an image path — Enter to attach, Esc to cancel");
    }
    return true;
  };

  // Esc cancels the attach editor, restoring the previous prompt text and leaving any
  // already-saved pending images untouched.
  const cancelAttachEdit = (): boolean => {
    exitAttachMode();
    return true;
  };

  // Enter in attach mode reads the typed path as one image through the same rules
  // `tumwater prompt --attach` uses (readPromptImageFiles), refuses a path no configured
  // director seam can read up front, and stores it as a pending attachment on the session
  // so the next director prompt carries it. Empty clears the pending images; a failed read
  // or a refusal flashes and STAYS in the editor so the operator can fix the path. Either
  // way the saved draft is restored.
  const commitAttachEdit = (): boolean => {
    const p = session.input.trim();
    if (p === "") {
      session.images = [];
      exitAttachMode();
      session.flashMessage("image attach cleared");
      return true;
    }
    let readImages: PromptImageInput[];
    try {
      readImages = readPromptImageFiles([p]);
    } catch (err) {
      session.flashError(err);
      return true;
    }
    const guidance = imagePromptGuidance(session.root, "director");
    if (guidance.refusal) {
      session.flashMessage(guidance.refusal);
      return true;
    }
    const next = [...session.images, ...readImages];
    const countProblem = promptImagesCountProblem(next.length);
    if (countProblem !== null) {
      session.flashMessage(countProblem);
      return true;
    }
    session.images = next;
    exitAttachMode();
    session.flashMessage(`attached ${path.basename(p)}`);
    return true;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "v") return toggleAttachEdit(ctx);
    if (key.name === "escape" && attachMode) return cancelAttachEdit();
    if (key.name === "return" && attachMode) return commitAttachEdit();
    return false;
  };

  return { handleKey, exit: exitAttachMode };
}
