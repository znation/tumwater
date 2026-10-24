import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { postReviewPath } from "../src/paths.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { acceptPostReview, acceptPostReviewBySha } from "../src/review/post-review-accept.js";
import { shortSha } from "../src/text/format.js";

// acceptPostReview: the operator's deliberate retire of a pending post-merge review — the
// `tumwater reviews --accept <n>` core, tested directly like cancelQueuedMerge.

function seedMany(root: string): void {
  writeFileDeep(
    postReviewPath(root),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
        { commit: "b".repeat(40), role: "clean", summary: "rework the docs" },
        { commit: "c".repeat(40), role: "coverage", summary: "add integration tests" },
      ],
    }),
  );
}

test("acceptPostReview removes only the named position and names what it retired", () => {
  const root = makeRepo();
  seedMany(root);
  const outcome = acceptPostReview(root, 2);
  assert.deepEqual(outcome, {
    status: "accepted",
    role: "clean",
    commit: "b".repeat(40),
    summary: "rework the docs",
  });
  assert.deepEqual(
    readPostReviews(root).map((e) => e.role),
    ["improve", "coverage"],
    "the accepted entry is gone, the others keep FIFO order",
  );
  const warnings = eventsOfType(root, "warning").filter((e) => e.source === "clean");
  assert.equal(warnings.length, 1, "exactly one warning under clean");
  assert.ok(
    String(warnings[0]!.message).includes(shortSha("b".repeat(40))),
    "the warning names the short sha",
  );
});

test("acceptPostReview refuses a rejected entry without writing", () => {
  const root = makeRepo();
  writeFileDeep(
    postReviewPath(root),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
        { commit: "b".repeat(40), role: "clean", summary: "bad change", rejected: ["no tests"] },
      ],
    }),
  );
  const seed = readPostReviews(root);
  const outcome = acceptPostReview(root, 2);
  assert.deepEqual(outcome, { status: "rejected", commit: "b".repeat(40) });
  assert.deepEqual(readPostReviews(root), seed, "nothing written on the rejected arm");
  assert.equal(eventsOfType(root, "warning").filter((e) => e.source === "clean").length, 0);
});

test("acceptPostReview reports the depth out of range", () => {
  const root = makeRepo();
  seedMany(root);
  const before = readPostReviews(root);
  assert.deepEqual(acceptPostReview(root, 0), { status: "out-of-range", depth: 3 });
  assert.deepEqual(acceptPostReview(root, 4), { status: "out-of-range", depth: 3 });
  assert.deepEqual(readPostReviews(root), before, "out-of-range changes no file");
});

test("acceptPostReview reports depth zero for a missing file", () => {
  const root = makeRepo();
  assert.deepEqual(acceptPostReview(root, 1), { status: "out-of-range", depth: 0 });
});

test("acceptPostReviewBySha removes the matching entry and reports a gone sha", () => {
  const root = makeRepo();
  seedMany(root);
  // Mixed case must not prevent the case-insensitive match.
  const outcome = acceptPostReviewBySha(root, "B".repeat(40));
  assert.deepEqual(outcome, {
    status: "accepted",
    role: "clean",
    commit: "b".repeat(40),
    summary: "rework the docs",
  });
  assert.deepEqual(
    readPostReviews(root).map((e) => e.role),
    ["improve", "coverage"],
    "the matching entry is gone, the others keep FIFO order",
  );
  const warnings = eventsOfType(root, "warning").filter((e) => e.source === "clean");
  assert.equal(warnings.length, 1, "exactly one warning under clean");
  assert.ok(String(warnings[0]!.message).includes(shortSha("b".repeat(40))), "the warning names the short sha");

  // A sha no longer in the queue is gone and changes nothing.
  const before = readPostReviews(root);
  assert.deepEqual(acceptPostReviewBySha(root, "z".repeat(40)), { status: "gone" });
  assert.deepEqual(readPostReviews(root), before, "a gone sha writes no file");
  assert.equal(eventsOfType(root, "warning").length, 1, "a gone sha logs no warning");
});

test("acceptPostReviewBySha refuses a rejected entry without writing", () => {
  const root = makeRepo();
  writeFileDeep(
    postReviewPath(root),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
        { commit: "b".repeat(40), role: "clean", summary: "bad change", rejected: ["no tests"] },
      ],
    }),
  );
  const seed = readPostReviews(root);
  const outcome = acceptPostReviewBySha(root, "b".repeat(40));
  assert.deepEqual(outcome, { status: "rejected", commit: "b".repeat(40) });
  assert.deepEqual(readPostReviews(root), seed, "nothing written on the rejected arm");
  assert.equal(eventsOfType(root, "warning").filter((e) => e.source === "clean").length, 0);
});
