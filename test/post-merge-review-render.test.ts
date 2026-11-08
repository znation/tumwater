import test from "node:test";
import assert from "node:assert/strict";
import { postReviewMatchesGrep, renderPostReviewDetail, renderPostReviews, scopePostReviews, postReviewStatusLabel, postReviewState } from "../src/review/post-merge-review-render.js";
import type { PostReview } from "../src/review/post-merge-review.js";

// The renderer behind `tumwater reviews`: pure text for the post-merge review queue, pinned
// exactly.

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
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected — no tests]`,
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
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected — no tests]`,
    ].join("\n"),
  );
});

test("postReviewMatchesGrep finds the text in every searched field, case-insensitively", () => {
  const entry = e({
    role: "ci",
    commit: "a".repeat(40),
    summary: "split the module",
    body: "the parser hangs on CRLF",
    rejected: ["no tests", "a very long rejection reason " + "x".repeat(70)],
    lastFailure: "the runner timed out before a verdict",
  });
  // A match in the role id, the role label (ci renders as CI), the commit, the summary, the
  // body, a rejection reason or the last failure each selects the entry; the case never matters.
  for (const needle of ["ci", "CI", "aaaa", "SPLIT", "crlf", "no tests", "very long", "x".repeat(70), "timed out"]) {
    assert.equal(postReviewMatchesGrep(entry, needle), true, `text ${JSON.stringify(needle)} matches`);
  }
  // Text in no field matches nothing.
  assert.equal(postReviewMatchesGrep(entry, "nothing-here"), false);
  // An entry with no optional fields still matches its role, commit and summary.
  assert.equal(postReviewMatchesGrep(e({}), "seed"), true);
  assert.equal(postReviewMatchesGrep(e({}), "zzz"), false);
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
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected — no tests]`,
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
      `  2. clean ${'b'.repeat(40).slice(0, 8)} · rejected · [rejected — no tests]`,
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
  assert.match(out, /\[rejected — no tests; missing docs\]/);
});

test("a rejected entry with empty reasons still renders as rejected", () => {
  const out = renderPostReviews([e({ rejected: [] })]);
  assert.match(out, /\[rejected\]/);
  assert.doesNotMatch(out, /\[rejected — \]/);
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
  assert.equal(postReviewStatusLabel(e({ rejected: ["a", "b"] })), "[rejected — a; b]");
  assert.equal(postReviewStatusLabel(e({ rejected: [] })), "[rejected]");
});

// The `tumwater reviews --show <n>` detail view: one entry, whole, with the fields the list
// squashes or never prints.

test("renderPostReviewDetail prints only the header for a bare entry", () => {
  assert.equal(renderPostReviewDetail(e({}), 1, 0), "post-merge review 1: feature cccccccc — seed");
});

test("renderPostReviewDetail adds the queued age line only when the entry carries enqueuedAt", () => {
  assert.equal(
    renderPostReviewDetail(e({ enqueuedAt: 3_601_000 }), 3, 3_601_000),
    "post-merge review 3: feature cccccccc — seed\n · queued 0s ago",
  );
  // Without enqueuedAt (an older file's entry) the header is the whole view.
  assert.equal(renderPostReviewDetail(e({}), 3, 0), "post-merge review 3: feature cccccccc — seed");
});

test("renderPostReviewDetail adds each optional block only when its field is present", () => {
  // Body only when the entry carries one, verbatim.
  assert.equal(
    renderPostReviewDetail(e({ body: "flat body" }), 1, 0),
    "post-merge review 1: feature cccccccc — seed\nBody:\nflat body",
  );
  // Rejection reasons only for a non-empty recorded list, one line per reason.
  assert.equal(
    renderPostReviewDetail(e({ rejected: ["no tests", "missing docs"] }), 1, 0),
    "post-merge review 1: feature cccccccc — seed\nRejection reasons:\n- no tests\n- missing docs",
  );
  assert.equal(renderPostReviewDetail(e({ rejected: [] }), 1, 0), "post-merge review 1: feature cccccccc — seed");
  // Failed runs without lastFailure name only the count.
  assert.equal(
    renderPostReviewDetail(e({ failures: 2 }), 1, 0),
    "post-merge review 1: feature cccccccc — seed\nFailed review runs: 2",
  );
  // A repair names the fix sha.
  assert.equal(
    renderPostReviewDetail(e({ fixed: "f".repeat(40) }), 1, 0),
    "post-merge review 1: feature cccccccc — seed\nFixed in: ffffffff",
  );
});

test("renderPostReviewDetail keeps summary, reasons and last failure longer than the list's squash whole", () => {
  const long = "x".repeat(200);
  const out = renderPostReviewDetail(
    e({
      commit: "a".repeat(40),
      role: "clean",
      summary: long,
      body: "first line\nsecond line",
      rejected: ["broad ".concat("y".repeat(70))],
      failures: 2,
      lastFailure: long,
      fixed: "f".repeat(40),
      enqueuedAt: 3_601_000,
    }),
    2,
    3_601_000,
  );
  assert.ok(out.startsWith(`post-merge review 2: clean ${'a'.repeat(40).slice(0, 8)} — ${long}`), out);
  assert.equal(out.split("\n")[1], " · queued 0s ago");
  assert.ok(out.includes(`- broad ${'y'.repeat(70)}`), out);
  assert.ok(out.includes(`Last failure: ${long}`), out);
  assert.ok(out.includes(`Fixed in: ${'f'.repeat(40).slice(0, 8)}`), out);
});
