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
