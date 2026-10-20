/** The hold-lifting and reordering writes of `tumwater bug|plan --release <n>` and `--top <n>`:
 * lift an entry's Refused or Waiting-for-the-next-failure note, or move it to the head of its open
 * section. Each comes as an exiting writer (the CLI) and a non-exiting `try…` core that refuses as
 * data (the TUI and dashboard); entry lookup and the section's file target are
 * backlog-write.ts's. */
import path from "node:path";
import { backlogTarget, findEntry, readEntryLines } from "./backlog-write.js";
import type { ActionableEntryRange } from "./backlog-structure.js";
import { withoutRefusalNotes, withoutWaitingNotes } from "./backlog-eligibility.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { fail } from "../cli/cli-output.js";
import { trimTrailingBlankLines } from "../text/text.js";
import { withPrimaryWorktreeLock } from "../concurrency/lock.js";

/** Drop the Refused note from `entry`'s slice of `lines`, in place; an entry with none loses its
 * Waiting-for-the-next-failure note instead. False (and `lines` untouched) when the entry
 * carries neither; shared by releaseEntry and tryReleaseEntry so they cannot
 * drift. */
function liftRefusal(lines: string[], entry: ActionableEntryRange): boolean {
  const slice = lines.slice(entry.start - 1, entry.end);
  let kept = withoutRefusalNotes(slice);
  if (kept.length === slice.length) kept = withoutWaitingNotes(slice);
  if (kept.length === slice.length) return false;
  lines.splice(entry.start - 1, slice.length, ...kept);
  return true;
}

/** What `tryReleaseEntry` did: `released` wrote the file; `gone`, `moved` and `not_refused`
 * refuse as data, writing nothing. */
export type ReleaseEntryOutcome =
  | { status: "released"; file: string; title: string }
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
    const file = path.join(root, fileName);
    const md = readTextIfExists(file) ?? "";
    const entry = findEntry(md, sectionTitle, n);
    if (entry === undefined) return { status: "gone" };
    if (entry.title !== expectedTitle) return { status: "moved", title: entry.title };
    const lines = md.split("\n");
    if (!liftRefusal(lines, entry)) return { status: "not_refused", title: entry.title };
    writeTextAtomic(file, lines.join("\n"));
    return { status: "released", file: fileName, title: entry.title };
  });
}

/** Lift the Refused or Waiting for the next failure note from the
 * `n`th entry (1-based, as `--list` numbers them) of the kind's open section and write the
 * file, under the same lock the cancel and edit writers hold.
 * An out-of-range position fails with locateEntry's wording; an entry with neither note
 * fails too, writing nothing. */
export function releaseEntry(root: string, kind: "bug" | "plan", n: number): { file: string; title: string } {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withPrimaryWorktreeLock(root, () => {
    const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
    if (!liftRefusal(lines, entry)) fail(`${kind} #${n} "${entry.title}" carries no Refused or Waiting for the next failure note`);
    writeTextAtomic(file, lines.join("\n"));
    return { file: fileName, title: entry.title };
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
    const file = path.join(root, fileName);
    const md = readTextIfExists(file) ?? "";
    const entry = findEntry(md, sectionTitle, n);
    if (entry === undefined) return { status: "gone" };
    if (entry.title !== expectedTitle) return { status: "moved", title: entry.title };
    if (n === 1) return { status: "already_first", title: entry.title };
    const lines = md.split("\n");
    spliceEntryToTop(lines, sectionTitle, entry);
    writeTextAtomic(file, lines.join("\n"));
    return { status: "moved_to_top", file: fileName, title: entry.title };
  });
}
