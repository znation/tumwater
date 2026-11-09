import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitMessage,
  commitTrailer,
  commitSubject,
  parseCommitMetadata,
  revisionRoundOf,
  stampedRole,
  stampedSubject,
} from "../src/git/commit-message.js";

test("revisionRoundOf reads only a whole harness Revision line, and parseCommitMetadata carries it", () => {
  const msg = buildCommitMessage("tumwater(feature): x", { why: "w" }, commitTrailer("feature", 7, 3, 100, undefined, 2));
  assert.equal(revisionRoundOf(msg), 2);
  assert.deepEqual(parseCommitMetadata(msg), {
    subject: "x",
    body: "WHY: w",
    highFriction: undefined,
    revisionRound: 2,
  });

  // Prose that mentions a round mid-line must not claim it (the `^` anchor).
  const midLine = "tumwater(feature): x\n\nWHY: the reviewer asked for Revision: 3\n\nRun: feature #7 · turns 3 · ctx 100";
  assert.equal(revisionRoundOf(midLine), undefined);
  assert.equal("revisionRound" in parseCommitMetadata(midLine), false);

  // A line that starts like the trailer but runs on must not claim it either (the `$` anchor).
  const runOn = "tumwater(feature): x\n\nRevision: 3 rounds was too many\n\nRun: feature #7 · turns 3 · ctx 100";
  assert.equal(revisionRoundOf(runOn), undefined);
});

test("parseCommitMetadata carries a whole harness Prior-review line, and reads prose as absent", () => {
  const priorReview = { sha: "a".repeat(40), reasons: ["fix the bug", "add a test"], counts: [1, 2] };
  const msg = buildCommitMessage(
    "tumwater(feature): x",
    { why: "w" },
    commitTrailer("feature", 7, 3, 100, undefined, 1, undefined, undefined, priorReview),
  );
  assert.deepEqual(parseCommitMetadata(msg).priorReview, priorReview);
  // Prose that mentions the trailer mid-line must not be read as the field (the whole-line anchor).
  const midLine = `tumwater(feature): x\n\nWHY: the reviewer asked for Prior-review: ${JSON.stringify(priorReview)}\n\nRun: feature #7 · turns 3 · ctx 100`;
  assert.equal(parseCommitMetadata(midLine).priorReview, undefined);
  // A line that is not a whole valid review (not JSON) reads as absent.
  assert.equal(parseCommitMetadata(`tumwater(feature): x\n\nPrior-review: {`).priorReview, undefined);
});

test("the subject stamp needs a space or the line's end after its colon, and stampedSubject round-trips through both readers", () => {
  assert.equal(stampedRole("tumwater(feature):x"), undefined);
  assert.equal(commitSubject("tumwater(feature):x"), "tumwater(feature):x");
  assert.equal(stampedRole("tumwater(clean):"), "clean");

  const subject = stampedSubject("dedupe", "tidy imports");
  assert.equal(stampedRole(subject), "dedupe");
  assert.equal(commitSubject(subject), "tidy imports");
});
