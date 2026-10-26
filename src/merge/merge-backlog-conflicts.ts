/** Deterministic first pass over a conflicted rebase for the backlog markdown files
 * (plans/parallel-work-instances.md, "Insert-only backlog conflicts", part 3/7).
 *
 * Every finished entry lands as the first one under `## Done` or `## Fixed` — at the top of
 * PLANS-DONE.md or BUGS-FIXED.md once tumwater archives it (plans/backlog-archive.md) — so two
 * merges off the same base insert different entries at the same location. Git's diff3 conflict
 * for that shape has an empty base section and both sides non-empty; keeping both inserted sides
 * adds no authored bytes, so no model run is needed.
 *
 * Two more shapes settle the same way:
 * - Entries above a deleted entry, in any `## ` section: one side added whole `### ` entries
 *   right above an entry the other side deleted. Typically the plan role prepends a plan on
 *   main while the change finishes the plan below it into PLANS-DONE.md, or the other way
 *   round. The inserting side is its new entries followed by exactly the base lines and the
 *   deleting side is empty, so the new entries alone carry both sides' edits.
 * - Entries above a rewritten history: inside a live `## Done`/`## Fixed` section, the change
 *   added whole `### ` entries right above lines that main has since rewritten — a change
 *   committed before its repository's history moved to the archive, whose entries sat right
 *   below the insertion point. The change's side is then its new entries followed by exactly
 *   the base lines, and keeping those entries on top of main's side again adds no authored
 *   bytes.
 * A fourth shape settles entry by entry instead of hunk by hunk (mergeBacklogEntries): each side
 * finished or added different whole entries, so git's hunks cut through entries and match none
 * of the shapes above. It reads the three index stages of PLANS.md, BUGS.md and QUESTIONS.md,
 * not the hunks.
 * Anything else — the same entry edited on both sides, a code file, a file one side deleted —
 * goes to the pi resolver untouched. */

import fs from "node:fs";
import path from "node:path";
import { BACKLOG_FILES, FINISHED_ARCHIVES, fenceTracker } from "../backlog/backlog-md.js";
import { readTextOrNull, writeTextAtomic } from "../files/files.js";
import { git, gitTry } from "../git/git-run.js";

/** A parsed diff3 conflict hunk: the three sides between `<<<<<<<`, `|||||||`, `=======` and
 * `>>>>>>>`. `base` is empty for an insertion both sides made at the same spot. */
interface ConflictHunk {
  start: number;
  end: number;
  ours: string[];
  base: string[];
  theirs: string[];
}

/** The lines that replace `hunk`, when it is one of the shapes this pass settles (see the
 * module comment), or null. Insert-only: an empty base section and both sides carrying lines —
 * the change's side stacked on main's. Entries above a deleted entry: one side empty, the other
 * whole `### ` entries followed by exactly the base lines — those entries alone. Entries above
 * a rewritten history: the hunk sits in a finished section, and the change's side is whole
 * `### ` entries followed by exactly the base lines — those entries stacked on main's side. */
function settledLines(hunk: ConflictHunk, lines: readonly string[]): string[] | null {
  if (hunk.base.length === 0) {
    return hunk.ours.length > 0 && hunk.theirs.length > 0 ? stacked(hunk.theirs, hunk.ours) : null;
  }
  if (hunk.theirs.length === 0) return entriesAboveBase(hunk.ours, hunk.base);
  if (hunk.ours.length === 0) return entriesAboveBase(hunk.theirs, hunk.base);
  if (!inFinishedSection(lines, hunk.start)) return null;
  const inserted = entriesAboveBase(hunk.theirs, hunk.base);
  return inserted === null ? null : stacked(inserted, hunk.ours);
}

/** The lines `side` adds above the `base` lines, when `side` is whole `### ` entries followed
 * by exactly those base lines, or null — a side no longer than the base, a base line changed or
 * missing, or added lines that do not open at a `### ` heading. */
function entriesAboveBase(side: readonly string[], base: readonly string[]): string[] | null {
  if (side.length <= base.length) return null;
  const cut = side.length - base.length;
  if (side.slice(cut).some((line, i) => line !== base[i])) return null;
  const inserted = side.slice(0, cut);
  const first = inserted.find((line) => line.trim() !== "");
  return first?.startsWith("### ") ? inserted : null;
}

/** `upper` then `lower`, with a blank separator when neither already supplies one, so the
 * later merge (the change, `upper`) stays first. */
function stacked(upper: readonly string[], lower: readonly string[]): string[] {
  const separated = lower.length === 0 || upper[upper.length - 1] === "" || lower[0] === "";
  return separated ? [...upper, ...lower] : [...upper, "", ...lower];
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
 * hunk is no shape settledLines accepts (or the markers are malformed) — the caller then
 * leaves the file for the model resolver. Each hunk is replaced by settledLines' lines. */
export function resolveInsertOnlyText(text: string): string | null {
  const lines = text.split("\n");
  const hunks = parseHunks(lines);
  if (hunks === null) return null;
  if (hunks.length === 0) return null;
  const settled = hunks.map((hunk) => settledLines(hunk, lines));
  if (settled.some((replacement) => replacement === null)) return null;
  // Replace from the end so earlier indices stay valid.
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h]!;
    lines.splice(hunk.start, hunk.end - hunk.start + 1, ...settled[h]!);
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

/** A backlog text split into blocks: the preamble before the first `## ` line, then per
 * section its header block and its `### ` entries (heading line to the next heading), each
 * block with trailing blank lines removed. */
interface ParsedBacklog {
  preamble: string;
  sections: { header: string; entries: { key: string; text: string }[] }[];
}

/** Split `text` into ParsedBacklog blocks, or null when a fence is still open at EOF or a
 * section holds two entries with the same heading line. */
function parseBacklogBlocks(text: string): ParsedBacklog | null {
  const fenced = fenceTracker();
  const parsed: ParsedBacklog = { preamble: "", sections: [] };
  let current: string[] = [];
  let flush: (block: string) => void = (block) => {
    parsed.preamble = block;
  };
  const close = (): void => {
    while (current.length > 0 && current[current.length - 1]!.trim() === "") current.pop();
    flush(current.join("\n"));
    current = [];
  };
  for (const line of text.split("\n")) {
    const structural = !fenced.inside(line);
    if (structural && line.startsWith("## ")) {
      close();
      const section: ParsedBacklog["sections"][number] = { header: "", entries: [] };
      parsed.sections.push(section);
      flush = (block) => {
        section.header = block;
      };
    } else if (structural && line.startsWith("### ") && parsed.sections.length > 0) {
      close();
      const section = parsed.sections[parsed.sections.length - 1]!;
      flush = (block) => section.entries.push({ key: line, text: block });
      // The entry's heading line is `line` itself; the closure above captured it.
    }
    current.push(line);
  }
  if (fenced.open()) return null;
  close();
  for (const section of parsed.sections) {
    if (new Set(section.entries.map((e) => e.key)).size !== section.entries.length) return null;
  }
  return parsed;
}

/** The one text all three versions agree on after at most one side's edit: the changed side
 * when only one changed, else the shared text, or null when both changed differently. */
function settleBlock(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) return ours;
  return ours === base ? theirs : null;
}

/** Merge one section's entries (see mergeBacklogEntries), or null on a same-entry conflict. */
function mergeSectionEntries(
  base: ParsedBacklog["sections"][number]["entries"],
  ours: ParsedBacklog["sections"][number]["entries"],
  theirs: ParsedBacklog["sections"][number]["entries"],
): { key: string; text: string }[] | null {
  const baseBy = new Map(base.map((e) => [e.key, e.text]));
  const theirsBy = new Map(theirs.map((e) => [e.key, e.text]));
  const oursKeys = new Set(ours.map((e) => e.key));
  const result: { key: string; text: string }[] = [];
  for (const { key, text: o } of ours) {
    const b = baseBy.get(key);
    const t = theirsBy.get(key);
    if (b === undefined) {
      if (t !== undefined && t !== o) return null;
      result.push({ key, text: o });
    } else if (t === undefined) {
      if (o !== b) return null; // main edited what the change deleted
    } else {
      const settled = settleBlock(b, o, t);
      if (settled === null) return null;
      result.push({ key, text: settled });
    }
  }
  // An entry main deleted stays deleted, unless the change edited it.
  for (const { key, text: b } of base) {
    const t = theirsBy.get(key);
    if (!oursKeys.has(key) && t !== undefined && t !== b) return null;
  }
  for (let i = 0; i < theirs.length; i++) {
    const added = theirs[i]!;
    if (baseBy.has(added.key) || oursKeys.has(added.key)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const found = result.findIndex((e) => e.key === theirs[j]!.key);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    result.splice(at, 0, added);
  }
  return result;
}

/** Merge three versions of a backlog file entry by entry — `ours` is main, `theirs` the change —
 * or null when that cannot be done without judgment: an open fence, a duplicate entry heading,
 * differing `## ` heading sequences, a preamble or section header both sides changed, or the
 * same entry edited on both sides (or edited by one side and deleted by the other). */
export function mergeBacklogEntries(base: string, ours: string, theirs: string): string | null {
  const [b, o, t] = [base, ours, theirs].map(parseBacklogBlocks);
  if (!b || !o || !t) return null;
  const count = b.sections.length;
  if (o.sections.length !== count || t.sections.length !== count) return null;
  const blocks: string[] = [];
  const preamble = settleBlock(b.preamble, o.preamble, t.preamble);
  if (preamble === null) return null;
  if (preamble !== "") blocks.push(preamble);
  for (let i = 0; i < count; i++) {
    const [bs, os, ts] = [b.sections[i]!, o.sections[i]!, t.sections[i]!];
    const heading = (header: string): string => header.split("\n")[0]!;
    if (heading(bs.header) !== heading(os.header) || heading(bs.header) !== heading(ts.header)) {
      return null;
    }
    const header = settleBlock(bs.header, os.header, ts.header);
    const entries = mergeSectionEntries(bs.entries, os.entries, ts.entries);
    if (header === null || entries === null) return null;
    blocks.push(header, ...entries.map((e) => e.text));
  }
  return `${blocks.join("\n\n")}\n`;
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
    // lstat, not stat: a symlink among the conflicted files is never followed out of the
    // worktree (INV-G3 — a symlink holds no text of its own and its target could point out
    // of it, so what a change that adds one put there is the link, not the target). Leaving
    // it to the pi resolver keeps the same policy the conflict-marker and secret-leak gates
    // pin: the resolver, like those gates, must not read an arbitrary host file.
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      remaining.push(file); // deleted side or unreadable path — leave it to the resolver
      continue;
    }
    if (!st.isFile()) {
      remaining.push(file); // symlink, directory or gitlink — leave it to the resolver
      continue;
    }
    const text = readTextOrNull(p);
    if (text === null) {
      remaining.push(file); // deleted side or unreadable path — leave it to the resolver
      continue;
    }
    const resolved = resolveInsertOnlyText(text) ?? (await mergeStagedEntries(wt, file));
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

/** The entry-by-entry merge of `file`'s three index stages (1 base, 2 main, 3 the change), or
 * null for an archive file, a stage missing on one side, or a merge needing judgment. */
async function mergeStagedEntries(wt: string, file: string): Promise<string | null> {
  if (FINISHED_ARCHIVES.some((a) => a.archive === file)) return null;
  const base = await gitTry(wt, "show", `:1:${file}`);
  const ours = await gitTry(wt, "show", `:2:${file}`);
  const theirs = await gitTry(wt, "show", `:3:${file}`);
  if (base === null || ours === null || theirs === null) return null;
  return mergeBacklogEntries(base, ours, theirs);
}
