import test from "node:test";
import assert from "node:assert/strict";
import { renderPostReviews, scopePostReviews, postReviewStatusLabel, postReviewState } from "../src/review/post-merge-review-render.js";
import type { PostReview } from "../src/review/post-merge-review.js";

// The renderer behind `tumwater reviews`: pure text for the post-merge review queue, pinned
// exactly like renderMergeQueue's tests pin `tumwater queue`'s lines.

function e(overrides: Partial<PostReview>): PostReview {
  return { commit: "c".repeat(40), role: "feature", summary: "seed", ...overrides };
}

test("an empty queue renders the empty line", () => {
  assert.equal(renderPostReviews([]), "post-merge review queue empty");
});

test("scopePostReviews keeps the matching entries under their whole-queue positions", () => {
  const whole = [
    e({ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }),
    e({ commit: "b".repeat(40), role: "clean", summary: "rejected", rejected: ["no tests"] }),
  ];
  const { entries, scope } = scopePostReviews(whole, ["clean"], (x) => x.role === "clean");
  assert.deepEqual(entries.map((x) => x.role), ["clean"]);
  assert.deepEqual(scope, { roles: ["clean"], positions: [2], total: 2 });
});

test("postReviewState names the precedence the status label uses", () => {
  assert.equal(postReviewState(e({ rejected: ["x"], failures: 2 })), "rejected");
  assert.equal(postReviewState(e({ rejected: [] })), "rejected");
  assert.equal(postReviewState(e({ failures: 1 })), "failing");
  assert.equal(postReviewState(e({})), "waiting");
  assert.equal(postReviewState(e({ fixed: "f".repeat(40) })), "fixed");
  // The terminal fixed record outranks every pending marker it might also carry.
  assert.equal(postReviewState(e({ fixed: "f".repeat(40), rejected: ["x"], failures: 2 })), "fixed");
});

test("a settled fixed record is taught to the readers as terminal, not pending", () => {
  // postReviewStatusLabel names it rather than leaving the empty (waiting) suffix.
  assert.equal(
    postReviewStatusLabel(e({ fixed: "f".repeat(40) })),
    `[fixed — the repair ${'f'.repeat(40).slice(0, 8)} already merged on main]`,
  );
  // renderPostReviews shows the same suffix, so an observer no longer reads it as pending.
  assert.match(renderPostReviews([e({ fixed: "f".repeat(40) })]), /· \[fixed — the repair/);
});

test("scopePostReviews's status filter keeps whole-queue positions", () => {
  const whole = [
    e({ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }),
    e({ commit: "b".repeat(40), role: "clean", summary: "rejected", rejected: ["no tests"] }),
  ];
  // A state filter passes roles: [] and a filter text; the kept entry keeps position 2.
  const { entries, scope } = scopePostReviews(whole, [], (x) => postReviewState(x) === "rejected", "--status rejected");
  assert.equal(
    renderPostReviews(entries, scope),
    [
      "post-merge review queue (1 of 2, --status rejected):",
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected: no tests]`,
    ].join("\n"),
  );
  // A filter that keeps nothing of a non-empty queue names the filter and the depth.
  const none = scopePostReviews(whole, [], (x) => postReviewState(x) === "failing", "--status failing");
  assert.equal(renderPostReviews(none.entries, none.scope), "no post-merge reviews matching --status failing (post-merge review queue holds 2)");
  // The three-argument --role call's render is unchanged from the pinned case below.
  const role = scopePostReviews(whole, ["clean"], (x) => x.role === "clean");
  assert.equal(
    renderPostReviews(role.entries, role.scope),
    [
      "post-merge review queue (1 of 2, --role clean):",
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected: no tests]`,
    ].join("\n"),
  );
});

test("renderPostReviews prints whole-queue positions under a scope", () => {
  const whole = [
    e({ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }),
    e({ commit: "b".repeat(40), role: "clean", summary: "rejected", rejected: ["no tests"] }),
  ];
  const { entries, scope } = scopePostReviews(whole, ["clean"], (x) => x.role === "clean");
  // Scoped: header names the kept count and the role; the kept entry keeps position 2.
  assert.equal(
    renderPostReviews(entries, scope),
    [
      "post-merge review queue (1 of 2, --role clean):",
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected: no tests]`,
    ].join("\n"),
  );
  // A scope that keeps nothing of a non-empty queue names the whole-queue depth.
  const none = scopePostReviews(whole, ["feature"], (x) => x.role === "feature");
  assert.equal(renderPostReviews(none.entries, none.scope), "no post-merge reviews for feature (post-merge review queue holds 2)");
  // A scope over an empty queue still prints the empty line.
  const empty = scopePostReviews([], ["clean"], (x) => x.role === "clean");
  assert.equal(renderPostReviews(empty.entries, empty.scope), "post-merge review queue empty");
  // Without a scope the unscoped render is byte-identical to the pinned whole-queue line.
  assert.equal(
    renderPostReviews(whole),
    [
      "post-merge review queue (2 entries):",
      `  1. improve ${'a'.repeat(40).slice(0, 8)} · tidy the parser`,
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected: no tests]`,
    ].join("\n"),
  );
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

test("a rejected entry carries its reasons", () => {
  const out = renderPostReviews([e({ rejected: ["no tests", "missing docs"] })]);
  assert.match(out, /\[rejected: no tests; missing docs\]/);
});

test("a rejected entry with empty reasons still renders as rejected", () => {
  const out = renderPostReviews([e({ rejected: [] })]);
  assert.match(out, /\[rejected: \]/);
});

test("an entry with positive failures carries the failed-review-run count", () => {
  const out = renderPostReviews([e({ failures: 2 })]);
  assert.match(out, /\[2 failed review runs\]/);
});

test("a failing entry names its last failure reason beside the count", () => {
  assert.equal(
    postReviewStatusLabel(e({ failures: 2, lastFailure: "no parseable VERDICT line in the reviewer's reply" })),
    "[2 failed review runs — last: no parseable VERDICT line in the reviewer's reply]",
  );
  assert.equal(postReviewStatusLabel(e({ failures: 2 })), "[2 failed review runs]");
  const long = "x".repeat(200);
  assert.equal(postReviewStatusLabel(e({ failures: 1, lastFailure: long })), "[1 failed review run — last: " + "x".repeat(79) + "…]");
});

test("an entry with neither rejected nor failures carries no suffix", () => {
  const out = renderPostReviews([e({})]);
  assert.ok(!out.includes("["), out);
});

test("renderPostReviews prints the wait since an entry was queued", () => {
  const whole = [
    e({ commit: "a".repeat(40), role: "improve", summary: "tidy the parser", enqueuedAt: 1_000 }),
    e({ commit: "b".repeat(40), role: "clean", summary: "split the module", enqueuedAt: 3_601_000 }),
    e({ commit: "c".repeat(40), role: "feature", summary: "no timestamp" }),
  ];
  // Two entries with enqueuedAt 3 600 000 and 0 ms before the fixed now read 1h ago and 0s ago
  // between the short sha and the summary; the no-enqueuedAt entry prints the pre-change line.
  const now = 3_601_000;
  assert.equal(
    renderPostReviews(whole, undefined, now),
    [
      "post-merge review queue (3 entries):",
      `  1. improve ${'a'.repeat(40).slice(0, 8)} · 1h ago · tidy the parser`,
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · 0s ago · split the module`,
      `  3. feature ${'c'.repeat(40).slice(0, 8)} · no timestamp`,
    ].join("\n"),
  );
  // With no now the whole render is byte-identical to the unscoped pre-change line.
  assert.equal(renderPostReviews(whole, undefined, undefined), renderPostReviews(whole));
});

test("a postReviewStatusLabel names the rejection or the failed-run count", () => {
  assert.equal(postReviewStatusLabel(e({})), "");
  assert.equal(postReviewStatusLabel(e({ failures: 2 })), "[2 failed review runs]");
  assert.equal(postReviewStatusLabel(e({ rejected: ["a", "b"] })), "[rejected: a; b]");
  assert.equal(postReviewStatusLabel(e({ rejected: [] })), "[rejected: ]");
});
