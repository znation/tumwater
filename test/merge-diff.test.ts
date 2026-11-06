/** The merge-diff module's line multiset (src/merge/merge-diff.ts): diffLineMultiset is
 * used to tell a rebased patch that gained or lost content lines, and counts a markdown rule
 * `---` inside a hunk as content rather than a file header. Extracted from
 * merge-to-main.test.ts (2026-10-11). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { diffLineMultiset, resolvedDiffDiverges } from "../src/merge/merge-diff.js";
import { commitIn, headSha, initializedWorktree } from "./fixtures/repo-fixtures.js";
import { dropLooseObject } from "./helpers/git-faults.js";

test("diffLineMultiset counts hunk content lines that carry header-like prefixes", () => {
  const diff = [
    "diff --git a/x.md b/x.md",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1,3 +1,3 @@",
    "--keep",
    "---",
    "+--gone",
    "+new",
    "diff --git a/y.md b/y.md",
    "--- a/y.md",
    "+++ b/y.md",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+old2",
  ].join("\n");
  const { add, del } = diffLineMultiset(diff);
  assert.deepEqual(del, ["-keep", "--", "old"], "the deleted markdown rule --- is content, not a header");
  assert.deepEqual(add, ["--gone", "new", "old2"]);
});

test("a resolution whose diff git cannot produce throws instead of skipping its re-review", async () => {
  // Read as empty, the resolved diff is a subset of any approved one, so a resolution that
  // added lines the reviewer never saw merged on the build check alone.
  const { wt } = await initializedWorktree();
  fs.mkdirSync(path.join(wt, "sub"));
  fs.writeFileSync(path.join(wt, "sub", "x.ts"), "export const approved = 1;\n");
  commitIn(wt, "the approved change");
  const preMergeHead = headSha(wt);
  fs.appendFileSync(path.join(wt, "sub", "x.ts"), "export const restored = 2;\n");
  commitIn(wt, "the resolution");
  assert.equal(await resolvedDiffDiverges({ mainBranch: "main" }, wt, preMergeHead), true);
  dropLooseObject(wt, "HEAD:sub"); // the resolved tree only: the approved diff still reads
  await assert.rejects(resolvedDiffDiverges({ mainBranch: "main" }, wt, preMergeHead), /git diff main\.\.\.HEAD failed/);
});

test("a resolution that stays inside the approved diff does not diverge", async () => {
  // A sound resolution reintroduces exactly the reviewed lines after main moved them aside: the
  // resolved diff's added lines are a multiset subset of the approved diff's, so the merge lands
  // the fix once without a re-review (BUGS-FIXED.md 2026-11-05).
  const { root, wt } = await initializedWorktree();
  fs.mkdirSync(path.join(wt, "sub"));
  fs.writeFileSync(path.join(wt, "sub", "x.ts"), "export const approved = 1;\n");
  commitIn(wt, "the approved change");
  const preMergeHead = headSha(wt);
  // The worktree's fix is reverted while it waits, then main moves the same file aside.
  fs.rmSync(path.join(wt, "sub", "x.ts"));
  commitIn(wt, "revert before resolution");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "x.ts"), "export const mainAside = 9;\n");
  commitIn(root, "main moves the file aside");
  // The resolution re-adds the reviewed line, whose content the approved diff already carried.
  fs.writeFileSync(path.join(wt, "sub", "x.ts"), "export const approved = 1;\n");
  commitIn(wt, "the sound resolution");
  assert.equal(await resolvedDiffDiverges({ mainBranch: "main" }, wt, preMergeHead), false);
});
