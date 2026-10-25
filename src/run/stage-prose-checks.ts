/** The diff-format and prose findings of the dormant staging self-check: how a change's text
 * reads and is shaped — a lost final newline, the garbled or doubled wording a rote word-swap
 * rename leaves, and a doc comment the change detached from its declaration. Split from
 * stage-path-checks.ts, the module that gathers the whole git-level finding family under
 * `gitLevelFindings`; this module holds the three prose/format checks and their parsing
 * helpers, sharing the staged diff/index reading helpers and `isRecordProse` with the path and
 * name sibling check modules. The gate does not run any of them. */

import fs from "node:fs";
import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import {
  JS_FILE,
  MAX_STALE_HITS,
  cappedList,
  diffPlusPath,
  isRecordProse,
} from "./stage-checks-shared.js";

/** How many files one lost-final-newline finding names before it stops. */
const MAX_NEWLINE_FILES = 10;
/** How many `file:line` sites one detached-doc finding names before it stops. */
const MAX_DETACHED_DOCS = 10;

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
export async function detachedDocFindings(wt: string, diff: string): Promise<string[]> {
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
      // lstat, not stat: a symlink among the changed files is never followed out of the
      // worktree (a change that adds a symlink writes no content of its own — the same
      // policy secret-leaks/INV-G4 pins), so it contributes no lines to analyze.
      const full = path.join(wt, file);
      let isFile = false;
      try {
        isFile = fs.lstatSync(full).isFile();
      } catch {
        isFile = false;
      }
      if (isFile) {
        const text = readTextOrNull(full);
        if (text !== null) check(file, hunks, text.split("\n"));
      }
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

/** (c) Lost final newlines: a text file whose new diff side carries git's
 * `\ No newline at end of file` marker while its base side does not. Git emits the marker
 * immediately after the line it applies to, so a marker after a `+` line flags the new side and
 * one after a `-` line flags the base side; a new file (`+` only) counts. Binary files have no
 * line hunks and never appear. */
export function newlineFindings(diff: string): string[] {
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

/** A word doubled back to back, the mark of a word-swap rename when the doubled copy is not
 * one of the grammatical exceptions named below. Case-sensitive, so
 * `[object Object]` does not match; the lookbehind skips a word after `-`, `.` or `/`, the
 * lookahead skips `NaN NaN:NaN` and `not not-ready`, and "that that" and "had had" are grammatical.
 * Only ever tested against prose (proseOf), never code. */
const DOUBLED_WORD = /(?<![-./\w])(?!(?:that|had)\b)([A-Za-z]{2,})\s+\1\b(?![-:])/;

/** The comment or doc prose of an added line, or null for code: the whole line of a `.md` file or
 * of a line whose trimmed start is `//`, `/*` or `*`, and the text from the first ` // ` of a
 * trailing comment. */
function proseOf(file: string, line: string): string | null {
  if (file.endsWith(".md") || /^\s*(?:\/\/|\/\*|\*)/.test(line)) return line;
  const at = line.indexOf(" // ");
  return at >= 0 ? line.slice(at) : null;
}

/** The first `patterns` match in `joined` that starts before `joinAt` and ends after it. */
function spanningGarbled(joined: string, joinAt: number, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
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
export function garbledWordingFindings(diff: string): string[] {
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
      const prose = proseOf(file, cur);
      if (!hit && prose !== null) {
        const m = DOUBLED_WORD.exec(prose);
        if (m) {
          hits.push(`${file}:${lineNo} "${m[0]}"`);
          hit = true;
        }
      }
      if (!hit && prevAdded !== null) {
        const head = prevAdded.trimEnd();
        const joined = head + " " + cur.replace(/^\s*(?:\/\/+|\*|#)\s*/, "");
        let split = spanningGarbled(joined, head.length, GARBLED_WORDING);
        if (!split && prose !== null && proseOf(file, prevAdded) !== null) {
          split = spanningGarbled(joined, head.length, [DOUBLED_WORD]);
        }
        if (split) hits.push(`${file}:${lineNo - 1}-${lineNo} "${split}"`);
      }
    }
    prevAdded = cur;
    lineNo++;
  }
  if (hits.length === 0) return [];
  const lead = 'added lines carry garbled rename wording (reword them; a rote word swap such as "tick" → "run" reads wrong here or leaves a word doubled): '; // vocabulary-ok: quotes the retired word
  return [lead + cappedList(hits, MAX_STALE_HITS)];
}
