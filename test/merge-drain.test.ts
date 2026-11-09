import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue, mergeTaskStarts, resetMergeTaskStarts } from "../src/merge/merge-drain.js";
import { mergeTasks, settleMergeOutcome } from "../src/merge/merge-pipeline.js";
import { enqueueMerge, queueDepth, staleHeadFile, type MergeEntry } from "../src/merge/merge-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { readMergeMarker, writeMergeMarker } from "../src/merge/merge-slot.js";
import { mergeQueueDir, mergeRefName } from "../src/paths.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { refSha, setRef } from "../src/git/git.js";
import { APPROVE, allTasks, drained, entry, makePipeline, pump, pumpUntil, queueChanges, runnersFor } from "./fixtures/merge-fixtures.js";
import { unwritableEvents } from "./fixtures/log-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { defaultConfig } from "../src/config/config.js";
import { mainSha, makeRepo, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";

/** First slice of the merge-drain suite (merge-pipeline.test.ts and merge-pipeline-2.test.ts
 * carry the rest) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process. The slices are balanced by measured
 * per-test duration (~10.6s vs ~6.9s at 2026-10-04 — this file holds the one ~10.5s
 * dedupe-cache stress test alone, so the split's balance point is that test); keep the files
 * roughly equal when moving tests between them. */
// Unit coverage for src/merge/merge-drain.ts — the scheduler seam between the durable merge
// queue and the merge pipeline (land-queue speed 2c): the dedupe against main and torn-head
// recovery, and the one serial gate-then-merge task per queue head (a change is gated and merged
// by the one task, so no verify stage starts), with the abort and shutdown rules
// and the marker records the observers read. The review gate's pi runs are real subprocesses behind
// the fake shim, exactly as merger.test.ts drives mergeApprovedChange directly.

test("an empty queue drains nothing", async () => {
  const root = makeRepo();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
  await drainMergeQueue(ctx, pipeline);
  assert.equal(mergeTasks(pipeline).length, 0, "no gate-then-merge task started");
  assert.equal(queueDepth(root), 0, "nothing was queued");
});

test("overlapping merge drains start at most one task for the same queue head (single-flight)", async () => {
  // INV-G6 / the 2026-11-09 drain race: a test (or the poll loop) that runs a background pump
  // and a pumpUntil overlaps two drainMerge calls. Both pass the drain's first slot check while
  // the slot is still null — the slot is assigned only inside startMerge, which runs in the
  // task's background body after an await — so on the unfixed code both start a gate-then-merge
  // task for the SAME queue head. The gate's check blocks on a release file this test never
  // writes until cleanup, so neither task settles: the duplicate-start count is observable the
  // whole time. The fix re-checks the slot synchronously right before each startMerge, so the
  // second drain backs off and exactly one task starts.
  const root = makeRepo();
  await queueChanges(root, ["alpha"]);
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
    assert.equal(mergeTaskStarts(), 1, "the one queued head started exactly one gate-then-merge task");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await bg.stop();
    await Promise.allSettled(mergeTasks(pipeline).map((t) => t.promise));
    restore();
  }
});

test("a torn merge-queue head is dropped and the drain continues when the events feed is unwritable", async () => {
  // dropTornHead (merge-head.ts) removes the unreadable head and then warns; an EISDIR on
  // that warning must not reject the whole drain poll, or one torn file plus a full disk stops
  // every role's queued merge from being verified. The drop itself still happens.
  const root = makeRepo();
  const dir = mergeQueueDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const torn = path.join(dir, "0000000000-000000-1.json");
  fs.writeFileSync(torn, "{ torn mid-write");
  assert.equal(staleHeadFile(root), torn, "the torn file is the unreadable head");
  unwritableEvents(root);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await drainMergeQueue(ctx, pipeline);

  assert.equal(staleHeadFile(root), null, "the torn head was dropped despite the broken feed");
  assert.equal(queueDepth(root), 0, "the drain reached an empty queue rather than aborting");
});

test("a queued entry whose sha main already holds is dropped without a verification", async () => {
  const root = makeRepo();
  const sha = mainSha(root);
  enqueueMerge(root, entry("improve", sha));
  // A crash between the fast-forward and the entry drop leaves a marker naming a change main
  // already holds; the dedupe clears its record alongside the entry.
  writeMergeMarker(root, { role: "improve", sha, summary: "the work", startedAt: Date.now(), stage: "merging" });
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await drainMergeQueue(ctx, pipeline);
  assert.equal(mergeTasks(pipeline).length, 0, "no task started — main already holds the sha");
  assert.equal(queueDepth(root), 0, "the stale entry was dropped");
  assert.equal(readMergeMarker(root), null, "the stale marker was cleared");
  assert.equal(readEvents(root).some((e) => e.type === "merge_done" || e.type === "merge_failed"), false, "no outcome was written");
});

test("a full dedupe cache never wedges the drain: every already-merged entry still drops", async () => {
  // The dedupe verdict cache is bounded at 128 entries, and its eviction arms — prune the
  // stale-head verdicts first, then clear — had no coverage in any tier: no realistic team
  // queues 129 merges between two main moves. Two phases drive both arms with entries main
  // already holds, so no verification and no pi run is ever needed: if the eviction ever wedges the
  // drain (a throw mid-prune, an entry wrongly kept queued), the queue depth and the event
  // log say so. Each phase's entries come from a commit-tree chain built in one spawn —
  // 500 spawns one-by-one would dwarf the drain itself.
  const root = makeRepo();
  const initialTip = mainSha(root);
  // 300 already-merged commits at one constant head: every sha the drain's dedupe reads as
  // merged, every verdict cached against the same head.
  sh(
    root,
    "bash",
    "-c",
    'head=$(git rev-parse main); tree=$(git rev-parse main^{tree}); ' +
      'for i in $(seq 1 300); do c=$(git commit-tree "$tree" -p "$head" -m "filler $i"); head=$c; done; ' +
      'git update-ref refs/heads/main "$head"',
  );
  const phaseOne = sh(root, "git", "rev-list", "main", `^${initialTip}`).split("\n");
  assert.equal(phaseOne.length, 300);
  for (const sha of phaseOne) enqueueMerge(root, entry("improve", sha));
  assert.equal(queueDepth(root), 300);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await pumpUntil(ctx, pipeline, drained(root, pipeline), "the first cache-filling queue to drain");
  assert.equal(queueDepth(root), 0, "every already-merged entry was dropped through the eviction churn");
  assert.equal(mergeTasks(pipeline).length, 0, "no task ever started: everything was already merged");
  assert.equal(readEvents(root).some((e) => e.type === "merge_done" || e.type === "merge_failed"), false, "no outcome was written");

  // Second arm: a cache holding phase-one verdicts against the OLD head, then a poll whose
  // main has moved — the eviction must prune the stale-head verdicts (the clear alone would
  // also thrash a cache that could have kept fresh-head entries) and the new entries must
  // still dedupe. 200 fresh misses guarantee the cache crosses 128 during this drain no
  // matter what earlier tests in this process left in it.
  sh(
    root,
    "bash",
    "-c",
    'head=$(git rev-parse main); tree=$(git rev-parse main^{tree}); ' +
      'for i in $(seq 1 200); do c=$(git commit-tree "$tree" -p "$head" -m "filler 2-$i"); head=$c; done; ' +
      'git update-ref refs/heads/main "$head"',
  );
  const phaseTwo = sh(root, "git", "rev-list", "main", `^${phaseOne[0]}`).split("\n");
  assert.equal(phaseTwo.length, 200);
  for (const sha of phaseTwo) enqueueMerge(root, entry("improve", sha));

  await pumpUntil(ctx, pipeline, drained(root, pipeline), "the stale-head queue to drain");
  assert.equal(queueDepth(root), 0, "every entry deduped against the new head");
  assert.equal(mergeTasks(pipeline).length, 0, "no task ever started: everything was already merged");
  assert.equal(readEvents(root).some((e) => e.type === "merge_done" || e.type === "merge_failed"), false, "still no outcome was written");
});

test("every merged role queues a post-landing review, whatever its role", async () => {
  // A "changed" merge from improve queues a PostReview for its commit — part 3g makes
  // review-after-landing a property of every change, whatever the role.
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "code.txt"), "work\n"), "work by improve", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  enqueueMerge(root, entry("improve", sha));
  const shutdown = new AbortController();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"], shutdown.signal), { signal: shutdown.signal });
  await withPi(APPROVE(), async () => {
    try {
      // Stop the instant the entry is queued — before the post-landing review (a real subprocess
      // behind the fake shim) can settle it away, so the queued entry is what is asserted.
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
  enqueueMerge(exempt, entry("improve", shaExempt));
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(exempt, runnersFor(exempt, ["improve"]));
    await pumpUntil(ctx, pipeline, drained(exempt, pipeline), "the exempt merge");
  });
  assert.equal(readPostReviews(exempt).length, 0, "an exempt-only diff queues no post-merge review");
});

test("a null-file settle writes the outcome, drops no file and queues no retry entry", async () => {
  // A pin-only merge (part 3h/7) settles with file null: the outcome must still be written
  // (merge_failed + the role's state), nothing is dropped (there is no queue file), and the
  // retriable result must NOT re-queue — the pin is the waiting state and the next poll
  // retries it under MERGE_CONFLICT_LIMIT.
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "no-file.txt"), "no-file work\n"), "no-file work", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  const state = freshRunnerState("improve");
  const noFile: MergeEntry = { role: "improve", sha, run: 7, summary: "the work", enqueuedAt: Date.now() };

  await settleMergeOutcome(root, noFile, state, "merge_blocked", 5, { tokens: 0, cost: 0, providerCost: {} }, null, "main");

  assert.equal(state.lastResult, "merge_blocked", "the outcome was written to the role's state");
  assert.ok(
    readEvents(root).some((e) => e.type === "merge_failed" && e.result === "merge_blocked"),
    "merge_failed fired with the result",
  );
  assert.equal(await refSha(root, mergeRefName("improve")).catch(() => null), sha, "the pin survives — nothing dropped it");
  assert.equal(queueDepth(root), 0, "no retry entry was queued");
});

test("two overlapping drains of one pipeline start one merge task, not two", async () => {
  // drainMerge checks p.merge between its dedupe awaits without reserving the slot, so two
  // overlapping drains of the SAME pipeline (the pump + pumpUntil shape) each read the slot as
  // free and each call startMerge for the same queue head: a duplicate task. Each task runs the
  // change's check exactly once, so the change's check runs a second time iff a duplicate task
  // started — that is the decisive, timing-independent signal the flaky abort tests left (a
  // green-fast check against a worktree a sibling task reset, a duplicate merged event).
  const root = makeRepo();
  const counters = tmpdir("drain-single-flight-");
  const counter = path.join(counters, "check-count");
  fs.writeFileSync(counter, "0");
  const config = {
    ...defaultConfig(),
    review: { enabled: true, exemptPaths: ["*.md", "docs/**"] },
    check: { command: `n=$(cat '${counter}'); echo $((n+1)) > '${counter}'; exit 0` },
  };
  await queueChanges(root, ["alpha"]);
  const restore = fakePi("VERDICT: approve\nok");
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"], undefined, config), { config });
  const bg = pump(ctx, pipeline);
  try {
    // pump (background) + pumpUntil (foreground) overlap on the same pipeline — the exact shape
    // that double-started the flaky test. Drive until the one queued change fully drains.
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the one change to fully drain", 45_000);
  } finally {
    await bg.stop().catch(() => {});
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
  const runs = Number.parseInt(fs.readFileSync(counter, "utf8").trim(), 10);
  assert.equal(queueDepth(root), 0, "the one queued change drained");
  assert.equal(await refSha(root, mergeRefName("alpha")), null, "the merged change's pin was consumed");
  assert.equal(runs, 1, `the one queued change's check ran exactly once (one task); observed ${runs}`);
});
