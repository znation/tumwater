import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue, settleAbortedApproved } from "../src/merge/merge-drain.js";
import {
  abortableMerges,
  mergeTasks,
  type InFlightMerge,
} from "../src/merge/merge-pipeline.js";
import { verifyLimit } from "../src/merge/merge-verify.js";
import { consumeAbortRequests } from "../src/operator/operator-requests.js";
import { enqueueMerge, queueDepth, queuedMergeFiles } from "../src/merge/merge-queue.js";
import { abortRequestPath, mergeQueueDir, mergeRefName, mergeStatePath, statePath } from "../src/paths.js";
import { deleteRef, isMergedInto, refSha, setRef } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { mergeChanges, readMergeMarker } from "../src/merge/merge-slot.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
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
} from "./fixtures/merge-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { sleep, waitFor, waitForFile, within } from "./helpers/wait.js";
import { assistantLine, leasedRoleShell } from "./fixtures/pi-events.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

/** Second slice of the merge-drain suite (merge-drain.test.ts carries the first) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process. The slices are balanced by measured
 * per-test duration (~18.5s vs ~18.1s at 2026-09-29); keep them roughly equal when moving tests
 * between the files. This slice carries the pipeline's end-to-end behaviors — torn-head
 * recovery, the merge stack, abort and shutdown, and the failure recoveries — while the dedupe
 * basics live in merge-drain.test.ts. */
// Unit coverage for src/merge/merge-drain.ts — the scheduler seam between the durable merge
// queue and the merge pipeline (land-queue speed 2c): the dedupe against main and torn-head
// recovery, the verify stage (one verification per queued change, each on a shared maxConcurrent
// permit), and the merge slot (every approved change, stacked), with the abort and shutdown rules
// and the marker records the observers read. The review gate's pi runs are real subprocesses behind
// the fake shim, exactly as merger.test.ts drives verifyRequest and mergeApproved directly.

/** The fixture the three busy-merge-slot tests below share: an alpha+beta queue on a real
 * repo, a merge config whose check is a no-op, the fake approver, and a pipeline whose merge
 * slot is held busy so both verifications stack up before any merge. `restore` must run in the
 * caller's finally, after its tasks settle. */
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

test("a torn head is dropped with a warning and the healthy entry behind it merges", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, mergeRefName("improve"), sha);
  // A hard crash mid enqueueMerge write: a file that sorts FIRST but parses to no entry.
  fs.mkdirSync(mergeQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(mergeQueueDir(root), "1-000000-0.json"), '{"role":"improve"');
  enqueueMerge(root, entry("improve", sha));
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual([...pipeline.verifying.keys()], ["improve"], "the healthy entry behind the torn head is being verified");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the healthy entry to merge");

    const torn = path.join(mergeQueueDir(root), "1-000000-0.json");
    assert.equal(fs.existsSync(torn), false, "the torn head was dropped");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes('merge queue head 1-000000-0.json is unreadable'),
      ),
      "the drop carried one warning event",
    );
    assert.ok(await isMergedInto(root, sha, "main"), "the healthy entry merged");
  });
});

test("a single queued pinned entry merges through the pipeline: main advances, ref and entry and marker clear", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, mergeRefName("improve"), sha);
  enqueueMerge(root, entry("improve", sha));
  const mainBefore = mainSha(root);
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the entry to merge");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "the change merged on main");
    assert.ok(await isMergedInto(root, sha, "main"), "the pinned commit is contained in main");
    assert.equal(await refSha(root, mergeRefName("improve")), null, "the ff deleted the merge ref");
    assert.equal(readMergeMarker(root), null, "the in-flight marker was cleared");
    const mergeDone = eventsOfType(root, "merge_done");
    assert.equal(mergeDone.length, 1, "one merge_done event for the queue's bookkeeping");
    assert.equal(mergeDone[0]!.source, "improve");
    assert.equal(mergeDone[0]!.result, "changed");
    assert.equal(loadRunnerState(root, "improve").lastResult, "changed", "the outcome folded into the author's state");
  });
});

test("a settled merge detaches its shutdown listener: the long-lived stop signal keeps no per-merge wiring", async () => {
  // The team shutdown signal is one object for the whole run and abortOnShutdown wires every
  // verify and merge to it. A task that settles while the signal is still live must detach its
  // listener; otherwise the signal accumulates one per merge — and the controller each
  // retains — unbounded until shutdown. The runners carry no signal here, so every abort
  // listener on the shutdown signal is a merge task's.
  const root = makeRepo();
  await queueChanges(root, ["alpha"]);
  await withPi(APPROVE(), async () => {
    const shutdown = new AbortController();
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"]), { signal: shutdown.signal });
    assert.equal(getEventListeners(shutdown.signal, "abort").length, 0, "nothing is wired before a merge starts");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the entry to merge");
    assert.equal(
      getEventListeners(shutdown.signal, "abort").length,
      0,
      "the verification's and merge's wiring detached as each task settled",
    );
  });
});

test("changes approved while the merge slot is busy merge as one stack: one shared check, one fast-forward", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");
    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual(
      mergeTasks(pipeline).flatMap((t) => t.roles),
      ["alpha", "beta"],
      "one merge, whose record names every stacked role, in queue order",
    );
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the stack to merge");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes merged on main");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, mergeRefName(role)), null, `${role}'s ref was deleted`);
    }
    assert.equal(readMergeMarker(root), null, "the marker was cleared");
    const checks = eventsOfType(root, "build_check");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 1, "ONE shared check over the stacked tree");
    assert.equal(checks.filter((e) => e.scope === "merge").length, 0, "and no per-change in-lock re-check");
    assert.deepEqual(
      eventsOfType(root, "merged").map((e) => e.source),
      ["alpha", "beta"],
      "one merged event per change, in queue order",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("an approved change whose queue entry is gone is forgotten while its neighbor still merges", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");
    // beta's queue entry vanishes while beta sits approved — the only way an entry leaves the
    // queue between its verification settling and the next merge: a hand outside the pipeline on
    // the queue dir. drainMerge must forget beta without writing it an outcome or a merge.
    fs.rmSync(queuedMergeFiles(root).find((q) => q.entry.role === "beta")!.file);
    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual(mergeTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "only alpha is picked for the merge");
    assert.deepEqual([...pipeline.approved.keys()], [], "beta left the approved map");
    assert.deepEqual(
      mergeChanges(readMergeMarker(root)!).map((c) => c.role),
      ["alpha"],
      "beta's marker record dropped with its entry",
    );
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "alpha to merge");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "only alpha reached main");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "alpha's work is on main");
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "alpha's pin was deleted after merge");
    assert.ok(await refSha(root, mergeRefName("beta")), "beta's pin survives: its approved work is still real");
    assert.deepEqual(
      readEvents(root).filter(
        (e) => e.source === "beta" && (e.type === "merged" || e.type === "merge_done" || e.type === "merge_failed"),
      ),
      [],
      "beta left no outcome — forgotten, not failed",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("the merge's conflict resolver takes a shared permit, ahead of a verification parked for one", async () => {
  // Merges count as active work: the one model run a merge makes, mergeToMain's conflict
  // resolver, holds a shared maxConcurrent permit for its length — outside the merge lock, so a
  // run waiting on that lock can never be what the resolver waits for — at MERGE_TIER, ahead
  // of any verification parked for a permit, since every queued change waits on the merge.
  const root = makeRepo();
  const alpha = pinnedCommit(root, "alpha");
  const beta = pinnedCommit(root, "beta");
  // main rewrites alpha's file after the pin: alpha's rebase conflicts, at its verification (which
  // then reviews the bare pin) and again at its merge, which needs the resolver.
  fs.writeFileSync(path.join(root, "alpha.txt"), "main's alpha\n");
  sh(root, "git", "add", "alpha.txt");
  sh(root, "git", "commit", "-m", "main edits alpha.txt");
  await setRef(root, mergeRefName("alpha"), alpha);
  await setRef(root, mergeRefName("beta"), beta);
  enqueueMerge(root, entry("alpha", alpha));
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
    await pumpUntil(ctx, pipeline, () => pipeline.approved.has("alpha"), "alpha to be approved");
    // A role run takes the only permit, and beta's change queues behind it: its verification
    // parks.
    await ctx.semaphore.acquire(0);
    held = true;
    enqueueMerge(root, entry("beta", beta));
    await drainMergeQueue(ctx, pipeline);
    assert.equal(pipeline.verifying.get("beta")?.parked, true, "beta's verify parks for the permit");
    pipeline.merge = null;
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual(mergeTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "alpha's merge is running");
    // The merge reaches its resolver, which parks for the permit beside beta's verify — or,
    // without one, runs at once and leaves its mark.
    await waitFor(() => ctx.semaphore.waiting === 2 || fs.existsSync(order), "alpha's resolver to reach the permit");
    assert.equal(fs.existsSync(order), false, "the resolver waits for a permit like any pi run");
    // The merge cell names the parked resolver's wait — not "merging" (2026-10-12: a resolver
    // parked 2.5 min with the merge queue behind it read as a slow fast-forward).
    assert.equal(
      mergeChanges(readMergeMarker(root)!).find((c) => c.role === "alpha")?.stage,
      "resolve-wait",
      "the parked resolver's stage",
    );

    ctx.semaphore.release(); // the run ends: the merge's resolver is first in line
    held = false;
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "both to merge");
    assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["resolver", "beta-review"], "the resolver ran before the parked verification");
    assert.equal(sh(root, "git", "show", "main:alpha.txt"), "resolved", "the resolution merged");
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
  } finally {
    if (held) ctx.semaphore.release();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a change settled early in a batch writes back before a slower batch-mate's resolver returns", async () => {
  // BUGS.md 2026-10-09: a change whose merge is already final must not keep its stale error
  // streak (and with it the dashboard's red "failing run after run" banner) until every
  // later change in the batch settles — including a conflict-resolution model run that can
  // take its whole timeout. alpha merges cleanly while beta's resolver blocks; alpha's streak
  // reset and `merged` event must already be on disk before the resolver returns.
  const root = makeRepo();
  await queueChanges(root, ["alpha", "beta"]);
  // main edits beta's file after both pins: beta's verify rebases to a conflict (and reviews the
  // bare pin), and its merge needs the resolver. alpha is untouched and merges cleanly.
  fs.writeFileSync(path.join(root, "beta.txt"), "main's beta\n");
  sh(root, "git", "add", "beta.txt");
  sh(root, "git", "commit", "-m", "main edits beta.txt");
  // alpha enters its merge with the stale streak the bug report saw.
  const alphaState = freshRunnerState("alpha");
  alphaState.consecutiveErrors = 6;
  alphaState.lastResult = "review_error";
  saveRunnerState(root, alphaState);

  const flags = tmpdir("batch-settle-");
  const started = path.join(flags, "resolver-started");
  const release = path.join(flags, "resolver-release");
  const restore = fakePi(
    [
      leasedRoleShell(),
      `for a in "$@"; do case "$a" in`,
      `tumwater-*-conflict) echo resolved > beta.txt; touch '${started}'; i=0; while [ ! -f '${release}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; printf '%s\\n' '${assistantLine("resolved")}'; exit 0;;`,
      `*"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
    ].join("\n"),
  );
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]));
  pipeline.merge = busySlot();
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => pipeline.approved.size === 2, "both changes to be approved", 60_000);
    pipeline.merge = null;
    await waitForFile(started, 60_000);
    // The running resolver names itself in beta's merge cell: its minutes are the resolver's,
    // not the merge's git steps (2026-10-12).
    assert.equal(
      mergeChanges(readMergeMarker(root)!).find((c) => c.role === "beta")?.stage,
      "resolving",
      "the running resolver's stage",
    );

    assert.equal(
      loadRunnerState(root, "alpha").consecutiveErrors,
      0,
      "alpha's merged change reset its streak before beta's resolver returned",
    );
    assert.ok(
      readEvents(root).some((e) => e.type === "merge_done" && e.source === "alpha"),
      "alpha's merge_done event was written before beta's resolver returned",
    );

    fs.writeFileSync(release, "");
    await waitFor(drained(root, pipeline), "both changes to merge", 60_000);
    assert.ok(
      readEvents(root).some((e) => e.type === "merge_done" && e.source === "beta"),
      "beta merged once its resolver was released",
    );
  } finally {
    fs.writeFileSync(release, "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a red stack merges its passing prefix, rejects the change red alone, and merges the one behind it next", async () => {
  // PLANS.md land-queue 3d through the pipeline: beta breaks the suite only on top of alpha (its
  // own verification passed — an interaction the stack check exists to catch). The bisect merges
  // alpha on its own green check, attributes beta's red through main's baseline (a cache hit:
  // alpha's prefix seeded it) and rejects it with no pi run, and leaves gamma unattempted — back to
  // approved, so the next merge merges it, re-checked on the main alpha moved.
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
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 3, "all three to be approved");
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
        ["merge", "passed"],
      ],
      "the whole stack, alpha's prefix, beta alone on top of it, then gamma's in-lock re-check",
    );
    const beta = loadRunnerState(root, "beta");
    assert.equal(beta.lastResult, "rejected");
    assert.match(beta.lastReview!.reasons[0]!, /: planted failure: beta breaks the suite$/);
    assert.deepEqual(eventsOfType(root, "review_rejected").map((e) => e.source), ["beta"]);
    assert.equal(eventsOfType(root, "review_start").length, 3, "one review per change, all in the verifications");
    assert.equal(await refSha(root, mergeRefName("beta")), null, "the rejection deleted beta's pin");
    assert.equal(await isMergedInto(root, shas.beta!, "main"), false);
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_done" || e.type === "merge_failed").map((e) => `${e.source}:${String(e.result)}`),
      ["alpha:changed", "beta:rejected", "gamma:changed"],
      "each outcome written once, gamma's only after its own merge",
    );
    assert.equal(readMergeMarker(root), null);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("verifications leave one permit for authoring: at cap 3 two review, the third waits unstarted, and a role run gets the last permit", async () => {
  assert.deepEqual([1, 2, 3, 6].map(verifyLimit), [1, 1, 2, 5], "maxConcurrent − 1, never below one");
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-reserve-");
  const restore = fakePi(reviewers(flags, roles, {}, roles));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 3 });
  const bg = pump(ctx, pipeline);
  let ran = false;
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitForFile(path.join(flags, "beta-reviewing"));
    await sleep(500); // a few more polls: nothing more may start
    assert.deepEqual([...pipeline.verifying.keys()], ["alpha", "beta"], "only verifyLimit(3) verifications exist");
    assert.equal(rowOf("gamma"), "due", "the third change waits in the queue, not parked on a permit");
    assert.ok(await within(ctx.semaphore.acquire(0), 5_000), "a role run takes the permit the verifications left free");
    ran = true;

    ctx.semaphore.release();
    ran = false;
    for (const role of roles) fs.writeFileSync(path.join(flags, `${role}-release`), "");
    await waitFor(drained(root, pipeline), "all three to merge", 60_000);
  } finally {
    if (ran) ctx.semaphore.release();
    for (const role of roles) fs.writeFileSync(path.join(flags, `${role}-release`), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a verification rejection drops its entry at once — its role may run next poll — while the other verify runs on", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const flags = tmpdir("vet-reject-");
  const restore = fakePi(reviewers(flags, roles, { alpha: "VERDICT: reject\n1. no" }, ["beta"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 2 });
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => queuedMergeFiles(root).length === 1, "alpha's entry to drop at its verdict", 30_000);

    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's entry is gone: the scheduler's interlock no longer holds alpha",
    );
    assert.equal(loadRunnerState(root, "alpha").lastResult, "rejected", "the outcome is saved before the drop");
    assert.equal(readEvents(root).filter((e) => e.type === "merge_failed" && e.source === "alpha").length, 1);
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "a rejection deletes the pin");
    assert.deepEqual([...pipeline.verifying.keys()], ["beta"], "beta's verify is still running");
    const marker = readMergeMarker(root);
    assert.deepEqual(
      marker?.changes?.map((c) => [c.role, c.status, c.stage]),
      [["beta", "merging", "reviewing"]],
      "the marker holds only the change still in flight, at its own stage",
    );
    assert.equal(marker?.role, "beta", "the top level follows the change still in flight, for older observers");
    assert.equal(marker?.stage, "reviewing", "at its own stage");

    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await waitFor(drained(root, pipeline), "beta to merge", 30_000);
    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta merged");
  } finally {
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a merge whose role has no live runner verifies and merges through a throwaway author", async () => {
  // resolveAuthor's fallback: a role disabled before this process started (or removed from
  // the team after its change was queued) has no runner in ctx.runners, so the drain builds
  // a throwaway one with the same merge wiring and a disk-loaded state — the queue must
  // still drain, or the orphaned entry wedges the interlock and the slot forever.
  const root = makeRepo();
  await queueChanges(root, ["alpha"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, []); // no live runners at all
  const bg = pump(ctx, pipeline);
  try {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the orphaned change to verify and land");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "the change merged on main");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_done" && e.source === "alpha").map((e) => e.result),
      ["changed"],
      "the outcome was written and reported for the runner-less role",
    );
    const state = loadRunnerState(root, "alpha");
    assert.equal(state.lastError, undefined, "the throwaway author ran clean");
    assert.equal(state.lastResult, "changed", "the disk-loaded state was folded and saved back");
    assert.equal(state.commits, 1, "the merged change counted on the throwaway author's counters");
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

// ── An abort whose pin is already gone ──────────────────────────────────────────────────
// discardPinnedRefs's documented edge: a pin that is already gone is not an error. The ref
// can vanish between the operator's abort and the settle — the gate itself deletes a pin at
// its rejection verdict (merge-core.ts), and an outside cleanup can drop tumwater refs — so the
// settle that discards an aborted approved change must tolerate a missing ref end to end:
// deleteRef's gitTry swallows the absent-ref failure, and the drain's own catch stands
// behind it for any other plumbing failure. No test pinned the settle against a vanished
// pin before this one.

test("abort --role settles an approved change whose pin is already gone without throwing", async () => {
  const root = makeRepo();
  const shas = await queueChanges(root, ["alpha", "beta"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]));
  pipeline.merge = busySlot(); // both changes verify and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => pipeline.approved.has("alpha") && pipeline.approved.has("beta"), "both changes to be approved", 30_000);

    // The pin vanishes before the abort lands: the race the catch exists for.
    await deleteRef(root, mergeRefName("alpha"));
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));
    await settleAbortedApproved(root, pipeline); // must resolve: the missing ref is not an error

    assert.ok(!pipeline.approved.has("alpha"), "the aborted entry left the pipeline");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_failed" && e.source === "alpha").map((e) => e.result),
      ["aborted"],
      "the outcome was still written and reported",
    );
    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's queue entry dropped with its outcome; beta still waits, approved",
    );
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta, "beta's pin was untouched");
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("an aborted approved change settles despite an unwritable state file: no throw, entry dropped, pin discarded", async () => {
  const root = makeRepo();
  const shas = await queueChanges(root, ["alpha", "beta"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]));
  pipeline.merge = busySlot(); // both changes verify and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => pipeline.approved.has("alpha") && pipeline.approved.has("beta"), "both changes to be approved", 30_000);

    // The abort's outcome write hits an unwritable state file: the state path becomes a
    // non-empty directory, so writeJsonAtomic's rename fails (EISDIR) — the shape an ENOSPC or
    // an immutable state path takes. settleAbortedApproved runs in the poll body with nothing to
    // guard it, so a throw here would end the team, and the operator's abort must still drop
    // the change and its pin rather than leave it to be re-verified and merged next poll.
    const stateFile = statePath(root, "alpha");
    fs.rmSync(stateFile, { recursive: true, force: true });
    fs.mkdirSync(stateFile, { recursive: true });
    fs.writeFileSync(path.join(stateFile, "keep"), "");

    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));
    await settleAbortedApproved(root, pipeline); // must resolve, not reject out of the poll

    assert.ok(!pipeline.approved.has("alpha"), "the aborted entry left the pipeline");
    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's queue entry dropped with its abort; beta still waits, approved",
    );
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "alpha's pin was discarded");
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta, "beta's pin was untouched");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes('the stopped merge for alpha could not be settled'),
      ),
      "the failed state write is warned about, not swallowed",
    );
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("an approved change merges while an earlier queue entry is still in review", async () => {
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
    await waitFor(() => readEvents(root).some((e) => e.type === "merge_done" && e.source === "beta"), "beta to merge", 30_000);

    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta merged ahead of the queue head");
    assert.equal(await isMergedInto(root, shas.alpha!, "main"), false);
    assert.deepEqual([...pipeline.verifying.keys()], ["alpha"], "the head is still in review");
    assert.match(rowOf("alpha"), REVIEWING, "the head's row shows its own verification");
    assert.equal(rowOf("beta"), "due", "beta's row is back to its own state");

    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await waitFor(drained(root, pipeline), "alpha to merge", 30_000);
    assert.deepEqual(
      eventsOfType(root, "merged").map((e) => e.source),
      ["beta", "alpha"],
      "each merged as soon as it was approved",
    );
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a shutdown reaches every verification and keeps their pins; an approved change waits out a busy merge slot", async () => {
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
    await waitFor(() => pipeline.approved.has("gamma"), "gamma to be approved", 30_000);
    assert.equal(rowOf("gamma"), "approved, waiting to merge");

    await bg.stop();
    shutdown.abort();
    await Promise.allSettled([...pipeline.verifying.values()].map((t) => t.promise));

    for (const role of ["alpha", "beta"]) {
      const failed = readEvents(root).filter((e) => e.type === "merge_failed" && e.source === role);
      assert.deepEqual(failed.map((e) => e.result), ["aborted"], `${role}'s verify ended aborted`);
      assert.equal(await refSha(root, mergeRefName(role)), shas[role], `${role}'s pin survives the shutdown`);
    }
    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["gamma"],
      "the approved change stays queued for the next start",
    );
    assert.ok(await refSha(root, mergeRefName("gamma")), "with its pin");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    shutdown.abort();
    await Promise.allSettled([...pipeline.verifying.values()].map((t) => t.promise));
    restore();
  }
});

test("abort --role stops that role's verify, or discards its approved change, pin and all, while another verification runs on", async () => {
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
    await waitFor(() => pipeline.approved.has("gamma"), "gamma to be approved", 30_000);

    const alphaVerify = pipeline.verifying.get("alpha")?.promise;
    for (const role of ["alpha", "gamma"]) writeJsonFile(abortRequestPath(root, role), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));
    await settleAbortedApproved(root, pipeline); // the scheduler settles right after, every poll
    // The aborted verify drops its entry before it discards its pin and leaves the pipeline, so
    // wait for the task itself: its outcome, pin discard and exit are all done once it settles.
    await alphaVerify;
    await waitFor(() => queuedMergeFiles(root).length === 1, "both aborted entries to drop", 30_000);

    for (const role of ["alpha", "gamma"]) {
      const failed = readEvents(root).filter((e) => e.type === "merge_failed" && e.source === role);
      assert.deepEqual(failed.map((e) => e.result), ["aborted"], `${role} ended aborted`);
      assert.equal(await refSha(root, mergeRefName(role)), null, `${role}'s pin was discarded`);
    }
    assert.deepEqual([...pipeline.verifying.keys()], ["beta"], "beta's verify runs on");

    pipeline.merge = null; // the busy slot frees
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await waitFor(drained(root, pipeline), "beta to merge", 30_000);
    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta merged");
    assert.equal(await isMergedInto(root, shas.gamma!, "main"), false, "the discarded change never merged");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

// The merge cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23) through the pipeline: each
// change's own record carries its stage, so a change's stage must leave `reviewing` the moment
// its gate returns — otherwise its finished reviewer's last turns sit in the cell, accruing a
// false `no pi output` flag, for as long as it waits for its merge — and one change's verify must
// advance only its own record. The stage sequence below is a single timeline: one permit, so the
// second verify parks (no record) until the first frees it, and a busy merge slot until both are
// done verifying.
for (const headVerdict of ["reject", "approve"] as const) {
  test(`a head ${headVerdict === "reject" ? "rejected" : "approved"} in its verification leaves reviewing when its gate returns; the stack check names itself`, async () => {
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
    const stagesOf = `'${process.execPath}' '${script}' '${mergeStatePath(root)}'`;
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
      await pumpUntil(ctx, pipeline, () => pipeline.approved.has("beta"), "beta to be approved");
      pipeline.merge = null;
      await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      // The head's own verification: pre-check, then its reviewer, with beta parked and showing
      // nothing. Then beta's verify runs with the head's record already off the gate's stages
      // (approved, or gone with its rejection) — beta's transitions advance only beta's own record.
      const alphaAfter = headVerdict === "reject" ? "" : "alpha=approved/merging,";
      const verifies = [
        "check:alpha=merging/build-check",
        "alpha:alpha=merging/reviewing",
        `check:${alphaAfter}beta=merging/build-check`,
        `beta:${alphaAfter}beta=merging/reviewing`,
      ];
      if (headVerdict === "reject") {
        assert.deepEqual(seen, verifies, "a one-change merge goes through on its own: no stack check, no re-check on an unmoved main");
        assert.equal(loadRunnerState(root, "alpha").lastResult, "rejected");
      } else {
        assert.deepEqual(
          seen,
          [...verifies, "check:alpha=merging/build-check,beta=merging/build-check"],
          "the shared stack check runs under build-check on every stacked change",
        );
        assert.equal(loadRunnerState(root, "alpha").lastResult, "changed");
      }
      assert.equal(loadRunnerState(root, "beta").lastResult, "changed");
      assert.equal(readMergeMarker(root), null, "the marker is gone once the merge is done");
    } finally {
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  });
}

// ── A plumbing throw in the merge slot ────────────────────────────────────────────────────
// mergeApproved's first assembly attempt propagates an unexpected throw (nothing has merged), and
// startMerge's catch is what keeps the team alive: every entry stays queued, unapproved, the
// head author's state records the error, and the next poll re-verifies from the surviving pins.

test("a plumbing throw in the merge keeps every entry queued and unapproved, records the error, and recovers on the next poll", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  // The sabotage target, repaired in the finally even when an assert throws first.
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");

    // Break the merge's plumbing: the registered-worktrees home becomes a plain file, so the
    // stack's worktree setup (the verification ran in a different pooled slot) fails hard in git —
    // not a verdict, a throw, out of mergeApproved's first attempt.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    fs.writeFileSync(worktreesHome, "not a directory");

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");
    await merge.promise; // resolves, never rejects — the drain caught the throw

    assert.equal(pipeline.merge, null, "the merge slot freed for the next attempt");
    assert.equal(queueDepth(root), 2, "every entry stays queued");
    assert.equal(pipeline.approved.size, 0, "nothing stays approved: each change is verified afresh from its pin");
    assert.ok(loadRunnerState(root, "alpha").lastError, "the head author's persisted state names the failure");
    assert.equal(readMergeMarker(root), null, "the merge's marker records were removed with its task");
    assert.equal(eventsOfType(root, "merged").length, 0, "nothing was reported merged");
    assert.equal(mainSha(root), mainBefore, "nothing merged");

    // Repair the plumbing and let the next poll re-verify from the surviving pins: the queue
    // still drains, which is the recovery the catch exists to preserve. Git may have
    // recreated the directory during the failed attempt, so remove whatever stands there.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain after the repair");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes merged after the retry");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, mergeRefName(role)), null, `${role}'s ref was deleted once merged`);
    }
  } finally {
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a failing state write in the merge's error path still frees the merge slot and warns", async () => {
  const { root, restore, ctx, pipeline } = await busyMergePipeline();
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");

    // Break the merge's plumbing so mergeApproved throws, then break the head author's state
    // file so the catch's saveRunnerState throws too — the exact unwritable-state failure the
    // guard exists for. The catch must not let that second throw skip the settle loop and the
    // finally, or p.merge stays set forever and every later merge is wedged.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    fs.writeFileSync(worktreesHome, "not a directory");
    const stateFile = statePath(root, "alpha");
    fs.rmSync(stateFile, { recursive: true, force: true });
    fs.mkdirSync(stateFile, { recursive: true });
    fs.writeFileSync(path.join(stateFile, "keep"), "");

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");
    const [settled] = await Promise.allSettled([merge.promise]);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.equal(pipeline.merge, null, "the merge slot freed despite the failed state write");
    assert.equal(queueDepth(root), 2, "every entry stays queued and unapproved");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes('the merge error for alpha could not be saved'),
      ),
      "the failed state write is warned about, not swallowed",
    );
  } finally {
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a git failure inside the gate's reject path settles the verification as an error outcome, naming the failure in the author's state", async () => {
  const root = makeRepo();
  const role = "improve";
  const shas = await queueChanges(root, [role]);
  // A stale index.lock in the worktree's gitdir — the wreckage of a crashed concurrent git —
  // planted by the reviewer shim itself, so it exists by the time the gate's reject path
  // resets the worktree (after the verdict, before the pin delete). resetWorktreeToMain's
  // `git reset --hard` throws, the throw rides out of the gate and verifyRequest, and the drain
  // must turn it into the terminal "error" outcome — never a rejected task promise, which
  // would leave the entry queued and its author interlocked forever.
  const shim = [
    leasedRoleShell(),
    `case "$role" in`,
    `"${role}") gd=$(sed 's/^gitdir: //' "$PWD/.git"); touch "$gd/index.lock"; ` +
      `printf '%s\\n' '${assistantLine("VERDICT: reject\\n1. no")}'; exit 0;;`,
    `esac`,
  ].join("\n");
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role]), { cap: 1 });
  await withPi(shim, async () => {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the failed verification to settle", 30_000);
  });
  await Promise.allSettled(allTasks(pipeline));

  const state = loadRunnerState(root, role);
  assert.equal(state.lastResult, "error", "the outcome folded into the author's state as an error");
  assert.match(state.lastError ?? "", /index\.lock/, "the persisted state names the git failure that threw");
  const failed = readEvents(root).filter((e) => e.type === "merge_failed" && e.source === role);
  assert.equal(failed.length, 1, "one merge_failed event, logged once by the settle");
  assert.equal(failed[0]!.result, "error");
  assert.equal(failed[0]!.commit, shas[role], "the event names the commit whose verification failed");
  assert.equal(
    await refSha(root, mergeRefName(role)),
    shas[role],
    "the pin survives the error outcome (only a rejection deletes it) for the next re-merge",
  );
});

test("an unwritable state file on a settling merge warns instead of rejecting the task promise", async () => {
  const root = makeRepo();
  const role = "improve";
  await queueChanges(root, [role]);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role]), { cap: 1 });
  // Break the author's state write: the state file becomes a non-empty directory, so
  // writeJsonAtomic's rename fails (EISDIR) — the shape an ENOSPC or an immutable state path
  // takes. The outcome write happens in the verification's fire-and-forget task, which nothing
  // awaits during normal operation, so a throw there must be warned about, never left as an
  // unhandled rejection that takes the orchestrator down.
  const stateFile = statePath(root, role);
  fs.mkdirSync(stateFile, { recursive: true });
  fs.writeFileSync(path.join(stateFile, "keep"), "");
  const flags = tmpdir("landing-state-fault-");
  const restore = fakePi(reviewers(flags, [role], { [role]: "VERDICT: reject\n1. no" }));
  try {
    await drainMergeQueue(ctx, pipeline);
    const pending = allTasks(pipeline);
    assert.equal(pending.length, 1, "the rejected verification started");
    const [settled] = await Promise.allSettled(pending);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes('merge task for improve'),
      ),
      "the state-write failure is warned about, not swallowed",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});
