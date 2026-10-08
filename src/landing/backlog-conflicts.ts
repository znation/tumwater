/** Deterministic first pass over a conflicted rebase for the backlog markdown files
 * (plans/parallel-work-instances.md, "Insert-only backlog conflicts", part 3/7).
 *
 * The move guidance pastes every finished entry as the first one under `## Done` or
 * `## Fixed`, so two landings off the same base insert different entries at the same
 * location. Git's diff3 conflict for that shape has an empty base section and both sides
 * non-empty; keeping both inserted sides adds no authored bytes, so no model run is
 * needed. Anything else — the same entry edited on both sides, a code file, a deleted
 * side — goes to the pi resolver untouched. */

import fs from "node:fs";
import path from "node:path";
import { BACKLOG_FILES } from "../backlog/backlog-md.js";
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

/** Rewrite every insert-only conflict hunk in `text` and return the result, or null when any
 * hunk is not insert-only (or the markers are malformed) — the caller then leaves the file
 * for the model resolver. A hunk is insert-only when its base section is empty and both sides
 * carry lines; it is replaced by the change's (theirs) lines, a blank separator when neither
 * side already supplies one, then main's (ours) lines, so the later landing stays first. */
export function resolveInsertOnlyText(text: string): string | null {
  const lines = text.split("\n");
  const hunks = parseHunks(lines);
  if (hunks === null) return null;
  if (hunks.length === 0) return null;
  for (const hunk of hunks) {
    if (hunk.base.length !== 0 || hunk.ours.length === 0 || hunk.theirs.length === 0) return null;
  }
  // Replace from the end so earlier indices stay valid.
  for (const hunk of [...hunks].sort((a, b) => b.start - a.start)) {
    const separated =
      hunk.theirs[hunk.theirs.length - 1] === "" || hunk.ours[0] === "";
    const replacement = separated
      ? [...hunk.theirs, ...hunk.ours]
      : [...hunk.theirs, "", ...hunk.ours];
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
    i++;
    while (i < lines.length && !lines[i]!.startsWith("|||||||")) ours.push(lines[i++]!);
    if (i >= lines.length) return null; // no base marker
    i++;
    while (i < lines.length && !lines[i]!.startsWith("=======")) base.push(lines[i++]!);
    if (i >= lines.length) return null; // no separator
    i++;
    while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) theirs.push(lines[i++]!);
    if (i >= lines.length) return null; // no end marker
    hunks.push({ start, end: i, ours, base, theirs });
    i++;
  }
  return hunks;
}

/** Settle the insert-only conflicts among `files` in `wt` (plans/parallel-work-instances.md,
 * part 3/7): every conflicted repo-root PLANS.md, BUGS.md or QUESTIONS.md whose hunks are all
 * insert-only is rewritten without markers and staged. Returns the files still conflicted —
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
    // Atomic (tmp + rename): a landing process killed mid-write (SIGKILL, the timeout
    // group-kill) must leave either the conflicted file or the fully resolved one, never a
    // truncated backlog — the CLI's backlog writers (backlog-write.ts, question-commands.ts)
    // already write these unbounded-history files through this helper.
    writeTextAtomic(p, resolved);
    await git(wt, "add", "--", file);
  }
  return remaining;
}
