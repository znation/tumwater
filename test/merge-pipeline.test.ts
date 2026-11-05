import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue } from "../src/merge/merge-drain.js";
import {
  mergeTasks,
} from "../src/merge/merge-pipeline.js";
import { enqueueMerge, queuedMergeFiles } from "../src/merge/merge-queue.js";
import { mergeQueueDir, mergeRefName } from "../src/paths.js";
import { isMergedInto, refSha, setRef } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { mergeChanges, readMergeMarker } from "../src/merge/merge-slot.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import {
  APPROVE,
  allTasks,
  busyMergePipeline,
  busySlot,
  drained,
  entry,
  makePipeline,
  pinnedCommit,
  pump,
  pumpUntil,
  queueChanges,
  runnersFor,
} from "./fixtures/merge-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { declareCheck, checkRunNumber } from "./fixtures/merger-fixtures.js";
import { mainSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { waitFor, waitForFile, within } from "./helpers/wait.js";
import { assistantLine, leasedRoleShell } from "./fixtures/pi-events.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

/** Second slice of the merge-drain suite (merge-drain.test.ts carries the first) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process, and each file must fit the gate's
 * 30 s budget. This slice carries the pipeline's end-to-end behaviors — torn-head recovery, the
 * merge slot's one-at-a-time merges and the verify permits — and merge-pipeline-2.test.ts the rest:
 * an abort whose pin is already gone, the reviewer hold, the merge cell's stage, and the failure
 * recoveries. The dedupe basics live in merge-drain.test.ts. */
// Unit coverage for src/merge/merge-drain.ts — the scheduler seam between the durable merge
// queue and the merge pipeline (land-queue speed 2c): the dedupe against main and torn-head
// recovery, the verify stage (one verification per queued change, each on a shared maxConcurrent
// permit), and the merge slot (every approved change, one at a time), with the abort and shutdown
// rules and the marker records the observers read. The review gate's pi runs are real subprocesses
// behind the fake shim, exactly as merger.test.ts drives verifyRequest and mergeApprovedChange.

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
    // Part 3g/3: the merged change now queues a post-merge review whatever its role, and that
    // review task also wires itself to the long-lived shutdown signal. Wait for it to start and
    // settle so nothing is left wired before the detached-count assertion.
    await pumpUntil(ctx, pipeline, () => pipeline.postReview !== null, "the post-review to start");
    await pumpUntil(ctx, pipeline, () => pipeline.postReview === null, "the post-review to settle");
    assert.equal(
      getEventListeners(shutdown.signal, "abort").length,
      0,
      "the verification's, merge's and post-review's wiring detached as each task settled",
    );
  });
});

test("changes approved while the merge slot is busy merge one at a time: no shared check, one fast-forward each", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");
    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual(
      mergeTasks(pipeline).flatMap((t) => t.roles),
      ["alpha", "beta"],
      "one merge, whose record names every approved role, in queue order",
    );
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the changes to merge");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes merged on main");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, mergeRefName(role)), null, `${role}'s ref was deleted`);
    }
    assert.equal(readMergeMarker(root), null, "the marker was cleared");
    // A merge is a rebase and a fast-forward (parts 4l/3 and 4m/3): no shared scope-`batch`
    // stack check and no per-change in-lock re-check.
    assert.equal(eventsOfType(root, "build_check").filter((e) => e.scope === "batch" || e.scope === "merge").length, 0, "no shared batch check and no in-lock merge check");
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
  // The ordered verification is beta's GATE BUILD CHECK, not its reviewer run: with the pre-merge
  // reviewer still running, its verdict is irrelevant here, and the parked verification's real
  // subject — its place in the shared-permit order — is pinned by the build check that runs when
  // it gets the permit. The declared check runs from the repo root (the npm walk-up's package
  // root), so it cannot see a slot worktree's files; the shared check counter names the runs:
  // 1 alpha's verify gate, 2 alpha's re-review gate (after the resolver), 3 beta's verify gate,
  // 4 beta's in-lock re-check — so run 3 is beta's verification's build check.
  const checkCount = path.join(root, ".checkcount");
  declareCheck(root, `#!/bin/sh\n${checkRunNumber(checkCount)}if [ "$n" -eq 3 ]; then echo beta-check >> '${order}'; fi\necho ok\n`);
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in`,
      `tumwater-*-conflict) echo resolved > alpha.txt; echo resolver >> '${order}'; printf '%s\\n' '${assistantLine("resolved")}'; exit 0;;`,
      `*"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
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
    assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["resolver", "beta-check"], "the resolver ran before the parked build-check verification");
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

test("approved changes merge one at a time: the shared stack check and bisect are gone, every change lands", async () => {
  // PLANS.md 4m/3 through the pipeline: with the batch path deleted a merge is a rebase and a
  // fast-forward, one change at a time through mergeApprovedChange — no shared scope-`batch`
  // check and no largest-passing-prefix bisect. Even a change that breaks the suite only on top
  // of an earlier change's merge is no longer held back by a merge-time check (the watch owns
  // main's health); the interaction a stack check once caught simply lands.
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
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
      ["work by alpha", "work by beta", "work by gamma"],
      "every approved change lands, in queue order",
    );
    // No merge-time scope-`batch` or `merge` check runs: each change's own verification's gate
    // pre-check was the only build check it saw.
    assert.equal(
      readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate").length,
      0,
      "no shared batch check and no in-lock merge check ran at merge time",
    );
    for (const role of roles) assert.equal(await refSha(root, mergeRefName(role)), null, `${role}'s ref was deleted`);
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_done" || e.type === "merge_failed").map((e) => `${e.source}:${String(e.result)}`),
      ["alpha:changed", "beta:changed", "gamma:changed"],
      "each change landed",
    );
    assert.equal(readMergeMarker(root), null);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("one verification runs at a time: with three queued at cap 3 the second waits unstarted until the first settles, and a role run takes the free permit", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const flags = tmpdir("vet-serial-");
  // Part 3s/3: hold the head's verification through the deterministic gate, not the reviewer
  // (part 3h/3 stops it): the check blocks alpha on its release file. beta and gamma stay queued
  // — the drain starts one verification at a time — so the cap's second permit sits free for a
  // role run. The block keys off alpha's own change file, so the gate's attribution re-check on
  // main's tip (which holds none of them) neither blocks nor touches the pipeline. The merge
  // slot is held so an approved change waits, keeping it visible for the assertion.
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-blocking")}'; ` +
        `i=0; while [ ! -f '${path.join(flags, "alpha-release")}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 3, config });
  pipeline.merge = busySlot();
  const bg = pump(ctx, pipeline);
  let ran = false;
  try {
    await waitForFile(path.join(flags, "alpha-blocking"));
    // alpha's check is in flight, so alpha is verifying; the serial rule means the rest have not
    // started, regardless of how many polls have run.
    assert.deepEqual([...pipeline.verifying.keys()], ["alpha"], "exactly one verification exists");
    assert.equal(pipeline.verifying.has("beta"), false, "the second change has not started");
    assert.equal(pipeline.verifying.has("gamma"), false, "the third change has not started");
    assert.equal(queuedMergeFiles(root).length, 3, "all three are still queued");
    assert.ok(await within(ctx.semaphore.acquire(0), 5_000), "a role run takes the permit the serialization left free");
    ran = true;

    ctx.semaphore.release();
    ran = false;
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    // alpha settles to approved (held on the merge slot); the next drain starts beta.
    await waitFor(() => pipeline.approved.has("alpha"), "alpha to settle to approved", 30_000);
    await waitFor(() => pipeline.verifying.has("beta"), "beta to start once the first settles", 30_000);
    assert.deepEqual([...pipeline.verifying.keys()], ["beta"], "the next queued entry starts once the first settles");

    pipeline.merge = null; // free the merge slot
    await waitFor(drained(root, pipeline), "all three to merge", 60_000);
    assert.equal(queuedMergeFiles(root).length, 0, "the queue is empty");
  } finally {
    if (ran) ctx.semaphore.release();
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a verification rejection drops its entry at once — its role may run next poll — and the next queued entry starts on the next drain", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const flags = tmpdir("vet-reject-");
  // Part 3s/3: the rejection comes from the deterministic gate, not the reviewer (part 3h/3
  // stops it): alpha's declared check fails on its own tree and drops its entry, freeing alpha
  // for the next poll while beta — still queued behind the rejected head — starts on the next
  // drain and blocks its check on `beta-release`. The block keys off `beta.txt` (present only in
  // beta's verification worktree), so the gate's attribution re-check on main's tip — which holds
  // neither change's file — neither blocks nor touches `beta-checking`.
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checking")}'; ` +
        `i=0; while [ ! -f '${path.join(flags, "beta-release")}' ] && [ $i -lt 3000 ]; do sleep 0.1; i=$((i+1)); done; fi; ` +
        `if [ -f alpha.txt ]; then printf '%s\n' "planted failure: alpha is bad"; exit 1; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 2, config });
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => queuedMergeFiles(root).length === 1, "alpha's entry to drop at its verdict", 30_000);

    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's entry is gone: the scheduler's interlock no longer holds alpha",
    );
    assert.equal(loadRunnerState(root, "alpha").lastResult, "rejected", "the outcome is saved before the drop");
    assert.equal(readEvents(root).filter((e) => e.type === "merge_failed" && e.source === "alpha").length, 1);
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "a rejection deletes the pin");
    assert.equal(pipeline.verifying.has("alpha"), false, "no verification remains for the rejected entry");

    // The next queued entry starts on the next drain: one verification at a time.
    await waitForFile(path.join(flags, "beta-checking"));
    assert.deepEqual([...pipeline.verifying.keys()], ["beta"], "beta's verify started after alpha's drop");
    const marker = readMergeMarker(root);
    assert.deepEqual(
      marker?.changes?.map((c) => [c.role, c.status, c.stage]),
      [["beta", "merging", "build-check"]],
      "the marker holds only the change in flight, at its own stage",
    );
    assert.equal(marker?.role, "beta", "the top level follows the change in flight, for older observers");
    assert.equal(marker?.stage, "build-check", "at its own stage");

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
