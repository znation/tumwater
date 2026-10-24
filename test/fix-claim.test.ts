import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bugEntryBody,
  cachedSourceHaystack,
  falseFixReason,
  fixSymbols,
  fixedHeadings,
  fixedSection,
  isOneLineRecord,
  missingSymbolNames,
  normalizeFixedHeading,
  sourceHaystack,
  unbackedSymbols,
} from "../src/verdict/fix-claim.js";
import { fixClaimProblems } from "../src/doctor/doctor-backlog-plans.js";
import { aheadOfMain } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, runningAsRoot, sh } from "./fixtures/repo-fixtures.js";
import { reviewGate, ROLE } from "./fixtures/gate-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";

// Regression coverage for the 2026-09-22 false-fix record (BUGS.md): commit 9cea8c3 was an
// md-only BUGS.md edit that moved a bug to Fixed with a Fix paragraph naming runScriptGroup
// and signalTree — symbols that exist nowhere in main's history. The md-only exemption is a
// fast path by design, so the gate itself now cross-checks a new Fixed entry's symbols
// against the tree being merged; the pure functions below pin that parsing, and the
// gate-orchestration section drives reviewAheadOfMain end-to-end over a real repo.

const DOC = `# Bugs

## Open

### Something is broken: details (found by qa 2026-09-22)

**Symptom:** it broke.

## Fixed

### An old bug: details (found by qa 2026-09-20, fixed 2026-09-21)

**Fix:** `+"`someRealThing`"+` now does it.
`;

test("fixedHeadings lists the Fixed section's entries only", () => {
  assert.deepEqual(fixedHeadings(DOC), [
    "An old bug: details (found by qa 2026-09-20, fixed 2026-09-21)",
  ]);
});

test("normalizeFixedHeading makes an Open heading and its Fixed twin compare equal", () => {
  // The bugfix run appends provenance and ", fixed <date>" when it moves an entry.
  const open = "An old bug: details (found by qa 2026-09-20)";
  const fixed = "An old bug: details (found by qa 2026-09-20, fixed 2026-09-21)";
  assert.equal(normalizeFixedHeading(fixed), normalizeFixedHeading(open));
});

test("bugEntryBody returns the entry's text up to the next heading", () => {
  const body = bugEntryBody(DOC, "An old bug: details (found by qa 2026-09-20, fixed 2026-09-21)");
  assert.match(body, /^\*\*Fix:\*\*/);
  assert.ok(!body.includes("## Open"));
});

// Regression coverage for the 2026-09-25 fence-blind reader record (BUGS.md): fixedHeadings
// counted a `### ` line quoted inside a fenced code block as a Fixed entry, and bugEntryBody
// cut an entry's body at its own quoted fence — so a rewrite confined to text after the
// fence compared equal against the base and skipped the false-fix symbol check, and a Fix
// paragraph placed after the fence contributed no symbols (the check passed vacuously).

const QUOTED_FENCE_DOC =
  "## Fixed\n\n" +
  "### A quoted-template bug (found 2026-09-25, fixed 2026-09-25)\n\n" +
  "**Symptom:** quoting a template.\n\n" +
  "```md\n## Done\n\n### Quoted entry (fixed 2026-01-01)\n\nSome quoted body.\n```\n\n" +
  "**Fix:** `totallyFakeSymbolXyz` now handles it.\n";

test("fixedHeadings never counts a `### ` quoted inside a fence", () => {
  assert.deepEqual(fixedHeadings(QUOTED_FENCE_DOC), [
    "A quoted-template bug (found 2026-09-25, fixed 2026-09-25)",
  ]);
});

test("bugEntryBody keeps the entry's fence and everything after it", () => {
  const body = bugEntryBody(
    QUOTED_FENCE_DOC,
    "A quoted-template bug (found 2026-09-25, fixed 2026-09-25)",
  );
  assert.ok(body.includes("```md"), "the fence itself stays in the body");
  assert.ok(body.includes("## Done"), "a quoted `## ` line does not cut the body");
  assert.ok(body.includes("### Quoted entry"), "a quoted `### ` line does not cut the body");
  assert.match(body, /\*\*Fix:\*\* `totallyFakeSymbolXyz`/);
  // The symbol check reads the body: a Fix paragraph living after the entry's fence must
  // contribute its symbols instead of leaving the check vacuously empty.
  assert.deepEqual(fixSymbols(body), ["totallyFakeSymbolXyz"]);
});

// Entry-body boundaries. falseFixReason compares each head entry's body against the base's
// body of the same (normalized) heading to decide whether the diff rewrote a Fixed record, so
// the body text must be exact: a body that swallowed the following entry or the next section
// would never compare equal to the base's body, and every BUGS.md touch would face the symbol
// check as if it had rewritten every record. The real BUGS.md layout has entries between
// section headings — `## Open` follows `## Fixed` — so both terminators are load-bearing.

const TWO_ENTRIES_DOC =
  "## Fixed\n\n" +
  "### First bug: details (fixed 2026-09-28)\n\n" +
  "**Fix:** `firstFix` does it.\n\n" +
  "### Second bug: details (fixed 2026-09-29)\n\n" +
  "**Fix:** `secondFix` does it.\n";

test("bugEntryBody ends an entry at the next `### ` heading", () => {
  assert.equal(bugEntryBody(TWO_ENTRIES_DOC, "First bug: details (fixed 2026-09-28)"), "**Fix:** `firstFix` does it.");
  assert.equal(bugEntryBody(TWO_ENTRIES_DOC, "Second bug: details (fixed 2026-09-29)"), "**Fix:** `secondFix` does it.");
});

const SECTIONS_DOC =
  "## Fixed\n\n" +
  "### The bug: details (fixed 2026-09-29)\n\n" +
  "**Fix:** `theFix` does it.\n\n" +
  "## Open\n\n" +
  "### Next bug: details (found by qa 2026-09-29)\n\n" +
  "**Symptom:** still broken.\n";

test("bugEntryBody ends an entry at a `## ` section heading and reads only the Fixed section", () => {
  const body = bugEntryBody(SECTIONS_DOC, "The bug: details (fixed 2026-09-29)");
  assert.equal(body, "**Fix:** `theFix` does it.");
  assert.ok(!body.includes("## Open"), "the body stops at the section boundary");
  // Every caller looks up a heading fixedHeadings produced (the Fixed section), so a
  // heading that lives only in another section is absent: "" — which also means an entry
  // whose Open-record body would otherwise be mistaken for an unchanged Fixed body
  // (base Open → head Fixed, heading text identical) still faces the symbol check.
  assert.equal(bugEntryBody(SECTIONS_DOC, "Next bug: details (found by qa 2026-09-29)"), "");
});

test("bugEntryBody returns an empty body for a heading the doc does not carry", () => {
  assert.equal(bugEntryBody(DOC, "No such bug: details (found by qa 2026-09-29)"), "");
});

test("isOneLineRecord matches the compressed record forms and never a body bullet", () => {
  assert.ok(isOneLineRecord("- A bug (found by qa 2026-09-29, fixed 2026-09-29; commit 0165c3b6; gap: no-fake)"));
  assert.ok(isOneLineRecord("- A bug (fixed 2026-09-29; commit 0165c3b6)"));
  assert.ok(isOneLineRecord("- A bug (commit f09b3d74)"), "a heading with no dates keeps only the commit");
  assert.ok(isOneLineRecord("- A bug (found 2026-09-29, fixed 2026-09-29; gap: slow-check)"), "no merge commit");
  assert.ok(!isOneLineRecord("- **Fix:** `realFix` now handles it (commit 0165c3b6)."), "a labelled bullet");
  assert.ok(!isOneLineRecord("- same shape as the sibling bug (fixed 2026-09-24)"), "a body bullet");
  assert.ok(!isOneLineRecord("A bug (commit 0165c3b6)"), "not a bullet");
});

test("fixedSection ends an entry's own body at its first one-line record", () => {
  // The headingless one-line records parse as the last full entry's body; the
  // false-fix check must read that entry's own text and the records apart (BUGS.md 2026-10-13).
  const doc =
    "## Fixed\n\n### A full entry (fixed 2026-10-01)\n\n**Fix:** `realFix` handles it.\n\n" +
    "```md\n- A quoted record (fixed 2026-01-01; commit abc12345)\n```\n\n" +
    "- An old bug (fixed 2026-09-01; commit 1234abcd)\n\n- Another (fixed 2026-09-02; gap: no-fake)\n";
  const { entries, records } = fixedSection(doc);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.body, /^\*\*Fix:\*\* `realFix` handles it\.\n\n```md\n- A quoted record/);
  assert.ok(entries[0]!.body.endsWith("```"), "a record quoted in a fence stays body text");
  assert.deepEqual(records, [
    "- An old bug (fixed 2026-09-01; commit 1234abcd)",
    "- Another (fixed 2026-09-02; gap: no-fake)",
  ]);
  assert.equal(bugEntryBody(doc, "A full entry (fixed 2026-10-01)"), entries[0]!.body);
});

test("missingSymbolNames truncates a long missing list to three names plus an ellipsis", () => {
  // The gate's one-line rejection message stays one line no matter how many phantom symbols
  // the entry named.
  assert.equal(
    missingSymbolNames(["runScriptGroup", "signalTree", "commitPathsAndDiscardRest", "resetWorktreeToMain"]),
    "runScriptGroup, signalTree, commitPathsAndDiscardRest…",
  );
  assert.equal(missingSymbolNames(["runScriptGroup", "signalTree"]), "runScriptGroup, signalTree");
});

test("fixSymbols keeps whitespace-free backticked spans, drops prose and call parens", () => {
  assert.deepEqual(
    fixSymbols("The fix: `npm test` passes, `runScriptGroup()` in `src/build/build-check.ts` signals."),
    ["runScriptGroup", "src/build/build-check.ts"],
  );
  assert.deepEqual(fixSymbols("No symbols at all here."), []);
  assert.deepEqual(fixSymbols("Body without an explicit **Fix:** line, `stillCounted`."), [
    "stillCounted",
  ]);
});

// Regression coverage for the 2026-10-08 false-fix-guard record (BUGS.md): a Fixed body can
// hold more than one `**Fix:**` paragraph — a headingless record absorbed into the entry above
// it, or a narrative describing two changes. Reading only the first paragraph (Array.find) let
// a later one name symbols that exist nowhere on the tree while the guard passed on the first.

test("fixSymbols reads every Fix paragraph in a body, not only the first", () => {
  const body =
    "**Symptom:** the first thing broke.\n\n" +
    "**Fix:** `realFix` does the first thing.\n\n" +
    "**Validation gap:** none.\n\n" +
    "**Symptom:** an absorbed headingless record.\n\n" +
    "**Fix:** `phantomFix` does the second thing too.\n";
  assert.deepEqual(fixSymbols(body), ["realFix", "phantomFix"]);
});

test("fixSymbols unwraps a name quoted in JSON or array notation", () => {
  assert.deepEqual(fixSymbols('**Fix:** it returns `["falseFixReason"]`.'), ["falseFixReason"]);
  assert.deepEqual(fixSymbols("**Fix:** it returns `[]` for none."), []);
  assert.deepEqual(fixSymbols("**Fix:** it returns `'quotedName'`."), ["quotedName"]);
});

// Regression coverage for the 2026-10-23 record (BUGS.md): a Fix paragraph citing where its fix
// lives (`status-roles.ts:66`) was checked as a symbol named "status-roles.ts:66", which no file
// is, so every bugfix run closing that bug was rejected (105 times in 41 h).
test("fixSymbols reads a path:line location as its file and drops a bare line reference", () => {
  assert.deepEqual(
    fixSymbols(
      "**Fix:** `src/a.ts:66`, `b.ts:12:3`, `c.test.ts:5-9`, `:368` and `:40-42`; " +
        "`127.0.0.1:8000` and `node:test` stay as written.",
    ),
    ["src/a.ts", "b.ts", "c.test.ts", "127.0.0.1:8000", "node:test"],
  );
});

test("unbackedSymbols keeps only names absent from both the code haystack and the tree", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export function signalTree() {}\n");
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "real.test.ts"), "import { signalTree } from '../src/real.js';\n");
  const haystack = sourceHaystack(root);
  assert.deepEqual(unbackedSymbols(root, ["signalTree", "runScriptGroup"], haystack), [
    "runScriptGroup",
  ]);
  // A path candidate is backed by the file existing on disk, even if no code names it.
  assert.deepEqual(unbackedSymbols(root, ["src/real.ts", "./test/real.test.ts"], haystack), []);
});

test("unbackedSymbols backs a bare file name by a file of that name under the source dirs", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src", "status"), { recursive: true });
  // The file's own text never spells its name, so only the file walk can back it.
  fs.writeFileSync(path.join(root, "src", "status", "status-roles.ts"), "export const rows = 1;\n");
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "vendored.ts"), "\n");
  const haystack = sourceHaystack(root);
  assert.ok(!haystack.includes("status-roles.ts"), "the fixture must not back the name by text");
  assert.deepEqual(
    unbackedSymbols(root, ["status-roles.ts", "ghost-module.ts", "vendored.ts"], haystack),
    ["ghost-module.ts", "vendored.ts"],
  );
});

test("sourceHaystack covers code but excludes markdown (the bug entry names its own symbols)", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const marker = 1;\n");
  fs.writeFileSync(path.join(root, "BUGS.md"), "`marker` claimed here\n");
  const haystack = sourceHaystack(root);
  assert.ok(haystack.includes("const marker = 1;"));
  assert.ok(!haystack.includes("claimed here"));
});

test("sourceHaystack walks nested subdirectories — a symbol defined under src/ui backs a claim", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src", "ui"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "top.ts"), "export const topMarker = 1;\n");
  fs.writeFileSync(path.join(root, "src", "ui", "deep.ts"), "export const deepMarker = 1;\n");
  const haystack = sourceHaystack(root);
  assert.ok(haystack.includes("topMarker"));
  assert.ok(haystack.includes("deepMarker"), "nested source text is in the haystack");
  // The gate cross-checks a Fixed entry's symbols against this haystack: a fix that names
  // code living in a subdirectory must count as backed, not be flagged as a false fix.
  assert.deepEqual(unbackedSymbols(root, ["deepMarker"], haystack), []);
});

test("sourceHaystack skips node_modules and dist trees at any depth but keeps other subdirs", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src", "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "test", "helpers"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "node_modules", "pkg", "dep.js"), "const depMarker = 1;\n");
  fs.writeFileSync(path.join(root, "src", "dist", "built.js"), "const builtMarker = 1;\n");
  fs.writeFileSync(path.join(root, "test", "helpers", "kept.ts"), "const keptMarker = 1;\n");
  const haystack = sourceHaystack(root);
  assert.ok(!haystack.includes("depMarker"), "vendored code is excluded");
  assert.ok(!haystack.includes("builtMarker"), "build output is excluded");
  assert.ok(haystack.includes("keptMarker"), "an ordinary subdirectory is still walked");
});

test("sourceHaystack tolerates unreadable files and stays usable", () => {
  // Root reads anything, so the permission failure these branches exist for cannot fire.
  if (runningAsRoot()) return;
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "ok.ts"), "const okMarker = 1;\n");
  const sealed = path.join(root, "src", "sealed.ts");
  fs.writeFileSync(sealed, "const sealedMarker = 1;\n");
  fs.chmodSync(sealed, 0o000);
  const pkg = path.join(root, "package.json");
  fs.writeFileSync(pkg, "{}\n");
  fs.chmodSync(pkg, 0o000);
  try {
    const haystack = sourceHaystack(root);
    assert.ok(haystack.includes("okMarker"), "readable files still contribute");
    assert.ok(!haystack.includes("sealedMarker"), "an unreadable source file contributes nothing");
    assert.throws(() => fs.readFileSync(pkg, "utf8"), "the fixture must really block reads");
  } finally {
    fs.chmodSync(sealed, 0o644);
    fs.chmodSync(pkg, 0o644);
  }
});

// Regression coverage for the 2026-10-06 record (BUGS.md): the haystack was hard-coded to
// JS/TS extensions, so in a non-JS project (../nostalgia is Rust) it read nothing, every
// symbol came back unbacked, and every md-only BUGS.md Fixed edit was blocked at merge.
// The haystack is now language-neutral (markdown excluded, not a fixed source-extension
// list), so a Rust tree backs its symbols and still rejects a phantom one.

test("sourceHaystack reads non-JS source, so a Rust symbol backs a claim", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "lib.rs"), "pub fn known_titles() {}\n");
  const haystack = sourceHaystack(root);
  assert.ok(haystack.includes("known_titles"), "Rust source text is in the haystack");
  assert.deepEqual(
    unbackedSymbols(root, ["known_titles", "src/lib.rs"], haystack),
    [],
    "both the symbol and the path are backed",
  );
});

test("sourceHaystack still excludes markdown living under the walked source dirs", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const marker = 1;\n");
  fs.writeFileSync(path.join(root, "src", "docs", "notes.md"), "`marker` claimed here\n");
  const haystack = sourceHaystack(root);
  assert.ok(haystack.includes("const marker = 1;"));
  assert.ok(!haystack.includes("claimed here"), "a doc haystack would back any claim");
});

test("cachedSourceHaystack caches on the stat signature and re-reads on a change", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "const versionOne = 1;\n");
  const first = cachedSourceHaystack(root);
  assert.equal(first, sourceHaystack(root), "the cache is transparent on a fresh tree");
  assert.ok(first.includes("const versionOne = 1;"));
  // A second call on an unchanged tree returns the cached text.
  assert.equal(cachedSourceHaystack(root), first);
  // An unchanged tree is served from the cache — no file is re-read (the equality above is
  // the observable sign; the signature walk is stat-only).
  assert.equal(cachedSourceHaystack(root), first);
  // Rewriting the file (a different mtime/size) invalidates the signature: the next call
  // reflects the new content, and stays transparent.
  fs.writeFileSync(file, "const v2 = 2;\n");
  const second = cachedSourceHaystack(root);
  assert.ok(second.includes("const v2 = 2;"));
  assert.ok(!second.includes("const versionOne = 1;"));
  assert.equal(second, sourceHaystack(root), "the cache stays transparent after a change");
});

test("fixClaimProblems names a record whose symbols are all absent", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export function liveSymbol() {}\n");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    `# Bugs\n\n## Open\n\n### Still broken (found by qa 2026-09-22)\n\n## Fixed\n\n### Phantom bug: details (found by qa 2026-09-20, fixed 2026-09-21)\n\n**Symptom:** it broke.\n\n**Fix:** \`ghostPhantom\` merged.\n`,
  );
  const problems = fixClaimProblems(root);
  assert.ok(problems.length > 0, "the phantom record must be a problem");
  const first = problems[0]!;
  assert.equal(first.heading, "Phantom bug: details (found by qa 2026-09-20, fixed 2026-09-21)");
  assert.deepEqual(first.missing, ["ghostPhantom"]);
  // Adding the symbol's text to a src/ file (the stat-keyed haystack re-reads on the change)
  // empties the problem set for the same record.
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export function ghostPhantom() {}\n");
  assert.deepEqual(fixClaimProblems(root), []);
});

test("falseFixReason passes an md-only Fixed edit in a non-JS (Rust) project", async () => {
  // The ../nostalgia block: the haystack walked no .rs file, so the Rust symbols its entry
  // named were all unbacked and the md-only edit was rejected. A language-neutral haystack
  // backs them, so the edit lands.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "lib.rs"), "pub fn known_titles() {}\n");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### Now Playing (found 2026-10-06)\n\n**Symptom:** the fallback plays nothing.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### Now Playing (found 2026-10-06, fixed 2026-10-06)\n\n" +
      "**Fix:** `known_titles` in `src/lib.rs` now returns the fallback titles.\n",
  );
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
});

test("falseFixReason still flags a phantom symbol in a non-JS project", async () => {
  // Language-neutral must not mean check-neutral: a Rust tree with content still rejects a
  // Fix claim naming code that exists nowhere on the tree.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "lib.rs"), "pub fn known_titles() {}\n");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-10-06)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-10-06, fixed 2026-10-06)\n\n" +
      "**Fix:** `phantomRustSymbol` fixes it.\n",
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /phantomRustSymbol/);
});

test("falseFixReason flags a new Fixed entry whose Fix names nothing on the tree", async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-09-22)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-09-22, fixed 2026-09-23)\n\n" +
      "**Fix:** `runScriptGroup` in src/build/build-check.ts now signals the tree.\n",
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /runScriptGroup/);
  assert.match(reason!, /A bug/);
});

test("falseFixReason flags a later Fix paragraph in a Fixed body, not only the first", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export const realFix = 1;\n");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-10-08)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-10-08, fixed 2026-10-08)\n\n" +
      "**Fix:** `realFix` does it.\n\n" +
      "**Validation gap:** none.\n\n" +
      "**Symptom:** an absorbed headingless record.\n\n" +
      "**Fix:** `phantomRecordSymbol` does it too.\n",
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /phantomRecordSymbol/);
});

test("falseFixReason passes an md-only edit with no Fixed transition or a backed one", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.ts"), "const real = 1;\n"); // haystack fodder
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-09-22)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  // 1: a new Open bug — no Fixed transition at all.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-09-22)\n\n**Symptom:** x.\n\n### Another (found 2026-09-23)\n",
  );
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
  // 2: a Fixed transition whose Fix names a symbol the tree's code actually has.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-09-22, fixed 2026-09-23)\n\n**Fix:** `real` now handled.\n",
  );
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
  // 3: not touching BUGS.md at all — never checked.
  assert.equal(await falseFixReason(root, "main", ["docs/notes.md"]), undefined);
});

test("falseFixReason tolerates a deleted BUGS.md instead of throwing out of the gate", async () => {
  // An md-only diff may delete BUGS.md. The read must read as "no Fixed transition to
  // check" and let the gate's sibling backlog-structure check report the dropped section —
  // not throw ENOENT and turn that deterministic rejection into a failed gate.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n### A bug (found 2026-09-27)\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.rmSync(path.join(root, "BUGS.md"));
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
});

// ── The two holes the phantom-markdown carries exploited (BUGS.md 2026-09-23) ───────────

test("falseFixReason checks an already-Fixed entry whose narrative the diff rewrites", async () => {
  // Hole 1: the old code skipped any heading already under ## Fixed in the base, so an
  // in-place rewrite of a phantom record's narrative — the exact shape a second phantom
  // merge takes — evaded the symbol check.
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-09-22, fixed 2026-09-23)\n\n" +
      "**Fix:** `runScriptGroup` now signals the tree.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the phantom record being rewritten");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-09-22, fixed 2026-09-23)\n\n" +
      "**Fix:** rewritten: `runScriptGroup` and `refusalContradiction` landed.\n",
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /runScriptGroup/);
  assert.match(reason!, /rewrites the already-Fixed entry "A bug/, "a rewrite is not called a move");
});

test("falseFixReason leaves an already-Fixed entry with an untouched body alone", async () => {
  // The skip survives only for a body-identical entry: history prose (and a record whose
  // symbols were since renamed) must keep merging md-only when the diff does not touch it.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "old.ts"), "const real = 1;\n");
  const fixedDoc =
    "## Fixed\n\n### An old bug (found 2026-09-20, fixed 2026-09-21)\n\n**Fix:** `ghostSymbol` handled.\n";
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n" + fixedDoc);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  // The diff only adds a new Open bug; the Fixed entry is byte-identical to the base.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### New (found 2026-09-23)\n\n" + fixedDoc,
  );
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
});

// Regression coverage for the 2026-10-23 record (BUGS.md): BUGS-FIXED.md held two Fixed entries
// whose headings normalize alike (the same bug fixed by two roles). The base bodies sat in a map
// keyed by heading, so only the second body was kept, the first entry read as rewritten on every
// md-only edit, and its Fix paragraph named a symbol a rename had since removed: 27 unrelated
// edits from five roles were rejected as "rewrites the already-Fixed entry".
test("falseFixReason leaves two untouched Fixed entries that share a normalized heading alone", async () => {
  const root = makeRepo();
  const twins =
    "## Fixed\n\n### The same bug (found 2026-10-06, fixed 2026-10-06 by bugfix loop)\n\n" +
    "**Fix:** `renamedAwaySymbol` now does it.\n\n" +
    "### The same bug (found 2026-10-06, fixed 2026-10-06 by perf loop)\n\n" +
    "**Fix:** the prompt now carries the index.\n";
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n" + twins);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed twins");
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n### New (found 2026-10-23)\n\n" + twins);
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
  // A rewrite of either twin into a new body still faces the symbol check.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n" + twins.replace("the prompt now carries the index.", "`phantomTwinSymbol` does it."),
  );
  assert.match((await falseFixReason(root, "main", ["BUGS.md"]))!, /rewrites the already-Fixed entry .*phantomTwinSymbol/);
});

test("falseFixReason backs a Fix paragraph that cites its fix as path:line locations", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src", "status"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "status", "status-roles.ts"), "export const rows = 1;\n");
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n### A bug (found 2026-10-21)\n\n**Symptom:** x.\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-10-21, fixed 2026-10-22)\n\n" +
      "**Fix:** the filter at `status-roles.ts:66` and `src/status/status-roles.ts:70`, `:72-74` now keeps it.\n",
  );
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
  // A location in a file the tree lacks is still a phantom, named by its file.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A bug (found 2026-10-21, fixed 2026-10-22)\n\n**Fix:** `src/ghost.ts:12` now keeps it.\n",
  );
  assert.match((await falseFixReason(root, "main", ["BUGS.md"]))!, /nowhere on this tree: src\/ghost\.ts —/);
});

test("falseFixReason measures an Open→Fixed restoration against the merge-base, not main's tip", async () => {
  // Hole 2: comparing against main's tip let a stacked batch's predecessor (which moved the
  // entry Fixed→Open) be undone by a restoration whose base still read (falsely) Fixed —
  // the record slipped through as "already done". The base is the diff's own merge-base.
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-09-22)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed: entry is Open");
  const wt = await ensureWorktree(root, ROLE, "main"); // branch cut while the entry is Open
  // Main advances: a phantom merge put the record in Fixed (as b65df63 did).
  const fixedDoc =
    "## Fixed\n\n### A bug (found 2026-09-22, fixed 2026-09-23)\n\n**Fix:** `runScriptGroup` now signals the tree.\n";
  fs.writeFileSync(path.join(root, "BUGS.md"), fixedDoc);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "main gains the phantom record");
  // The stacked md-only change restores the same Fixed record relative to its merge-base.
  fs.writeFileSync(path.join(wt, "BUGS.md"), fixedDoc);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "bugfix: mark the bug fixed again");
  const reason = await falseFixReason(wt, "main", ["BUGS.md"]);
  assert.match(reason!, /runScriptGroup/);
});

test("falseFixReason checks a Fixed entry whose narrative after its quoted fence the diff rewrites", async () => {
  // The fence-blind readers truncated base and head bodies at the same quoted fence, so a
  // rewrite confined to text after the fence compared equal and skipped the symbol check —
  // and the Fix paragraph itself lived after the fence, so fixSymbols saw none of it.
  const root = makeRepo();
  const entry =
    "## Fixed\n\n### A leak (found 2026-09-22, fixed 2026-09-23)\n\n" +
    "**Symptom:** the kill leaked grandchildren.\n\n" +
    "```md\n## Done\n\n### Quoted entry (fixed 2026-01-01)\n```\n\n" +
    "**Fix:** the kill now goes through `runScriptGroup`.\n";
  fs.writeFileSync(path.join(root, "BUGS.md"), entry);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the record with a quoted fence");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    entry + "\nRewritten narrative: the kill also handles signals now.\n",
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /runScriptGroup/);
});

// ── The one-line record archive (BUGS.md 2026-10-13) ────────────────────────────────────
// The headingless records below the full Fixed entries parsed as the LAST full entry's body.
// Compressing the oldest full entries made a different entry last, its body "changed", and
// every record's names faced the symbol check: two prose names no code ever held rejected
// three steward compressions in a row.

/** A Fixed section of full entries (newest first) over a one-line record archive whose first
 * record names `ghostName`, a prose name no code holds. The full entries write `Fix:` without
 * the bold label, so the old reader scanned a last entry's whole body, archive included. */
function archiveDoc(full: string[], records: string[]): string {
  const entries = full.map((name) => `### ${name} broke (fixed 2026-10-01)\n\nFix: \`${name}Fn\` handles it.\n`);
  return `## Fixed\n\n${entries.join("\n")}\n${records.join("\n")}\n`;
}

const GHOST_RECORD = "- An old leak: `ghostName` never existed (fixed 2026-09-01; commit 1234abcd)";

function archiveRepo(): string {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export const newerFn = 1, olderFn = 2;\n");
  fs.writeFileSync(path.join(root, "BUGS.md"), archiveDoc(["newer", "older"], [GHOST_RECORD]));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed: two full entries over the archive");
  return root;
}

test("falseFixReason passes a compression that makes a different full entry last", async () => {
  const root = archiveRepo();
  // The older full entry becomes a record; `newer`'s own body is untouched, but it now sits
  // directly above the archive.
  const compressed = "- older broke: `olderFn` handles it (fixed 2026-10-01; commit 5678abcd)";
  fs.writeFileSync(path.join(root, "BUGS.md"), archiveDoc(["newer"], [compressed, GHOST_RECORD]));
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
});

test("falseFixReason lets an edited record carry a name the base's Fixed section already holds", async () => {
  const root = archiveRepo();
  // History keeps a renamed symbol's old name: rewording the ghost record is no new claim.
  const reworded = "- An old leak, reworded: `ghostName` (fixed 2026-09-01; commit 1234abcd)";
  fs.writeFileSync(path.join(root, "BUGS.md"), archiveDoc(["newer", "older"], [reworded]));
  assert.equal(await falseFixReason(root, "main", ["BUGS.md"]), undefined);
});

test("falseFixReason flags a new one-line record that introduces a name the tree lacks", async () => {
  const root = archiveRepo();
  // A bug moved straight from Open into a record faces the same check a full entry does.
  const phantom = "- A new bug: `phantomRecordFn` fixes it (fixed 2026-10-13; commit 9abcdef0)";
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    archiveDoc(["newer", "older"], [phantom, GHOST_RECORD]),
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /adds the one-line Fixed record "- A new bug/);
  assert.match(reason!, /: phantomRecordFn — /);
});

// ── Gate orchestration ──────────────────────────────────────────────────────────────────

/** Repo whose worktree carries an md-only BUGS.md commit claiming a fix for `symbol`. */
async function falseFixFixture(symbol: string, symbolOnTree: boolean): Promise<string> {
  const root = makeRepo();
  if (symbolOnTree) {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "real.ts"), `export function ${symbol}() {}\n`);
sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "code");
  }
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    "## Fixed\n\n### A leak (found 2026-09-22, fixed 2026-09-23)\n\n" +
      `**Fix:** the group kill now goes through \`${symbol}\`.\n`,
  );
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "bugfix: mark the leak fixed");
  return root;
}

test("gate rejects an md-only BUGS.md fix claim with no code behind it, without running pi", async () => {
  const root = await falseFixFixture("runScriptGroup", false);
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected"); // deterministic — no reviewer run
    assert.ok(!fs.existsSync(marker));
    assert.match(result.detail!, /runScriptGroup/);
    assert.match(state.lastReview!.reasons[0]!, /Fixed/);
    assert.equal(await aheadOfMain(wt, "main"), 0); // the false record is discarded
  });
});

test("gate rejects an md-only rewrite of an already-Fixed record's narrative", async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Fixed\n\n### A leak (found 2026-09-22, fixed 2026-09-23)\n\n" +
      "**Fix:** the group kill now goes through `runScriptGroup`.\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the phantom record");
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "BUGS.md"),
    "## Fixed\n\n### A leak (found 2026-09-22, fixed 2026-09-23)\n\n" +
      "**Fix:** rewritten: the kill now goes through `runScriptGroup` and `signalTree`.\n",
  );
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "bugfix: refresh the record");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected", "the rewrite faces the same symbol check");
    assert.ok(!fs.existsSync(marker));
    assert.match(result.detail!, /runScriptGroup/);
  });
});

test("gate exempts an md-only BUGS.md fix claim whose symbols exist on the tree", async () => {
  const root = await falseFixFixture("signalTree", true);
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker));
  });
});

// ── The gate's backlog-structure check (plans part 2/4) — same deterministic shape as the
// false-fix rejections above: no pi run, no check run, the reason injected into the author's
// next run, and the branch reset to main.

/** A repo whose worktree carries a PLANS.md commit that adds a second `## Done` — md-only, so
 * the gate exempts it from the reviewer and the structure check is the only guard. */
async function duplicateDoneFixture(): Promise<string> {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "## Done\n\n### Landed (planned 2026-09-24, done 2026-09-25)\n\n## Planned\n\n_None yet._\n",
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base backlog");
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(
    path.join(wt, "PLANS.md"),
    "## Done\n\n### A stray plan (planned 2026-09-26)\n",
  );
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "plan: file it twice");
  return root;
}

test("gate rejects an md-only diff that duplicates ## Done, without running pi or the check", async () => {
  const root = await duplicateDoneFixture();
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected"); // deterministic — no reviewer run
    assert.ok(!fs.existsSync(marker));
    assert.match(result.detail!, /## Done/);
    assert.match(state.lastReview!.reasons[0]!, /PLANS\.md/);
    assert.equal(await aheadOfMain(wt, "main"), 0); // the malformed file is discarded
  });
});

test("gate rejects a code diff that breaks backlog structure before the build pre-check runs", async () => {
  const root = await duplicateDoneFixture();
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  // Make the diff non-exempt with a real code change; the structure rejection must fire
  // before any build_check event is logged.
  fs.writeFileSync(path.join(wt, "src.ts"), "export const x = 1;\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "code plus a duplicated heading");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail!, /## Done/);
    assert.ok(!fs.existsSync(marker));
    assert.ok(
      !readEvents(root).some((e) => e.type === "build_check"),
      "no check run spent on a tree the heading set already condemns",
    );
  });
});
