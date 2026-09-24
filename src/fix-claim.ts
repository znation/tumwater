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
 * Fixed→Open) is what an Open→Fixed restoration is measured against. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sectionLines } from "./backlog.js";
import { gitTry } from "./git.js";

/** Strip the provenance parentheticals and the `, fixed <date>` suffix a bugfix tick appends
 * when it moves an entry, so a heading compares equal across the Open→Fixed move. */
export function normalizeFixedHeading(heading: string): string {
  return heading
    .replace(/\([^)]*\)/g, "")
    .replace(/,\s*fixed.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Headings (as written, `### ` stripped) under the `## Fixed` section of a BUGS.md
 * document. Empty when the document has no Fixed section. Walks the section through
 * sectionLines — backlog.ts's single home of "where a `## ` section starts and ends" — so
 * this reader and the backlog browsers can never disagree about the boundary. */
export function fixedHeadings(doc: string): string[] {
  return sectionLines(doc, "Fixed")
    .filter((line) => /^### /.test(line))
    .map((line) => line.replace(/^###\s+/, "").trim());
}

/** The body of one `### ` entry in a BUGS.md document: everything from after its heading to
 * the next `### ` or `## ` heading. Empty when the heading is absent. */
export function bugEntryBody(doc: string, heading: string): string {
  const lines = doc.split("\n");
  let body: string[] | undefined;
  for (const line of lines) {
    if (/^### /.test(line)) {
      if (body) break;
      if (line.replace(/^###\s+/, "").trim() === heading) body = [];
    } else if (/^## /.test(line)) {
      if (body) break;
    } else if (body) {
      body.push(line);
    }
  }
  return (body ?? []).join("\n").trim();
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
  const baseRev = (await gitTry(wt, "merge-base", "HEAD", mainBranch)) ?? mainBranch;
  const base = (await gitTry(wt, "show", `${baseRev}:BUGS.md`)) ?? "";
  // An already-Fixed entry is skipped only when its body is unchanged: an md-only edit that
  // rewrites an existing Fixed record's narrative must face the symbol check too (BUGS.md
  // 2026-09-23 — the in-place narrative rewrite is how a second phantom landing evaded it).
  const baseBodies = new Map(
    fixedHeadings(base).map((h) => [normalizeFixedHeading(h), bugEntryBody(base, h)]),
  );
  const haystack = sourceHaystack(wt);
  for (const heading of fixedHeadings(head)) {
    const body = bugEntryBody(head, heading);
    if (baseBodies.get(normalizeFixedHeading(heading)) === body) continue;
    const missing = unbackedSymbols(wt, fixSymbols(body), haystack);
    if (missing.length === 0) continue;
    const names = missing.length <= 3 ? missing.join(", ") : `${missing.slice(0, 3).join(", ")}…`;
    return (
      `md-only BUGS.md edit moves "${heading}" to Fixed, but none of the symbols its ` +
      `Fix paragraph names exist on this tree: ${names} — land the fix in the same commit, ` +
      `or keep the bug Open until the code exists`
    );
  }
  return undefined;
}
