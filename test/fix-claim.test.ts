import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bugEntryBody,
  falseFixReason,
  fixSymbols,
  fixedHeadings,
  missingSymbolNames,
  normalizeFixedHeading,
  sourceHaystack,
  unbackedSymbols,
} from "../src/fix-claim.js";
import { aheadOfMain } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { makeRepo, runningAsRoot, sh, tmpdir } from "./repo-fixtures.js";
import { reviewGate, ROLE } from "./gate-fixtures.js";
import { fakePi } from "./fake-pi.js";

// Regression coverage for the 2026-09-22 false-fix record (BUGS.md): commit 9cea8c3 was an
// md-only BUGS.md edit that moved a bug to Fixed with a Fix paragraph naming runScriptGroup
// and signalTree — symbols that exist nowhere in main's history. The md-only exemption is a
// fast path by design, so the gate itself now cross-checks a new Fixed entry's symbols
// against the tree being landed; the pure functions below pin that parsing, and the
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
  // The bugfix tick appends provenance and ", fixed <date>" when it moves an entry.
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
    fixSymbols("The fix: `npm test` passes, `runScriptGroup()` in `src/build-check.ts` signals."),
    ["runScriptGroup", "src/build-check.ts"],
  );
  assert.deepEqual(fixSymbols("No symbols at all here."), []);
  assert.deepEqual(fixSymbols("Body without an explicit **Fix:** line, `stillCounted`."), [
    "stillCounted",
  ]);
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
      "**Fix:** `runScriptGroup` in src/build-check.ts now signals the tree.\n",
  );
  const reason = await falseFixReason(root, "main", ["BUGS.md"]);
  assert.match(reason!, /runScriptGroup/);
  assert.match(reason!, /A bug/);
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

// ── The two holes the phantom-markdown carries exploited (BUGS.md 2026-09-23) ───────────

test("falseFixReason checks an already-Fixed entry whose narrative the diff rewrites", async () => {
  // Hole 1: the old code skipped any heading already under ## Fixed in the base, so an
  // in-place rewrite of a phantom record's narrative — the exact shape a second phantom
  // landing takes — evaded the symbol check.
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
});

test("falseFixReason leaves an already-Fixed entry with an untouched body alone", async () => {
  // The skip survives only for a body-identical entry: history prose (and a record whose
  // symbols were since renamed) must keep landing md-only when the diff does not touch it.
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
  // Main advances: a phantom landing put the record in Fixed (as b65df63 did).
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
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected"); // deterministic — no reviewer run
    assert.ok(!fs.existsSync(marker));
    assert.match(result.detail!, /runScriptGroup/);
    assert.match(state.lastReview!.reasons[0]!, /Fixed/);
    assert.equal(await aheadOfMain(wt, "main"), 0); // the false record is discarded
  } finally {
    restore();
  }
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
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected", "the rewrite faces the same symbol check");
    assert.ok(!fs.existsSync(marker));
    assert.match(result.detail!, /runScriptGroup/);
  } finally {
    restore();
  }
});

test("gate exempts an md-only BUGS.md fix claim whose symbols exist on the tree", async () => {
  const root = await falseFixFixture("signalTree", true);
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker));
  } finally {
    restore();
  }
});
