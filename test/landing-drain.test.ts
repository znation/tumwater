import test from "node:test";
import assert from "node:assert/strict";
import { drainLandings } from "../src/landing/landing-drain.js";
import { landingTasks } from "../src/landing/landing-pipeline.js";
import { enqueueLanding, queueDepth } from "../src/landing/landing-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { readLandingMarker, writeLandingMarker } from "../src/landing/landing-slot.js";
import { drained, entry, makePipeline, pumpUntil, runnersFor } from "./landing-fixtures.js";
import { mainSha, makeRepo, sh } from "./repo-fixtures.js";

/** First slice of the landing-drain suite (landing-pipeline.test.ts carries the rest, and
 * landing-drain-vetting.test.ts the vet-permit tests) — split so node --test runs the slices in
 * parallel processes: top-level tests within one file run sequentially, while each test FILE
 * gets its own process. The slices are balanced by measured per-test duration (~10.6s vs ~6.9s
 * at 2026-10-04 — this file holds the one ~10.5s dedupe-cache stress test alone, so the split's
 * balance point is that test); keep the files roughly equal when moving tests between them. */
// Unit coverage for src/landing/landing-drain.ts — the scheduler seam between the durable land queue and
// the landing pipeline (land-queue speed 2c): the dedupe against main and torn-head recovery,
// the vetting stage (one vet per queued change, each on a shared maxConcurrent permit), and the
// merge slot (every vetted change, stacked), with the abort and shutdown rules and the marker
// records the observers read. The review gate's pi runs are real subprocesses behind the fake
// shim, exactly as lander.test.ts drives vetRequest and landVetted directly.

test("an empty queue drains nothing", async () => {
  const root = makeRepo();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
  await drainLandings(ctx, pipeline);
  assert.equal(landingTasks(pipeline).length, 0, "no vet and no merge started");
  assert.equal(pipeline.vetting.size, 0);
});

test("a queued entry whose sha main already holds is dropped without a vet", async () => {
  const root = makeRepo();
  const sha = mainSha(root);
  enqueueLanding(root, entry("improve", sha));
  // A crash between the fast-forward and the entry drop leaves a marker naming a change main
  // already holds; the dedupe clears its record alongside the entry.
  writeLandingMarker(root, { role: "improve", sha, summary: "the work", startedAt: Date.now(), stage: "merging" });
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await drainLandings(ctx, pipeline);
  assert.equal(pipeline.vetting.size, 0, "nothing to vet — main already holds the sha");
  assert.equal(queueDepth(root), 0, "the stale entry was dropped");
  assert.equal(readLandingMarker(root), null, "the stale marker was cleared");
  assert.equal(readEvents(root).some((e) => e.type === "landed" || e.type === "land_failed"), false, "no outcome was written");
});

test("a full dedupe cache never wedges the drain: every already-merged entry still drops", async () => {
  // The dedupe verdict cache is bounded at 128 entries, and its eviction arms — prune the
  // stale-head verdicts first, then clear — had no coverage in any tier: no realistic fleet
  // queues 129 landings between two main moves. Two phases drive both arms with entries main
  // already holds, so no vet and no pi run is ever needed: if the eviction ever wedges the
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
  for (const sha of phaseOne) enqueueLanding(root, entry("improve", sha));
  assert.equal(queueDepth(root), 300);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await pumpUntil(ctx, pipeline, drained(root, pipeline), "the first cache-filling queue to drain");
  assert.equal(queueDepth(root), 0, "every already-merged entry was dropped through the eviction churn");
  assert.equal(readEvents(root).some((e) => e.type === "landed" || e.type === "land_failed"), false, "no outcome was written");

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
  for (const sha of phaseTwo) enqueueLanding(root, entry("improve", sha));

  await pumpUntil(ctx, pipeline, drained(root, pipeline), "the stale-head queue to drain");
  assert.equal(queueDepth(root), 0, "every entry deduped against the new head");
  assert.equal(pipeline.vetting.size, 0, "no vet ever started: everything was already merged");
  assert.equal(readEvents(root).some((e) => e.type === "landed" || e.type === "land_failed"), false, "still no outcome was written");
});
