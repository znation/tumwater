// vocabulary: plain
import { tryCancelEntry, tryMoveEntryToTop, tryReleaseEntry, OPERATOR_FILE_KINDS } from "../../backlog/backlog-write.js";
import { requestWake } from "../../operator/operator-intent.js";
import { moveEntrySelection, pageMarkdownBody } from "./tui-backlog.js";
import { arrowDir, pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The project-status pane (view roleIds.length + 1) of the TUI (src/ui/tui/tui.tsx): the
 * entry browser's selection/scroll state, the up/down and PgUp/PgDn entry arms, and the
 * two-step Ctrl+X cancel arm (plus the answer/title-edit selection clear the editors call back).
 * Split out of the pane-navigation monolith; it owns the pane's selection/scroll state and
 * the arms that touch them. */
export function createBacklogPane(
  session: TuiPaneSession,
) {
  // The project-status pane's entry selection (null = list mode): the flat index of the
  // entry shown in full — plans first, then bugs, then questions. Cleared on every Ctrl+T,
  // so cycling back into the view always starts at today's heading list.
  let selectedEntry: number | null = null;
  // The within-body scroll offset (line index of the window head, 0 = head) for the selected
  // entry's body — PgDn/PgUp in project-status entry mode. Reset whenever the selection
  // changes or clears, so every newly opened entry starts at its head.
  let entryScroll = 0;

  const clearBacklogSelection = (): void => {
    // Clear the project-status pane's selection and its body scroll after a recorded answer or
    // edited entry leaves the list — the pane-side half of an answer/title-edit commit.
    selectedEntry = null;
    entryScroll = 0;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (
      key.ctrl && key.name === "x" &&
      promptLineFree(ctx.es) &&
      session.view === session.roleIds.length + 1
    ) {
      // Ctrl+X twice cancels the selected plan or bug through the non-exiting core the
      // dashboard drawer uses; the title check inside tryCancelEntry refuses a stale selection.
      if (selectedEntry !== null) {
        const entries = session.flat();
        const sel = Math.min(selectedEntry, entries.length - 1);
        const picked = entries[sel];
        if (picked === undefined) {
          // an emptied list has nothing to cancel
        } else if (picked.label === "done" || picked.label === "fixed" || picked.label === "answered") {
          session.flashMessage("a done plan, fixed bug or answered question is read-only");
        } else if (picked.label === "question") {
          session.flashMessage("only a plan or open bug can be cancelled here");
        } else {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
          const target = { kind, position, title: picked.title };
          if (session.armed !== null && session.armed.kind === kind && session.armed.position === position) {
            // The armed title (not the re-read one) goes to tryCancelEntry, so an entry that
            // changed since the arm reports `moved` instead of being cancelled.
            try {
              const outcome = tryCancelEntry(session.root, kind, position, session.armed.title);
              if (outcome.status === "cancelled") {
                session.commitBacklogEdit(outcome.file, `Cancel ${kind}: ${outcome.title}`);
              }
              selectedEntry = null;
              entryScroll = 0;
              session.flashMessage(
                outcome.status === "cancelled"
                  ? `cancelled ${kind} #${position}: ${target.title}`
                  : `that ${kind} was already removed or moved — nothing cancelled`,
              );
            } catch (err) {
              session.flashError(err);
            }
          } else {
            session.cancelArmed = target;
            session.flashMessage(`press Ctrl+X again to cancel ${kind} #${position} — any other key keeps it`);
          }
        }
      }
      session.requestRender();
      return true;
    }
    if (
      key.ctrl && key.name === "v" &&
      promptLineFree(ctx.es) &&
      session.view === session.roleIds.length + 1
    ) {
      // Ctrl+V moves the selected plan or bug to the head of its section through the
      // non-exiting core the dashboard drawer uses; the title check inside tryMoveEntryToTop
      // refuses a stale selection. It is the terminal twin of `tumwater plan|bug --top <n>`
      // and the dashboard's Move to top: one press, like the drawer's single click, and moving
      // changes no entry's eligibility, so no role is woken. A plan or bug at the head answers
      // already_first with no write.
      if (selectedEntry !== null) {
        const entries = session.flat();
        const sel = Math.min(selectedEntry, entries.length - 1);
        const picked = entries[sel];
        if (picked === undefined) {
          // an emptied list has nothing to move
        } else if (picked.label === "done" || picked.label === "fixed" || picked.label === "answered") {
          session.flashMessage("a done plan, fixed bug or answered question is read-only");
        } else if (picked.label === "question") {
          session.flashMessage("only a plan or open bug can be moved here");
        } else {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
          try {
            const outcome = tryMoveEntryToTop(session.root, kind, position, picked.title);
            if (outcome.status === "moved_to_top") {
              session.commitBacklogEdit(outcome.file, `Prioritize ${kind}: ${outcome.title}`);
            }
            selectedEntry = null;
            entryScroll = 0;
            session.flashMessage(
              outcome.status === "moved_to_top"
                ? `moved ${kind} #${position} to the top: ${outcome.title}`
                : outcome.status === "already_first"
                  ? `that ${kind} is already at the top`
                  : `that ${kind} was already removed or moved — nothing moved`,
            );
          } catch (err) {
            session.flashError(err);
          }
        }
      }
      session.requestRender();
      return true;
    }
    if (
      key.ctrl && key.name === "r" &&
      promptLineFree(ctx.es) &&
      session.view === session.roleIds.length + 1
    ) {
      // Ctrl+R twice releases the Refused or Waiting-for-the-next-failure note on the selected
      // plan or bug through the non-exiting core the dashboard drawer uses; the title check
      // inside tryReleaseEntry refuses a stale selection. Releasing is the terminal twin of
      // `tumwater plan|bug --release <n>`: it lifts the note, commits the file and wakes the
      // kind's loop, so an operator never has to leave the pane.
      if (selectedEntry !== null) {
        const entries = session.flat();
        const sel = Math.min(selectedEntry, entries.length - 1);
        const picked = entries[sel];
        if (picked === undefined) {
          // an emptied list has nothing to release
        } else if (picked.label === "done" || picked.label === "fixed" || picked.label === "answered") {
          session.flashMessage("a done plan, fixed bug or answered question is read-only");
        } else if (picked.label === "question") {
          session.flashMessage("only a plan or open bug can be released here");
        } else if (picked.hold !== "refused" && picked.hold !== "waiting-for-failure") {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          session.flashMessage(`that ${kind} carries no Refused or Waiting for the next failure note`);
        } else {
          const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
          const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
          const target = { kind, position, title: picked.title };
          if (session.armedRelease !== null && session.armedRelease.kind === kind && session.armedRelease.position === position) {
            // The armed title (not the re-read one) goes to tryReleaseEntry, so an entry that
            // changed since the arm reports `moved` instead of being released.
            try {
              const outcome = tryReleaseEntry(session.root, kind, position, session.armedRelease.title);
              if (outcome.status === "released") {
                session.commitBacklogEdit(outcome.file, `Release ${kind}: ${outcome.title}`);
                requestWake(session.root, [OPERATOR_FILE_KINDS[kind].role]);
              }
              selectedEntry = null;
              entryScroll = 0;
              session.flashMessage(
                outcome.status === "released"
                  ? `released ${kind} #${position}: ${outcome.title}`
                  : outcome.status === "not_refused"
                    ? `that ${kind} carries no Refused or Waiting for the next failure note`
                    : `that ${kind} was already removed or moved — nothing released`,
              );
            } catch (err) {
              session.flashError(err);
            }
          } else {
            session.releaseArmed = target;
            session.flashMessage(`press Ctrl+R again to release ${kind} #${position} — any other key keeps it`);
          }
        }
      }
      session.requestRender();
      return true;
    }
    const arrow = arrowDir(key.name);
    const page = pageDir(key.name);
    if (session.view === session.roleIds.length + 1 && arrow !== null) {
      // In the project-status pane, up/down browse entries in full instead of editing the
      // prompt; every other view keeps today's behavior (arrows are ignored by applyKey).
      // An open answer editor pins the selection (its position was taken from it).
      if (!ctx.es.answerFor && !ctx.es.entryEditFor) {
        const count = session.flat().length;
        selectedEntry = moveEntrySelection(count, selectedEntry, arrow);
        entryScroll = 0; // a newly opened entry starts at its body's head
      }
      session.requestRender();
      return true;
    }
    if (session.view === session.roleIds.length + 1 && page !== null) {
      // Within-body scroll in project-status ENTRY mode: PgDn/PgUp page the selected entry's
      // body, clamped at both ends. No-op in list mode and for bodies that fit — every other
      // view ignores these keys as today (applyKey drops them).
      if (selectedEntry !== null && !ctx.es.answerFor && !ctx.es.entryEditFor) {
        const entries = session.flat();
        const sel = entries.length > 0 ? Math.min(selectedEntry, entries.length - 1) : null;
        const body = sel === null ? "" : entries[sel]!.body;
        entryScroll = pageMarkdownBody(entryScroll, body, session.entryBudget, page);
      }
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    reset() {
      // Leaving a view drops any entry selection and its within-body scroll, so re-entering
      // starts at the list/head.
      selectedEntry = null;
      entryScroll = 0;
    },
    clearBacklogSelection,
    state() {
      return { selectedEntry, entryScroll, releaseArmed: session.releaseArmed };
    },
  } satisfies TuiPaneModule & { clearBacklogSelection(): void };
}
