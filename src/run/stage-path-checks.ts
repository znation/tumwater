/** The git-level, language-neutral findings of the staging self-check, split from
 * stage-check.ts (which gathers them with the merge gate's own checks): path drift after a
 * rename or delete, added lines naming paths absent from the resulting tree, lost final
 * newlines, a compound name the change removed that a comment still names, doc comments
 * separated from their declaration, a moved-source file whose old path is still named, and
 * garbled run wording. `gitLevelFindings` stages the change (`git add -A`) to read the index,
 * then restores the index to HEAD; the checks skip record prose (isRecordProse), where an old
 * or not-yet-created path is correct as written. The gate does not run any of them. */

import path from "node:path";
import { changeBaseRev } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { readTextOrNull } from "../files/files.js";
import { BACKLOG_FILES } from "../backlog/backlog-md.js";
import { moreSuffix } from "../text/phrases.js";

/** How many `file:line` hits a single stale-reference finding lists before it stops. */
const MAX_STALE_HITS = 10;
/** How many renamed/deleted paths each stale-reference finding reports before stopping — the
 * cap that keeps a 40-file rename to a bounded finding list. */
const MAX_STALE_PATHS = 10;
/** How many nonexistent added paths one finding names before it stops. */
const MAX_MISSING_PATHS = 10;
/** How many files one lost-final-newline finding names before it stops. */
const MAX_NEWLINE_FILES = 10;
/** How many `file:line` sites one detached-doc finding names before it stops. */
const MAX_DETACHED_DOCS = 10;
/** The shortest trimmed line that counts toward a move, so braces and `});` never do. */
const MOVED_LINE_MIN_CHARS = 12;
/** How many moved lines make a modified file a move source. */
const MOVED_LINES_MIN = 10;

/** The path a unified diff's `+++ b/<path>` header names. Strips the four-character `+++ `
 * marker and git's `b/` prefix. A deleted file's new side is `+++ /dev/null`, which carries no
 * `b/` prefix and is returned as `/dev/null`. */
function diffPlusPath(line: string): string {
  return line.slice(4).replace(/^b\//, "");
}

/** True for record prose: a backlog file (BACKLOG_FILES: PLANS.md, BUGS.md, QUESTIONS.md and the
 * finished-entry archives) or a markdown design doc under `plans/`. They record history and
 * describe planned work, so a path there is correct as written even when it is absent from the
 * tree: a finished entry names a file as it was, and a plan names the file it will create or
 * both sides of the move it describes. Asking a rename to sweep them rewrote "old → new" into
 * "new → new" and history into the present; that failure took five rejections on
 * one rename on 2026-10-18 and -19. */
function isRecordProse(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return BACKLOG_FILES.has(base) || (file.startsWith("plans/") && file.endsWith(".md"));
}

/** The capped list a finding line appends: at most `max` entries joined by ", ", then
 * `moreSuffix` for the rest. Shared by the missing-path and lost-final-newline findings so both
 * cap and join identically. */
function cappedList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max);
  return `${shown.join(", ")}${moreSuffix(items.length - shown.length)}`;
}


/** One `git diff --name-status -M` entry: the status letter (`A`/`M`/`D`/`R`/`C`/`T`), the
 * destination (current) path, and — for a rename or copy — the origin path. */
interface NameStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
}

/** Parse `git diff --cached -M --name-status` output: `M\tpath`, `D\tpath`, or
 * `R100\told\tnew`. Malformed lines are skipped. */
function parseNameStatus(out: string | null): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of (out ?? "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    if (!status) continue;
    if (status === "R" || status === "C") {
      const oldPath = parts[1];
      const path = parts[2];
      if (oldPath && path) entries.push({ status, path, oldPath });
    } else if (parts[1]) {
      entries.push({ status, path: parts[1] });
    }
  }
  return entries;
}

/** Stage the change and run the three git-level path checks over the resulting index, then
 * restore the index to HEAD so the staging is invisible to the run's own change detection.
 * Each check is best-effort: a failed git command contributes nothing. */
export async function gitLevelFindings(wt: string, mainBranch: string): Promise<string[]> {
  await gitTry(wt, "add", "-A");
  try {
    const base = await changeBaseRev(wt, mainBranch);
    const entries = parseNameStatus(await gitTry(wt, "diff", "--cached", "-M", "--name-status", base));
    const findings = await staleReferenceFindings(wt, entries);
    const diff = (await gitTry(wt, "diff", "--cached", "-U0", base)) ?? "";
    findings.push(...(await missingPathFindings(wt, diff, entries)));
    findings.push(...newlineFindings(diff));
    findings.push(...garbledWordingFindings(diff));
    findings.push(...(await detachedDocFindings(wt, diff)));
    findings.push(...(await staleNameFindings(wt, diff)));
    findings.push(...(await movedSourceFindings(wt, diff, entries)));
    return findings;
  } finally {
    // Restore the index to HEAD. Without this, the run's change detection (changedFiles and
    // stageRunMerge's "nothing left to merge" guard) reads the stale index and reports a
    // fix-up that reverted the whole change as still changed, so an empty tree would reach
    // commitAll instead of the run ending no_change.
    await gitTry(wt, "reset");
  }
}

/** A line that can carry a doc comment: a keyword declaration or a class member or field. */
const DOC_TARGET = new RegExp(
  "^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?" +
    "(?:function\\b|const\\b|let\\b|var\\b|class\\b|interface\\b|type\\b|enum\\b)" +
    "|^\\s*(?:(?:public|private|protected|static|readonly|async|get|set|override)\\s+)*" +
    "#?[A-Za-z_$][\\w$]*\\??\\s*[(<:=]",
);

/** True when `lines[i]` (0-based) ends a JSDoc block: it ends with a block-comment close and the
 * nearest line at or above it containing a block-comment open starts, trimmed, with `/**`. */
function closesDocComment(lines: string[], i: number): boolean {
  if (!(lines[i] ?? "").trim().endsWith("*/")) return false;
  for (let j = i; j >= 0; j--) {
    if (lines[j]!.includes("/*")) return lines[j]!.trim().startsWith("/**");
  }
  return false;
}

/** (e) Doc comments the change detached from their declaration, read from the `-U0` diff of
 * JS/TS files. Insertion: a pure-add hunk lands code between a doc block and the declaration
 * below it, so the doc now describes the inserted code. Deletion: a pure-delete hunk removes a
 * declaration but leaves the doc block above it, which then documents the next declaration. */
async function detachedDocFindings(wt: string, diff: string): Promise<string[]> {
  interface Hunk {
    c: number;
    d: number;
    removed: string[];
    added: string[];
  }
  const inserted: string[] = [];
  const deleted: string[] = [];
  const check = (file: string, hunks: Hunk[], lines: string[]): void => {
    const addedAt = new Set<number>();
    for (const h of hunks) for (let k = 0; k < h.d; k++) addedAt.add(h.c + k);
    for (const h of hunks) {
      if (h.removed.length === 0 && h.d > 0) {
        const target = lines[h.c + h.d - 1];
        if (
          h.c >= 2 && !addedAt.has(h.c - 1) && closesDocComment(lines, h.c - 2) &&
          h.added.some((l) => DOC_TARGET.test(l)) && target !== undefined && DOC_TARGET.test(target)
        ) inserted.push(`${file}:${h.c - 1}`);
      } else if (h.d === 0 && h.removed.some((l) => DOC_TARGET.test(l))) {
        if (h.c >= 1 && !addedAt.has(h.c) && closesDocComment(lines, h.c - 1)) deleted.push(`${file}:${h.c}`);
      }
    }
  };
  let file: string | null = null;
  let hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = async (): Promise<void> => {
    if (file !== null && hunks.length > 0) {
      const text = readTextOrNull(path.join(wt, file));
      if (text !== null) check(file, hunks, text.split("\n"));
    }
    file = null;
    hunks = [];
    cur = null;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      await flush();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = diffPlusPath(line);
      file = p !== "/dev/null" && JS_FILE.test(p) ? p : null;
      continue;
    }
    if (file === null) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { c: Number(m[1]), d: m[2] === undefined ? 1 : Number(m[2]), removed: [], added: [] };
      hunks.push(cur);
    } else if (cur && line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (cur && line.startsWith("+")) cur.added.push(line.slice(1));
  }
  await flush();
  const findings: string[] = [];
  if (inserted.length > 0) {
    findings.push(
      `code was inserted between a doc comment and the declaration it documents, so the doc now describes the inserted code: ${cappedList(inserted, MAX_DETACHED_DOCS)} — move the inserted code above the doc comment or below that declaration`,
    );
  }
  if (deleted.length > 0) {
    findings.push(
      `a declaration was deleted but its doc comment was kept, so the doc now documents the next declaration: ${cappedList(deleted, MAX_DETACHED_DOCS)} — delete the doc comment with it`,
    );
  }
  return findings;
}

/** How many removed identifiers one stale-name check looks up. */
const MAX_STALE_NAMES = 40;

const JS_FILE = /\.(?:ts|tsx|js|mjs)$/;

/** The identifiers a source line declares: keyword declarations (`function`, `const`, `let`,
 * `var`, `class`, `interface`, `type`, `enum`) and a property or field signature at the start of
 * the line. A call line declares nothing. */
export function declaredNames(line: string): string[] {
  const names: string[] = [];
  const keyword = /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of line.matchAll(keyword)) names.push(m[1]!);
  const field = /^\s*(?:(?:readonly|public|private|protected|static)\s+)*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
  if (field) names.push(field[1]!);
  return names;
}

/** True for a name worth looking up: camelCase/PascalCase (a lowercase letter then an uppercase
 * one) or UPPER_SNAKE with an underscore, so common words never count. */
function isCompoundName(name: string): boolean {
  return /[a-z][A-Z]/.test(name) || /^[A-Z0-9_]+$/.test(name) && name.includes("_");
}

/** True when the occurrence starting at `index` sits inside a closed `"…"` or `'…'` literal on
 * `line`. An unclosed quote (an apostrophe in prose) does not count. */
function insideStringLiteral(line: string, index: number): boolean {
  let open: string | null = null;
  let openAt = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (open === null) {
      if (c === '"' || c === "'") {
        open = c;
        openAt = i;
      }
    } else if (c === "\\") {
      i++;
    } else if (c === open) {
      if (openAt < index && index < i) return true;
      open = null;
    }
  }
  return false;
}

/** (d) Compound identifiers the change removed from JS/TS source that a comment or doc still
 * names. Candidates come from removed `-U0` lines; one `git grep -w --cached` covers them all. */
async function staleNameFindings(wt: string, diff: string): Promise<string[]> {
  const removed: string[] = [];
  const added = new Set<string>();
  let jsFile = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      jsFile = JS_FILE.test(header[1]!);
      continue;
    }
    if (!jsFile) continue;
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push(...declaredNames(line.slice(1)));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const n of declaredNames(line.slice(1))) added.add(n);
    }
  }
  const candidates = [...new Set(removed)]
    .filter((n) => isCompoundName(n) && !added.has(n))
    .slice(0, MAX_STALE_NAMES);
  if (candidates.length === 0) return [];
  const out = await gitTry(wt, "grep", "-n", "-w", "-I", "--cached", ...candidates.flatMap((n) => ["-e", n]));
  if (!out) return [];
  const lines: { file: string; no: string; text: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m) lines.push({ file: m[1]!, no: m[2]!, text: m[3] ?? "" });
  }
  const findings: string[] = [];
  for (const name of candidates) {
    if (findings.length >= MAX_STALE_PATHS) break;
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const mine = lines.filter((l) => [...l.text.matchAll(word)].length > 0);
    // Another module may still own the name.
    if (mine.some((l) => JS_FILE.test(l.file) && declaredNames(l.text).includes(name))) continue;
    const hits: string[] = [];
    for (const l of mine) {
      if (isRecordProse(l.file) || l.text.includes("retired-name-ok")) continue;
      if ([...l.text.matchAll(word)].some((m) => !insideStringLiteral(l.text, m.index))) {
        hits.push(`${l.file}:${l.no}`);
      }
    }
    if (hits.length === 0) continue;
    findings.push(
      `\`${name}\` was removed by this change but is still named at: ${cappedList(hits, MAX_STALE_HITS)}`,
    );
  }
  return findings;
}

/** (f) References to a file the change moved code out of. A modified (`M`) file is a source
 * when at least MOVED_LINES_MIN of its removed `-U0` lines (trimmed, at least MOVED_LINE_MIN_CHARS
 * long) were added verbatim to another file. Each hit of the source's path outside record prose
 * and the source itself, including in a receiver, is listed for the author to re-check. */
async function movedSourceFindings(
  wt: string,
  diff: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const files = new Map<string, { removed: string[]; added: Set<string> }>();
  let cur: { removed: string[]; added: Set<string> } | undefined;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      cur = { removed: [], added: new Set() };
      files.set(header[1]!, cur);
      continue;
    }
    if (!cur) continue;
    const isRemoved = line.startsWith("-") && !line.startsWith("---");
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    if (!isRemoved && !isAdded) continue;
    const text = line.slice(1).trim();
    if (text.length < MOVED_LINE_MIN_CHARS) continue;
    if (isRemoved) cur.removed.push(text);
    else cur.added.add(text);
  }
  const findings: string[] = [];
  for (const e of entries) {
    if (e.status !== "M") continue;
    if (findings.length >= MAX_STALE_PATHS) break;
    const src = files.get(e.path);
    if (!src) continue;
    const others = [...files].filter(([f]) => f !== e.path);
    const receivers = others
      .filter(([, v]) => src.removed.some((l) => v.added.has(l)))
      .map(([f]) => f);
    const moved = src.removed.filter((l) => others.some(([, v]) => v.added.has(l))).length;
    if (moved < MOVED_LINES_MIN) continue;
    const out = await gitTry(wt, "grep", "-n", "-F", "-I", "--cached", "-e", e.path);
    if (!out) continue;
    const hits: string[] = [];
    for (const line of out.split("\n")) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m || m[1] === e.path || isRecordProse(m[1]!)) continue;
      if (!hasStandalonePathOccurrence(m[3] ?? "", e.path)) continue;
      hits.push(`${m[1]}:${m[2]}`);
      if (hits.length >= MAX_STALE_HITS) break;
    }
    if (hits.length === 0) continue;
    findings.push(
      `${e.path} had ${moved} lines moved to ${cappedList(receivers, MAX_STALE_PATHS)}, but it is ` +
        `still named at: ${hits.join(", ")} — check each still describes what stays in ${e.path}, ` +
        `and point any that describes the moved code at its new file`,
    );
  }
  return findings;
}

/** (a) References left behind by a rename or delete: for each `D` path and each `R` origin,
 * `git grep --cached` the old path across the staged tree and report up to MAX_STALE_HITS
 * `file:line` hits outside record prose (isRecordProse). Renames report the path they moved to;
 * deletes report the deletion. */
async function staleReferenceFindings(
  wt: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const findings: string[] = [];
  let reported = 0;
  for (const e of entries) {
    if (e.status !== "D" && e.status !== "R") continue;
    if (reported >= MAX_STALE_PATHS) break;
    const old = e.oldPath ?? e.path;
    // `git grep` exits 1 with no output when nothing matches — the common, clean case — and
    // gitTry maps that to null exactly as it maps a real failure, both of which mean "no hits".
    const out = await gitTry(wt, "grep", "-n", "-F", "-I", "--cached", "-e", old);
    if (!out) continue;
    const hits: string[] = [];
    for (const line of out.split("\n")) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m || isRecordProse(m[1]!) || !hasStandalonePathOccurrence(m[3] ?? "", old)) continue;
      hits.push(`${m[1]}:${m[2]}`);
      if (hits.length >= MAX_STALE_HITS) break;
    }
    if (hits.length === 0) continue;
    const moved = e.status === "R" ? `was renamed to ${e.path}` : "was deleted";
    findings.push(`${old} ${moved} but is still named at: ${hits.join(", ")}`);
    reported++;
  }
  return findings;
}

/** True when `needle` appears in `line` as a repo path of its own — not as one segment of a
 * longer path. `git grep -F` matches substrings, so a line naming a rename's destination
 * (`src/<dir>/config.ts`) would otherwise read as a stale reference to an old root `config.ts`.
 * A preceding path character (or a following one that continues the token, as a `.` extension
 * or an alphanumeric does) disqualifies the occurrence; trailing sentence punctuation does not. */
function hasStandalonePathOccurrence(line: string, needle: string): boolean {
  const pathChar = /[A-Za-z0-9_./-]/;
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) {
    const before = i > 0 ? line[i - 1]! : "";
    if (before && pathChar.test(before)) continue;
    const after = line[i + needle.length] ?? "";
    if (/[A-Za-z0-9_/-]/.test(after)) continue;
    if (after === "." && /[A-Za-z0-9]/.test(line[i + needle.length + 1] ?? "")) continue;
    return true;
  }
  return false;
}

/** Each distinct path-shaped token in `text`, in first-appearance order: at least one slash and
 * a final `.<ext>` segment. Scanned inside the text (not whitespace-split) so surrounding
 * backticks, brackets, and sentence punctuation fall away with the match. */
export function pathTokens(text: string): string[] {
  const tokenRe = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g;
  return [...new Set([...text.matchAll(tokenRe)].map((m) => m[0]))];
}

/** (b) Nonexistent paths: every path-shaped token on an added diff line whose first segment is
 * a tracked top-level directory but which is absent from the staged tree. Rename origins and
 * deleted paths are excluded — "moved from X" prose names them legitimately. */
async function missingPathFindings(
  wt: string,
  diff: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const ls = await gitTry(wt, "ls-files");
  const staged = new Set<string>();
  const topDirs = new Set<string>();
  for (const p of (ls ?? "").split("\n")) {
    if (!p) continue;
    staged.add(p);
    const slash = p.indexOf("/");
    if (slash > 0) topDirs.add(p.slice(0, slash));
  }
  const oldPaths = new Set<string>();
  for (const e of entries) {
    if (e.oldPath) oldPaths.add(e.oldPath);
    if (e.status === "D") oldPaths.add(e.path);
  }
  const seen = new Set<string>();
  const missing: string[] = [];
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = diffPlusPath(line);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    // A test file's fixtures routinely name paths from the software under test, which need
    // not exist here, and record prose names the paths a plan proposes to create; the
    // added-nonexistent-path heuristic targets real references, so it spares added lines in
    // test/ and in record prose (isRecordProse).
    if (file !== null && (file.startsWith("test/") || isRecordProse(file))) continue;
    for (const p of pathTokens(line.slice(1))) {
      const top = p.slice(0, p.indexOf("/"));
      if (!topDirs.has(top) || oldPaths.has(p) || staged.has(p) || seen.has(p)) continue;
      seen.add(p);
      missing.push(p);
    }
  }
  if (missing.length === 0) return [];
  return [
    `added lines name paths that do not exist in the tree: ${cappedList(missing, MAX_MISSING_PATHS)}`,
  ];
}

/** (c) Lost final newlines: a text file whose new diff side carries git's
 * `\ No newline at end of file` marker while its base side does not. Git emits the marker
 * immediately after the line it applies to, so a marker after a `+` line flags the new side and
 * one after a `-` line flags the base side; a new file (`+` only) counts. Binary files have no
 * line hunks and never appear. */
function newlineFindings(diff: string): string[] {
  const files: string[] = [];
  let path: string | null = null;
  let newLacks = false;
  let oldLacks = false;
  let prev = "";
  const flush = (): void => {
    if (path !== null && newLacks && !oldLacks) files.push(path);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = null;
      newLacks = false;
      oldLacks = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = diffPlusPath(line);
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      if (prev.startsWith("+")) newLacks = true;
      else if (prev.startsWith("-")) oldLacks = true;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) prev = line;
  }
  flush();
  if (files.length === 0) return [];
  return [`the change removes the final newline from: ${cappedList(files, MAX_NEWLINE_FILES)}`];
}

/** Patterns for the garbled English a rote "tick" → "run" word swap leaves, in order: a broken
 * past participle after an auxiliary, "ran" hyphenated onto another word (the class stays a
 * letter range so this line does not match itself), "run" followed by a form of "to be" and
 * "running", and "run" stacked directly on "run". Three more patterns catch "run" followed by
 * "run", "runs" or "running"; a possessive run followed, with at most one word between, by
 * "run" or "runs" (not when that word is "agent", the wording the rename series prescribes); and
 * "run" joined to "run" by "and" or "or". */
const GARBLED_WORDING: readonly RegExp[] = [
  /\b(?:has|have|had|having)\s+(?:\w+ly\s+|never\s+|not\s+|already\s+|just\s+)?ran\b/i,
  /[A-Za-z]-ran\b/i,
  /\bruns?\s+(?:is|are|was|were|already|still)\s+(?:still\s+|already\s+)?running\b/i,
  /\b(?:run|runs|running)\s+(?:a|the|no)\s+run\b/i,
  /\bruns?\s+run(?:s|ning)?\b/i,
  /\bruns?'s?\s+(?:(?!agent\b)[a-z]+\s+)?runs?\b/i,
  /\bruns?\s+(?:and|or)\s+runs?\b/i,
];

/** The first GARBLED_WORDING match in `joined` that starts before `joinAt` and ends after it. */
function spanningGarbled(joined: string, joinAt: number): string | null {
  for (const re of GARBLED_WORDING) {
    const g = new RegExp(re.source, re.flags + "g");
    for (const m of joined.matchAll(g)) {
      if (m.index < joinAt && m.index + m[0].length > joinAt) return m[0];
    }
  }
  return null;
}

/** (e) Added lines, outside record prose, that match GARBLED_WORDING: at most one hit per line,
 * reported as `file:line "matched text"` in a single finding. A phrase split across two
 * consecutive added lines is reported as `file:N-M`. */
function garbledWordingFindings(diff: string): string[] {
  const hits: string[] = [];
  let file: string | null = null;
  let lineNo = 0;
  let prevAdded: string | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      file = header[1]!;
      prevAdded = null;
      continue;
    }
    const hunk = /^@@ .*\+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      prevAdded = null;
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++ ")) {
      prevAdded = null;
      continue;
    }
    const cur = line.slice(1);
    if (file !== null && !isRecordProse(file)) {
      let hit = false;
      for (const re of GARBLED_WORDING) {
        const m = re.exec(cur);
        if (m) {
          hits.push(`${file}:${lineNo} "${m[0]}"`);
          hit = true;
          break;
        }
      }
      if (!hit && prevAdded !== null) {
        const head = prevAdded.trimEnd();
        const joined = head + " " + cur.replace(/^\s*(?:\/\/+|\*|#)\s*/, "");
        const split = spanningGarbled(joined, head.length);
        if (split) hits.push(`${file}:${lineNo - 1}-${lineNo} "${split}"`);
      }
    }
    prevAdded = cur;
    lineNo++;
  }
  if (hits.length === 0) return [];
  const lead = 'added lines carry garbled rename wording (reword them; a rote "tick" → "run" swap reads wrong here): '; // vocabulary-ok: quotes the retired word
  return [lead + cappedList(hits, MAX_STALE_HITS)];
}
