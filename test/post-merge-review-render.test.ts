import test from "node:test";
import assert from "node:assert/strict";
import { postReviewMatchesGrep, renderPostReviewDetail, renderPostReviews, scopePostReviews, postReviewStatusLabel, postReviewState, postReviewBackoffNote, postReviewFindingNote } from "../src/review/post-merge-review-render.js";
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
    finding: ["the stale comment still says not yet"],
    lastFailure: "the runner timed out before a verdict",
  });
  // A match in the role id, the role label (ci renders as CI), the commit, the summary, the
  // body, a rejection reason, a kept finding or the last failure each selects the entry; the case
  // never matters.
  for (const needle of ["ci", "CI", "aaaa", "SPLIT", "crlf", "no tests", "very long", "x".repeat(70), "timed out", "stale comment"]) {
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
  // A finding a withheld fix left behind, one line per reason, before any rejection block.
  assert.equal(
    renderPostReviewDetail(e({ failures: 1, finding: ["breaks the contract"] }), 1, 0),
    "post-merge review 1: feature cccccccc — seed\nReviewer's finding:\n- breaks the contract\nFailed review runs: 1",
  );
  assert.equal(renderPostReviewDetail(e({ finding: [] }), 1, 0), "post-merge review 1: feature cccccccc — seed");
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

test("postReviewBackoffNote names only a live provider-failure backoff", () => {
  const now = 1_000_000_000_000;
  // A deadline 600 000 ms ahead reads the humanSeconds countdown; a passed deadline, a bare
  // equal-to-now deadline and no field at all name nothing (the drain admits those entries).
  assert.equal(postReviewBackoffNote(e({ notBeforeMs: now + 600_000 }), now), "provider failure — retrying in 10m");
  assert.equal(postReviewBackoffNote(e({ notBeforeMs: now - 1 }), now), "");
  assert.equal(postReviewBackoffNote(e({ notBeforeMs: now }), now), "");
  assert.equal(postReviewBackoffNote(e({}), now), "");
});

test("the list names a live provider backoff beside the status label", () => {
  const now = 1_000_000_000_000;
  // A live deadline appends the bracket; a passed deadline and a bare entry print byte-identically.
  assert.ok(
    renderPostReviews([e({ notBeforeMs: now + 600_000 })], undefined, now).includes(
      `cccccccc · seed · [provider failure — retrying in 10m]`,
    ),
    renderPostReviews([e({ notBeforeMs: now + 600_000 })], undefined, now),
  );
  assert.equal(renderPostReviews([e({ notBeforeMs: now - 1 })], undefined, now), renderPostReviews([e({})]));
  assert.equal(renderPostReviews([e({})], undefined, now), renderPostReviews([e({})]));
  // A list called without a clock renders no backoff bracket at all.
  assert.equal(renderPostReviews([e({ notBeforeMs: now + 600_000 })]), renderPostReviews([e({})]));
  // An entry can hold a content-failure count AND a transient deadline: both brackets print, the
  // status label first. That is why the note is not part of the status-label switch.
  const both = renderPostReviews([e({ failures: 2, lastFailure: "boom", notBeforeMs: now + 600_000 })], undefined, now);
  assert.ok(both.includes("· [2 failed review runs — last: boom] · [provider failure — retrying in 10m]"), both);
  // The backoff bracket survives an entry with no status label of its own.
  assert.ok(renderPostReviews([e({ notBeforeMs: now + 600_000 })], undefined, now).includes("[provider failure"));
});

test("postReviewFindingNote names a kept finding only on a still-failing entry", () => {
  // The withheld-fix shape (INV-BT8): a failed run plus the reviewer's kept objection.
  assert.equal(postReviewFindingNote(e({ failures: 1, finding: ["breaks the contract"] })), "reviewer's finding — breaks the contract");
  // The first finding only, squashed to the same 60 the rejected bracket uses, plus a count of
  // the rest: 70 x's cut at 59 with the ellipsis, then the tail.
  const long = postReviewFindingNote(e({ failures: 2, finding: ["x".repeat(70), "second", "third"] }));
  assert.equal(long, `reviewer's finding — ${"x".repeat(59)}… (+2 more)`);
  // One finding names no tail.
  assert.equal(postReviewFindingNote(e({ failures: 2, finding: ["one", "two"] })), "reviewer's finding — one (+1 more)");
  // Nothing to name: no finding, an empty list, or a blank first entry.
  assert.equal(postReviewFindingNote(e({ failures: 1 })), "");
  assert.equal(postReviewFindingNote(e({ failures: 1, finding: [] })), "");
  assert.equal(postReviewFindingNote(e({ failures: 1, finding: ["   "] })), "");
  // The state guard is the whole rule: a rejected row already prints those reasons in its own
  // bracket, and a fixed row can carry a stale finding its landed repair answered.
  assert.equal(postReviewFindingNote(e({ rejected: ["no tests"], finding: ["no tests"] })), "");
  assert.equal(postReviewFindingNote(e({ fixed: "f".repeat(40), finding: ["stale"] })), "");
  // A waiting entry with a finding and no failed run names nothing.
  assert.equal(postReviewFindingNote(e({ finding: ["kept"] })), "");
});

test("the list names a withheld fix's kept finding after the status bracket", () => {
  const line = renderPostReviews([e({ failures: 1, finding: ["breaks the contract"] })]);
  assert.ok(
    line.includes("cccccccc · seed · [1 failed review run] · [reviewer's finding — breaks the contract]"),
    line,
  );
  // Two findings: the first squashed, the rest counted, on the line's end.
  const two = renderPostReviews([e({ failures: 1, finding: ["y".repeat(70), "z"] })]);
  assert.ok(two.endsWith(` · [reviewer's finding — ${"y".repeat(59)}… (+1 more)]`), two);
  // No finding, an empty finding list and a non-failing entry with a finding each render a line
  // byte-identical to a bare entry.
  assert.equal(renderPostReviews([e({ finding: [] })]), renderPostReviews([e({})]));
  assert.equal(renderPostReviews([e({ finding: ["kept"] })]), renderPostReviews([e({})]));
  assert.equal(renderPostReviews([e({ rejected: ["no tests"], finding: ["no tests"] })]), renderPostReviews([e({ rejected: ["no tests"] })]));
  assert.equal(
    renderPostReviews([e({ fixed: "f".repeat(40), finding: ["stale"] })]),
    renderPostReviews([e({ fixed: "f".repeat(40) })]),
  );
  // The bracket rides between the status bracket and the provider-failure bracket, so an entry
  // holding a finding and a live deadline prints all three, and it needs no clock of its own.
  const now = 1_000_000_000_000;
  const all = renderPostReviews([e({ failures: 1, lastFailure: "boom", finding: ["breaks the contract"], notBeforeMs: now + 600_000 })], undefined, now);
  assert.ok(
    all.includes("· [1 failed review run — last: boom] · [reviewer's finding — breaks the contract] · [provider failure — retrying in 10m]"),
    all,
  );
  assert.ok(renderPostReviews([e({ failures: 1, finding: ["kept"] })]).includes("[reviewer's finding — kept]"));
});

test("renderPostReviewDetail names the backoff wait and its consecutive-failure streak", () => {
  const now = 1_000_000_000_000;
  const out = renderPostReviewDetail(e({ notBeforeMs: now + 90_000, consecutiveTransientFailures: 3 }), 1, now);
  assert.ok(out.includes("Provider failure: retrying in 2m"), out);
  assert.ok(out.includes("Transient provider failures in a row: 3"), out);
  // A zero streak names no line (a first failure has not doubled anything yet).
  const once = renderPostReviewDetail(e({ notBeforeMs: now + 90_000, consecutiveTransientFailures: 0 }), 1, now);
  assert.ok(once.includes("Provider failure: retrying in 2m"), once);
  assert.ok(!once.includes("Transient provider failures"), once);
  // No deadline, no backoff line; a passed deadline prints neither the wait nor a stale streak
  // alone (the streak line only rides a live wait's view when the entry carries one).
  const none = renderPostReviewDetail(e({}), 1, now);
  assert.ok(!none.includes("Provider failure"), none);
  assert.ok(!none.includes("Transient provider failures"), none);
  const passed = renderPostReviewDetail(e({ notBeforeMs: now - 1 }), 1, now);
  assert.ok(!passed.includes("Provider failure"), passed);
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
