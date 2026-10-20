import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cachedBaselineVerdict,
  checkMainBaseline,
  mainIsGreen,
  noteGreenBaseline,
  noteInheritedGreen,
} from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";

// The green carry-over in src/baseline/main-baseline.ts (inheritedGreen, noteInheritedGreen):
// a main SHA whose tree differs from a green-verified ancestor only in review-exempt paths
// inherits the green instead of re-running the suite, and an inherited green ranks below an
// observed one. main-baseline.test.ts covers the cache, the red re-verification policy and
// seeding that this builds on.

const ROLE = "improve";
/** The defaults carry review.exemptPaths ["*.md", "docs/**"], the patterns the carry-over reads. */
const CFG = defaultConfig();

/** Commit `files` (path → content) on the fixture's main and move the role worktree onto it, the
 * way a fresh run resets to main. Returns the new main SHA. */
function advanceMain(root: string, wt: string, files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  // Only the named files: `add -A` would also stage the role worktree under .tumwater/ as a
  // gitlink (a real project gitignores it), a non-exempt path in every delta.
  sh(root, "git", "add", "--", ...Object.keys(files));
  sh(root, "git", "commit", "-m", message);
  sh(wt, "git", "reset", "--hard", "main");
  return headSha(root);
}

/** A baseline fixture whose suite passes and counts its runs in the returned counter file. */
function greenFixture(): { root: string; wt: string; counter: string } {
  const counter = path.join(tmpdir(), "runs");
  return { ...baselineFixture(ROLE, `echo run >> ${counter}; echo ok`), counter };
}

test("a doc-only commit on a green main inherits the green without running the suite", async () => {
  const { root, wt, counter } = greenFixture();
  const green = headSha(root);
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "green");
  assert.equal(runsOf(counter), 1);
  const doc = advanceMain(root, wt, { "NOTES.md": "notes\n", "docs/guide.md": "guide\n" }, "docs");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "green");
  assert.equal(result.baseline?.sha, doc);
  assert.equal(result.baseline?.inheritedFrom, green, "the verdict names the green it came from");
  assert.equal(runsOf(counter), 1, "the suite did not run again for a doc-only move");
  assert.equal(cachedBaselineVerdict(doc), "green", "the carry-over is cached for every consumer");
});

test("the carry-over walks through several doc commits to the nearest verdict", async () => {
  const { root, wt, counter } = greenFixture();
  const green = headSha(root);
  noteGreenBaseline(green);
  advanceMain(root, wt, { "a.md": "a\n" }, "doc a");
  advanceMain(root, wt, { "b.md": "b\n" }, "doc b");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.inheritedFrom, green);
  assert.equal(runsOf(counter), 0);
});

test("a code commit on a green main runs the suite", async () => {
  const { root, wt, counter } = greenFixture();
  noteGreenBaseline(headSha(root));
  advanceMain(root, wt, { "notes.md": "doc\n", "src/app.js": "export {};\n" }, "code and docs");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "green");
  assert.equal(result.baseline?.inheritedFrom, undefined, "an observed verdict, not a carried one");
  assert.equal(runsOf(counter), 1, "a non-exempt path in the delta means the suite ran");
});

test("a move out of a non-exempt path into docs/ is not a doc-only delta", async () => {
  const { root, wt, counter } = greenFixture();
  advanceMain(root, wt, { "src/tool.js": "export {};\n" }, "code");
  noteGreenBaseline(headSha(root));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  sh(root, "git", "mv", "src/tool.js", "docs/tool.js");
  sh(root, "git", "commit", "-m", "move into docs");
  sh(wt, "git", "reset", "--hard", "main");
  await checkMainBaseline(wt, CFG);
  assert.equal(runsOf(counter), 1, "the removal from src/ counts: the suite ran");
});

test("the nearest verdict being red stops the carry-over: a doc commit after a red re-runs", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  const red = headSha(root);
  noteGreenBaseline(`unrelated-green-${red}`);
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  advanceMain(root, wt, { "README.md": "readme\n" }, "doc after red");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "a doc commit after a red may be its fix, so it is checked");
});

test("a config without exempt paths carries nothing over", async () => {
  const { root, wt, counter } = greenFixture();
  noteGreenBaseline(headSha(root));
  advanceMain(root, wt, { "notes.md": "doc\n" }, "docs");
  const cfg = { ...CFG, review: { ...CFG.review, exemptPaths: [] } };
  await checkMainBaseline(wt, cfg);
  assert.equal(runsOf(counter), 1, "with no exempt paths every new SHA runs its own check");
});

test("observedOnly ignores an inherited green, and the run's red replaces it for everyone", async () => {
  const counter = path.join(tmpdir(), "runs");
  // The suite passes until the docs say otherwise: a doc edit that breaks a test reading the docs.
  const { root, wt } = baselineFixture(
    ROLE,
    `echo run >> ${counter}; if [ -f BROKEN.md ]; then echo docs-broke-it; exit 1; fi; echo ok`,
  );
  noteGreenBaseline(headSha(root));
  const broken = advanceMain(root, wt, { "BROKEN.md": "x\n" }, "doc that breaks a docs test");
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.inheritedFrom !== undefined, true);
  assert.equal(runsOf(counter), 0);
  const observed = await checkMainBaseline(wt, CFG, undefined, false, false, undefined, true);
  assert.equal(observed.baseline?.status, "red", "attribution ran the suite instead of trusting the carry-over");
  assert.equal(runsOf(counter), 1);
  assert.equal(cachedBaselineVerdict(broken), "red", "the observed red replaced the inherited green");
});

test("observedOnly's green upgrades an inherited green to an observed one", async () => {
  const { root, wt, counter } = greenFixture();
  noteGreenBaseline(headSha(root));
  advanceMain(root, wt, { "notes.md": "doc\n" }, "docs");
  assert.notEqual((await checkMainBaseline(wt, CFG)).baseline?.inheritedFrom, undefined);
  const observed = await checkMainBaseline(wt, CFG, undefined, false, false, undefined, true);
  assert.equal(observed.baseline?.inheritedFrom, undefined);
  assert.equal(runsOf(counter), 1);
  await checkMainBaseline(wt, CFG, undefined, false, false, undefined, true);
  assert.equal(runsOf(counter), 1, "the upgraded verdict now answers attribution from the cache");
});

test("mainIsGreen inherits across doc commits, like the redeploy pre-warm needs", async () => {
  const { root, wt, counter } = greenFixture();
  noteGreenBaseline(headSha(root));
  advanceMain(root, wt, { "docs/howto.md": "howto\n" }, "docs");
  assert.equal(await mainIsGreen(wt, CFG), true);
  assert.equal(runsOf(counter), 0, "the redeployer's green check did not run the suite for a doc head");
});

test("noteInheritedGreen never displaces an observed red", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  noteInheritedGreen(headSha(root), "some-ancestor");
  assert.equal(cachedBaselineVerdict(headSha(root)), "red");
});

test("an observed green displaces an inherited one", async () => {
  const { root, wt, counter } = greenFixture();
  noteInheritedGreen(headSha(root), "some-ancestor");
  noteGreenBaseline(headSha(root));
  const result = await checkMainBaseline(wt, CFG, undefined, false, false, undefined, true);
  assert.equal(result.baseline?.inheritedFrom, undefined);
  assert.equal(runsOf(counter), 0, "attribution trusts the observed green without a run");
});

test("a carried-over head is itself a verdict the next doc commit can inherit from", async () => {
  const { root, wt, counter } = greenFixture();
  const green = headSha(root);
  noteGreenBaseline(green);
  const first = advanceMain(root, wt, { "one.md": "1\n" }, "doc one");
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.inheritedFrom, green);
  advanceMain(root, wt, { "two.md": "2\n" }, "doc two");
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.inheritedFrom, first, "the nearest cached verdict is the anchor");
  assert.equal(runsOf(counter), 0);
});
