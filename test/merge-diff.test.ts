/** The landing-diff module's line multiset (src/merge/merge-diff.ts): diffLineMultiset is
 * used to tell a rebased patch that gained or lost content lines, and counts a markdown rule
 * `---` inside a hunk as content rather than a file header. Extracted from
 * merge-to-main.test.ts (2026-10-11). */
import test from "node:test";
import assert from "node:assert/strict";
import { diffLineMultiset } from "../src/merge/merge-diff.js";

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

