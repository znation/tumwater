/** False-fix detection for md-only BUGS.md edits (BUGS.md 2026-09-22): an md-only diff is
 * exempt from the review gate by design, so nothing else verifies that a bug it moves to
 * Fixed actually has code behind it — commit 9cea8c3 landed a Fix paragraph naming
 * `runScriptGroup`/`signalTree` with no source anywhere in main's history. This module
 * cross-checks the diff against the tree being landed: a `## Fixed` entry that is new in
 * the diff must name at least one symbol or path that exists on the tree — identifier-like
 * backticked spans are substring-matched against the tree's code files, path-like spans
 * against the tree itself. An entry whose Fix paragraph names nothing checkable is left
 * alone: pure-documentation fixes are legitimate and must keep landing md-only.
 *
 * Two holes this check closed after its first landing (BUGS.md 2026-09-23): an ALREADY-Fixed
 * entry is skipped only when its body is untouched — an md-only edit that rewrites an
 * existing Fixed record's narrative (the exact shape a second phantom landing takes) faces
 * the same symbol check a new entry does; and the comparison base is the diff's own
 * merge-base, not main's tip, so a stacked batch's earlier change (which moved the entry
 * Fixed→Open) is what an Open→Fixed restoration is measured against.
 *
 * A third hole this check closed after those (BUGS.md 2026-09-25): both readers were
 * fence-blind. A `### ` line quoted inside a fenced code block counted as a Fixed heading,
 * and an entry body was cut at its own quoted fence — so base and head bodies truncated at
 * the same fence compared equal, and a rewrite confined to text after the fence (including
 * a Fix paragraph placed there) never faced the symbol check. Both readers now see fences
 * through parseEntryDetails — backlog-md.ts's fence-aware entry parser, the same one the
 * dashboards read — with one scanner serving headings and bodies alike (as of 2026-09-29,
 * replacing the earlier hand-rolled fenceTracker walk), so the two cannot drift apart. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEntryDetails } from "./backlog/backlog-md.js";
import { changeBaseRev, fileContentAt } from "./git/git.js";
import { collapseWhitespace } from "./text/text.js";

/** Strip the provenance parentheticals and the `, fixed <date>` suffix a bugfix tick appends
 * when it moves an entry, so a heading compares equal across the Open→Fixed move. The
 * whitespace-normalize tail is text.ts's collapseWhitespace — the one home for that step,
 * shared with planHeadingKey's PLANS.md counterpart in backlog-structure.ts. */
export function normalizeFixedHeading(heading: string): string {
  return collapseWhitespace(
    heading.replace(/\([^)]*\)/g, "").replace(/,\s*fixed.*$/i, ""),
  );
}

/** Headings (as written, `### ` stripped) under the `## Fixed` section of a BUGS.md
 * document. Empty when the document has no Fixed section. Walks the section through
 * parseEntryDetails — backlog-md.ts's fence-aware entry parser, the same reader the dashboards
 * use — so this reader and the backlog browsers can never disagree about what is an entry
 * and what is quoted content: a `### ` line inside a fenced code block is body text, never
 * a Fixed entry. */
export function fixedHeadings(doc: string): string[] {
  return parseEntryDetails(doc, "Fixed").map((entry) => entry.title);
}

/** The body of one `### ` entry in a BUGS.md document: everything from after its heading to
 * the next `### ` or `## ` heading. Empty when the heading is absent. Fence-aware: a heading
 * line inside a fenced code block is quoted content, never a boundary, and a fence inside
 * the entry itself (an entry quoting a markdown template) is body content the entry keeps —
 * the body runs to the next heading outside the fence, not to the fence's first quoted
 * `## `/`### ` line.
 *
 * Read through parseEntryDetails like fixedHeadings (every caller looks up a heading
 * fixedHeadings produced, so the Fixed section is the only one that matters) instead of
 * hand-rolling a second fence-aware walk of the same document: one parser serves headings
 * and bodies alike, so the two lookups can never disagree about where an entry starts,
 * ends, or what is quoted content. */
export function bugEntryBody(doc: string, heading: string): string {
  return parseEntryDetails(doc, "Fixed").find((entry) => entry.title === heading)?.body ?? "";
}

/** The backticked, whitespace-free spans of one entry's `**Fix:**` paragraph (the whole body
 * when the entry carries no explicit Fix line), each with a trailing `()` stripped so a call
 * mention matches the identifier it names. Spans with whitespace inside — `npm test`,
 * `--days N`, `Ctrl+B` — are not symbols and never counted. */
export function fixSymbols(body: string): string[] {
  const fix = /(^|\n)[^\n]*\*\*Fix:\*\*/.test(body)
    ? body.split(/\n\s*\n/).find((p) => p.includes("**Fix:**")) ?? body
    : body;
  const symbols: string[] = [];
  for (const span of fix.matchAll(/`([^`\n]+)`/g)) {
    const symbol = (span[1] ?? "").trim().replace(/\(\)$/, "");
    if (symbol && !/\s/.test(symbol)) symbols.push(symbol);
  }
  return symbols;
}

/** The tree's code text: every tracked-source-shaped file under src/, test/, and scripts/,
 * plus package.json and tsconfig.json, concatenated. Markdown is deliberately excluded —
 * the BUGS.md entry itself names the symbols it claims, so a doc haystack would back any
 * claim, including a false one. */
export function sourceHaystack(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Absent directory (early repo, no test/ yet): contributes nothing.
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name)) {
        try {
          if (statSync(p).isFile()) parts.push(readFileSync(p, "utf8"));
        } catch {
          // Unreadable file: contributes nothing rather than failing the check.
        }
      }
    }
  };
  for (const dir of ["src", "test", "scripts"]) walk(join(root, dir));
  for (const file of ["package.json", "tsconfig.json"]) {
    const p = join(root, file);
    if (existsSync(p)) {
      try {
        parts.push(readFileSync(p, "utf8"));
      } catch {
        // Unreadable: contributes nothing.
      }
    }
  }
  return parts.join("\n");
}

/** The symbols an entry names that exist nowhere on the tree: neither as a substring of the
 * code haystack nor as a file path on disk (`src/foo.ts`, `./test/foo.test.ts`). */
export function unbackedSymbols(root: string, symbols: string[], haystack: string): string[] {
  return symbols.filter(
    (s) => !haystack.includes(s) && !existsSync(join(root, s.replace(/^\.\//, ""))),
  );
}

/** The unbacked names for a one-line message: all of them when 3 or fewer, otherwise the
 * first 3 and an ellipsis — a doctor check or gate message has room for one line. */
export function missingSymbolNames(missing: string[]): string {
  return missing.length <= 3 ? missing.join(", ") : `${missing.slice(0, 3).join(", ")}…`;
}

/** The first false-fix claim in an md-only diff that touches BUGS.md, or undefined when the
 * diff backs its Fixed transitions (or makes none). `files` is the ahead-of-main path list
 * of the diff landing on `mainBranch`; the worktree `wt` holds the tree being landed. */
export async function falseFixReason(
  wt: string,
  mainBranch: string,
  files: string[],
): Promise<string | undefined> {
  if (!files.includes("BUGS.md")) return undefined;
  const head = readFileSync(join(wt, "BUGS.md"), "utf8");
  if (!head.includes("## Fixed")) return undefined;
  // The diff's own base, not main's tip: the gate diffs `mainBranch...HEAD` against the
  // merge-base, and the entry's Open/Fixed state lives in the tree the change builds on —
  // pre-batch main can still carry the record as (falsely) Fixed and make an Open→Fixed
  // restoration in a stacked batch compare as already done (BUGS.md 2026-09-23).
  const baseRev = await changeBaseRev(wt, mainBranch);
  const base = await fileContentAt(wt, baseRev, "BUGS.md");
  // An already-Fixed entry is skipped only when its body is unchanged: an md-only edit that
  // rewrites an existing Fixed record's narrative must face the symbol check too (BUGS.md
  // 2026-09-23 — the in-place narrative rewrite is how a second phantom landing evaded it).
  const baseBodies = new Map(
    fixedHeadings(base).map((h) => [normalizeFixedHeading(h), bugEntryBody(base, h)]),
  );
  // Built lazily, only once a Fixed record's body actually changed: the haystack walks and
  // reads the entire source tree (~5 MB here), and the common BUGS.md edit moves nothing to
  // Fixed — an Open bug added, a narrative touched elsewhere — so the gate and the in-lock
  // recheck each paid that walk for a check that never reached a symbol.
  let haystack: string | undefined;
  for (const heading of fixedHeadings(head)) {
    const body = bugEntryBody(head, heading);
    if (baseBodies.get(normalizeFixedHeading(heading)) === body) continue;
    haystack ??= sourceHaystack(wt);
    const missing = unbackedSymbols(wt, fixSymbols(body), haystack);
    if (missing.length === 0) continue;
    const names = missingSymbolNames(missing);
    return (
      `md-only BUGS.md edit moves "${heading}" to Fixed, but none of the symbols its ` +
      `Fix paragraph names exist on this tree: ${names} — land the fix in the same commit, ` +
      `or keep the bug Open until the code exists`
    );
  }
  return undefined;
}
