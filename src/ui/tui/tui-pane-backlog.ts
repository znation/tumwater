import { tryCancelEntry, OPERATOR_FILE_KINDS } from "../../backlog/backlog-write.js";
import { tryMoveEntryToTop, tryReleaseEntry } from "../../backlog/backlog-release.js";
import { backlogHolds, cancelledClaimNote, stillHeldNote } from "../../backlog/backlog-eligibility.js";
import { entryKey, plansReleasedBy, releasedPartsNote } from "../../backlog/backlog-parts.js";
import { plannedPlanEntries } from "../../backlog/backlog.js";
import { allLiveClaims } from "../../runner/runner-state-load.js";
import { requestWake } from "../../operator/operator-intent.js";
import { moveEntrySelection, pageMarkdownBody, visibleBacklogIndexes, type labeledBacklogEntries } from "./tui-backlog.js";
import { arrowDir, pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** Resolve the selected plan/bug from the flat backlog list, deduping the four entry-action
 * arms' common prologue (Ctrl+X cancel, Ctrl+V move-to-top, Ctrl+R release, Ctrl+E edit): the
 * flat-index clamp and the empty / read-only-done / question guards, whose refusal flash
 * differs only in the action's verb. Returns the actionable `{ kind, position, picked }`, or
 * null — after flashing the guard's message — when the selection is unactionable (an emptied
 * list, a done/fixed/answered entry, or a question). The caller then runs its own arm on the
 * result. All four arms require the same selection, so they cannot drift on how it is resolved.
 * The session, flat() and flashMessage() are structurally shared by the backlog and entry
 * editors' sessions. */
export function selectedEditableEntry(
  session: { flat(): ReturnType<typeof labeledBacklogEntries>; flashMessage(message: string): void },
  selectedEntry: number | null,
  verb: "cancelled" | "moved" | "released" | "edited",
): { kind: "plan" | "bug"; position: number; picked: ReturnType<typeof labeledBacklogEntries>[number] } | null {
  if (selectedEntry === null) return null;
  const entries = session.flat();
  const sel = Math.min(selectedEntry, entries.length - 1);
  const picked = entries[sel];
  if (picked === undefined) return null; // an emptied list has nothing to act on
  if (picked.label === "done" || picked.label === "fixed" || picked.label === "answered") {
    session.flashMessage("a done plan, fixed bug or answered question is read-only");
    return null;
  }
  if (picked.label === "question") {
    session.flashMessage(`only a plan or open bug can be ${verb} here`);
    return null;
  }
  const kind: "plan" | "bug" = picked.label === "plan" ? "plan" : "bug";
  const position = kind === "plan" ? sel + 1 : sel - entries.filter((e) => e.label === "plan").length + 1;
  return { kind, position, picked };
}

/** The project-status pane (view roleIds.length + 1) of the TUI (src/ui/tui/tui.tsx): the
 * entry browser's selection/scroll state, the up/down and PgUp/PgDn entry arms, and the
 * three entry-action arms (Ctrl+X cancel, Ctrl+V move-to-top and Ctrl+R release) — each
 * two-step arming except the one-press move — plus the answer/title-edit selection clear the
 * editors call back.
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
  // The pane's active free-text search (the `/` editor's applied pattern), like historyGrep on
  // the History pane: it persists across view cycling, and a non-null value filters the open
  // entries the up/down arms and the list render show. Cleared when the operator applies an
  // empty pattern.
  let backlogGrep: string | null = null;

  const clearBacklogSelection = (): void => {
    // Clear the project-status pane's selection and its body scroll after a recorded answer or
    // edited entry leaves the list — the pane-side half of an answer/title-edit commit.
    selectedEntry = null;
    entryScroll = 0;
  };

  // The pane's three entry actions (Ctrl+X cancel, Ctrl+V move-to-top, Ctrl+R release) live in
  // named helpers so each handler stays at two or three levels: the handler resolves the
  // selection, picks the armed/guard path, then delegates the try/commit/scroll-reset/flash to
  // the helper. The core's status decides the flash, so the one-press move and the two-press
  // cancel/release read the same as the dashboard drawer's non-exiting action.
  const cancelArmed = (
    target: { kind: "plan" | "bug"; position: number; title: string },
    armedTitle: string,
  ): void => {
    const { kind, position } = target;
    try {
      const claims = allLiveClaims(session.root);
      const outcome = tryCancelEntry(session.root, kind, position, armedTitle);
      const claimNote = outcome.status === "cancelled" ? cancelledClaimNote(claims.get(entryKey(outcome.title)) ?? null) : "";
      if (outcome.status === "cancelled") {
        session.commitBacklogEdit(outcome.file, `Cancel ${kind}: ${outcome.title}`);
      }
      const releasedNote = outcome.status === "cancelled" && kind === "plan" ? releasedPartsNote(plansReleasedBy(plannedPlanEntries(session.root), outcome.title)) : "";
      const note = [claimNote, releasedNote].filter((n) => n !== "").join(" — ");
      selectedEntry = null;
      entryScroll = 0;
      session.flashMessage(
        outcome.status === "cancelled"
          ? `cancelled ${kind} #${position}: ${target.title}${note === "" ? "" : ` — ${note}`}`
          : `that ${kind} was already removed or moved — nothing cancelled`,
      );
    } catch (err) {
      session.flashError(err);
    }
  };
  /** ` — still held [...]` for the entry now at a 1-based position, "" when it is eligible. */
  const heldTailAt = (kind: "plan" | "bug", position: number): string => {
    const holds = backlogHolds(session.root);
    const hold = (kind === "bug" ? holds.bugs : holds.plans)[position - 1] ?? null;
    return hold === null ? "" : ` — ${stillHeldNote(hold)}`;
  };
  const moveEntryToTop = (kind: "plan" | "bug", position: number, title: string): void => {
    try {
      const outcome = tryMoveEntryToTop(session.root, kind, position, title);
      let heldTail = "";
      if (outcome.status === "moved_to_top") {
        session.commitBacklogEdit(outcome.file, `Prioritize ${kind}: ${outcome.title}`);
        heldTail = heldTailAt(kind, 1);
      }
      selectedEntry = null;
      entryScroll = 0;
      session.flashMessage(
        outcome.status === "moved_to_top"
          ? `moved ${kind} #${position} to the top: ${outcome.title}${heldTail}`
          : outcome.status === "already_first"
            ? `that ${kind} is already at the top`
            : `that ${kind} was already removed or moved — nothing moved`,
      );
    } catch (err) {
      session.flashError(err);
    }
  };
  const releaseArmed = (
    target: { kind: "plan" | "bug"; position: number; title: string },
    armedTitle: string,
  ): void => {
    const { kind, position } = target;
    try {
      const outcome = tryReleaseEntry(session.root, kind, position, armedTitle);
      let heldTail = "";
      if (outcome.status === "released") {
        session.commitBacklogEdit(outcome.file, `Release ${kind}: ${outcome.title}`);
        heldTail = heldTailAt(kind, position);
        if (heldTail === "") requestWake(session.root, [OPERATOR_FILE_KINDS[kind].role]);
      }
      selectedEntry = null;
      entryScroll = 0;
      session.flashMessage(
        outcome.status === "released"
          ? `released ${kind} #${position}: ${outcome.title}${heldTail}`
          : outcome.status === "not_refused"
            ? `that ${kind} carries no Refused or Waiting for the next failure note`
            : `that ${kind} was already removed or moved — nothing released`,
      );
    } catch (err) {
      session.flashError(err);
    }
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
      const selected = selectedEditableEntry(session, selectedEntry, "cancelled");
      if (selected !== null) {
        const kind = selected.kind;
        const position = selected.position;
        const target = { kind, position, title: selected.picked.title };
        if (session.armed !== null && session.armed.kind === kind && session.armed.position === position) {
          // The armed title (not the re-read one) goes to tryCancelEntry, so an entry that
          // changed since the arm reports `moved` instead of being cancelled.
          cancelArmed(target, session.armed.title);
        } else {
          session.cancelArmed = target;
          session.flashMessage(`press Ctrl+X again to cancel ${kind} #${position} — any other key keeps it`);
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
      const selected = selectedEditableEntry(session, selectedEntry, "moved");
      if (selected !== null) {
        moveEntryToTop(selected.kind, selected.position, selected.picked.title);
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
      // kind's role, so an operator never has to leave the pane.
      const selected = selectedEditableEntry(session, selectedEntry, "released");
      if (selected !== null) {
        const kind = selected.kind;
        const position = selected.position;
        const target = { kind, position, title: selected.picked.title };
        if (selected.picked.hold !== "refused" && selected.picked.hold !== "waiting-for-failure") {
          session.flashMessage(`that ${kind} carries no Refused or Waiting for the next failure note`);
        } else if (session.armedRelease !== null && session.armedRelease.kind === kind && session.armedRelease.position === position) {
          // The armed title (not the re-read one) goes to tryReleaseEntry, so an entry that
          // changed since the arm reports `moved` instead of being released.
          releaseArmed(target, session.armedRelease.title);
        } else {
          session.releaseArmed = target;
          session.flashMessage(`press Ctrl+R again to release ${kind} #${position} — any other key keeps it`);
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
        const entries = session.flat();
        // With a search applied, up/down step only through the matching open entries (their
        // unfiltered indexes), wrapping at that list's ends; without one, they keep browsing
        // the whole flat list (open entries plus the read-only answered/done/fixed rows).
        const visible = backlogGrep === null ? undefined : visibleBacklogIndexes(entries, backlogGrep);
        selectedEntry = moveEntrySelection(entries.length, selectedEntry, arrow, visible);
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
      // starts at the list/head. The applied search pattern persists, like historyGrep.
      selectedEntry = null;
      entryScroll = 0;
    },
    clearBacklogSelection,
    grep(): string | null {
      return backlogGrep;
    },
    applySearch(pattern: string | null): void {
      // The `/` editor's Enter: sets the applied pattern, clears the selection and its body
      // scroll so the next frame starts in list mode, and leaves the pattern applied across
      // view cycles (like historyGrep).
      backlogGrep = pattern;
      selectedEntry = null;
      entryScroll = 0;
      session.requestRender();
    },
    state() {
      return { selectedEntry, entryScroll, releaseArmed: session.releaseArmed, backlogGrep };
    },
  } satisfies TuiPaneModule & { clearBacklogSelection(): void; grep(): string | null; applySearch(pattern: string | null): void }; 
}
