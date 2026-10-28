/** The shared diff/index reading helpers of the staging self-check's git-level findings, split
 * out of stage-path-checks.ts so the three per-concern check modules (stage-path-checks,
 * stage-name-checks, stage-prose-checks) read the staged diff the same way without importing
 * each other. `gitLevelFindings` (stage-path-checks.ts) stages the change once and hands each
 * check module the diff and name-status parsed here. */

import { BACKLOG_FILES } from "../backlog/backlog-md.js";
import { moreSuffix } from "../text/phrases.js";

/** How many `file:line` hits a single stale-reference finding lists before it stops. */
export const MAX_STALE_HITS = 10;
/** How many renamed/deleted paths each stale-reference finding reports before stopping — the
 * cap that keeps a 40-file rename to a bounded finding list. */
export const MAX_STALE_PATHS = 10;

/** The path a unified diff's `+++ b/<path>` header names. Strips the four-character `+++ `
 * marker and git's `b/` prefix. A deleted file's new side is `+++ /dev/null`, which carries no
 * `b/` prefix and is returned as `/dev/null`. */
export function diffPlusPath(line: string): string {
  return line.slice(4).replace(/^b\//, "");
}

/** Parse a `-U0` unified diff into each file's removed and added content lines, marker-stripped.
 * The `diff --git` header names the file, and git's `---`/`+++` old/new path headers carry no
 * content; `@@` hunk headers, context lines and the `\ No newline` marker match neither branch,
 * so the walk records only real `-`/`+` content lines. Consumers keep only what they want — a
 * JS-file filter, a trim-and-min-length rule, a compound-name extraction — from the per-file
 * removed/added lists; stage-path-checks's movedSourceFindings and stage-name-checks's
 * declaredNameDeltas each walked this same grammar before the helper. stage-prose-checks's
 * detachedDocFindings and addedDiffLines are deliberately not folded here: both need each hunk's
 * start-line count from the `@@` header, which this shape drops. */
export function diffRemovedAdded(diff: string): { path: string; removed: string[]; added: string[] }[] {
  const files: { path: string; removed: string[]; added: string[] }[] = [];
  let cur: { path: string; removed: string[]; added: string[] } | undefined;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      cur = { path: header[1]!, removed: [], added: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("-") && !line.startsWith("---")) cur.removed.push(line.slice(1));
    else if (line.startsWith("+") && !line.startsWith("+++")) cur.added.push(line.slice(1));
  }
  return files;
}

/** Parse `git grep -n` stage output into `file:line:text` hits. `git grep -n` prints one
 * `path:line:text` per match, and the four name/path checks (stage-name-checks.ts's
 * staleNameFindings and movedNameFindings, stage-path-checks.ts's movedSourceFindings and
 * staleReferenceFindings) all read that grammar to turn the raw output into individual hits;
 * malformed (or trailing empty) lines are dropped. Callers then filter the hits and keep the
 * `file:no` coordinate they want. */
export function gitGrepHits(out: string): { file: string; no: string; text: string }[] {
  const hits: { file: string; no: string; text: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m) hits.push({ file: m[1]!, no: m[2]!, text: m[3] ?? "" });
  }
  return hits;
}

/** True for record prose: a backlog file (BACKLOG_FILES: PLANS.md, BUGS.md, QUESTIONS.md and the
 * finished-entry archives) or a markdown design doc under `plans/`. They record history and
 * describe planned work, so a path there is correct as written even when it is absent from the
 * tree: a finished entry names a file as it was, and a plan names the file it will create or
 * both sides of the move it describes. Asking a rename to sweep them rewrote "old → new" into
 * "new → new" and history into the present; that failure took five rejections on
 * one rename on 2026-10-18 and -19. */
export function isRecordProse(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return BACKLOG_FILES.has(base) || (file.startsWith("plans/") && file.endsWith(".md"));
}

/** The capped list a finding line appends: at most `max` entries joined by ", ", then
 * `moreSuffix` for the rest. Shared by the missing-path and lost-final-newline findings so both
 * cap and join identically. */
export function cappedList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max);
  return `${shown.join(", ")}${moreSuffix(items.length - shown.length)}`;
}

/** A JS/TS source file: the only files whose identifiers the name checks read and whose doc
 * comments the detached-doc check analyzes. */
export const JS_FILE = /\.(?:ts|tsx|js|mjs)$/;

/** True when `needle` appears in `line` as a repo path of its own — not as one segment of a
 * longer path. `git grep -F` matches substrings, so a line naming a rename's destination
 * (`src/<dir>/config.ts`) would otherwise read as a stale reference to an old root `config.ts`.
 * A preceding path character (or a following one that continues the token, as a `.` extension
 * or an alphanumeric does) disqualifies the occurrence; trailing sentence punctuation does not. */
export function hasStandalonePathOccurrence(line: string, needle: string): boolean {
  return standalonePathIndexes(line, needle).length > 0;
}

/** Every index at which `needle` appears in `line` as a repo path of its own (see
 * hasStandalonePathOccurrence). */
export function standalonePathIndexes(line: string, needle: string): number[] {
  const pathChar = /[A-Za-z0-9_./-]/;
  const found: number[] = [];
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) {
    const before = i > 0 ? line[i - 1]! : "";
    if (before && pathChar.test(before)) continue;
    const after = line[i + needle.length] ?? "";
    if (/[A-Za-z0-9_/-]/.test(after)) continue;
    if (after === "." && /[A-Za-z0-9]/.test(line[i + needle.length + 1] ?? "")) continue;
    found.push(i);
  }
  return found;
}
