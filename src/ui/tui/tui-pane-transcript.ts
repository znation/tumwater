import { saveRoleNote } from "../../agent/role-notes-write.js";
import { roleNotesPath } from "../../paths.js";
import { renderRoleChange } from "../../change/change-render.js";
import { readMergeQueue } from "../../merge/merge-queue.js";
import { renderMergeQueue, scopeMergeQueue } from "../../merge/merge-queue-render.js";
import { orchestratorAlive } from "../../team/orchestrator-info.js";
import { queueInFlight } from "../../status/status-polls.js";
import { roleInspectMarkdown } from "./tui-pane.js";
import { pageMarkdownBody } from "./tui-backlog.js";
import { pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The per-role transcript panes (views 1..roleIds.length) of the TUI: the Ctrl+N
 * transcript→notes→change cycle and its two-step Ctrl+X notes-clear arm, the Ctrl+Y
 * change-diff toggle, plus the notes/change PgUp/PgDn body window, and the `/` search over
 * the live transcript step. Split out of the pane-navigation monolith; it owns the
 * notes/change mode state and the arms that touch them. */
export function createTranscriptPane(session: TuiPaneSession) {
  // Ctrl+N toggles the viewed role's pane between its live transcript and a read-only
  // notes view (its note and next run's prompt). Like paneCache, noteCache is computed
  // once on entry and only re-windowed each frame; both reset when the mode changes or the
  // view cycles.
  let noteMode = false;
  let noteCache: string | null = null;
  // Ctrl+N's third step: the viewed role's collected unmerged change (the CLI's
  // `renderRoleChange` text). changeCache is null until the async collector resolves, and the
  // pane paints a loading note meanwhile; both reset on leaving the mode or cycling the view.
  let changeMode = false;
  let changeCache: string | null = null;
  // Ctrl+Y on the change step (mnemonic: summarY) toggles the viewed role's diff between
  // the full patch and `git diff --stat`'s summary — the terminal twin of `tumwater diff
  // --role <id> --stat` and the dashboard drawer's Stat only toggle.
  let changeStat = false;
  // changeGen makes a stale collector harmless: it is bumped on every change-step load
  // (loadChange, a Ctrl+Y toggle included), on the change → transcript branch, and on
  // reset(), so a collector a newer load or a leave superseded must not paint the pane.
  let changeGen = 0;
  // The `/` search over the live transcript step: the pattern belongs to the role it was applied
  // on, so a roster shift that puts another role at the same index does not inherit it.
  let transcriptSearch: { role: string; pattern: string } | null = null;
  // The currently viewed role (TuiPaneSession.roleIds is a 1-based per-role index); the
  // deref is safe because every read below sits in an arm that has already clamped
  // session.view into 1..roleIds.length or compares against a known role id.
  const viewedRole = (): string => session.roleIds[session.view - 1]!;

  // The change step's collector, shared by the notes→change arm and the Ctrl+Y diffstat
  // toggle so both load through one path. It clears the cached render (the pane paints its
  // loading note) and bumps changeGen; every resolution older than the current generator is
  // dropped, which is what makes a Ctrl+Y toggle, a cycle away, or a reset without a new
  // load harmless. The default collector degrades rather than throws, so the rejection arm
  // only covers an injected seam (or an unexpected throw).
  const loadChange = (role: string): void => {
    changeCache = null;
    const gen = ++changeGen;
    const target = role;
    // The role's waiting merges head the change, exact-matching this one runner id.
    let queueText = "";
    try {
      const { view, scope } = scopeMergeQueue(readMergeQueue(session.root), [role], (r) => r === role);
      if (view.entries.length > 0) {
        const inFlight = queueInFlight(session.root, view.entries, orchestratorAlive(session.root));
        queueText = renderMergeQueue(view, session.now(), inFlight, scope) + "\n\n";
      }
    } catch (err) {
      queueText = "";
      session.flashError(err);
    }
    void session.collectChange(session.root, target, changeStat ? { stat: true } : undefined).then(
      (change) => {
        // changeGen drops a load superseded by a re-load or a leave; the role match drops one
        // a roster change (syncRoster mutates session.roleIds without resetting this pane)
        // made stale, so an in-flight collection cannot paint the previous role's change.
        if (gen !== changeGen || viewedRole() !== target) return;
        changeCache = queueText + renderRoleChange(change);
        session.requestRender();
      },
      (err: unknown) => {
        if (gen !== changeGen || viewedRole() !== target) return;
        session.flashError(err);
        session.requestRender();
      },
    );
  };

  // The Ctrl+N transcript→notes→change cycle for the viewed role. Returns true every path
  // because routeCtrlN in tui-panes.ts routes it last and relies on this pane consuming
  // Ctrl+N as the fallback.
  const transcriptCycle = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+N cycles the viewed role's pane live transcript → notes → change → transcript.
    // The change step renders the same
    // collectRoleChange/renderRoleChange view the CLI's `tumwater diff --role <id>` and the
    // dashboard drawer use. Guarded to a transcript view and out of budget-edit and
    // role-prompt modes, the same way the per-role controls below are; the History view's
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
    const role = viewedRole(); // defined: view is clamped inside the transcript range
    if (changeMode) {
      changeMode = false;
      changeGen += 1;
      changeCache = null;
    } else if (noteMode) {
      // notes → change: reset the notes snapshot, start on the full patch, and kick off the
      // collector fire-and-forget, caching the rendered text when it resolves (the Pending
      // pane's pattern). changeGen drops a collector superseded by a Ctrl+Y toggle, a cycle
      // away, or a reset.
      noteMode = false;
      noteCache = null;
      changeMode = true;
      changeStat = false;
      loadChange(role);
    } else {
      // rolePayload reads the notes and assembles the next run's prompt off disk; a
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
  };

  // The Ctrl+Y diffstat toggle, live only on the change step (mnemonic: summarY). Returns
  // false on a guard miss so routeCtrlY still reaches History's Summary cycle.
  const transcriptStatToggle = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+Y on the change step toggles the viewed role's diff between the full patch and
    // the diffstat. The flip clears the cached render and kicks a fresh collector (so the
    // pane paints its loading note and the new view when it resolves); jumping straight to
    // the diffstat is the first question a large pending change answers. With any guard
    // false it returns false so the router falls through to History's Summary toggle.
    if (!(changeMode && promptLineFree(ctx.es) &&
        session.view >= 1 && session.view <= session.roleIds.length)) {
      return false;
    }
    const role = viewedRole();
    changeStat = !changeStat;
    session.paneScroll = 0;
    loadChange(role);
    session.requestRender();
    return true;
  };

  // The Ctrl+X two-step notes clear, live only on the notes step. Returns false on a guard
  // miss so routeCtrlX still reaches History/Queued/Pending/Backlog.
  const transcriptNotesClear = (ctx: TuiPaneCtx): boolean => {
    // Ctrl+X twice clears the viewed role's notes through the writer the CLI's
    // `--clear-notes` and the dashboard drawer share, then re-renders the notes view.
    if (!(noteMode && promptLineFree(ctx.es) &&
        session.view >= 1 && session.view <= session.roleIds.length)) {
      return false;
    }
    const role = viewedRole();
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
  };

  // The notes/change PgUp/PgDn body window. Returns false off those modes so routePage falls
  // through to the backlog for the live transcript step.
  const transcriptPage = (page: "up" | "down"): boolean => {
    // Within-body scroll in the notes and change views: PgDn/PgUp page the cached
    // inspection Markdown, clamped at both ends, exactly like the usage/failures panes
    // below. (The run-trail view's arm lives in the history module beside trailMode.)
    if (!(noteMode || changeMode)) return false;
    session.paneScroll = pageMarkdownBody(session.paneScroll, noteMode ? noteCache : changeCache, session.eventBudget, page);
    session.requestRender();
    return true;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "n") return transcriptCycle(ctx);
    if (key.ctrl && key.name === "y") return transcriptStatToggle(ctx);
    if (key.ctrl && key.name === "x") return transcriptNotesClear(ctx);
    const page = pageDir(key.name);
    if (page !== null) return transcriptPage(page);
    return false;
  };

  return {
    handleKey,
    // Repaint the notes view after the Ctrl+E editor wrote a replacement note: recompute the
    // cached inspection Markdown and repaint, but only when the notes view is actually up for
    // that role — a write whose view cycled away or whose roster shifted must not overwrite
    // the pane now shown or repaint a stale frame.
    refreshNotes(role: string) {
      if (!noteMode || viewedRole() !== role) return;
      noteCache = roleInspectMarkdown(session.root, role);
      session.paneScroll = 0;
      session.requestRender();
    },
    reset() {
      // A cycle away leaves notes and change modes and drops their snapshots; changeGen
      // bumps so an in-flight change load cannot paint after the view cycled away, and
      // changeStat resets so every fresh entry to the change step starts on the full patch
      // (like the drawer, which refetches without stat on reopen).
      noteMode = false;
      noteCache = null;
      changeMode = false;
      changeCache = null;
      changeGen += 1;
      changeStat = false;
      transcriptSearch = null;
    },
    applySearch(pattern: string | null): void {
      // The `/` editor's Enter on a role's live transcript: sets (or clears) the pattern for the
      // viewed role and returns the pane to its head.
      if (session.view < 1 || session.view > session.roleIds.length) return;
      transcriptSearch = pattern === null ? null : { role: viewedRole(), pattern };
      session.paneScroll = 0;
      session.requestRender();
    },
    state() {
      const transcriptGrep = transcriptSearch !== null && viewedRole() === transcriptSearch.role
        ? transcriptSearch.pattern
        : null;
      return { noteMode, noteCache, changeMode, changeCache, changeStat, transcriptGrep };
    },
  } satisfies TuiPaneModule & { applySearch(pattern: string | null): void };
}
