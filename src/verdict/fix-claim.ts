// vocabulary: plain
/** False-fix detection for md-only BUGS.md edits (BUGS.md 2026-09-22): an md-only diff is
 * exempt from the review gate by design, so nothing else verifies that a bug it moves to
 * Fixed actually has code behind it — commit 9cea8c3 merged a Fix paragraph naming
 * `runScriptGroup`/`signalTree` with no source anywhere in main's history. This module
 * cross-checks the diff against the tree being merged: a `## Fixed` entry that is new in
 * the diff must name only symbols or paths that exist on the tree — identifier-like
 * backticked spans are substring-matched against the tree's code files, path-like spans
 * against the tree itself. An entry whose Fix paragraph names nothing checkable is left
 * alone: pure-documentation fixes are legitimate and must keep merging md-only.
 *
 * Two holes this check closed after its first merge (BUGS.md 2026-09-23): an ALREADY-Fixed
 * entry is skipped only when its body is untouched — an md-only edit that rewrites an
 * existing Fixed record's narrative (the exact shape a second phantom merge takes) faces
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
 * replacing the earlier hand-rolled fenceTracker walk), so the two cannot drift apart.
 *
 * A fourth (BUGS.md 2026-10-13): the compressed one-line records below the newest-ten full
 * entries have no `### ` heading, so the parser read the whole block of records as the LAST full
 * entry's body. Every steward compression made a different entry last, so that entry's body
 * "changed"
 * and all ~170 records' names faced its symbol check — two prose names no code ever held
 * rejected three compressions in a row. fixedSection now ends an entry's own body at its first
 * one-line record and checks records on their own: a record the diff adds or edits may carry
 * forward any name the base's Fixed section already holds, and nothing else unbacked. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { readTextOrNull, walkFiles } from "../files/files.js";
import {
  fenceTracker,
  finishedArchiveOf,
  parseEntryDetails,
  sectionLines,
  trailingParenthetical,
  type BacklogEntry,
} from "../backlog/backlog-md.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { collapseWhitespace, truncate } from "../text/text.js";

/** How much of a one-line record a rejection quotes: the record is one line by construction but
 * can run to several hundred characters, and the reason rides in a one-line event. */
const RECORD_QUOTE_MAX = 160;

/** Strip the provenance parentheticals and the `, fixed <date>` suffix a bugfix run appends
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
  return fixedEntries(doc).map((entry) => entry.title);
}

/** The `## Fixed` section's parsed entries, in document order, each with only its own body
 * (fixedSection) — one parse that headings and bodies both read from. Callers that need more
 * than one heading's body (falseFixReason's base-vs-head comparison, the doctor's
 * checkFixClaims) iterate this once instead of calling the per-heading lookups, each of which
 * re-parsed the whole document: with ~200 Fixed entries, building the base body map and
 * walking the head section re-parsed BUGS.md ~400 times per check, and the doctor's newest-10
 * scan re-parsed it once per heading. */
function fixedEntries(doc: string): BacklogEntry[] {
  return fixedSection(doc).entries;
}

/** Whether `line` is a compressed one-line Fixed record — the steward's
 * `- <headline> (<date clause>; commit <sha>; gap: <tag>)` form and the variants its rules allow
 * (src/roles/role-catalog.ts: no dates, no commit, no gap): a `- ` line whose trailing
 * parenthetical carries a `commit` reference or a `gap:` tag. The commit half is backlog-md.ts
 * entryDates' epitaph guard. A labelled body bullet (`- **Fix:** …`) never is one, whatever its
 * parenthetical says. */
export function isOneLineRecord(line: string): boolean {
  if (!line.startsWith("- ") || line.startsWith("- **")) return false;
  return /\bcommits?\b|\bgap:/.test(trailingParenthetical(line));
}

/** Where fixed bugs are archived (plans/backlog-archive.md): BUGS-FIXED.md, under the same
 * `## Fixed` heading, newest first. */
const BUGS_ARCHIVE = finishedArchiveOf("BUGS.md").archive;

/** The Fixed entries of the checkout at `root` as fixedEntries reads them, newest first:
 * BUGS.md's own section (normally empty), then BUGS-FIXED.md's. `bugsMd` is BUGS.md's text when
 * the caller has already read it. Doctor's newest-Fixed checks read through this. */
export function fixedEntriesAt(root: string, bugsMd?: string): BacklogEntry[] {
  const live = bugsMd ?? readTextOrNull(join(root, "BUGS.md")) ?? "";
  return [...fixedEntries(live), ...fixedEntries(readTextOrNull(join(root, BUGS_ARCHIVE)) ?? "")];
}

/** The `## Fixed` section split the way the false-fix check reads it: each `### ` entry with
 * only its OWN body, and the one-line records apart, trimmed, blank lines dropped. The parser
 * opens an entry only at a `### ` line, so the headingless records after the full entries parse
 * as the last full entry's body; here an entry's own body ends at its first unfenced one-line
 * record, and that line and every line after it up to the next heading are record lines. An
 * entry body's fence state starts closed (its heading line was outside any fence), so a fresh
 * tracker reads the body in step with the document. */
export function fixedSection(doc: string): { entries: BacklogEntry[]; records: string[] } {
  const entries: BacklogEntry[] = [];
  const records: string[] = [];
  for (const entry of parseEntryDetails(doc, "Fixed")) {
    const lines = entry.body.split("\n");
    const fenced = fenceTracker();
    const start = lines.findIndex((line) => !fenced.inside(line) && isOneLineRecord(line));
    if (start === -1) {
      entries.push(entry);
      continue;
    }
    entries.push({ title: entry.title, body: lines.slice(0, start).join("\n").trim() });
    for (const line of lines.slice(start)) if (line.trim()) records.push(line.trim());
  }
  return { entries, records };
}

/** The own body of one `### ` entry in a BUGS.md document: everything from after its heading to
 * the next `### ` or `## ` heading, or to its first one-line record (fixedSection). Empty when
 * the heading is absent. Fence-aware: a heading
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
  return fixedEntries(doc).find((entry) => entry.title === heading)?.body ?? "";
}

/** The backticked, whitespace-free spans of EVERY `**Fix:**` paragraph in an entry's body
 * (the whole body when the entry carries no explicit Fix line), each with a trailing `()`
 * stripped so a call mention matches the identifier it names. Every claim must be read, not
 * just the first: a body can hold a second `**Fix:**` paragraph — a headingless record
 * absorbed into it (BUGS.md 2026-10-08), or a narrative describing two fixes — and picking
 * the first match with `Array.find` let a later paragraph name symbols that exist nowhere on
 * the tree while `falseFixReason` passed on the first. Spans with whitespace inside —
 * `npm test`, `--days N`, `Ctrl+B` — are not symbols and never counted. */
export function fixSymbols(body: string): string[] {
  const fixes = body.split(/\n\s*\n/).filter((p) => p.includes("**Fix:**"));
  const fix = fixes.length > 0 ? fixes.join("\n") : body;
  const symbols: string[] = [];
  for (const span of fix.matchAll(/`([^`\n]+)`/g)) {
    const symbol = unwrapSymbol((span[1] ?? "").trim()).replace(/\(\)$/, "");
    if (symbol && !/\s/.test(symbol)) symbols.push(symbol);
  }
  return symbols;
}

/** A backticked span with a surrounding array/quote wrapper stripped: a Fix paragraph may
 * quote a name in the notation it was returned in — `["falseFixReason"]` — and checking the
 * raw span would report the brackets as missing when the name itself is on the tree. `[]`
 * unwraps to nothing and is dropped by fixSymbols' emptiness guard. */
function unwrapSymbol(span: string): string {
  let out = span;
  if (out.startsWith("[") && out.endsWith("]")) out = out.slice(1, -1);
  const quote = out[0];
  if (out.length >= 2 && (quote === '"' || quote === "'") && out.endsWith(quote))
    out = out.slice(1, -1);
  return out;
}

/** The tree's code text: every non-documentation tracked-source-shaped file under src/,
 * test/, and scripts/, plus package.json and tsconfig.json, concatenated. The walk is
 * language-neutral — markdown is the one thing excluded, not a fixed source-extension list
 * — so a Rust, Python, or Go tree backs its symbols like a TypeScript one does; a JS/TS-only
 * haystack left every symbol in a non-JS project unbacked and blocked every md-only BUGS.md
 * Fixed edit there (BUGS.md 2026-10-06). Markdown is deliberately excluded — the BUGS.md
 * entry itself names the symbols it claims, so a doc haystack would back any claim including
 * a false one. */
export function sourceHaystack(root: string): string {
  const parts: string[] = [];
  const skipDirs = new Set(["node_modules", "dist"]);
  const docExts = new Set([".md", ".markdown"]);
  for (const dir of ["src", "test", "scripts"])
    walkFiles(
      join(root, dir),
      (p, entry) => {
        if (docExts.has(extname(entry.name).toLowerCase())) return;
        try {
          if (statSync(p).isFile()) parts.push(readFileSync(p, "utf8"));
        } catch {
          // Unreadable file: contributes nothing rather than failing the check.
        }
      },
      skipDirs,
    );
  for (const file of ["package.json", "tsconfig.json"]) {
    const text = readTextOrNull(join(root, file));
    if (text !== null) parts.push(text); // Missing or unreadable contributes nothing.
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
 * of the diff merging on `mainBranch`; the worktree `wt` holds the tree being merged. */
export async function falseFixReason(
  wt: string,
  mainBranch: string,
  files: string[],
): Promise<string | undefined> {
  // Fixed entries live in BUGS.md's own section and in its archive, BUGS-FIXED.md
  // (plans/backlog-archive.md): tumwater moves a fixed bug there right before the commit, so a
  // fix claim reaches the gate as an archive edit, and an archived entry whose body is intact
  // is no claim at all. Both sides of the comparison read both files.
  if (!files.includes("BUGS.md") && !files.includes(BUGS_ARCHIVE)) return undefined;
  // A deleted or unreadable file reads as empty: there is no Fixed transition to verify,
  // so this check passes and lets the gate's sibling structural check (backlog-structure.ts)
  // report the dropped section. Reading it raw would throw ENOENT out of the gate instead —
  // and a file the change deletes is exactly the input the sibling check already handles.
  const heads = ["BUGS.md", BUGS_ARCHIVE].map((f) => readTextOrNull(join(wt, f)) ?? "");
  if (!heads.some((head) => head.includes("## Fixed"))) return undefined;
  // The diff's own base, not main's tip: the gate diffs `mainBranch...HEAD` against the
  // merge-base, and the entry's Open/Fixed state lives in the tree the change builds on —
  // pre-batch main can still carry the record as (falsely) Fixed and make an Open→Fixed
  // restoration in a stacked batch compare as already done (BUGS.md 2026-09-23).
  const baseRev = await changeBaseRev(wt, mainBranch);
  const bases = [await fileContentAt(wt, baseRev, "BUGS.md"), await fileContentAt(wt, baseRev, BUGS_ARCHIVE)];
  // An already-Fixed entry is skipped only when its body is unchanged: an md-only edit that
  // rewrites an existing Fixed record's narrative must face the symbol check too (BUGS.md
  // 2026-09-23 — the in-place narrative rewrite is how a second phantom merge evaded it).
  const baseBodies = new Map(
    bases.flatMap((base) => fixedEntries(base)).map((e) => [normalizeFixedHeading(e.title), e.body]),
  );
  // Built lazily, only once a Fixed record's body actually changed: the haystack walks and
  // reads the entire source tree (~5 MB here), and the common BUGS.md edit moves nothing to
  // Fixed — an Open bug added, a narrative touched elsewhere — so the gate and the in-lock
  // recheck each paid that walk for a check that never reached a symbol.
  let haystack: string | undefined;
  const sections = heads.map((head) => fixedSection(head));
  const entries = sections.flatMap((section) => section.entries);
  const records = sections.flatMap((section) => section.records);
  for (const { title: heading, body } of entries) {
    const baseBody = baseBodies.get(normalizeFixedHeading(heading));
    if (baseBody === body) continue;
    haystack ??= sourceHaystack(wt);
    const missing = unbackedSymbols(wt, fixSymbols(body), haystack);
    if (missing.length === 0) continue;
    const names = missingSymbolNames(missing);
    // The rejection says which shape it saw: the old message called every rewrite of an
    // already-Fixed entry a move "to Fixed", so an author could not find the move it named and
    // resubmitted the same diff as a false positive (BUGS.md 2026-10-13).
    return baseBody === undefined
      ? `md-only BUGS.md edit moves "${heading}" to Fixed, but its Fix paragraph names code ` +
          `that exists nowhere on this tree: ${names} — include the fix in the same commit, ` +
          `or keep the bug Open until the code exists`
      : `md-only BUGS.md edit rewrites the already-Fixed entry "${heading}", and its Fix ` +
          `paragraph now names code that exists nowhere on this tree: ${names} — include that ` +
          `code in the same commit, or leave the entry's text as it was`;
  }
  // One-line records are compressions of entries the base already holds as Fixed, and history
  // keeps a renamed symbol's old name, so a record the diff adds or edits may carry forward any
  // name the base's Fixed section already records. A name it introduces must exist on the tree:
  // a bug moved straight from Open into a one-line record faces the same check as a full entry.
  const baseLines = bases.flatMap((base) => sectionLines(base, "Fixed")).map((line) => line.trim());
  const seen = new Set(baseLines);
  const baseText = baseLines.join("\n");
  for (const record of records) {
    if (seen.has(record)) continue;
    const introduced = fixSymbols(record).filter((symbol) => !baseText.includes(symbol));
    if (introduced.length === 0) continue;
    haystack ??= sourceHaystack(wt);
    const missing = unbackedSymbols(wt, introduced, haystack);
    if (missing.length === 0) continue;
    return (
      `md-only BUGS.md edit adds the one-line Fixed record "${truncate(record, RECORD_QUOTE_MAX)}", ` +
      `which names code that exists nowhere on this tree or in the base's Fixed section: ` +
      `${missingSymbolNames(missing)} — copy names from the entry it compresses, or include the ` +
      `code in the same commit`
    );
  }
  return undefined;
}
