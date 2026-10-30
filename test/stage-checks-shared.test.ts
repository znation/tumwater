import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STALE_HITS,
  MAX_STALE_PATHS,
  JS_FILE,
  cappedList,
  diffPlusPath,
  diffRemovedAdded,
  gitGrepHits,
  hasStandalonePathOccurrence,
  isRecordProse,
  standalonePathIndexes,
} from "../src/run/stage-checks-shared.js";

/** Unit coverage for src/run/stage-checks-shared.ts — the pure diff/index reading helpers the
 * three staging self-check modules (stage-path-checks, stage-name-checks, stage-prose-checks)
 * share. Each helper's edge cases (the `+++ b/` and `/dev/null` path forms, the git grep
 * grammar and its malformed lines, the capped finding lists, and the standalone-path match
 * that must not read `src/x/config.ts` as the old root `config.ts`) are load-bearing for every
 * consumer, so each is pinned here directly rather than only through the integration
 * stage-check.test.ts. */

test("diffPlusPath strips the +++ marker and b/ prefix, and keeps /dev/null", () => {
  assert.equal(diffPlusPath("+++ b/src/a.ts"), "src/a.ts");
  assert.equal(diffPlusPath("+++ /dev/null"), "/dev/null");
});

test("diffRemovedAdded parses a -U0 diff into per-file removed/added lines", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-export const a = 1;",
    "+export const a = 2;",
    "\\ No newline at end of file",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-line one",
    "-line two",
  ].join("\n");
  assert.deepEqual(diffRemovedAdded(diff), [
    { path: "src/a.ts", removed: ["export const a = 1;"], added: ["export const a = 2;"] },
    { path: "src/b.ts", removed: ["line one", "line two"], added: [] },
  ]);
});

test("diffRemovedAdded drops context and hunk/header lines", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " unchanged context",
    "-removed",
    "+added",
  ].join("\n");
  assert.deepEqual(diffRemovedAdded(diff), [
    { path: "src/a.ts", removed: ["removed"], added: ["added"] },
  ]);
});

test("gitGrepHits parses path:line:text and drops malformed and empty lines", () => {
  assert.deepEqual(
    gitGrepHits(["src/a.ts:1:export const a", "src/keep.ts:7:export const keep", "no-colon-line", ""].join("\n")),
    [
      { file: "src/a.ts", no: "1", text: "export const a" },
      { file: "src/keep.ts", no: "7", text: "export const keep" },
    ],
  );
});

test("cappedList joins up to max and appends moreSuffix for the rest", () => {
  assert.equal(cappedList(["a", "b"], 2), "a, b");
  assert.equal(cappedList(["a", "b", "c"], 2), "a, b (+1 more)");
  assert.equal(cappedList([], MAX_STALE_HITS), "");
  assert.equal(cappedList(["a", "b", "c", "d", "e"], MAX_STALE_HITS), "a, b, c, d, e");
  assert.equal(cappedList(["a", "b", "c"], MAX_STALE_PATHS), "a, b, c");
});

test("isRecordProse names the backlog files, their archives, and plans/ design docs", () => {
  for (const f of ["PLANS.md", "BUGS.md", "QUESTIONS.md", "PLANS-DONE.md", "BUGS-FIXED.md", "plans/design.md"]) {
    assert.equal(isRecordProse(f), true, `${f} should be record prose`);
  }
  assert.equal(isRecordProse("src/a.ts"), false);
  assert.equal(isRecordProse("plans/design.txt"), false);
  assert.equal(isRecordProse("plans-misc/design.md"), false);
});

test("JS_FILE matches the supported source extensions", () => {
  for (const f of ["src/a.ts", "src/a.tsx", "src/a.js", "src/a.mjs"]) assert.equal(JS_FILE.test(f), true, f);
  for (const f of ["src/a.json", "README.md", "plans/design.md", "src/a.css"]) assert.equal(JS_FILE.test(f), false, f);
});

test("standalonePathIndexes finds only path-of-its-own occurrences", () => {
  // An exact mention of the needle at the start of a word is standalone.
  assert.deepEqual(standalonePathIndexes("See src/a.ts for details.", "src/a.ts"), [4]);
  // A preceding path character (the / of a containing directory) disqualifies an occurrence,
  // so a shorter root path is not read inside a longer path.
  assert.deepEqual(standalonePathIndexes("src/x/src/a.ts", "src/a.ts"), []);
  // The path character is a segment separator, not a boundary-qualifier: a word starting at
  // index 0 (no preceding char) is still a standalone occurrence.
  assert.deepEqual(standalonePathIndexes("src/a.ts:2", "src/a.ts"), [0]);
  // A following path token ("src/a" in "src/a.ts") continues the occurrence and so
  // disqualifies the shorter needle.
  assert.deepEqual(standalonePathIndexes("See src/a.ts.", "src/a"), []);
  // A following hyphen/underscore (a compound segment) also continues the token.
  assert.deepEqual(standalonePathIndexes("src/a-gen.ts", "src/a"), []);
  assert.deepEqual(standalonePathIndexes("src/a_keep.ts", "src/a"), []);
  // Trailing sentence punctuation does not disqualify the occurrence.
  assert.equal(hasStandalonePathOccurrence("Moved src/a.ts to src/x/a.ts.", "src/a.ts"), true);
  // A dot extension qualifies the following-char check only when an alphanumeric
  // follows it: "src/a.tsv" must not read as "src/a.ts".
  assert.equal(hasStandalonePathOccurrence("data/src/a.tsv", "src/a.ts"), false);
  // After the dot, an alphanumeric continues the token regardless of the next dot.
  assert.equal(hasStandalonePathOccurrence("See src/a.ts... done.", "src/a.ts"), true);
  // The needle itself as the whole token is standalone.
  assert.deepEqual(standalonePathIndexes("config.ts:1", "config.ts"), [0]);
  assert.deepEqual(standalonePathIndexes("See config.ts.", "config.ts"), [4]);
});
