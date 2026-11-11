import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue, mergeTaskStarts, resetMergeTaskStarts } from "../src/merge/merge-drain.js";
import { mergeTasks, settleMergeOutcome } from "../src/merge/merge-pipeline.js";
import { enqueueMerge, queueDepth } from "../src/merge/merge-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { mergeRefName } from "../src/paths.js";
import { refSha, setRef } from "../src/git/git.js";
import { APPROVE, allTasks, makePipeline, pinChanges, pinDrained, pump, pumpUntil, runnersFor } from "./fixtures/merge-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { defaultConfig } from "../src/config/config.js";
import { mainSha, makeRepo, pinOffMain, tmpdir } from "./fixtures/repo-fixtures.js";

// pinChanges seeds every role's merge pin without a queue file — the drain's kept-pin path —
// and pinDrained (the ref files plus the tasks) stands in for the queue depth it replaces. A
// case that must assert on its OWN commit's sha pins directly with setRef instead, because
// pinChanges computes the sha itself.

/** First slice of the merge-drain suite (merge-pipeline.test.ts and merge-pipeline-2.test.ts
 * carry the rest) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process. The slices are balanced by measured
 * per-test duration (~10.6s vs ~6.9s at 2026-10-04); keep the files roughly equal when moving
 * tests between them. */
// Unit coverage for src/merge/merge-drain.ts — the scheduler seam between the merge queue and
// the merge pipeline: this slice drives every merge from a role's merge pin (part 1d/5) — the
// kept-pin path the pin-only writers of parts 3e/7 and 3i/7 leave behind, with no queue file —
// covering the one serial gate-then-merge task per kept pin (a change is gated and merged by
// the one task, so no verify stage starts) and the one task per poll across overlapping drains,
// with the review and post-merge review the task settles. The queue-file cases it replaces
// (a torn head, an entry main already holds, the dedupe-cache eviction) are the queue's own
// story; the drain still reads both. The review gate's pi runs are real subprocesses behind
// the fake shim, exactly as merger.test.ts drives mergeApprovedChange directly.

test("an empty queue and no pins drain nothing", async () => {
  const root = makeRepo();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
  await drainMergeQueue(ctx, pipeline);
  assert.equal(mergeTasks(pipeline).length, 0, "no gate-then-merge task started");
  assert.equal(await refSha(root, mergeRefName("improve")), null, "nothing was pinned");
});

test("overlapping merge drains start at most one task for the same kept pin (single-flight)", async () => {
  // INV-G6 / the 2026-11-09 drain race: a test (or the poll loop) that runs a background pump
  // and a pumpUntil overlaps two drainMerge calls. Both pass the drain's first slot check while
  // the slot is still null — the slot is assigned by the drain only after the awaits ahead of
  // startMerge, and startMerge launches the task in the background — so on the unfixed code both
  // start a gate-then-merge task for the SAME queue head. The gate's check blocks on a release
  // file this test never writes until cleanup, so neither task settles: the duplicate-start count
  // is observable the whole time. The fix re-checks the slot synchronously right before each
  // startMerge, so the second drain backs off and exactly one task starts.
  const root = makeRepo();
  await pinChanges(root, ["alpha"]);
  const flags = tmpdir("drain-single-flight-");
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-blocking")}'; ` +
        `i=0; while [ ! -f '${path.join(flags, "alpha-release")}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"], undefined, config), { cap: 3, config });
  resetMergeTaskStarts();
  const bg = pump(ctx, pipeline); // a second, background drain overlapping the pumpUntil below
  try {
    // Drive a first drain (pumpUntil's loop) until alpha's gate is in flight. Its check is
    // blocked on the release file, so the task — and the slot — are held open while we read the
    // start count. On unfixed code both drains started alpha here (count 2); fixed code starts
    // it exactly once.
    await pumpUntil(ctx, pipeline, () => fs.existsSync(path.join(flags, "alpha-blocking")), "alpha's gate to be in flight", 5_000);
    assert.ok(pipeline.merge, "a gate-then-merge task is in flight");
    assert.equal(mergeTaskStarts(), 1, "the one kept pin started exactly one gate-then-merge task");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await bg.stop();
    await Promise.allSettled(mergeTasks(pipeline).map((t) => t.promise));
    restore();
  }
});

test("a merged change's pin is deleted — the ref files settle drained", async () => {
  // The queue depth stood in for the pin before part 1d/5: the pin is the waiting state now, so
  // pinDrained reads the role's ref files instead — false while the pin resolves, true once the
  // merge consumes it and its task settles.
  const root = makeRepo();
  await pinChanges(root, ["alpha"]);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"]));
  const done = pinDrained(root, pipeline, ["alpha"]);
  assert.equal(queueDepth(root), 0, "no queue file was written");
  assert.equal(done(), false, "a kept pin is not drained even with no queue file");
  await pumpUntil(ctx, pipeline, done, "alpha's merge");
  assert.equal(await refSha(root, mergeRefName("alpha")), null, "a merged change deletes its pin");
});

test("every merged role queues a post-landing review, whatever its role", async () => {
  // A "changed" merge from improve queues a PostReview for its commit — part 3g makes
  // review-after-landing a property of every change, whatever the role.
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "code.txt"), "work\n"), "work by improve", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  const shutdown = new AbortController();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"], shutdown.signal), { signal: shutdown.signal });
  await withPi(APPROVE(), async () => {
    try {
      // Stop the instant the review is queued — before the post-landing review (a real subprocess
      // behind the fake shim) can settle it away, so the queued review is what is asserted.
      await pumpUntil(ctx, pipeline, () => readPostReviews(root).length > 0, "the unlisted role's post-landing review to queue");
    } finally {
      // The drain queues the PostReview and starts its review task (p.postReview) behind the fake
      // pi. Abort it and await it BEFORE withPi restores the real pi: aborting routes the task to
      // return without settling the queued entry (so the length assertion below still sees it), and
      // awaiting it here keeps the fake pi on PATH for the whole of its reviewer run instead of
      // letting that run outlive the test against the restored real pi (the offline principle).
      shutdown.abort();
      await Promise.allSettled([...(pipeline.postReview ? [pipeline.postReview.promise] : []), ...mergeTasks(pipeline).map((t) => t.promise)]);
    }
  });
  const queued = readPostReviews(root);
  assert.equal(queued.length, 1, "a merged role queues a PostReview for its commit");
  assert.equal(queued[0]!.role, "improve");
  assert.equal(queued[0]!.commit, sha, "the review names the merged commit");

  // An exempt-only diff (NOTES.md) queues none for the same role.
  const exempt = makeRepo();
  const shaExempt = pinOffMain(exempt, (d) => fs.writeFileSync(path.join(d, "NOTES.md"), "work\n"), "work by improve", { reset: true });
  await setRef(exempt, mergeRefName("improve"), shaExempt);
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(exempt, runnersFor(exempt, ["improve"]));
    await pumpUntil(ctx, pipeline, pinDrained(exempt, pipeline, ["improve"]), "the exempt merge");
  });
  assert.equal(readPostReviews(exempt).length, 0, "an exempt-only diff queues no post-merge review");
});

test("a null-file settle writes the outcome, drops no file and keeps the pin", async () => {
  // A pin-only merge (part 3h/7) settles with file null: the outcome must still be written
  // (merge_failed + the role's state), nothing is dropped (there is no queue file), and the
  // retriable result must NOT re-queue — the pin is the waiting state and the next poll
  // retries it under MERGE_CONFLICT_LIMIT.
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "no-file.txt"), "no-file work\n"), "no-file work", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  const state = freshRunnerState("improve");
  const noFile = { role: "improve", sha, run: 7, summary: "the work", enqueuedAt: Date.now() };

  await settleMergeOutcome(root, noFile, state, "merge_blocked", 5, { tokens: 0, cost: 0, providerCost: {} }, null);

  assert.equal(state.lastResult, "merge_blocked", "the outcome was written to the role's state");
  assert.ok(
    readEvents(root).some((e) => e.type === "merge_failed" && e.result === "merge_blocked"),
    "merge_failed fired with the result",
  );
  assert.equal(await refSha(root, mergeRefName("improve")), sha, "the pin survives — nothing dropped it");
  assert.equal(queueDepth(root), 0, "no retry entry was queued");
});

test("two overlapping drains of one pipeline start one merge task, not two", async () => {
  // drainMerge checks p.merge before its first await and re-checks it synchronously right before
  // each startMerge, so two overlapping drains of the SAME pipeline (the pump + pumpUntil shape)
  // cannot both start a task for the same kept pin: whichever reaches the re-check first assigns
  // the slot and the other sees it taken. If that guard regressed, a duplicate task would run the
  // change's check a second time. Each task runs the change's check exactly once, so the change's
  // check runs a second time iff a duplicate task started — that is the decisive, timing-
  // independent signal the flaky abort tests left (a green-fast check against a worktree a sibling
  // task reset, a duplicate merged event).
  const root = makeRepo();
  const counters = tmpdir("drain-single-flight-");
  const counter = path.join(counters, "check-count");
  fs.writeFileSync(counter, "");
  const config = {
    ...defaultConfig(),
    review: { enabled: true, exemptPaths: ["*.md", "docs/**"] },
    // One atomic append per check, so two duplicate tasks running their checks concurrently (the
    // default check cap is 2) cannot lose an increment to a read-modify-write and hide the
    // duplicate-start signal this regression reads.
    check: { command: `echo x >> '${counter}'; exit 0` },
  };
  await pinChanges(root, ["alpha"]);
  const restore = fakePi("VERDICT: approve\nok");
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"], undefined, config), { config });
  const bg = pump(ctx, pipeline);
  try {
    // pump (background) + pumpUntil (foreground) overlap on the same pipeline — the exact shape
    // that double-started the flaky test. Drive until the one pinned change fully drains.
    await pumpUntil(ctx, pipeline, pinDrained(root, pipeline, ["alpha"]), "the one change to fully drain", 45_000);
  } finally {
    await bg.stop().catch(() => {});
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
  const runs = fs.readFileSync(counter, "utf8").split("\n").filter((line) => line !== "").length;
  assert.equal(await refSha(root, mergeRefName("alpha")), null, "the merged change's pin was consumed");
  assert.equal(runs, 1, `the one pinned change's check ran exactly once (one task); observed ${runs}`);
});

test("a queue file with no live merge ref starts no merge at the drain", async () => {
  // Part 1b/3: a queue file an older build left starts no merge — the drain reads only the
  // live merge pins. A queue file with no resolvable ref for its role must start no task and
  // log no merge outcome: the queue file alone is not waiting state the drain merges.
  const root = makeRepo();
  const sha = mainSha(root);
  // A queue file for the role, but no merge ref: the drain has nothing to merge.
  enqueueMerge(root, { role: "clean", sha, run: 1, summary: "stale", enqueuedAt: Date.now() });
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["clean"]));
  await drainMergeQueue(ctx, pipeline);
  assert.equal(mergeTasks(pipeline).length, 0, "a queue file with no live ref starts no task");
  assert.equal(
    readEvents(root).some((e) => e.type === "merge_done" || e.type === "merge_failed"),
    false,
    "a queue file with no live ref logs no merge outcome",
  );
  assert.equal(await refSha(root, mergeRefName("clean")), null, "the queue file left no pin");
});
