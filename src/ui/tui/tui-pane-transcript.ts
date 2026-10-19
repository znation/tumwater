// vocabulary: plain
import { saveRoleNote } from "../../agent/role-notes-write.js";
import { roleNotesPath } from "../../paths.js";
import { renderRoleChange } from "../../change/change-render.js";
import { roleInspectMarkdown } from "./tui-pane.js";
import { pageMarkdownBody } from "./tui-backlog.js";
import { pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The per-loop transcript panes (views 1..roleIds.length) of the TUI: the Ctrl+N
 * transcript→notebook→change cycle and its two-step Ctrl+X notebook-clear arm, plus the
 * notebook/change PgUp/PgDn body window. Split out of the pane-navigation monolith; it owns
 * the notebook/change mode state and the arms that touch them. */
export function createTranscriptPane(session: TuiPaneSession) {
  // Ctrl+N toggles the viewed loop's pane between its live transcript and a read-only
  // notebook view (its note and next tick's prompt). Like paneCache, noteCache is computed
  // once on entry and only re-windowed each frame; both reset when the mode changes or the
  // view cycles.
  let noteMode = false;
  let noteCache: string | null = null;
  // Ctrl+N's third step: the viewed loop's collected unmerged change (the CLI's
  // `renderRoleChange` text). changeCache is null until the async collector resolves, and the
  // pane paints a loading note meanwhile; both reset on leaving the mode or cycling the view.
  let changeMode = false;
  let changeCache: string | null = null;

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "n") {
      // Ctrl+N cycles the viewed loop's pane live transcript → notebook → change → transcript
      // (PLANS.md "Inspect a loop's notebook and next tick prompt in the TUI" and "Show a
      // loop's pending change in the TUI transcript pane"). The change step renders the same
      // collectRoleChange/renderRoleChange view the CLI's `tumwater diff --role <id>` and the
      // dashboard drawer use. Guarded to a transcript view and out of budget-edit and
      // role-prompt modes, the same way the per-loop controls below are; the History view's
      // trail arm is handled by the history module ahead of this one in the routing order.
      // The editor flags below (budget/role/pause/queued/answer/entry/search) are all
      // false here — the editors consume every key that reads or writes the line — but the
      // guard restates them so the arm keeps its mutual-exclusion contract explicit. (The
      // `search` flag is absent from this guard exactly as before: the shared `/` search
      // editor consumes the key first, so the pane arm is never reached while it is open.)
      if (
        ctx.es.budgetMode || ctx.es.rolePromptFor || ctx.es.pauseEditMode ||
        ctx.es.queuedEditFor || ctx.es.answerFor || ctx.es.entryEditFor || ctx.es.notesEditFor ||
        ctx.es.quietMode || ctx.es.roleModelMode || ctx.es.instructionsEditFor ||
        session.roleIds.length === 0 || session.view < 1 || session.view > session.roleIds.length
      ) {
        session.requestRender();
        return true;
      }
      const role = session.roleIds[session.view - 1]!; // defined: view is clamped inside the transcript range
      if (changeMode) {
        changeMode = false;
        changeCache = null;
      } else if (noteMode) {
        // notebook → change: reset the notebook snapshot and kick off the collector
        // fire-and-forget, caching the rendered text when it resolves (the Pending pane's
        // pattern). Guard on the change pane still being current — changeMode on, same role
        // at the same index — so a cycle away or a roster shift cannot overwrite the pane now
        // shown. The default collector degrades rather than throws, so the rejection arm only
        // covers an injected seam (or an unexpected throw).
        noteMode = false;
        noteCache = null;
        changeMode = true;
        changeCache = null;
        const target = role;
        void session.collectChange(session.root, target).then(
          (change) => {
            if (!changeMode || session.roleIds[session.view - 1] !== target) return;
            changeCache = renderRoleChange(change);
            session.requestRender();
          },
          (err: unknown) => {
            if (!changeMode || session.roleIds[session.view - 1] !== target) return;
            session.flashError(err);
            session.requestRender();
          },
        );
      } else {
        // rolePayload reads the notebook and assembles the next tick's prompt off disk; a
        // throw leaves the transcript shown (the mode stays off) and flashes the reason
        // instead of escaping the handler and killing the TUI.
        try {
          noteCache = roleInspectMarkdown(session.root, role);
          noteMode = true;
        } catch (err) {
          noteCache = null;
          session.flashError(err);
        }
      }
      session.paneScroll = 0; // either way the pane starts at its head
      session.requestRender();
      return true;
    }
    if (
      key.ctrl && key.name === "x" && noteMode &&
      promptLineFree(ctx.es) &&
      session.view >= 1 && session.view <= session.roleIds.length
    ) {
      // Ctrl+X twice clears the viewed loop's notebook through the writer the CLI's
      // `--clear-notes` and the dashboard drawer share, then re-renders the notebook view.
      const role = session.roleIds[session.view - 1]!;
      if (session.armedNotes === role) {
        try {
          session.flashMessage(`${role}: ${saveRoleNote(roleNotesPath(session.root, role), "")}`);
          noteCache = roleInspectMarkdown(session.root, role);
          session.paneScroll = 0;
        } catch (err) {
          session.flashError(err);
        }
      } else {
        session.notesClearArmed = role;
        session.flashMessage(`press Ctrl+X again to clear ${role}'s notes — any other key keeps it`);
      }
      session.requestRender();
      return true;
    }
    const page = pageDir(key.name);
    if (page !== null && (noteMode || changeMode)) {
      // Within-body scroll in the notebook and change views: PgDn/PgUp page the cached
      // inspection Markdown, clamped at both ends, exactly like the usage/failures panes
      // below. (The tick-trail view's arm lives in the history module beside trailMode.)
      session.paneScroll = pageMarkdownBody(session.paneScroll, noteMode ? noteCache : changeCache, session.eventBudget, page);
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    // Repaint the notes view after the Ctrl+E editor wrote a replacement note: recompute the
    // cached inspection Markdown and repaint, but only when the notes view is actually up for
    // that role — a write whose view cycled away or whose roster shifted must not overwrite
    // the pane now shown or repaint a stale frame.
    refreshNotes(role: string) {
      if (!noteMode || session.roleIds[session.view - 1] !== role) return;
      noteCache = roleInspectMarkdown(session.root, role);
      session.paneScroll = 0;
      session.requestRender();
    },
    reset() {
      // A cycle away leaves notebook and change modes and drops their snapshots.
      noteMode = false;
      noteCache = null;
      changeMode = false;
      changeCache = null;
    },
    state() {
      return { noteMode, noteCache, changeMode, changeCache };
    },
  } satisfies TuiPaneModule;
}
