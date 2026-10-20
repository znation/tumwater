import test from "node:test";
import assert from "node:assert/strict";
import { mergeBlocked } from "../src/merge/merge-check-failures.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { refSha } from "../src/git/git.js";
import { sh } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeCtx, pinnedFixture, REF, ROLE } from "./fixtures/merger-fixtures.js";

test("mergeBlocked keeps a pin whose patch-id cannot be read on every attempt and stores no strike", async () => {
  // The role worktree is clean at main, so main...HEAD is empty and the patch-id is null.
  const { root, sha, wt } = await pinnedFixture();
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(await mergeBlocked(ctx, ROLE, wt, "the block"), "merge_blocked", `attempt ${attempt}`);
    assert.equal(state.mergeCheckFailures, undefined, "an unreadable patch-id stores no strike");
    assert.match(state.lastError ?? "", /merge_blocked — the block/);
    assert.equal(await refSha(root, REF), sha, "the pin is kept");
  }
  assert.equal(eventsOfType(root, "review_rejected").length, 0);
});

test("mergeBlocked starts a new patch's count at one when the stored strike belongs to another patch", async () => {
  const { root, sha, wt } = await pinnedFixture();
  sh(wt, "git", "checkout", "--quiet", "--detach", sha); // the head now carries the pinned change
  const state = freshRunnerState(ROLE);
  state.mergeCheckFailures = { patchId: "another-pin", count: 1 };
  const { ctx } = makeCtx(root, state);

  assert.equal(await mergeBlocked(ctx, ROLE, wt, "the block"), "merge_blocked", "another pin's strike does not add");
  assert.equal(state.mergeCheckFailures?.count, 1);
  assert.notEqual(state.mergeCheckFailures?.patchId, "another-pin");
  assert.equal(await refSha(root, REF), sha);

  assert.equal(await mergeBlocked(ctx, ROLE, wt, "the block"), "rejected", "the second strike of the same patch");
  assert.equal(await refSha(root, REF), null);
  assert.equal(state.mergeCheckFailures, undefined);
  assert.equal(state.lastReview?.verdict, "reject");
  assert.equal(state.lastReview!.reasons[0], "merge blocked: the block");
});
