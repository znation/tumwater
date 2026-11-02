import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue, settleAbortedApproved } from "../src/merge/merge-drain.js";
import {
  abortableMerges,
  type InFlightMerge,
} from "../src/merge/merge-pipeline.js";
import { mergeStartHeld } from "../src/orchestrator/orchestrator-poll.js";
import { consumeAbortRequests } from "../src/operator/operator-requests.js";
import { queueDepth, queuedMergeFiles } from "../src/merge/merge-queue.js";
import { abortRequestPath, mergeQueueDir, mergeRefName, statePath } from "../src/paths.js";
import { deleteRef, refSha } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { readMergeMarker } from "../src/merge/merge-slot.js";
import { defaultConfig } from "../src/config/config.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { writeJsonFile } from "../src/files/json-files.js";
import {
  APPROVE,
  allTasks,
  busyMergePipeline,
  busySlot,
  drained,
  makePipeline,
  pump,
  pumpUntil,
  queueChanges,
  runnersFor,
} from "./fixtures/merge-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { waitFor } from "./helpers/wait.js";

/** Third slice of the merge-drain suite (see merge-pipeline.test.ts for the split): an abort
 * whose pin is already gone, a merge while an earlier entry still verifies, the reviewer hold,
 * the merge cell's stage, and the plumbing-throw recoveries. The review gate's pi runs are real
 * subprocesses behind the fake shim. */

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

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
        (e) => e.type === "warning" && String(e.message).includes("could not save the role's state"),
      ),
      "the failed state write is warned about, not swallowed",
    );
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});


// The reviewer-hold (part 3i/3): a hold on the reviewer's provider parks only the post-merge
// review drain — its no-role verdict — never a role start, verify or landing. The production
// pollMergeDrain start gate and these tests drive one exported predicate (mergeStartHeld), so
// the wiring cannot drift.

test("mergeStartHeld holds only the no-role drain under a reviewer hold", () => {
  assert.equal(mergeStartHeld(true, true, "feature"), true, "a restart/disk hold holds a role");
  assert.equal(mergeStartHeld(false, true, "feature"), false, "no role start is held by the reviewer");
  assert.equal(mergeStartHeld(false, true, "dedupe"), false, "every role drains while the reviewer is held — no exemption exists");
  assert.equal(mergeStartHeld(false, true, undefined), true, "the no-role verdict stays held (what drainPostReviews and mergeApprovedChange read)");
  assert.equal(mergeStartHeld(true, false, "dedupe"), true, "a restart/disk hold still holds every role");
});

test("approved entries merge while the reviewer's provider is held", async () => {
  const root = makeRepo();
  const roles = ["feature", "dedupe"];
  await queueChanges(root, roles);
  const config = defaultConfig();
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  try {
    // Open gate, merge slot held busy: both changes verify and sit approved without merging.
    pipeline.merge = busySlot();
    await pumpUntil(
      ctx,
      pipeline,
      () => pipeline.approved.has("feature") && pipeline.approved.has("dedupe"),
      "both changes to be approved",
    );
    assert.equal(queueDepth(root), 2, "no merge has run yet");

    // Free the slot and close the reviewer hold with the production predicate: no role's merge
    // is held by the reviewer, so both approved entries drain.
    pipeline.merge = null;
    ctx.startHeld = (role?: string) => mergeStartHeld(false, true, role);
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the approved entries to merge while the reviewer is held");
    assert.equal(queueDepth(root), 0, "the approved entries merged despite the reviewer hold");
    // Each change merges as its own commit (rebased onto main's tip), so the original pinned shas
    // are rewritten and are not main ancestors — assert main holds each change's content instead.
    assert.equal(sh(root, "git", "show", "main:feature.txt").trim(), "work by feature", "the approved feature change merged while the reviewer's provider was held");
    assert.equal(sh(root, "git", "show", "main:dedupe.txt").trim(), "work by dedupe", "the dedupe change merged too");
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a fresh entry verifies and merges while the reviewer's provider is held — no role is parked", async () => {
  const root = makeRepo();
  const roles = ["feature", "dedupe"];
  await queueChanges(root, roles);
  const config = defaultConfig();
  const held = (role?: string) => mergeStartHeld(false, true, role);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config, held });
  try {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "both fresh entries to verify and merge while the reviewer is held", 30_000);
    assert.equal(queueDepth(root), 0, "the reviewer hold parks no role — both entries drained");
    assert.equal(ctx.startHeld(), true, "the no-role startHeld (what drainPostReviews reads) is true under the reviewer hold");
    // Both fresh changes merge as their own commits (each rebased onto main's tip), so assert
    // main holds each change's content rather than the pinned shas (rewritten, not ancestors).
    assert.equal(sh(root, "git", "show", "main:feature.txt").trim(), "work by feature", "the fresh feature entry merged despite the reviewer hold");
    assert.equal(sh(root, "git", "show", "main:dedupe.txt").trim(), "work by dedupe", "the fresh dedupe entry merged too — every role drains while the reviewer is held");
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});



// ── A plumbing throw in the merge slot ────────────────────────────────────────────────────
// mergeApprovedChange's first merge attempt propagates an unexpected throw (nothing has merged),
// and startMerge's catch is what keeps the team alive: every entry stays queued, unapproved, the
// head author's state records the error, and the next poll re-verifies from the surviving pins.

test("a plumbing throw in the merge keeps every entry queued and unapproved, records the error, and recovers on the next poll", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  // The sabotage target, repaired in the finally even when an assert throws first.
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");

    // Break the merge's plumbing: the registered-worktrees home becomes a plain file, so the
    // the merge's worktree setup (the verification ran in a different pooled slot) fails hard in
    // git — not a verdict, a throw, out of mergeApprovedChange's first attempt.
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

    // Break the merge's plumbing so mergeApprovedChange throws, then break the head author's state
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

test("a throw settling an aborted merge still frees the merge slot", async () => {
  // The settle loops run inside the merge task's try whose finally is the only place the slot
  // is freed (p.merge = null) and shutdown is detached. The second loop settles every role a
  // user abort left unmerged — settleOne → settleMergeOutcome → dropMerge — and dropMerge
  // rethrows a non-ENOENT fs error (removeQueueFile). A throw there must not skip the finally,
  // or p.merge stays set forever and every later merge on the team is wedged behind it.
  const { root, restore, ctx, pipeline } = await busyMergePipeline();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");

    // Plant the settle path's fault, then flag the user abort, both synchronously before the
    // merge task's first await resumes: every queue file becomes a directory, so the second
    // loop's dropMerge (fs.rmSync without recursive) throws EISDIR the moment it settles an
    // unmerged role — the shape an ENOSPC or immutable queue file takes on disk.
    for (const { file } of queuedMergeFiles(root)) {
      fs.rmSync(file);
      fs.mkdirSync(file);
    }
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));

    const [settled] = await Promise.allSettled([merge.promise]);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.equal(pipeline.merge, null, "the merge slot freed despite the settle-path throw");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("merge task"),
      ),
      "the settle-path failure is warned about, not swallowed",
    );
  } finally {
    // Restore a usable queue directory so the settled tasks' cleanup does not fight the plant.
    const dir = mergeQueueDir(root);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});


test("an unwritable state file on a settling merge warns instead of rejecting the task promise", async () => {
  const root = makeRepo();
  const role = "improve";
  await queueChanges(root, [role]);
  const stateFile = statePath(root, role);
  fs.mkdirSync(stateFile, { recursive: true });
  fs.writeFileSync(path.join(stateFile, "keep"), "");
  // Break the author's state write: the state file becomes a non-empty directory, so
  // writeJsonAtomic's rename fails (EISDIR) — the shape an ENOSPC or an immutable state path
  // takes. The outcome write happens in the verification's fire-and-forget task, which nothing
  // awaits during normal operation, so a throw there must be warned about, never left as an
  // unhandled rejection that takes the orchestrator down.
  // The settle writes the change's outcome into the author's state; with the state file broken
  // that write must warn, not reject the task promise. (Since Subtract part 3b/7 the gate runs no
  // build check, so the change here clears the diff rules and settles as a merge — the outcome
  // kind is not what this case pins; the state-write warning is.)
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role]), { cap: 1 });
  const restore = fakePi(APPROVE());
  try {
    await drainMergeQueue(ctx, pipeline);
    const pending = allTasks(pipeline);
    assert.equal(pending.length, 1, "the rejected verification started");
    const [settled] = await Promise.allSettled(pending);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("could not save the role's state"),
      ),
      "the state-write failure is warned about, not swallowed",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});
