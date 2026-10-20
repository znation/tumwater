/** The merge pipeline re-queues a kept change itself (plans/fast-merge.md "Lever 1"): after a
 * retriable result drops its entry, settleMergeOutcome puts the pinned change back on the queue
 * with the original summary and a `retry` field — no author run between. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { newMergePipeline, settleMergeOutcome } from "../src/merge/merge-pipeline.js";
import { drainVerify } from "../src/merge/merge-verify.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { defaultConfig } from "../src/config/config.js";
import { requeueMainRedPin } from "../src/merge/merge-slot.js";
import { enqueueMerge, headMerge, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { MERGE_CONFLICT_LIMIT } from "../src/runner/leftover.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { mergeRefName } from "../src/paths.js";
import { deleteRef, refSha, setRef } from "../src/git/git.js";
import { makeRepo, pinOffMain } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";

const NO_USAGE = { tokens: 0, cost: 0, providerCost: {} };

/** A repo with one change pinned off main for `improve` and its entry queued; `file` is the
 * queue file a settled merge drops. */
async function pinnedEntry(): Promise<{ root: string; entry: MergeEntry; file: string }> {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "a.txt"), "a\n"), "add a");
  assert.ok(await setRef(root, mergeRefName("improve"), sha));
  const entry: MergeEntry = {
    role: "improve",
    sha,
    run: 7,
    summary: "add a",
    body: "WHY: x",
    highFriction: true,
    revisionRound: 2,
    enqueuedAt: Date.now(),
  };
  enqueueMerge(root, entry);
  const head = headMerge(root);
  assert.ok(head);
  return { root, entry, file: head.file };
}

test("a merge_blocked change is re-queued at once with its original summary and a retry field", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  await settleMergeOutcome(root, entry, state, "merge_blocked", 5, NO_USAGE, file, "main");
  const queued = queuedMerges(root);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.sha, entry.sha);
  assert.equal(queued[0]!.summary, "add a");
  assert.equal(queued[0]!.body, "WHY: x");
  assert.equal(queued[0]!.highFriction, true);
  assert.equal(queued[0]!.revisionRound, 2);
  assert.equal(queued[0]!.run, 7);
  assert.equal(queued[0]!.retry, "merge_blocked");
  assert.equal(queued[0]!.notBefore, undefined);
  const ev = eventsOfType(root, "merge_queued").at(-1)!;
  assert.equal(ev.retry, "merge_blocked");
  assert.equal(ev.summary, "add a");
});

test("a review_error re-queue waits 60 s; a held reviewer config error does not re-queue", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  const before = Date.now();
  await settleMergeOutcome(root, entry, state, "review_error", 5, NO_USAGE, file, "main");
  const [queued] = queuedMerges(root);
  assert.ok(queued?.notBefore !== undefined);
  assert.ok(queued.notBefore >= before + 60_000 && queued.notBefore <= Date.now() + 60_000);

  const held = await pinnedEntry();
  const heldState = freshRunnerState("improve");
  heldState.mergeReviewError = { sha: held.entry.sha, message: "401" };
  await settleMergeOutcome(held.root, held.entry, heldState, "review_error", 5, NO_USAGE, held.file, "main");
  assert.equal(queuedMerges(held.root).length, 0);
});

test("a change at MERGE_CONFLICT_LIMIT is not re-queued; a gone pin is not either", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  state.mergeConflicts = { sha: entry.sha, count: MERGE_CONFLICT_LIMIT - 1 };
  // This conflict makes the streak reach the limit.
  await settleMergeOutcome(root, entry, state, "merge_conflict", 5, NO_USAGE, file, "main");
  assert.equal(state.mergeConflicts.count, MERGE_CONFLICT_LIMIT);
  assert.equal(queuedMerges(root).length, 0);

  const under = await pinnedEntry();
  const underState = freshRunnerState("improve");
  await settleMergeOutcome(under.root, under.entry, underState, "merge_conflict", 5, NO_USAGE, under.file, "main");
  assert.equal(queuedMerges(under.root).length, 1, "under the limit it re-queues");

  const gone = await pinnedEntry();
  await deleteRef(gone.root, mergeRefName("improve"));
  await settleMergeOutcome(gone.root, gone.entry, freshRunnerState("improve"), "merge_blocked", 5, NO_USAGE, gone.file, "main");
  assert.equal(queuedMerges(gone.root).length, 0);
  assert.equal(await refSha(gone.root, mergeRefName("improve")).catch(() => null), null);
});

test("a main_red pin is re-queued once main's head moves, and not before", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  await settleMergeOutcome(root, entry, state, "main_red", 5, NO_USAGE, file, "main");
  assert.equal(queuedMerges(root).length, 0, "nothing is queued while main is red");
  const recorded = state.mainRedRetry;
  assert.ok(recorded);

  await requeueMainRedPin(root, "main", state, recorded.head);
  assert.equal(queuedMerges(root).length, 0, "main has not moved");
  assert.ok(state.mainRedRetry, "the record stands");

  await requeueMainRedPin(root, "main", state, "f".repeat(40));
  const [queued] = queuedMerges(root);
  assert.ok(queued);
  assert.equal(queued.summary, "add a");
  assert.equal(queued.retry, "main_red");
  assert.equal(state.mainRedRetry, undefined);
});

test("drainVerify leaves an entry queued until its notBefore passes", async () => {
  const { root, entry, file } = await pinnedEntry();
  fs.rmSync(file);
  enqueueMerge(root, { ...entry, notBefore: Date.now() + 60_000 });
  const pipeline = newMergePipeline();
  const config = defaultConfig();
  await drainVerify(
    {
      root,
      mainBranch: "main",
      signal: new AbortController().signal,
      semaphore: new Semaphore(2),
      runners: [],
      liveConfig: config,
      roleConfig: config,
      directorConfig: config,
      startHeld: () => false,
    },
    pipeline,
  );
  assert.equal(pipeline.verifying.size, 0, "no verification started");
  assert.equal(queuedMerges(root).length, 1, "the entry is still queued");
});
