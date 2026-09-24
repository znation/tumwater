import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bugEntryBody,
  falseFixReason,
  fixSymbols,
  fixedHeadings,
  normalizeFixedHeading,
  sourceHaystack,
  unbackedSymbols,
} from "../src/fix-claim.js";
import { reviewAheadOfMain } from "../src/review.js";
import { aheadOfMain } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/state.js";
import { fakePi, makeRepo, sh, tmpdir } from "./util.js";

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
  if (process.getuid && process.getuid() === 0) return;
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

// ── Gate orchestration ────────────────────────────────────────────────────────────────────

const ROLE = "improve";

function gateCtx(root: string, wt: string, tick = 1) {
  return { root, role: ROLE, wt, mainBranch: "main", config: defaultConfig(), tick };
}

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
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
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
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
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
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker));
  } finally {
    restore();
  }
});
