import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { drainLandings, settleAbortedVetted } from "../src/landing/landing-drain.js";
import {
  abortableLandings,
  landingTasks,
  type InFlightLanding,
} from "../src/landing/landing-pipeline.js";
import { vetLimit } from "../src/landing/landing-vetting.js";
import { consumeAbortRequests } from "../src/operator/operator-requests.js";
import { enqueueLanding, queueDepth, queuedLandingFiles } from "../src/landing/landing-queue.js";
import { abortRequestPath, landQueueDir, landingRefName, landingStatePath } from "../src/paths.js";
import { deleteRef, isMergedInto, refSha, setRef } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { landingChanges, readLandingMarker } from "../src/landing/landing-slot.js";
import { defaultConfig } from "../src/config/config.js";
import { loadLoopState } from "../src/loop/loop-state.js";
import { writeJsonFile } from "../src/files/json-files.js";
import {
  APPROVE,
  allTasks,
  busySlot,
  drained,
  entry,
  makePipeline,
  pinnedCommit,
  pump,
  pumpUntil,
  queueChanges,
  reviewers,
  REVIEWING,
  rowReader,
  runnersFor,
} from "./fixtures/landing-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { sleep, waitFor, waitForFile, within } from "./helpers/wait.js";
import { assistantLine, leasedRoleShell } from "./fixtures/pi-events.js";

/** Second slice of the landing-drain suite (landing-drain.test.ts carries the first) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process. The slices are balanced by measured
 * per-test duration (~18.5s vs ~18.1s at 2026-09-29); keep them roughly equal when moving tests
 * between the files. This slice carries the pipeline's end-to-end behaviors — torn-head
 * recovery, the merge stack, abort and shutdown, and the failure recoveries — while the dedupe
 * basics live in landing-drain.test.ts. */
// Unit coverage for src/landing/landing-drain.ts — the scheduler seam between the durable land queue and
// the landing pipeline (land-queue speed 2c): the dedupe against main and torn-head recovery,
// the vetting stage (one vet per queued change, each on a shared maxConcurrent permit), and the
// merge slot (every vetted change, stacked), with the abort and shutdown rules and the marker
// records the observers read. The review gate's pi runs are real subprocesses behind the fake
// shim, exactly as lander.test.ts drives vetRequest and landVetted directly.

/** The fixture the three busy-merge-slot tests below share: an alpha+beta queue on a real
 * repo, a landing config whose check is a no-op, the fake approver, and a pipeline whose merge
 * slot is held busy so both vets stack up before any merge. `restore` must run in the caller's
 * finally, after its tasks settle. */
async function busyMergePipeline() {
  const root = makeRepo();
  await queueChanges(root, ["alpha", "beta"]);
  const mainBefore = mainSha(root);
  const config = { ...defaultConfig(), check: { command: "true" } };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"], undefined, config), { config });
  pipeline.merge = busySlot();
  return { root, mainBefore, restore, ctx, pipeline };
}

test("a torn head is dropped with a warning and the healthy entry behind it lands", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  // A hard crash mid enqueueLanding write: a file that sorts FIRST but parses to no entry.
  fs.mkdirSync(landQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(landQueueDir(root), "1-000000-0.json"), '{"role":"improve"');
  enqueueLanding(root, entry("improve", sha));
  const restore = fakePi(APPROVE());
  try {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await drainLandings(ctx, pipeline);
    assert.deepEqual([...pipeline.vetting.keys()], ["improve"], "the healthy entry behind the torn head is vetted");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the healthy entry to land");

    const torn = path.join(landQueueDir(root), "1-000000-0.json");
    assert.equal(fs.existsSync(torn), false, "the torn head was dropped");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && /land queue head 1-000000-0\.json is unreadable/.test(String(e.message)),
      ),
      "the drop carried one warning event",
    );
    assert.ok(await isMergedInto(root, sha, "main"), "the healthy entry landed");
  } finally {
    restore();
  }
});

test("a single queued pinned entry lands through the pipeline: main advances, ref and entry and marker clear", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  enqueueLanding(root, entry("improve", sha));
  const mainBefore = mainSha(root);
  const restore = fakePi(APPROVE());
  try {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the entry to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "the change landed on main");
    assert.ok(await isMergedInto(root, sha, "main"), "the pinned commit is contained in main");
    assert.equal(await refSha(root, landingRefName("improve")), null, "the ff deleted the landing ref");
    assert.equal(readLandingMarker(root), null, "the in-flight marker was cleared");
    const landed = eventsOfType(root, "landed");
    assert.equal(landed.length, 1, "one landed event for the queue's bookkeeping");
    assert.equal(landed[0]!.loop, "improve");
    assert.equal(landed[0]!.result, "changed");
    assert.equal(loadLoopState(root, "improve").lastResult, "changed", "the outcome folded into the author's state");
  } finally {
    restore();
  }
});

test("a settled landing detaches its shutdown listener: the long-lived stop signal keeps no per-landing wiring", async () => {
  // The fleet shutdown signal is one object for the whole run and abortOnShutdown wires every
  // vet and merge to it. A task that settles while the signal is still live must detach its
  // listener; otherwise the signal accumulates one per landing — and the controller each
  // retains — unbounded until shutdown. The runners carry no signal here, so every abort
  // listener on the shutdown signal is a landing task's.
  const root = makeRepo();
  await queueChanges(root, ["alpha"]);
  const restore = fakePi(APPROVE());
  const shutdown = new AbortController();
  try {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"]), { signal: shutdown.signal });
    assert.equal(getEventListeners(shutdown.signal, "abort").length, 0, "nothing is wired before a landing starts");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the entry to land");
    assert.equal(
      getEventListeners(shutdown.signal, "abort").length,
      0,
      "the vet's and merge's wiring detached as each task settled",
    );
  } finally {
    restore();
  }
});

test("changes vetted while the merge slot is busy merge as one stack: one shared check, one fast-forward", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 2, "both changes to be vetted");
    pipeline.merge = null; // the busy slot frees
    await drainLandings(ctx, pipeline);
    assert.deepEqual(
      landingTasks(pipeline).flatMap((t) => t.roles),
      ["alpha", "beta"],
      "one merge, whose record names every stacked role, in queue order",
    );
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the stack to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes landed on main");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, landingRefName(role)), null, `${role}'s ref was deleted`);
    }
    assert.equal(readLandingMarker(root), null, "the marker was cleared");
    const checks = eventsOfType(root, "build_check");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 1, "ONE shared check over the stacked tree");
    assert.equal(checks.filter((e) => e.scope === "landing").length, 0, "and no per-change in-lock re-check");
    assert.deepEqual(
      eventsOfType(root, "merged").map((e) => e.loop),
      ["alpha", "beta"],
      "one merged event per change, in queue order",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a vetted change whose queue entry is gone is forgotten while its neighbor still lands", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 2, "both changes to be vetted");
    // beta's queue entry vanishes while beta sits vetted — the only way an entry leaves the
    // queue between its vet settling and the next merge: a hand outside the pipeline on the
    // queue dir. drainMerge must forget beta without writing it an outcome or a merge.
    fs.rmSync(queuedLandingFiles(root).find((q) => q.entry.role === "beta")!.file);
    pipeline.merge = null; // the busy slot frees
    await drainLandings(ctx, pipeline);
    assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "only alpha is picked for the merge");
    assert.deepEqual([...pipeline.vetted.keys()], [], "beta left the vetted map");
    assert.deepEqual(
      landingChanges(readLandingMarker(root)!).map((c) => c.role),
      ["alpha"],
      "beta's marker record dropped with its entry",
    );
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "alpha to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "only alpha reached main");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "alpha's work is on main");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "alpha's pin was deleted after landing");
    assert.ok(await refSha(root, landingRefName("beta")), "beta's pin survives: its approved work is still real");
    assert.deepEqual(
      readEvents(root).filter(
        (e) => e.loop === "beta" && (e.type === "merged" || e.type === "landed" || e.type === "land_failed"),
      ),
      [],
      "beta left no outcome — forgotten, not failed",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("the merge's conflict resolver takes a shared permit, ahead of a vet parked for one", async () => {
  // Landings count as active work: the one model run a merge makes, mergeToMain's conflict
  // resolver, holds a shared maxConcurrent permit for its length — outside the merge lock, so a
  // tick waiting on that lock can never be what the resolver waits for — at MERGE_TIER, ahead
  // of any vet parked for a permit, since every queued change waits on the merge.
  const root = makeRepo();
  const alpha = pinnedCommit(root, "alpha");
  const beta = pinnedCommit(root, "beta");
  // main rewrites alpha's file after the pin: alpha's rebase conflicts, at its vet (which then
  // reviews the bare pin) and again at its merge, which needs the resolver.
  fs.writeFileSync(path.join(root, "alpha.txt"), "main's alpha\n");
  sh(root, "git", "add", "alpha.txt");
  sh(root, "git", "commit", "-m", "main edits alpha.txt");
  await setRef(root, landingRefName("alpha"), alpha);
  await setRef(root, landingRefName("beta"), beta);
  enqueueLanding(root, entry("alpha", alpha));
  const flags = tmpdir("resolver-permit-");
  const order = path.join(flags, "order");
  const restore = fakePi(
    [
      leasedRoleShell(),
      `for a in "$@"; do case "$a" in`,
      `tumwater-*-conflict) echo resolved > alpha.txt; echo resolver >> '${order}'; printf '%s\\n' '${assistantLine("resolved")}'; exit 0;;`,
      `*"VERDICT:"*) case "$role" in beta) echo beta-review >> '${order}';; esac; printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
    ].join("\n"),
  );
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]), { cap: 1 });
  pipeline.merge = busySlot();
  let held = false;
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.has("alpha"), "alpha to be vetted");
    // A role tick takes the only permit, and beta's change queues behind it: its vet parks.
    await ctx.semaphore.acquire(0);
    held = true;
    enqueueLanding(root, entry("beta", beta));
    await drainLandings(ctx, pipeline);
    assert.equal(pipeline.vetting.get("beta")?.parked, true, "beta's vet parks for the permit");
    pipeline.merge = null;
    await drainLandings(ctx, pipeline);
    assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "alpha's merge is running");
    // The merge reaches its resolver, which parks for the permit beside beta's vet — or, without
    // one, runs at once and leaves its mark.
    await waitFor(() => ctx.semaphore.waiting === 2 || fs.existsSync(order), "alpha's resolver to reach the permit");
    assert.equal(fs.existsSync(order), false, "the resolver waits for a permit like any pi run");

    ctx.semaphore.release(); // the tick ends: the merge's resolver is first in line
    held = false;
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "both to land");
    assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["resolver", "beta-review"], "the resolver ran before the parked vet");
    assert.equal(sh(root, "git", "show", "main:alpha.txt"), "resolved", "the resolution landed");
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
  } finally {
    if (held) ctx.semaphore.release();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a red stack lands its passing prefix, rejects the change red alone, and merges the one behind it next", async () => {
  // PLANS.md land-queue 3d through the pipeline: beta breaks the suite only on top of alpha (its
  // own vet passed — an interaction the stack check exists to catch). The bisect lands alpha on
  // its own green check, attributes beta's red through main's baseline (a cache hit: alpha's
  // prefix seeded it) and rejects it with no pi run, and leaves gamma unattempted — back to
  // vetted, so the next merge lands it, re-checked on the main alpha moved.
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const shas = await queueChanges(root, roles);
  const mainBefore = mainSha(root);
  const config = {
    ...defaultConfig(),
    check: { command: `if [ -f alpha.txt ] && [ -f beta.txt ]; then echo "planted failure: beta breaks the suite"; exit 1; fi` },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 3, "all three to be vetted");
    pipeline.merge = null;
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

    assert.deepEqual(
      sh(root, "git", "log", "--reverse", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by alpha", "work by gamma"],
      "alpha's prefix, then gamma on the next merge",
    );
    const checks = readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate");
    assert.deepEqual(
      checks.map((e) => [e.scope, e.status]),
      [
        ["batch", "failed"],
        ["batch", "passed"],
        ["batch", "failed"],
        ["landing", "passed"],
      ],
      "the whole stack, alpha's prefix, beta alone on top of it, then gamma's in-lock re-check",
    );
    const beta = loadLoopState(root, "beta");
    assert.equal(beta.lastResult, "rejected");
    assert.match(beta.lastReview!.reasons[0]!, /: planted failure: beta breaks the suite$/);
    assert.deepEqual(eventsOfType(root, "review_rejected").map((e) => e.loop), ["beta"]);
    assert.equal(eventsOfType(root, "review_start").length, 3, "one review per change, all in the vets");
    assert.equal(await refSha(root, landingRefName("beta")), null, "the rejection deleted beta's pin");
    assert.equal(await isMergedInto(root, shas.beta!, "main"), false);
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "landed" || e.type === "land_failed").map((e) => `${e.loop}:${String(e.result)}`),
      ["alpha:changed", "beta:rejected", "gamma:changed"],
      "each outcome written once, gamma's only after its own merge",
    );
    assert.equal(readLandingMarker(root), null);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("vets leave one permit for authoring: at cap 3 two review, the third waits unstarted, and a role tick gets the last permit", async () => {
  assert.deepEqual([1, 2, 3, 6].map(vetLimit), [1, 1, 2, 5], "maxConcurrent − 1, never below one");
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-reserve-");
  const restore = fakePi(reviewers(flags, roles, {}, roles));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 3 });
  const bg = pump(ctx, pipeline);
  let ticked = false;
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitForFile(path.join(flags, "beta-reviewing"));
    await sleep(500); // a few more polls: nothing more may start
    assert.deepEqual([...pipeline.vetting.keys()], ["alpha", "beta"], "only vetLimit(3) vets exist");
    assert.equal(rowOf("gamma"), "queued", "the third change waits in the queue, not parked on a permit");
    assert.ok(await within(ctx.semaphore.acquire(0), 5_000), "a role tick takes the permit the vets left free");
    ticked = true;

    ctx.semaphore.release();
    ticked = false;
    for (const role of roles) fs.writeFileSync(path.join(flags, `${role}-release`), "");
    await waitFor(drained(root, pipeline), "all three to land", 60_000);
  } finally {
    if (ticked) ctx.semaphore.release();
    for (const role of roles) fs.writeFileSync(path.join(flags, `${role}-release`), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a vetting rejection drops its entry at once — its role may tick next poll — while the other vet runs on", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const flags = tmpdir("vet-reject-");
  const restore = fakePi(reviewers(flags, roles, { alpha: "VERDICT: reject\n1. no" }, ["beta"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 2 });
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => queuedLandingFiles(root).length === 1, "alpha's entry to drop at its verdict", 30_000);

    assert.deepEqual(
      queuedLandingFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's entry is gone: the scheduler's interlock no longer holds alpha",
    );
    assert.equal(loadLoopState(root, "alpha").lastResult, "rejected", "the outcome is saved before the drop");
    assert.equal(readEvents(root).filter((e) => e.type === "land_failed" && e.loop === "alpha").length, 1);
    assert.equal(await refSha(root, landingRefName("alpha")), null, "a rejection deletes the pin");
    assert.deepEqual([...pipeline.vetting.keys()], ["beta"], "beta's vet is still running");
    const marker = readLandingMarker(root);
    assert.deepEqual(
      marker?.changes?.map((c) => [c.role, c.status, c.stage]),
      [["beta", "landing", "reviewing"]],
      "the marker holds only the change still in flight, at its own stage",
    );
    assert.equal(marker?.role, "beta", "the top level follows the change still in flight, for older observers");
    assert.equal(marker?.stage, "reviewing", "at its own stage");

    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await waitFor(drained(root, pipeline), "beta to land", 30_000);
    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta landed");
  } finally {
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a landing whose role has no live runner vets and lands through a throwaway author", async () => {
  // resolveAuthor's fallback: a role disabled before this process started (or removed from
  // the fleet after its change was queued) has no runner in ctx.runners, so the drain builds
  // a throwaway one with the same landing wiring and a disk-loaded state — the queue must
  // still drain, or the orphaned entry wedges the interlock and the slot forever.
  const root = makeRepo();
  await queueChanges(root, ["alpha"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, []); // no live runners at all
  const bg = pump(ctx, pipeline);
  try {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the orphaned change to vet and land");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "the change landed on main");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "landed" && e.loop === "alpha").map((e) => e.result),
      ["changed"],
      "the outcome was written and reported for the runner-less role",
    );
    const state = loadLoopState(root, "alpha");
    assert.equal(state.lastError, undefined, "the throwaway author ran clean");
    assert.equal(state.lastResult, "changed", "the disk-loaded state was folded and saved back");
    assert.equal(state.commits, 1, "the landed change counted on the throwaway author's counters");
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

// ── An abort whose pin is already gone ──────────────────────────────────────────────────
// discardPinnedRefs's documented edge: a pin that is already gone is not an error. The ref
// can vanish between the operator's abort and the settle — the gate itself deletes a pin at
// its rejection verdict (landing-core.ts), and an outside cleanup can drop tumwater refs — so the
// settle that discards an aborted vetted change must tolerate a missing ref end to end:
// deleteRef's gitTry swallows the absent-ref failure, and the drain's own catch stands
// behind it for any other plumbing failure. No test pinned the settle against a vanished
// pin before this one.

test("abort --role settles a vetted change whose pin is already gone without throwing", async () => {
  const root = makeRepo();
  const shas = await queueChanges(root, ["alpha", "beta"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]));
  pipeline.merge = busySlot(); // both changes vet and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => pipeline.vetted.has("alpha") && pipeline.vetted.has("beta"), "both changes to be vetted", 30_000);

    // The pin vanishes before the abort lands: the race the catch exists for.
    await deleteRef(root, landingRefName("alpha"));
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableLandings(pipeline));
    await settleAbortedVetted(root, pipeline); // must resolve: the missing ref is not an error

    assert.ok(!pipeline.vetted.has("alpha"), "the aborted entry left the pipeline");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "land_failed" && e.loop === "alpha").map((e) => e.result),
      ["aborted"],
      "the outcome was still written and reported",
    );
    assert.deepEqual(
      queuedLandingFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's queue entry dropped with its outcome; beta still waits, vetted",
    );
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta, "beta's pin was untouched");
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});
test("a vetted change merges while an earlier queue entry is still in review", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-ahead-");
  const restore = fakePi(reviewers(flags, roles, {}, ["alpha"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 3 });
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitFor(() => readEvents(root).some((e) => e.type === "landed" && e.loop === "beta"), "beta to land", 30_000);

    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta merged ahead of the queue head");
    assert.equal(await isMergedInto(root, shas.alpha!, "main"), false);
    assert.deepEqual([...pipeline.vetting.keys()], ["alpha"], "the head is still in review");
    assert.match(rowOf("alpha"), REVIEWING, "the head's row shows its own vet");
    assert.equal(rowOf("beta"), "queued", "beta's row is back to its own state");

    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await waitFor(drained(root, pipeline), "alpha to land", 30_000);
    assert.deepEqual(
      eventsOfType(root, "merged").map((e) => e.loop),
      ["beta", "alpha"],
      "each merged as soon as it was vetted",
    );
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a shutdown reaches every vet and keeps their pins; a vetted change waits out a busy merge slot", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const shas = await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-shutdown-");
  const restore = fakePi(reviewers(flags, roles, {}, ["alpha", "beta"]));
  const shutdown = new AbortController();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, shutdown.signal), { cap: 4, signal: shutdown.signal });
  pipeline.merge = busySlot();
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => pipeline.vetted.has("gamma"), "gamma to be vetted", 30_000);
    assert.equal(rowOf("gamma"), "vetted, awaiting merge");

    await bg.stop();
    shutdown.abort();
    await Promise.allSettled([...pipeline.vetting.values()].map((t) => t.promise));

    for (const role of ["alpha", "beta"]) {
      const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === role);
      assert.deepEqual(failed.map((e) => e.result), ["aborted"], `${role}'s vet ended aborted`);
      assert.equal(await refSha(root, landingRefName(role)), shas[role], `${role}'s pin survives the shutdown`);
    }
    assert.deepEqual(
      queuedLandingFiles(root).map((q) => q.entry.role),
      ["gamma"],
      "the vetted change stays queued for the next start",
    );
    assert.ok(await refSha(root, landingRefName("gamma")), "with its pin");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    shutdown.abort();
    await Promise.allSettled([...pipeline.vetting.values()].map((t) => t.promise));
    restore();
  }
});

test("abort --role stops that role's vet, or discards its vetted change, pin and all, while another vet runs on", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const shas = await queueChanges(root, roles);
  const flags = tmpdir("vet-abort-");
  const restore = fakePi(reviewers(flags, roles, {}, ["alpha", "beta"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 4 });
  pipeline.merge = busySlot();
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => pipeline.vetted.has("gamma"), "gamma to be vetted", 30_000);

    const alphaVet = pipeline.vetting.get("alpha")?.promise;
    for (const role of ["alpha", "gamma"]) writeJsonFile(abortRequestPath(root, role), { at: Date.now() });
    consumeAbortRequests(root, [], abortableLandings(pipeline));
    await settleAbortedVetted(root, pipeline); // the scheduler settles right after, every poll
    // The aborted vet drops its entry before it discards its pin and leaves the pipeline, so
    // wait for the task itself: its outcome, pin discard and exit are all done once it settles.
    await alphaVet;
    await waitFor(() => queuedLandingFiles(root).length === 1, "both aborted entries to drop", 30_000);

    for (const role of ["alpha", "gamma"]) {
      const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === role);
      assert.deepEqual(failed.map((e) => e.result), ["aborted"], `${role} ended aborted`);
      assert.equal(await refSha(root, landingRefName(role)), null, `${role}'s pin was discarded`);
    }
    assert.deepEqual([...pipeline.vetting.keys()], ["beta"], "beta's vet runs on");

    pipeline.merge = null; // the busy slot frees
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await waitFor(drained(root, pipeline), "beta to land", 30_000);
    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta landed");
    assert.equal(await isMergedInto(root, shas.gamma!, "main"), false, "the discarded change never landed");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

// The landing cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23) through the pipeline: each
// change's own record carries its stage, so a change's stage must leave `reviewing` the moment
// its gate returns — otherwise its finished reviewer's last turns sit in the cell, accruing a
// false `no pi output` flag, for as long as it waits for its merge — and one change's vet must
// advance only its own record. The stage sequence below is a single timeline: one permit, so the
// second vet parks (no record) until the first frees it, and a busy merge slot until both are
// done vetting.
for (const headVerdict of ["reject", "approve"] as const) {
  test(`a head ${headVerdict === "reject" ? "rejected" : "approved"} in its vet leaves reviewing when its gate returns; the stack check names itself`, async () => {
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    await queueChanges(root, roles);
    const rec = path.join(tmpdir(), "stages");
    // Every record as `role=status/stage`, read from the live marker by whichever run records it.
    const script = path.join(tmpdir(), "stages.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";\n` +
        `let m = {};\ntry { m = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch {}\n` +
        `process.stdout.write((m.changes ?? []).map((c) => c.role + "=" + c.status + "/" + (c.stage ?? "-")).join(","));\n`,
    );
    const stagesOf = `'${process.execPath}' '${script}' '${landingStatePath(root)}'`;
    const config = { ...defaultConfig(), check: { command: `echo "check:$(${stagesOf})" >> '${rec}'` } };
    const headReply = headVerdict === "reject" ? "VERDICT: reject\n1. no" : "VERDICT: approve";
    const restore = fakePi(
      [
        // Tell the two reviewer runs apart by the session name pi is handed.
        `r=none; for a in "$@"; do case "$a" in tumwater-review-alpha-*) r=alpha ;; tumwater-review-beta-*) r=beta ;; esac; done`,
        `echo "$r:$(${stagesOf})" >> '${rec}'`,
        `if [ "$r" = alpha ]; then printf '%s\\n' '${assistantLine(headReply)}'; else printf '%s\\n' '${assistantLine("VERDICT: approve")}'; fi`,
      ].join("\n"),
    );
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 1, config });
    pipeline.merge = busySlot();
    try {
      await pumpUntil(ctx, pipeline, () => pipeline.vetted.has("beta"), "beta to be vetted");
      pipeline.merge = null;
      await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      // The head's own vet: pre-check, then its reviewer, with beta parked and showing nothing.
      // Then beta's vet runs with the head's record already off the gate's stages (vetted, or
      // gone with its rejection) — beta's transitions advance only beta's own record.
      const alphaAfter = headVerdict === "reject" ? "" : "alpha=vetted/merging,";
      const vets = [
        "check:alpha=landing/build-check",
        "alpha:alpha=landing/reviewing",
        `check:${alphaAfter}beta=landing/build-check`,
        `beta:${alphaAfter}beta=landing/reviewing`,
      ];
      if (headVerdict === "reject") {
        assert.deepEqual(seen, vets, "a one-change merge lands on its own: no stack check, no re-check on an unmoved main");
        assert.equal(loadLoopState(root, "alpha").lastResult, "rejected");
      } else {
        assert.deepEqual(
          seen,
          [...vets, "check:alpha=landing/build-check,beta=landing/build-check"],
          "the shared stack check runs under build-check on every stacked change",
        );
        assert.equal(loadLoopState(root, "alpha").lastResult, "changed");
      }
      assert.equal(loadLoopState(root, "beta").lastResult, "changed");
      assert.equal(readLandingMarker(root), null, "the marker is gone once the merge is done");
    } finally {
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  });
}

// ── A plumbing throw in the merge slot ────────────────────────────────────────────────────
// landVetted's first assembly attempt propagates an unexpected throw (nothing has landed), and
// startMerge's catch is what keeps the fleet alive: every entry stays queued, un-vetted, the
// head author's state records the error, and the next poll re-vets from the surviving pins.

test("a plumbing throw in the merge keeps every entry queued and un-vetted, records the error, and recovers on the next poll", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  // The sabotage target, repaired in the finally even when an assert throws first.
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 2, "both changes to be vetted");

    // Break the merge's plumbing: the registered-worktrees home becomes a plain file, so the
    // stack's worktree setup (the vet ran in a different pooled slot) fails hard in git —
    // not a verdict, a throw, out of landVetted's first attempt.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    fs.writeFileSync(worktreesHome, "not a directory");

    pipeline.merge = null; // the busy slot frees
    await drainLandings(ctx, pipeline);
    const merge = pipeline.merge as InFlightLanding | null;
    assert.ok(merge, "the merge started");
    await merge.promise; // resolves, never rejects — the drain caught the throw

    assert.equal(pipeline.merge, null, "the merge slot freed for the next attempt");
    assert.equal(queueDepth(root), 2, "every entry stays queued");
    assert.equal(pipeline.vetted.size, 0, "nothing stays vetted: each change is vetted afresh from its pin");
    assert.ok(loadLoopState(root, "alpha").lastError, "the head author's persisted state names the failure");
    assert.equal(readLandingMarker(root), null, "the merge's marker records were removed with its task");
    assert.equal(eventsOfType(root, "merged").length, 0, "nothing was reported landed");
    assert.equal(mainSha(root), mainBefore, "nothing landed");

    // Repair the plumbing and let the next poll re-vet from the surviving pins: the queue
    // still drains, which is the recovery the catch exists to preserve. Git may have
    // recreated the directory during the failed attempt, so remove whatever stands there.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain after the repair");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes landed after the retry");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, landingRefName(role)), null, `${role}'s ref was deleted once landed`);
    }
  } finally {
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a git failure inside the gate's reject path settles the vet as an error outcome, naming the failure in the author's state", async () => {
  const root = makeRepo();
  const role = "improve";
  const shas = await queueChanges(root, [role]);
  // A stale index.lock in the worktree's gitdir — the wreckage of a crashed concurrent git —
  // planted by the reviewer shim itself, so it exists by the time the gate's reject path
  // resets the worktree (after the verdict, before the pin delete). resetWorktreeToMain's
  // `git reset --hard` throws, the throw rides out of the gate and vetRequest, and the drain
  // must turn it into the terminal "error" outcome — never a rejected task promise, which
  // would leave the entry queued and its author interlocked forever.
  const shim = [
    leasedRoleShell(),
    `case "$role" in`,
    `"${role}") gd=$(sed 's/^gitdir: //' "$PWD/.git"); touch "$gd/index.lock"; ` +
      `printf '%s\\n' '${assistantLine("VERDICT: reject\\n1. no")}'; exit 0;;`,
    `esac`,
  ].join("\n");
  const restore = fakePi(shim);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role]), { cap: 1 });
  try {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the failed vet to settle", 30_000);
  } finally {
    restore();
  }
  await Promise.allSettled(allTasks(pipeline));

  const state = loadLoopState(root, role);
  assert.equal(state.lastResult, "error", "the outcome folded into the author's state as an error");
  assert.match(state.lastError ?? "", /index\.lock/, "the persisted state names the git failure that threw");
  const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === role);
  assert.equal(failed.length, 1, "one land_failed event, logged once by the settle");
  assert.equal(failed[0]!.result, "error");
  assert.equal(failed[0]!.commit, shas[role], "the event names the commit whose vet failed");
  assert.equal(
    await refSha(root, landingRefName(role)),
    shas[role],
    "the pin survives the error outcome (only a rejection deletes it) for the next re-land",
  );
});
