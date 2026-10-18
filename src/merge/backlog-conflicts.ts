/** Deterministic first pass over a conflicted rebase for the backlog markdown files
 * (plans/parallel-work-instances.md, "Insert-only backlog conflicts", part 3/7).
 *
 * Every finished entry lands as the first one under `## Done` or `## Fixed` — at the top of
 * PLANS-DONE.md or BUGS-FIXED.md once tumwater archives it (plans/backlog-archive.md) — so two
 * merges off the same base insert different entries at the same location. Git's diff3 conflict
 * for that shape has an empty base section and both sides non-empty; keeping both inserted sides
 * adds no authored bytes, so no model run is needed.
 *
 * One more shape settles the same way: inside a live `## Done`/`## Fixed` section, the change
 * added whole `### ` entries right above lines that main has since removed or rewritten — a
 * change committed before its repository's history moved to the archive, whose entries sat
 * right below the insertion point. The change's side is then its new entries followed by
 * exactly the base lines, and keeping those entries on top of main's side again adds no
 * authored bytes. Anything else — the same entry edited on both sides, a code file, a deleted
 * side — goes to the pi resolver untouched. */

import fs from "node:fs";
import path from "node:path";
import { BACKLOG_FILES, FINISHED_ARCHIVES } from "../backlog/backlog-md.js";
import { writeTextAtomic } from "../files/files.js";
import { git } from "../git/git-run.js";

/** A parsed diff3 conflict hunk: the three sides between `<<<<<<<`, `|||||||`, `=======` and
 * `>>>>>>>`. `base` is empty for an insertion both sides made at the same spot. */
interface ConflictHunk {
  start: number;
  end: number;
  ours: string[];
  base: string[];
  theirs: string[];
}

/** The lines the change inserted in `hunk`, when it is one of the two shapes this pass settles,
 * or null. Insert-only: an empty base section and both sides carrying lines — all of the
 * change's side. Entries above a rewritten history (see the module comment): the hunk sits in a
 * finished section, and the change's side is whole `### ` entries followed by exactly the base
 * lines — the part before them. */
function insertedLines(hunk: ConflictHunk, lines: readonly string[]): string[] | null {
  if (hunk.base.length === 0) return hunk.ours.length > 0 && hunk.theirs.length > 0 ? hunk.theirs : null;
  if (!inFinishedSection(lines, hunk.start) || hunk.theirs.length <= hunk.base.length) return null;
  const cut = hunk.theirs.length - hunk.base.length;
  if (hunk.theirs.slice(cut).some((line, i) => line !== hunk.base[i])) return null;
  const inserted = hunk.theirs.slice(0, cut);
  const first = inserted.find((line) => line.trim() !== "");
  return first?.startsWith("### ") ? inserted : null;
}

/** True when the nearest `## ` heading above line `at` is a finished section (`## Done` or
 * `## Fixed`), with no conflict marker in between — an earlier hunk's sides leave the section
 * unknown, so the answer is then no. */
function inFinishedSection(lines: readonly string[], at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (/^(<{7}|\|{7}|={7}|>{7})/.test(line)) return false;
    if (line.startsWith("## ")) return FINISHED_SECTIONS.has(line.slice(3).trim());
  }
  return false;
}

/** The finished sections' titles, from FINISHED_ARCHIVES. */
const FINISHED_SECTIONS = new Set<string>(FINISHED_ARCHIVES.map((a) => a.section));

/** Rewrite every settleable conflict hunk in `text` and return the result, or null when any
 * hunk is neither shape insertedLines accepts (or the markers are malformed) — the caller then
 * leaves the file for the model resolver. Each hunk is replaced by the lines the change (theirs)
 * inserted, a blank separator when neither side already supplies one, then main's (ours)
 * lines, so the later merge stays first. */
export function resolveInsertOnlyText(text: string): string | null {
  const lines = text.split("\n");
  const hunks = parseHunks(lines);
  if (hunks === null) return null;
  if (hunks.length === 0) return null;
  const inserted = hunks.map((hunk) => insertedLines(hunk, lines));
  if (inserted.some((ins) => ins === null)) return null;
  // Replace from the end so earlier indices stay valid.
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h]!;
    const theirs = inserted[h]!;
    const separated = hunk.ours.length === 0 || theirs[theirs.length - 1] === "" || hunk.ours[0] === "";
    const replacement = separated ? [...theirs, ...hunk.ours] : [...theirs, "", ...hunk.ours];
    lines.splice(hunk.start, hunk.end - hunk.start + 1, ...replacement);
  }
  return lines.join("\n");
}

/** Split `lines` into conflict hunks. Returns null when a marker sequence is malformed (an
 * unterminated hunk, or a missing `|||||||`/`=======`), so the caller can bail out. */
function parseHunks(lines: string[]): ConflictHunk[] | null {
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const start = i;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    // Consume each side up to its marker (the `<<<<<<<` line itself is skipped by starting
    // at i + 1); a missing marker means the diff3 hunk is malformed and the parse aborts.
    const afterOurs = collectUntilMarker(lines, i + 1, "|||||||", ours);
    if (afterOurs === null) return null; // no base marker
    const afterBase = collectUntilMarker(lines, afterOurs, "=======", base);
    if (afterBase === null) return null; // no separator
    const afterTheirs = collectUntilMarker(lines, afterBase, ">>>>>>>", theirs);
    if (afterTheirs === null) return null; // no end marker
    hunks.push({ start, end: afterTheirs - 1, ours, base, theirs });
    i = afterTheirs;
  }
  return hunks;
}

/** Append lines from `start` into `into` until one starts with `marker` (the marker itself is
 * consumed, not kept), and return the index just past it. Returns null when no line from
 * `start` on carries the marker — the malformed-hunk signal parseHunks turns into a bail-out.
 * The one home of the drain-until-marker step shared by parseHunks's three sides, so the
 * marker-consumption rule cannot drift between `|||||||`, `=======`, and `>>>>>>>`. */
function collectUntilMarker(
  lines: string[],
  start: number,
  marker: string,
  into: string[],
): number | null {
  let i = start;
  while (i < lines.length && !lines[i]!.startsWith(marker)) into.push(lines[i++]!);
  return i >= lines.length ? null : i + 1;
}

/** Settle the insert-only conflicts among `files` in `wt` (plans/parallel-work-instances.md,
 * part 3/7): every conflicted repo-root backlog file (BACKLOG_FILES: PLANS.md, BUGS.md,
 * QUESTIONS.md and the two archive files) whose hunks all settle is rewritten without markers and
 * staged. Returns the files still conflicted —
 * every file that was not fully settled, including non-backlog files and files with any other
 * hunk — so the caller runs the model resolver only over those. */
export async function resolveBacklogInsertConflicts(
  wt: string,
  files: readonly string[],
): Promise<string[]> {
  const remaining: string[] = [];
  for (const file of files) {
    if (path.dirname(file) !== "." || !BACKLOG_FILES.has(file)) {
      remaining.push(file);
      continue;
    }
    const p = path.join(wt, file);
    let text: string;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      remaining.push(file); // deleted side or unreadable path — leave it to the resolver
      continue;
    }
    const resolved = resolveInsertOnlyText(text);
    if (resolved === null) {
      remaining.push(file);
      continue;
    }
    // Atomic (tmp + rename): a merge process killed mid-write (SIGKILL, the timeout
    // group-kill) must leave either the conflicted file or the fully resolved one, never a
    // truncated backlog — the CLI's backlog writers (backlog-write.ts, question-answer.ts)
    // already write these unbounded-history files through this helper.
    writeTextAtomic(p, resolved);
    await git(wt, "add", "--", file);
  }
  return remaining;
}
