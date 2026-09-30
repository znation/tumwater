import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainLandings } from "../src/landing-drain.js";
import { abortableLandings, landingTasks } from "../src/landing-pipeline.js";
import { enqueueLanding, queueDepth, queuedLandingFiles } from "../src/landing-queue.js";
import { landingRefName } from "../src/paths.js";
import { refSha } from "../src/git.js";
import { readEvents } from "../src/event-read.js";
import { readLandingMarker, writeLandingMarker } from "../src/landing-slot.js";
import { defaultConfig } from "../src/config.js";
import {
  APPROVE,
  allTasks,
  busySlot,
  drained,
  entry,
  makePipeline,
  pump,
  pumpUntil,
  queueChanges,
  reviewers,
  REVIEWING,
  rowReader,
  runnersFor,
  within,
} from "./landing-fixtures.js";
import { eventsOfType } from "./log-fixtures.js";
import { mainSha, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { waitFor, waitForFile } from "./wait.js";

/** First slice of the landing-drain suite (landing-pipeline.test.ts carries the rest) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process. The slices are balanced by measured
 * per-test duration (~18.5s vs ~18.1s at 2026-09-29); keep them roughly equal when moving tests
 * between the files. */
// Unit coverage for src/landing-drain.ts — the scheduler seam between the durable land queue and
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

test("landBatchMax caps each merge's stack, read from the live config at each drain", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const config = { ...defaultConfig(), check: { command: "true" } };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 3, "all three to be vetted");
    ctx.liveConfig = { ...config, landBatchMax: 2 }; // a live edit, as the scheduler hands it over
    pipeline.merge = null;
    await drainLandings(ctx, pipeline);
    assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha", "beta"], "the first merge stacks two, in queue order");
    assert.deepEqual([...pipeline.vetted.keys()], ["gamma"], "the third waits for the next merge");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

    const checks = readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate");
    assert.deepEqual(
      checks.map((e) => [e.loop, e.scope]),
      [
        ["alpha", "batch"],
        ["gamma", "landing"],
      ],
      "one shared check for the stack of two, then gamma's own in-lock re-check on the main they moved",
    );
    assert.deepEqual(eventsOfType(root, "merged").map((e) => e.loop), roles);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("every vet holds a shared permit: with one free, one reviews while the other parks, showing nothing, and no permit leaks", async () => {
  // A landing's pi runs take the same permit role ticks do (BUGS.md 2026-09-18), and landings
  // count as active work. At cap 3 (vetLimit 2) with no role tick running, both reviews run at
  // once; with two role ticks holding permits, one is free, so the second vet parks for it — no
  // marker record, its row plainly queued, out of reach of abort --role and of the shutdown
  // wait — until the first vet frees it. Each review records how many reviews were in flight as
  // it started. With both free, beta's review also holds (bounded) until alpha's has begun: two
  // vets that may overlap can still happen not to — beta's review can finish before alpha's
  // starts — so the overlap a working pipeline allows is made certain rather than left to
  // timing; a pipeline that serializes them leaves beta waiting out its bound alone.
  const cap = 3;
  for (const ticks of [0, 2]) {
    const free = cap - ticks;
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    await queueChanges(root, roles);
    const rowOf = rowReader(root, roles);
    const flags = tmpdir("vet-permits-");
    const awaitAlpha =
      ticks === 0
        ? `*_land-beta) i=0; while [ ! -f '${flags}/alpha-reviewing' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done;;`
        : "";
    const restore = fakePi(
      [
        `d='${flags}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX")`,
        `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${flags}/samples.log'`,
        `case "$PWD" in *_land-alpha) touch '${flags}/alpha-reviewing'; i=0; while [ ! -f '${flags}/alpha-release' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done;; ${awaitAlpha} esac`,
        `rm -f "$f"`,
        APPROVE(),
      ].join("\n"),
    );
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap });
    for (let k = 0; k < ticks; k++) await ctx.semaphore.acquire(0); // role ticks already running
    const bg = pump(ctx, pipeline);
    try {
      await waitForFile(path.join(flags, "alpha-reviewing"));
      if (ticks > 0) {
        await waitFor(() => pipeline.vetting.get("beta")?.parked === true, "beta's vet to park for the permit", 30_000);
        assert.match(rowOf("alpha"), REVIEWING, "one free: the vet holding the permit shows its stage");
        assert.equal(rowOf("beta"), "queued", "one free: the parked vet's role reads plainly queued");
        assert.deepEqual(readLandingMarker(root)?.changes?.map((c) => c.role), ["alpha"], "one free: no record for the parked vet");
        assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "one free: the parked vet is not in flight");
        assert.deepEqual(abortableLandings(pipeline).flatMap((t) => t.roles), ["alpha"], "one free: nor abortable");
      } else {
        await waitFor(() => readEvents(root).some((e) => e.type === "review_verdict" && e.loop === "beta"), "beta's review beside alpha's", 30_000);
      }
      fs.writeFileSync(path.join(flags, "alpha-release"), "");
      await waitFor(drained(root, pipeline), `${free} free: both changes to land`, 60_000);

      const samples = fs.readFileSync(path.join(flags, "samples.log"), "utf8").trim().split("\n").map(Number);
      assert.equal(samples.length, 2, `${free} free: one review per change`);
      assert.equal(Math.max(...samples), Math.min(free, 2), `${free} free: reviews in flight at each start never exceed the free permits (${samples})`);
      await bg.stop();
      // Every vet's permit came back: all the ticks left free are acquirable again.
      for (let k = 0; k < free; k++) {
        assert.ok(await within(ctx.semaphore.acquire(0), 5_000), `${free} free: permit ${k + 1} was never released`);
      }
    } finally {
      fs.writeFileSync(path.join(flags, "alpha-release"), "");
      await bg.stop();
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  }
});

test("a parked vet starts nothing when a shutdown or a closed start gate meets it: entry and pin stay queued", async () => {
  // A vet parked for its permit has started nothing, so it must end like a parked role tick —
  // no outcome, no review, no marker record — whether the harness stops (its controller) or a
  // restart / 429 hold closes the start gate before its permit comes (the gate at its grant).
  for (const stop of ["gate", "shutdown"] as const) {
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    const shas = await queueChanges(root, roles);
    const flags = tmpdir("vet-parked-");
    const restore = fakePi(reviewers(flags, roles, {}, ["alpha"]));
    const shutdown = new AbortController();
    let held = false;
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, shutdown.signal), {
      cap: 3,
      signal: shutdown.signal,
      held: () => held,
    });
    // Two role ticks hold two of the three permits: one is free, so beta's vet parks behind alpha's.
    await ctx.semaphore.acquire(0);
    await ctx.semaphore.acquire(0);
    try {
      await drainLandings(ctx, pipeline);
      await waitForFile(path.join(flags, "alpha-reviewing"));
      const beta = pipeline.vetting.get("beta");
      assert.equal(beta?.parked, true, `${stop}: beta's vet is parked behind alpha's`);
      if (stop === "gate") {
        held = true; // a restart hold, say: the scheduler stops draining, and parked vets meet it
        fs.writeFileSync(path.join(flags, "alpha-release"), "");
      } else {
        shutdown.abort();
      }
      assert.ok(await within(beta!.promise, 30_000), `${stop}: the parked vet settled`);
      await Promise.allSettled(allTasks(pipeline));

      assert.equal(pipeline.vetting.has("beta"), false, `${stop}: beta holds no vet any more`);
      assert.ok(queuedLandingFiles(root).some((q) => q.entry.role === "beta"), `${stop}: beta's entry is still queued`);
      assert.equal(await refSha(root, landingRefName("beta")), shas.beta, `${stop}: with its pin`);
      assert.equal(readEvents(root).some((e) => e.loop === "beta" && (e.type === "land_failed" || e.type === "review_start")), false, `${stop}: nothing ran for beta`);
      assert.ok(!readLandingMarker(root)?.changes?.some((c) => c.role === "beta"), `${stop}: beta never had a record`);
      if (stop === "shutdown") {
        const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === "alpha");
        assert.deepEqual(failed.map((e) => e.result), ["aborted"], "the vet under review ended aborted");
        assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha, "its pin survives the shutdown");
      } else {
        held = false; // the hold lifts: the next drain vets beta afresh
        await pumpUntil(ctx, pipeline, drained(root, pipeline), "both to land once the gate reopens");
        assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"), "beta landed once the gate reopened");
      }
      assert.ok(await within(ctx.semaphore.acquire(0), 5_000), `${stop}: the handed-back permit is free again`);
    } finally {
      fs.writeFileSync(path.join(flags, "alpha-release"), "");
      shutdown.abort();
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  }
});

test("three T-long reviews run at once at cap 4, so all three merge in about T, not 3T", async () => {
  // Acceptance for land-queue speed 2c. Each review records how many reviews were in flight as
  // it started, holds (bounded) until all three are in flight — three vets that may overlap can
  // still happen not to, and the overlap a working pipeline allows is made certain rather than
  // left to a long hold — and then holds T. As in lander.test.ts's timing tests, the span is
  // read off the harness's own timeline — first review_start to last `merged` — and held against
  // the reviews' own summed durations (the floor of any one-after-another schedule), so a loaded
  // host's git plumbing cannot swamp the bound.
  const T = 2;
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const mainBefore = mainSha(root);
  await queueChanges(root, roles);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d='${runDir}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX")`,
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${runDir}/samples.log'`,
      `i=0; while [ $(ls "$d" | wc -l) -lt 3 ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done`,
      `sleep ${T}; rm -f "$f"`,
      APPROVE(),
    ].join("\n"),
  );
  try {
    // Cap 4: vetLimit keeps one permit for authoring, so three vets may run.
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 4 });
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "3", "all three landed");
    const samples = fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
    assert.equal(samples.length, 3, "one review per change");
    assert.equal(Math.max(...samples), 3, `all three reviews overlapped (in flight at each start: ${samples})`);
    const events = readEvents(root);
    const firstStart = Math.min(...events.filter((e) => e.type === "review_start").map((e) => e.ts));
    const lastMerged = Math.max(...events.filter((e) => e.type === "merged").map((e) => e.ts));
    const serialFloorMs = events
      .filter((e) => e.type === "review_verdict")
      .reduce((sum, e) => sum + Number(e.durationMs), 0);
    assert.ok(
      lastMerged - firstStart < serialFloorMs,
      `review to last merge took ${lastMerged - firstStart} ms, no less than the reviews' ${serialFloorMs} ms sum — they ran one after another`,
    );
    assert.equal(events.filter((e) => e.type === "landed").length, 3, "each change's outcome written once");
    assert.equal(readLandingMarker(root), null, "the marker is gone once nothing is in flight");
  } finally {
    restore();
  }
});

