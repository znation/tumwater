import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** The pointer guard behind PLANS.md's citation convention: a comment in `src/` or `test/` that
 * cites a PLANS.md entry must cite one the file — or PLANS-DONE.md, where finished plans are
 * archived — still records. Entries are curated as the backlog moves — a `## Planned` heading was
 * rewritten to a terse `## Done` bullet, and a superseded one is deleted — and each move silently
 * strands every comment that named it. Nothing
 * checked that, so the review gate found the survivors one change at a time and rejected the sweep
 * for being incomplete, and the same cleanup was re-authored tick after tick (BUGS.md 2026-10-12,
 * "REVISION_LIMIT exhaustion …"): ~100 citations name entries PLANS.md no longer holds. This guard
 * makes the class deterministic — the author runs the suite before merging and sees exactly which
 * citations are stale — so completeness stops depending on a reviewer's sweep.
 *
 * Comment text only: a string literal that mentions PLANS.md is code, not a citation. And only the
 * shapes a reader reads as a pointer — a quoted title beside the token, a
 * `--- Label (PLANS.md …) ---` banner, or a parenthetical holding nothing but the token and the
 * label. A bare prose mention of the token (`PLANS.md` beside `BUGS.md`), a date citation
 * (`PLANS.md 2026-09-30`), and a section reference (``PLANS.md `## Planned` ``) name no entry and
 * are out of scope. */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// The suite runs both from test/ (node --test on the source) and from dist/test/ (the compiled
// runner), so find the repo root by walking up to the directory that has package.json and src/.
function repoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no repo root above ${from}`);
    dir = parent;
  }
}
const ROOT = repoRoot(TEST_DIR);

/** The status parenthetical every PLANS.md entry carries (`(planned …`, `(done …`). */
const STATUS = / \((?:planned|done) /;

/** The entry titles PLANS.md records: its `### ` headings, and the terse `- ` bullets under
 * `## Done` that completed entries are rewritten to. A heading keeps everything before its status
 * parenthetical (headings legitimately carry colons); a Done bullet also cuts its `: ` gloss,
 * since the bullet is `Title: what it did (planned …; done …)`. Both the cut title and the full
 * heading before its parenthetical are kept, so a citation quoting a longer phrase still resolves.
 * Pure, so a test can feed it planted markdown. */
function planEntries(md: string): string[] {
  const out = new Set<string>();
  let inDone = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("## Done")) inDone = true;
    else if (line.startsWith("### ")) add(line.slice(4), false);
    else if (inDone && line.startsWith("- ")) add(line.slice(2), true);
  }
  return [...out];
  function add(text: string, gloss: boolean): void {
    const head = text.split(STATUS)[0]!.trim();
    if (head.length > 0) out.add(head);
    const title = head.split(": ")[0]!.trim();
    if (gloss && title.length > 0) out.add(title);
  }
}

/** The PLANS.md entry labels one line of comment text cites, in the shapes a reader reads as a
 * pointer. The caller owns the comment-ness of the line (danglingCitations checks it). */
function citedLabels(line: string): string[] {
  const out = new Set<string>();
  // The test-file banner convention: `// --- Label (PLANS.md "Label") ---`. The caption is the
  // label only when the parenthetical holds nothing but the token — `(PLANS.md "Title")` gives its
  // label through the quoted rule below, and `(PLANS.md 2026-09-25)` or `(PLANS.md: keyName)` is a
  // date or a key reference, not a title. A caption that glosses its title
  // (`Yield-scaled clocks: the ring and the multiplier it feeds (PLANS.md)`) also offers the head
  // before the colon, which is the title itself.
  const banner = /^\s*(?:\/\/|\/\*|\*)\s*---\s*(.+?)\s*\((PLANS\.md[^)]*)\)\s*---/.exec(line);
  if (banner && /^PLANS\.md\s*$/.test(banner[2]!)) {
    const label = banner[1]!.trim();
    out.add(label);
    const head = label.split(": ")[0]!.trim();
    if (head.length > 0 && head !== label) out.add(head);
  }
  // A quoted title immediately after the token, and immediately before a parenthetical.
  for (const m of line.matchAll(/PLANS\.md[,:]?\s+"([^"]+)"/g)) out.add(m[1]!);
  for (const m of line.matchAll(/"([^"]+)",?\s*\(PLANS\.md/g)) out.add(m[1]!);
  // Any quoted title inside a parenthetical that names the token.
  for (const m of line.matchAll(/\([^()]*PLANS\.md[^()]*\)/g)) {
    for (const q of m[0].matchAll(/"([^"]+)"/g)) out.add(q[1]!);
  }
  // A parenthetical holding only the token and an unquoted label; conservative on purpose, since a
  // false positive would demand a citation edit the author cannot verify.
  for (const m of line.matchAll(/\(PLANS\.md,?\s+([^"`#\d][^()]*)\)/g)) {
    const label = m[1]!.trim();
    const titleish =
      label.length >= 4 &&
      /^[A-Za-z]/.test(label) &&
      !/[`{}[\]=]/.test(label) &&
      !/\.md\b/.test(label) &&
      !/^\d{4}-\d{2}-\d{2}/.test(label);
    if (titleish) out.add(label);
  }
  return [...out];
}

/** Every citation in `source` whose label no entry in `entries` holds, as its 1-based line and the
 * label. Empty means every pointer resolves. Pure: the one place the rule lives, so the planted
 * cases and the tree scan below cannot drift. */
function danglingCitations(source: string, entries: readonly string[]): { line: number; label: string }[] {
  const lowered = entries.map((e) => e.toLowerCase());
  const out: { line: number; label: string }[] = [];
  source.split("\n").forEach((line, i) => {
    if (!/^\s*(?:\/\/|\/\*|\*)/.test(line)) return; // A string literal mentioning the file is code.
    for (const label of citedLabels(line)) {
      if (!lowered.some((entry) => entry.includes(label.toLowerCase()))) out.push({ line: i + 1, label });
    }
  });
  return out;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every entry PLANS.md still records: its own, and the finished ones archived in PLANS-DONE.md
 * (plans/backlog-archive.md), which keeps them under the same `## Done` heading. */
const ENTRIES = ["PLANS.md", "PLANS-DONE.md"].flatMap((file) => {
  const full = path.join(ROOT, file);
  return fs.existsSync(full) ? planEntries(fs.readFileSync(full, "utf8")) : [];
});

test("planEntries reads the heading and Done-bullet titles and cuts each one's status", () => {
  const md = [
    "## Planned",
    "### Role notebook: carry a note across ticks (planned 2026-10-06 by plan; done 2026-10-06 by feature)",
    "**Goal.** …",
    "## Done",
    "- Robust conflict landing, part 2/2: a conflict goes back to its author (planned 2026-10-07, done 2026-10-07; commit 0f7aca27)",
    "- The TUI moves to ink, part 2a/3: extract the key handler (planned 2026-10-06, done 2026-10-06; commit 15ff6a8d)",
  ].join("\n");
  const entries = planEntries(md);
  assert.ok(entries.includes("Role notebook: carry a note across ticks"), "a heading keeps its colon clause");
  assert.ok(entries.includes("Robust conflict landing, part 2/2"), "a Done bullet cuts its gloss");
  assert.ok(entries.includes("The TUI moves to ink, part 2a/3"), "and keeps the leading article");
  assert.ok(!entries.some((e) => e.includes("(planned")), "no status text leaks into a title");
});

test("a stale citation is reported, a live one is not", () => {
  const entries = ["Role notebook", "Robust conflict landing, part 2/2"];
  assert.deepEqual(danglingCitations('// see PLANS.md "Gone plan" for the shape', entries), [
    { line: 1, label: "Gone plan" },
  ]);
  assert.deepEqual(danglingCitations('// see PLANS.md "Role notebook" for the shape', entries), []);
  assert.deepEqual(danglingCitations('// --- Robust conflict landing, part 2/2 (PLANS.md) ---', entries), []);
});

test("citations the guard must not read: code, dates, sections, and prose mentions", () => {
  const entries: string[] = [];
  assert.deepEqual(danglingCitations('const s = \'PLANS.md "Gone plan"\';', entries), [], "a string literal is code");
  assert.deepEqual(danglingCitations("// (PLANS.md 2026-09-30): the abort flag", entries), [], "a date names no title");
  assert.deepEqual(danglingCitations("// PLANS.md `## Planned` lists every eligible entry", entries), [], "a section ref is not a title");
  assert.deepEqual(danglingCitations("// PLANS.md and BUGS.md grow without bound", entries), [], "a prose mention names no title");
});

test("the banner, quoted, and bare-parenthetical shapes are all read", () => {
  const entries: string[] = [];
  const stale = danglingCitations(
    [
      "// --- Yield-scaled clocks: the ring and the multiplier it feeds (PLANS.md) ---",
      '// (PLANS.md "Yield-scaled clocks") drives the gap',
      "// the plan (PLANS.md Land-queue speed 3e) made this opt-in",
      '// "Retire the README freshness stamp" (PLANS.md) recorded the intent',
    ].join("\n"),
    entries,
  );
  assert.deepEqual(
    stale.map((d) => d.label),
    [
      // A bare banner offers its caption, and the colon head that is the title itself.
      "Yield-scaled clocks: the ring and the multiplier it feeds",
      "Yield-scaled clocks",
      "Yield-scaled clocks",
      "Land-queue speed 3e",
      "Retire the README freshness stamp",
    ],
    "each pointer shape yields its label",
  );
  assert.deepEqual(stale.map((d) => d.line), [1, 1, 2, 3, 4]);
});

test("every PLANS.md citation in a src/ or test/ comment names an entry PLANS.md still records", () => {
  const stale: string[] = [];
  for (const file of [...tsFiles(path.join(ROOT, "src")), ...tsFiles(path.join(ROOT, "test"))]) {
    const source = fs.readFileSync(file, "utf8");
    for (const { line, label } of danglingCitations(source, ENTRIES)) {
      stale.push(`${path.relative(ROOT, file)}:${line} — PLANS.md "${label}"`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `these comments cite PLANS.md entries it no longer holds; retitle the pointer to the live entry or drop it:\n${stale.join("\n")}`,
  );
});
