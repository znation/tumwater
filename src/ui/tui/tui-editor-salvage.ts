import { applySalvagePatchForOperator } from "../../git/slot-salvage.js";
import { isGitRepo } from "../../git/git.js";
import { collectSalvagePatches, dropSalvagePatch, salvagePatchAt } from "../../status/status-salvage.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import { openBlankPromptLine, savedPromptDraft, type TuiEditorSession } from "./tui-editor-session.js";

/** The Health view's salvage editor on the shared prompt line: the Ctrl+G salvage-apply arm (the
 * `tumwater salvage --apply <n>` and the dashboard Settings card's per-patch Apply button)
 * and the Ctrl+Y salvage-drop arm (the terminal twin of `tumwater salvage --drop <n>`).
 * It owns its `salvageMode` flag (the `"apply"` or `"drop"` arm open, null when closed), its
 * saved-draft pair, and the handleKey arms for both keys (each with the
 * `heldEditorFlash(entering)` guard clause — the shared guard priority lives in the session module
 * — plus Esc and Enter). Both arms are guarded to the Health view
 * (`ctx.view === roleIds.length + 7`), so every other view's Ctrl+G arm (Activity scope, Report
 * scope, Transcript instances) and every other view's Ctrl+Y arm (Activity window, History
 * tables, Transcript diffstat) keeps the key. Enter in either arm resolves the typed number
 * through `collectSalvagePatches` the way the CLI does (the same empty / non-whole / past-
 * the-list flashes, so a bad number cannot act); the apply arm runs
 * `applySalvagePatchForOperator` (the patch file is kept for re-apply) and the drop arm runs
 * `dropSalvagePatch` (the CLI's `--drop` core, so the file is deleted and the terminal drop
 * cannot drift from it), both then calling `refreshHealth()` to repaint the list. A bad number, a
 * non-git apply root, a patch that does not apply, or a file that cannot be deleted flashes and
 * stays open so the operator can fix it. */
export function createSalvageEditor(session: TuiEditorSession): TuiEditorModule {
  let salvageMode: "apply" | "drop" | null = null;
  const draft = savedPromptDraft(session);

  // Leave salvage mode (Esc, the matching Ctrl+G / Ctrl+Y again, Enter's success path, or
  // Ctrl+T): restore the saved prompt text and clear the held flags.
  const exitSalvageMode = (): void => {
    if (salvageMode === null) return;
    salvageMode = null;
    session.held.salvage = false;
    session.held.salvageDrop = false;
    draft.restore();
  };

  // Ctrl+G toggles salvage-apply mode on the Health view's prompt line (mnemonic: **g**
  // for "apply" a kept **g**it patch — the same key the Activity scope, Report scope, and
  // Transcript instances arms use on their own views, guarded away here by the Health index).
  // The line edits one patch number; Enter applies that patch through the same
  // `applySalvagePatchForOperator` core the CLI's `tumwater salvage --apply <n>` and the
  // dashboard button use. Entering saves the prompt draft and blanks the line; leaving restores
  // it. Pressing Ctrl+G again (or Esc) cancels. The guard returns false off Health so the key
  // falls through to the other views' own Ctrl+G arms.
  const openSalvageApply = (ctx: TuiEditorCtx): boolean => {
    if (ctx.view !== ctx.roleIds.length + 7) return false;
    if (salvageMode === "apply") return cancelSalvageEdit(); // Ctrl+G again cancels
    if (session.editorEntryDenied("salvage")) return true;
    // Mid-recall, hand the arrows' saved draft back before the editor takes the line — the same
    // settle the retire editor does — so leaving restores the draft, not a history entry, with
    // no stale recall state riding along.
    salvageMode = "apply";
    session.held.salvageDrop = false;
    openBlankPromptLine(session, draft, "salvage", "apply a kept salvage patch: type its number, Enter to apply, Esc to cancel");
    return true;
  };

  // Ctrl+Y toggles salvage-drop mode on the Health view's prompt line (mnemonic: **y** for "d**y**"
  // — the destructive twin of apply, deleting the patch file). The line edits one patch number;
  // Enter deletes it through the same `dropSalvagePatch` core the CLI's `tumwater salvage
  // --drop <n>` uses, so the terminal drop cannot drift from it. Entering saves the prompt draft
  // and blanks the line; leaving restores it. Pressing Ctrl+Y again (or Esc) cancels. The guard
  // returns false off Health so the key falls through to the other views' own Ctrl+Y arms
  // (Activity window, History tables, Transcript diffstat), which stay intact.
  const openSalvageDrop = (ctx: TuiEditorCtx): boolean => {
    if (ctx.view !== ctx.roleIds.length + 7) return false;
    if (salvageMode === "drop") return cancelSalvageEdit(); // Ctrl+Y again cancels
    if (session.editorEntryDenied("salvage")) return true;
    // The same mid-recall settle the apply arm does — openBlankPromptLine parks the draft so
    // leaving restores it, not a history entry.
    salvageMode = "drop";
    session.held.salvageDrop = true;
    openBlankPromptLine(session, draft, "salvage", "drop a kept salvage patch: type its number, Enter to delete it, Esc to cancel");
    return true;
  };

  // Esc (or its matching Ctrl+G / Ctrl+Y again) cancels the open salvage mode, restoring the
  // previous prompt text and applying/dropping nothing. The message names the mode so both arms
  // share this one cancel.
  const cancelSalvageEdit = (): boolean => {
    const mode = salvageMode;
    exitSalvageMode();
    if (mode !== null) session.flashMessage(`salvage ${mode} cancelled`);
    return true;
  };

  // Enter applies the typed patch number through applySalvagePatchForOperator — the same core,
  // and the same never-delete-the-patch / never-commit policy, the CLI's `tumwater salvage --apply
  // <n>` and the dashboard's Apply button use — then flashes the CLI's own outcome wording. An
  // empty line, a non-whole number, a number past the list (or below 1), a non-git root, and a
  // patch that does not apply all flash and STAY in the editor so the operator can fix the input
  // or reach for the CLI; only a successful apply exits the editor and repaints the Health list.
  const submitSalvageApply = (): boolean => {
    const text = session.input.trim();
    if (text === "") {
      session.flashMessage("a salvaged patch position is required");
      return true;
    }
    const position = Number(text);
    if (!Number.isInteger(position)) {
      session.flashMessage("salvage position must be a whole number");
      return true;
    }
    const at = salvagePatchAt(collectSalvagePatches(session.root), position);
    if ("message" in at) {
      session.flashMessage(at.message!);
      return true;
    }
    const patch = at.patch;
    void (async () => {
      // Apply needs a git checkout (the list needs none); a non-git root changes nothing and
      // stays open, the same refusal the CLI's `--apply` branch gives.
      if (!(await isGitRepo(session.root))) {
        session.flashMessage("salvage --apply needs a git checkout (run it from the checkout the patch should apply to)");
        return;
      }
      const applied = await applySalvagePatchForOperator(session.root, patch.file);
      if (!applied) {
        // A patch whose context no longer fits leaves every file untouched and keeps the patch
        // file; flash the CLI's does-not-apply sentence (which already says no files were
        // changed) and stay open.
        session.flashMessage(
          `salvaged workspace patch ${patch.file} does not apply cleanly to this checkout — no files were changed (run tumwater salvage --show ${position} to print it for a manual apply)`,
        );
        return;
      }
      exitSalvageMode();
      session.flashMessage(`applied salvaged workspace patch ${position}: ${patch.file}`);
      // Re-read the doctor report and the patch list so the successful apply is visible (the
      // patch file stays listed, exactly as the CLI keeps it).
      session.refreshHealth();
    })();
    return true;
  };

  // Enter in drop mode deletes the typed patch number through `dropSalvagePatch` — the same
  // core the CLI's `tumwater salvage --drop <n>` uses, so the terminal drop cannot drift from
  // it. The empty-line, non-whole-number, and past-the-list flashes are the apply arm's, so a
  // bad number cannot delete anything. On a successful delete the editor exits and repaints
  // the Health list with the patch gone; on a delete that could not remove the file it flashes
  // the CLI's `could not drop` sentence and stays open.
  const submitSalvageDrop = (): boolean => {
    const text = session.input.trim();
    if (text === "") {
      session.flashMessage("a salvaged patch position is required");
      return true;
    }
    const position = Number(text);
    if (!Number.isInteger(position)) {
      session.flashMessage("salvage position must be a whole number");
      return true;
    }
    const at = salvagePatchAt(collectSalvagePatches(session.root), position);
    if ("message" in at) {
      session.flashMessage(at.message!);
      return true;
    }
    const patch = at.patch;
    void (async () => {
      const dropped = dropSalvagePatch(session.root, patch.file);
      if (!dropped) {
        // A file that could not be removed stays put; flash the CLI's `--drop` refusal sentence
        // and keep the editor open so the operator can reach for the CLI or `rm`.
        session.flashMessage(`could not drop salvaged patch ${patch.file}`);
        return;
      }
      exitSalvageMode();
      session.flashMessage(`dropped salvaged workspace patch ${position}: ${patch.file}`);
      // Re-read the doctor report and the patch list so the dropped patch is gone from the list.
      session.refreshHealth();
    })();
    return true;
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (key.ctrl && key.name === "g") return openSalvageApply(ctx);
    if (key.ctrl && key.name === "y") return openSalvageDrop(ctx);
    if (key.name === "escape" && salvageMode !== null) return cancelSalvageEdit();
    if (key.name === "return" && salvageMode !== null) {
      return salvageMode === "apply" ? submitSalvageApply() : submitSalvageDrop();
    }
    return false;
  };

  return { handleKey, exit: exitSalvageMode };
}
