import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { drainPostReviews } from "../src/merge/merge-post-review-drain.js";
import { mergeTasks, newMergePipeline, type MergePipelineContext } from "../src/merge/merge-pipeline.js";
import { addPostReview, readPostReviews, settlePostReview } from "../src/review/post-merge-review.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { headSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { sleep } from "./helpers/wait.js";

// The post-merge review waits for a team permit the way a pre-merge verification does: parked
// at VERIFY_TIER, ahead of every queued role run. On 2026-11-03 the poll only peeked for a free
// permit and never queued, so with ~30 roles parked on 8 permits every freed permit went
// straight to a role run: 2 reviews ran against 81 merges and 68 commits sat unreviewed.

function fakeRunner(role: string, verdict: string): RoleRunner {
  return {
    role,
    baseRole: role,
    state: freshRunnerState(role),
    runGatePi: async () => ({ ok: true, verdictText: verdict }),
  } as unknown as RoleRunner;
}

/** One merged commit queued for its post-merge review, with a team of `permits` permits all
 * held by role runs (their releases returned) and `held` deciding the start gate. */
async function saturated(permits: number, held: () => boolean = () => false) {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "x.txt"), "x");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "add x");
  const commit = headSha(root);
  const semaphore = new Semaphore(permits);
  const roleRuns = [];
  for (let i = 0; i < permits; i++) roleRuns.push(await semaphore.acquireLease(0));
  const shutdown = new AbortController();
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners: [fakeRunner("improve", "VERDICT: approve\n1. fine")],
    semaphore,
    signal: shutdown.signal,
    startHeld: held,
  } as unknown as MergePipelineContext;
  addPostReview(root, { commit, role: "improve", summary: "add x" });
  return { root, commit, semaphore, roleRuns, shutdown, ctx };
}

test("a post-merge review parks for a busy team's next permit ahead of a queued role run", async () => {
  const { root, semaphore, roleRuns, ctx } = await saturated(2);
  let roleGranted = false;
  const queuedRole = semaphore.acquireLease(0).then((lease) => {
    roleGranted = true;
    return lease;
  });
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await sleep(10);
  assert.ok(p.postReview, "the review stays in flight, parked, while every permit is busy");
  assert.equal(p.postReview.parked, true);
  assert.deepEqual(mergeTasks(p), [], "a parked review holds nothing a shutdown or restart must wait on");
  assert.equal(eventsOfType(root, "review_start").length, 0, "nothing runs before a permit frees");

  roleRuns[0]!.release();
  await p.postReview.promise;
  assert.equal(eventsOfType(root, "review_start").length, 1, "the freed permit runs the review");
  assert.equal(readPostReviews(root).length, 0, "the approval settles the entry");
  assert.equal(roleGranted, true, "the review's release hands its permit on to the queued role run");
  assert.equal(p.postReview, null, "a settled review leaves the slot free for the next poll");
  (await queuedRole).release();
  roleRuns[1]!.release();
});

test("a parked post-merge review whose start gate closes hands its permit back and keeps its entry", async () => {
  let held = false;
  const { root, commit, semaphore, roleRuns, ctx } = await saturated(1, () => held);
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await sleep(10);
  held = true; // a restart or team hold closes the gate while the review waits
  roleRuns[0]!.release();
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start").length, 0, "no review starts under a closed gate");
  assert.deepEqual(readPostReviews(root).map((e) => e.commit), [commit], "the entry stays for a later poll");
  assert.equal(semaphore.canLeaseAtOnce(0), true, "the permit is free again");
  // The task that ran nothing must not stay in the slot: the 11-03 wedge left a settled task
  // there, and the drain then never started another review until the team restarted.
  assert.equal(p.postReview, null);
  held = false;
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start").length, 1, "the gate's next opening reviews the commit");
  assert.equal(readPostReviews(root).length, 0);
});

test("a parked post-merge review whose entry settles meanwhile runs nothing", async () => {
  const { root, commit, semaphore, roleRuns, ctx } = await saturated(1);
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await sleep(10);
  settlePostReview(root, commit, null); // `tumwater review --accept` while the review waited
  roleRuns[0]!.release();
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start").length, 0, "the settled commit is not reviewed");
  assert.equal(semaphore.canLeaseAtOnce(0), true, "the permit is free again");
});

test("a shutdown settles a parked post-merge review at once, keeping its entry", async () => {
  const { root, commit, semaphore, roleRuns, shutdown, ctx } = await saturated(1);
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await sleep(10);
  shutdown.abort();
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start").length, 0);
  assert.deepEqual(readPostReviews(root).map((e) => e.commit), [commit]);
  roleRuns[0]!.release();
  await sleep(0);
  assert.equal(semaphore.canLeaseAtOnce(0), true, "the abandoned wait took no permit");
});
