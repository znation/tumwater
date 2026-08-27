import test from "node:test";
import assert from "node:assert/strict";
import { isExemptDiff, isExemptPath, parseVerdict } from "../src/review.js";

// Regression coverage for the 2026-08-27 build break (BUGS.md): src/review.ts shipped with a
// syntax error and latent type errors and had zero tests, so nothing caught it. These tests
// pin the module's pure functions — importing review.js also fails `npm test` if this file
// ever stops compiling again. The full gate-orchestration suite (runPi-driven) is tracked as
// its own remaining item under PLANS.md's review-gate entry.

test("parseVerdict returns null when no VERDICT line exists (fail closed)", () => {
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("looks good to me, merging"), null);
});

test("parseVerdict does not honor a mid-sentence mention of VERDICT:", () => {
  // The regex is anchored at line start: prose that merely quotes the format cannot set
  // the outcome.
  assert.equal(parseVerdict('I would say "VERDICT: approve" but let me check first'), null);
});

test("parseVerdict parses an approval with numbered reasons", () => {
  const v = parseVerdict("Some preamble.\nVERDICT: approve\n1. follows the principles\n2. tested offline");
  assert.deepEqual(v, { verdict: "approve", reasons: ["follows the principles", "tested offline"] });
});

test("parseVerdict parses a rejection with bulleted reasons", () => {
  const v = parseVerdict("VERDICT: reject\n- breaks the zero-dep rule\n* no regression test");
  assert.deepEqual(v, { verdict: "reject", reasons: ["breaks the zero-dep rule", "no regression test"] });
});

test("parseVerdict falls back to prose lines when no list items follow the verdict", () => {
  const v = parseVerdict("VERDICT: approve\nAll good.\nNo issues found.");
  assert.deepEqual(v, { verdict: "approve", reasons: ["All good.", "No issues found."] });
});

test("parseVerdict lets the LAST VERDICT line win", () => {
  const v = parseVerdict(
    "VERDICT: reject\n1. first pass had problems\nAfter re-reading:\nVERDICT: approve\n1. actually fine",
  );
  assert.deepEqual(v, { verdict: "approve", reasons: ["actually fine"] });
});

test("parseVerdict clips long reasons and caps the count at ten", () => {
  const long = "x".repeat(500);
  const v = parseVerdict(`VERDICT: reject\n1. ${long}`);
  assert.equal(v?.reasons.length, 1);
  assert.equal(v?.reasons[0]?.length, 300); // ellipsis included in the cap
  assert.match(v!.reasons[0]!, /^x{299}…$/);

  const many = Array.from({ length: 12 }, (_, i) => `${i + 1}. reason ${i + 1}`).join("\n");
  assert.equal(parseVerdict(`VERDICT: reject\n${many}`)?.reasons.length, 10);
});

test("isExemptPath matches a slash-free pattern against the basename at any depth", () => {
  assert.ok(isExemptPath("README.md", ["*.md"]));
  assert.ok(isExemptPath("docs/plans/deep/notes.md", ["*.md"]));
  assert.ok(!isExemptPath("src/foo.ts", ["*.md"]));
});

test("isExemptPath matches a slash-bearing pattern against the full path, * within one segment and ** across segments", () => {
  assert.ok(isExemptPath("docs/a.md", ["docs/*.md"]));
  assert.ok(!isExemptPath("docs/sub/a.md", ["docs/*.md"])); // * does not cross /
  assert.ok(isExemptPath("docs/sub/deep/a.md", ["docs/**"])); // ** crosses segments
  assert.ok(!isExemptPath("other/a.md", ["docs/**"]));
});

test("isExemptPath ignores empty patterns and never matches with none left", () => {
  assert.ok(!isExemptPath("anything.ts", []));
  assert.ok(!isExemptPath("anything.ts", ["", "   "])); // "" is skipped; "   " is a literal that matches nothing here
});

test("isExemptDiff requires EVERY file to be exempt and treats an empty diff as vacuously exempt", () => {
  assert.ok(isExemptDiff([], ["*.md"]));
  assert.ok(isExemptDiff(["a.md", "docs/b.md"], ["*.md"]));
  assert.ok(!isExemptDiff(["a.md", "src/b.ts"], ["*.md"])); // one non-exempt file defeats it
});
