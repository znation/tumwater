/** The hold-lifting and reordering writes of `tumwater bug|plan --release <n>` and `--top <n>`:
 * lift an entry's Refused, Waiting-for-the-next-failure, or held-for-operator note, or move
 * it to the head of its open
 * section. Each comes as an exiting writer (the CLI) and a non-exiting `try…` core that refuses as
 * data (the TUI and dashboard); entry lookup and the section's file target are
 * backlog-write.ts's. */
import { backlogTarget, findEntry, locateDashboardEntry, readEntryLines } from "./backlog-write.js";
import type { ActionableEntryRange } from "./backlog-index-data.js";
import { withoutHeldForOperatorNotes, withoutRefusalNotes, withoutWaitingNotes } from "./backlog-eligibility.js";
import { writeTextAtomic } from "../files/files.js";
import { fail } from "../cli/cli-output.js";
import { trimTrailingBlankLines } from "../text/text.js";
import { withPrimaryWorktreeLock } from "../concurrency/lock.js";

/** The kind of note a release lifts, reported on every surface so the operator can tell a
 * refusal lifted from a failure-wait lifted from an operator-hold lifted. */
export type LiftableHold = "refused" | "waiting-for-failure" | "held-for-operator";

/** The prose naming the note `lifted` kind a release removed, shared by the CLI, TUI and the
 * exit-announcers so their released lines cannot drift. */
export function liftedNotePhrase(lifted: LiftableHold): string {
  return lifted === "refused"
    ? "the Refused note"
    : lifted === "waiting-for-failure"
      ? "the Waiting-for-the-next-failure note"
      : "the held-for-operator note"; // vocabulary-ok: the held-for-operator note's release wording
}

/** Drop the Refused note from `entry`'s slice of `lines`, in place, and return its kind; an
 * entry with none loses its Waiting-for-the-next-failure note instead, and one with neither
 * loses its held-for-operator Needs-review/Needs-replan note (the `(held N)` count at/above
 * threshold, plus its **Previously held N** line). Null (and `lines` untouched) when the entry
 * carries none of the three, shared by releaseEntry and tryReleaseEntry so they cannot drift. */
function liftRefusal(lines: string[], entry: ActionableEntryRange): LiftableHold | null {
  const slice = lines.slice(entry.start - 1, entry.end);
  let kept = withoutRefusalNotes(slice);
  if (kept.length === slice.length) {
    kept = withoutWaitingNotes(slice);
    if (kept.length === slice.length) {
      kept = withoutHeldForOperatorNotes(slice);
      if (kept.length === slice.length) return null;
      lines.splice(entry.start - 1, slice.length, ...kept);
      return "held-for-operator"; // vocabulary-ok: the held-for-operator note's release wording
    }
    lines.splice(entry.start - 1, slice.length, ...kept);
    return "waiting-for-failure";
  }
  lines.splice(entry.start - 1, slice.length, ...kept);
  return "refused";
}

/** What `tryReleaseEntry` did: `released` wrote the file and reports the hold it lifted;
 * `gone`, `moved` and `not_refused` refuse as data, writing nothing. */
export type ReleaseEntryOutcome =
  | { status: "released"; file: string; title: string; lifted: LiftableHold }
  | { status: "gone" }
  | { status: "moved"; title: string }
  | { status: "not_refused"; title: string };

/** The non-exiting release the dashboard calls: releaseEntry's splice with tryCancelEntry's
 * title check, all decided inside the lock. */
export function tryReleaseEntry(
  root: string,
  kind: "bug" | "plan",
  n: number,
  expectedTitle: string,
): ReleaseEntryOutcome {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withPrimaryWorktreeLock(root, () => {
    const located = locateDashboardEntry(root, fileName, sectionTitle, n, expectedTitle);
    if (located.status !== "ok") return located;
    const { file, md, entry } = located;
    const lines = md.split("\n");
    const lifted = liftRefusal(lines, entry);
    if (lifted === null) return { status: "not_refused", title: entry.title };
    writeTextAtomic(file, lines.join("\n"));
    return { status: "released", file: fileName, title: entry.title, lifted };
  });
}

/** Lift the Refused, Waiting for the next failure, or held-for-operator note from the
 * `n`th entry (1-based, as `--list` numbers them) of the kind's open section and write the
 * file, under the same lock the cancel and edit writers hold, returning which hold it lifted.
 * An out-of-range position fails with locateEntry's wording; an entry with neither note
 * fails too, writing nothing. */
export function releaseEntry(
  root: string,
  kind: "bug" | "plan",
  n: number,
): { file: string; title: string; lifted: LiftableHold } {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withPrimaryWorktreeLock(root, () => {
    const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
    const lifted = liftRefusal(lines, entry);
    if (lifted === null) fail(`${kind} #${n} "${entry.title}" carries no Refused, Waiting for the next failure, or held-for-operator note`); // vocabulary-ok: the held-for-operator note's release wording
    writeTextAtomic(file, lines.join("\n"));
    return { file: fileName, title: entry.title, lifted };
  });
}

/** Move the `n`th entry (1-based, as `--list` numbers them) of the kind's open section to the
 * head of that section and write the file, under the same lock as the other writers. Position
 * 1 fails ("is already first") and an out-of-range one fails with locateEntry's wording, both
 * writing nothing. The entry's lines move byte for byte; only the blank lines around the cut
 * and the splice are normalized, and an entry that was the file's last content leaves the file
 * ending as it did before the move (a trailing newline iff it had one). */
export function moveEntryToTop(root: string, kind: "bug" | "plan", n: number): { file: string; title: string } {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withPrimaryWorktreeLock(root, () => {
    const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
    if (n === 1) fail(`${kind} #1 "${entry.title}" is already first`);
    spliceEntryToTop(lines, sectionTitle, entry);
    writeTextAtomic(file, lines.join("\n"));
    return { file: fileName, title: entry.title };
  });
}

/** Cut `entry` out of `lines` and put it at the head of the section, in place; shared by
 * moveEntryToTop and tryMoveEntryToTop so their bytes cannot drift. */
function spliceEntryToTop(lines: string[], sectionTitle: string, entry: ActionableEntryRange): void {
  const first = findEntry(lines.join("\n"), sectionTitle, 1) as ActionableEntryRange;
  const endsWithNewline = lines[lines.length - 1] === "";
  const atEof = lines.slice(entry.end).every((l) => l.trim() === "");
  const cut = lines.slice(entry.start - 1, entry.end);
  trimTrailingBlankLines(cut);
  lines.splice(entry.start - 1, entry.end - entry.start + 1);
  if (atEof) {
    trimTrailingBlankLines(lines);
    if (endsWithNewline) lines.push("");
  }
  lines.splice(first.start - 1, 0, ...cut, "");
}

/** What `tryMoveEntryToTop` did: `moved_to_top` wrote the file; `gone`, `moved` and
 * `already_first` refuse as data, writing nothing. */
export type MoveEntryOutcome =
  | { status: "moved_to_top"; file: string; title: string }
  | { status: "gone" }
  | { status: "moved"; title: string }
  | { status: "already_first"; title: string };

/** The non-exiting reorder the dashboard calls: moveEntryToTop's splice with tryReleaseEntry's
 * title check, all decided inside the lock. */
export function tryMoveEntryToTop(
  root: string,
  kind: "bug" | "plan",
  n: number,
  expectedTitle: string,
): MoveEntryOutcome {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withPrimaryWorktreeLock(root, () => {
    const located = locateDashboardEntry(root, fileName, sectionTitle, n, expectedTitle);
    if (located.status !== "ok") return located;
    const { file, md, entry } = located;
    if (n === 1) return { status: "already_first", title: entry.title };
    const lines = md.split("\n");
    spliceEntryToTop(lines, sectionTitle, entry);
    writeTextAtomic(file, lines.join("\n"));
    return { status: "moved_to_top", file: fileName, title: entry.title };
  });
}
