import test from "node:test";
import assert from "node:assert/strict";
import { renderPostReviews } from "../src/review/post-review-render.js";
import type { PostReview } from "../src/review/post-merge-review.js";

// The renderer behind `tumwater reviews`: pure text for the post-merge review queue, pinned
// exactly like renderMergeQueue's tests pin `tumwater queue`'s lines.

function e(overrides: Partial<PostReview>): PostReview {
  return { commit: "c".repeat(40), role: "feature", summary: "seed", ...overrides };
}

test("an empty queue renders the empty line", () => {
  assert.equal(renderPostReviews([]), "post-merge review queue empty");
});

test("entries render in input order with role, short sha and summary", () => {
  const out = renderPostReviews([
    e({ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }),
    e({ commit: "b".repeat(40), role: "organize", summary: "split the module" }),
  ]);
  assert.equal(
    out,
    [
      "post-merge review queue (2 entries):",
      `  1. improve ${"a".repeat(40).slice(0, 8)} · tidy the parser`,
      `  2. organize ${"b".repeat(40).slice(0, 8)} · split the module`,
    ].join("\n"),
  );
});

test("a rejected entry carries its waiting-to-revert reasons", () => {
  const out = renderPostReviews([e({ rejected: ["no tests", "missing docs"] })]);
  assert.match(out, /\[rejected — waiting to revert: no tests; missing docs\]/);
});

test("a rejected entry with empty reasons still renders as rejected", () => {
  const out = renderPostReviews([e({ rejected: [] })]);
  assert.match(out, /\[rejected — waiting to revert: \]/);
});

test("an entry with positive failures carries the failed-review-run count", () => {
  const out = renderPostReviews([e({ failures: 2 })]);
  assert.match(out, /\[2 failed review runs\]/);
});

test("an entry with neither rejected nor failures carries no suffix", () => {
  const out = renderPostReviews([e({})]);
  assert.ok(!out.includes("["), out);
});
