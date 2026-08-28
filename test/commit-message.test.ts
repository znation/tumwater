import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  formatCommitBody,
} from "../src/commit-message.js";

test("extractSummary finds the SUMMARY line anywhere in the reply", () => {
  assert.equal(extractSummary("did stuff\nSUMMARY: add foo helper\n"), "add foo helper");
  assert.equal(extractSummary("SUMMARY:    trimmed   "), "trimmed");
  assert.equal(extractSummary("no summary here"), null);
  assert.equal(extractSummary(""), null);
});

test("extractSummary truncates absurdly long summaries", () => {
  const summary = extractSummary(`SUMMARY: ${"x".repeat(500)}`);
  assert.ok(summary && summary.length <= 100);
});

// The commit body is the author's own explanation (WHY/RISK/VERIFIED), parsed out of pi's
// final reply and stamped into every tick commit. The review gate checks these claims
// against the diff, so a parsing regression silently strips rationale from every commit —
// or worse, fabricates it from unrelated lines.

test("extractCommitBody pulls all three fields, trimmed", () => {
  const body = extractCommitBody(
    "done\nSUMMARY: add helper\nWHY:   the loops needed one. \nRISK: callers of old path\nVERIFIED: npm test, 325 pass\n",
  );
  assert.deepEqual(body, {
    why: "the loops needed one.",
    risk: "callers of old path",
    verified: "npm test, 325 pass",
  });
});

test("extractCommitBody tolerates any subset and returns null when none are present", () => {
  // Absent fields come back as explicit undefined (the CommitBody shape is fixed).
  assert.deepEqual(extractCommitBody("WHY: only a reason\n"), {
    why: "only a reason",
    risk: undefined,
    verified: undefined,
  });
  assert.deepEqual(extractCommitBody("VERIFIED: ran the suite\n"), {
    why: undefined,
    risk: undefined,
    verified: "ran the suite",
  });
  // A non-compliant reply still commits (subject + trailer): no fields, not an error.
  assert.equal(extractCommitBody("SUMMARY: did a thing\nall good\n"), null);
  assert.equal(extractCommitBody(""), null);
});

test("extractCommitBody only matches line-anchored fields", () => {
  // "WHY:" mid-sentence is prose, not the contract — matching it would fabricate a claim.
  const body = extractCommitBody("the WHY: this matters\nRISK: none that I can see\n");
  assert.equal(body?.why, undefined, "mid-line WHY: is prose, not the contract");
  assert.equal(body?.risk, "none that I can see");
});

test("extractCommitBody caps each field at 200 chars with an ellipsis", () => {
  const body = extractCommitBody(`WHY: ${"w".repeat(500)}\nRISK: short\n`);
  assert.ok(body?.why && body.why.length === 200, "capped at exactly 200");
  assert.match(body!.why!, /…$/);
  assert.equal(body!.risk, "short", "other fields untouched by the cap");
});

test("formatCommitBody orders WHY, RISK, VERIFIED and skips missing fields", () => {
  assert.equal(
    formatCommitBody({ why: "a", risk: "b", verified: "c" }),
    "WHY: a\nRISK: b\nVERIFIED: c",
  );
  // A partial body must not leave blank lines in the commit message.
  assert.equal(formatCommitBody({ why: "a", verified: "c" }), "WHY: a\nVERIFIED: c");
  assert.equal(formatCommitBody({}), "");
});

test("commitTrailer compacts context at 10k and below", () => {
  assert.equal(commitTrailer("feature", 7, 2, 9_999), "Tick: feature #7 · turns 2 · ctx 9999");
  assert.equal(commitTrailer("feature", 7, 2, 10_000), "Tick: feature #7 · turns 2 · ctx 10.0k");
  assert.equal(commitTrailer("bugfix", 1, 3, 12_345), "Tick: bugfix #1 · turns 3 · ctx 12.3k");
});

test("buildCommitMessage assembles subject, body, and trailer as separate paragraphs", () => {
  const trailer = commitTrailer("clean", 3, 1, 500);
  assert.equal(
    buildCommitMessage("tumwater(clean): tidy imports", { why: "duplication" }, trailer),
    `tumwater(clean): tidy imports\n\nWHY: duplication\n\n${trailer}`,
  );
  // A non-compliant reply (no body) still gets subject + trailer — no empty paragraph.
  assert.equal(
    buildCommitMessage("tumwater(clean): tidy imports", null, trailer),
    `tumwater(clean): tidy imports\n\n${trailer}`,
  );
});
