import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue } from "../src/merge/merge-drain.js";
import { mergeTasks } from "../src/merge/merge-pipeline.js";
import { enqueueMerge, queueDepth, staleHeadFile } from "../src/merge/merge-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { readMergeMarker, writeMergeMarker } from "../src/merge/merge-slot.js";
import { mergeQueueDir, mergeRefName } from "../src/paths.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { setRef } from "../src/git/git.js";
import { APPROVE, drained, entry, makePipeline, pumpUntil, runnersFor } from "./fixtures/merge-fixtures.js";
import { unwritableEvents } from "./fixtures/log-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { mainSha, makeRepo, pinOffMain, sh } from "./fixtures/repo-fixtures.js";

/** First slice of the merge-drain suite (merge-pipeline.test.ts and merge-pipeline-2.test.ts
 * carry the rest, and merge-drain-verify.test.ts the verification-permit tests) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process. The slices are balanced by measured
 * per-test duration (~10.6s vs ~6.9s at 2026-10-04 — this file holds the one ~10.5s
 * dedupe-cache stress test alone, so the split's balance point is that test); keep the files
 * roughly equal when moving tests between them. */
// Unit coverage for src/merge/merge-drain.ts — the scheduler seam between the durable merge
// queue and the merge pipeline (land-queue speed 2c): the dedupe against main and torn-head
// recovery, the verify stage (one verification per queued change, each on a shared maxConcurrent
// permit), and the merge slot (every approved change, stacked), with the abort and shutdown rules
// and the marker records the observers read. The review gate's pi runs are real subprocesses behind
// the fake shim, exactly as merger.test.ts drives verifyRequest and mergeApproved directly.

test("an empty queue drains nothing", async () => {
  const root = makeRepo();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
  await drainMergeQueue(ctx, pipeline);
  assert.equal(mergeTasks(pipeline).length, 0, "no verification and no merge started");
  assert.equal(pipeline.verifying.size, 0);
});

test("a torn merge-queue head is dropped and the drain continues when the events feed is unwritable", async () => {
  // dropTornHead (merge-verify.ts) removes the unreadable head and then warns; an EISDIR on
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
  assert.equal(pipeline.verifying.size, 0, "nothing to verify — main already holds the sha");
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
  assert.equal(pipeline.verifying.size, 0, "no verification ever started: everything was already merged");
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
