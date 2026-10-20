import test from "node:test";
import assert from "node:assert/strict";
import { priorObjectionNumber } from "../src/review/review-verdict.js";
import { verifyRequest } from "../src/merge/merge-batch.js";
import { refSha } from "../src/git/git.js";
import { rejectedRefName } from "../src/paths.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { withPi } from "./fakes/fake-pi.js";
import { batchWiring, makeCtx, pinnedFixture, request, reviewerPi, ROLE } from "./fixtures/merger-fixtures.js";

/** Edge coverage for the repeat tag the revision-finality policy reads: which reasons count as a
 * `(prior N)` restatement, and what a tag with no matching prior count is worth. */

test("priorObjectionNumber reads only a leading (prior N) tag with N of at least one", () => {
  assert.equal(priorObjectionNumber("(prior 3) still wrong"), 3);
  assert.equal(priorObjectionNumber("  (PRIOR 2) still wrong"), 2, "trimmed and case-insensitive");
  assert.equal(priorObjectionNumber("(prior 0) still wrong"), null);
  assert.equal(priorObjectionNumber("prior to the change, x"), null);
  assert.equal(priorObjectionNumber("see (prior 1) above"), null, "a tag mid-line is not a tag");
  assert.equal(priorObjectionNumber("(prior one) x"), null);
});

test("a (prior N) tag beyond the prior list, or with no prior list, counts one revision and is not final", async () => {
  const cases: Array<{ reply: string; priorReview?: { reasons: string[]; counts: number[] } }> = [
    { reply: "VERDICT: reject\n1. (prior 3) a stale number", priorReview: { reasons: ["the bug"], counts: [1] } },
    { reply: "VERDICT: reject\n1. (prior 1) still wrong" },
  ];
  for (const c of cases) {
    await withPi(reviewerPi(c.reply), async () => {
      const { root, sha } = await pinnedFixture();
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);
      const w = batchWiring(ctx);
      const verdict = await verifyRequest(
        ctx,
        request(sha, { revisionRound: 1, ...(c.priorReview ? { priorReview: { sha, ...c.priorReview } } : {}) }),
        w,
      );
      assert.equal(verdict.kind, "result");
      assert.equal(state.revision?.round, 2);
      assert.deepEqual(state.revision?.reasonCounts, [1]);
      assert.equal(state.lastReview?.exhausted, undefined);
      assert.equal(await refSha(root, rejectedRefName(ROLE)), state.revision?.sha);
    });
  }
});
