/** Direct unit tests for src/loop/loop-recovery.ts — the three recovery phases split out of
 * LoopRunner's tick lifecycle. The loop suites drive them end-to-end, but no test file imports
 * the module, so the contract each arm is chosen on (which pending-prompt policy runs, which
 * leftover kind maps to which outcome, and what survives a failed pin) has no direct
 * assertions. These pin those arms with a recording context; a real initialized worktree is
 * used only where the phase actually touches git (the pin and the reset). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { refSha } from "../src/git/git.js";
import { inboxSize } from "../src/inbox/inbox.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import type { LandingEntry } from "../src/merge/merge-queue.js";
import {
  finishAbortedTickPhase,
  finishRecoveryTickPhase,
  pinAndResetPhase,
} from "../src/loop/loop-recovery.js";
import type { LoopState } from "../src/loop/loop-state.js";
import { landingRefName } from "../src/paths.js";
import { shortSha } from "../src/text/format.js";
import { commitIn, headSha, initializedRepo, initializedWorktree, mainSha, tmpdir } from "./fixtures/repo-fixtures.js";

/** The slice of RecoveryContext the phases read, with their side effects recorded: the real
 * PendingPrompt so clear/requeue policy is observed against the inbox, and arrays for the
 * warn/setRecoveryFailure callbacks. `state` is the phase's scratch object (lastError). */
function makeCtx(root: string, role = "improve", mainBranch = "main") {
  const state = {} as LoopState;
  const pending = new PendingPrompt(root, role);
  const warns: string[] = [];
  const failures: Array<string | undefined> = [];
  const ctx = {
    root,
    role,
    mainBranch,
    state,
    pending,
    warn: (message: string) => {
      warns.push(message);
    },
    setRecoveryFailure: (message: string | undefined) => {
      failures.push(message);
    },
  };
  return { ctx, pending, state, warns, failures };
}

test("pinAndResetPhase warns and leaves the commit when the landing-ref write fails", async () => {
  const root = tmpdir();
  const { ctx, warns } = makeCtx(root);
  // A plain temp dir is not a git repo, so setRef's update-ref cannot write the pin: the phase
  // must fail closed before touching the (also absent) worktree.
  const ok = await pinAndResetPhase(ctx, path.join(root, "no-worktree"), "deadbeef00");
  assert.equal(ok, false);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /failed to pin deadbeef by its merge ref — leaving the commit on the branch/);
});

test("pinAndResetPhase pins the sha and resets the worktree to main on success", async () => {
  const { root, wt } = await initializedWorktree();
  const { ctx } = makeCtx(root);
  fs.writeFileSync(path.join(wt, "leftover.txt"), "leftover work\n");
  commitIn(wt, "leftover work");
  const sha = headSha(wt);
  assert.notEqual(sha, mainSha(root), "the fixture commit sits ahead of main");

  const ok = await pinAndResetPhase(ctx, wt, sha);
  assert.equal(ok, true);
  assert.equal(await refSha(root, landingRefName("improve")), sha);
  assert.equal(headSha(wt), mainSha(root), "the branch moved back to main once the pin held the commit");
});

test("finishAbortedTickPhase discards the request and the work on an explicit user abort", async () => {
  const { root, wt } = await initializedWorktree();
  const { ctx, pending } = makeCtx(root);
  pending.record("please do x");

  const outcome = await finishAbortedTickPhase(ctx, "please do x", wt, true, false);
  assert.deepEqual(outcome, { result: "user_aborted" });
  assert.equal(pending.get(), null, "the abort is the answer: the request is dropped, not requeued");
  assert.equal(inboxSize(root, "improve"), 0);
  assert.equal(headSha(wt), mainSha(root), "the half-done work is discarded");
});

test("finishAbortedTickPhase requeues the prompt for resume on a plain shutdown", async () => {
  const root = await initializedRepo();
  const { ctx, pending } = makeCtx(root);
  pending.record("please do x");

  // No worktree is touched on this arm — only the prompt is handed back for a resumed session.
  const outcome = await finishAbortedTickPhase(ctx, "please do x", path.join(root, "unused"), false, false);
  assert.deepEqual(outcome, { result: "aborted" });
  assert.equal(inboxSize(root, "improve"), 1, "the shutdown requeues the unfulfilled request");
});

test("finishAbortedTickPhase names a budget handback as the resume cause", async () => {
  const root = await initializedRepo();
  const { ctx, pending } = makeCtx(root);
  pending.record("please do x");

  const outcome = await finishAbortedTickPhase(ctx, "please do x", path.join(root, "unused"), false, true);
  assert.deepEqual(outcome, { result: "aborted", resumeCause: "budget-resumed" });
  assert.equal(inboxSize(root, "improve"), 1);
});

test("finishRecoveryTickPhase fails an unpinned leftover without resetting the worktree", async () => {
  const root = await initializedRepo();
  const { ctx, pending, state } = makeCtx(root);
  pending.record("please do x");

  const outcome = await finishRecoveryTickPhase(
    ctx,
    { kind: "unpinned", sha: "abcdef1234" },
    "please do x",
    path.join(root, "unused"),
    undefined,
  );
  assert.equal(outcome.result, "error");
  assert.equal(outcome.recoveredLeftover, true);
  assert.equal(state.lastError, `failed to pin leftover ${shortSha("abcdef1234")} by its merge ref; left for the next run's recovery`);
  assert.equal(pending.get(), null);
  assert.equal(inboxSize(root, "improve"), 1, "the tick's request is requeued since nothing ran it");
});

test("finishRecoveryTickPhase ends error on a held pin and keeps its message", async () => {
  const root = await initializedRepo();
  const { ctx, state } = makeCtx(root);

  const outcome = await finishRecoveryTickPhase(
    ctx,
    { kind: "held", sha: "sha1", message: "reviewer config is broken" },
    null,
    path.join(root, "unused"),
    undefined,
  );
  assert.deepEqual(outcome, { result: "error", summary: "reviewer config is broken", recoveredLeftover: true });
  assert.equal(state.lastError, "reviewer config is broken");
  assert.equal(inboxSize(root, "improve"), 0, "a null prompt enqueues nothing");
});

test("finishRecoveryTickPhase maps an already-queued pin to queued without a recovery failure", async () => {
  const root = await initializedRepo();
  const { ctx, failures } = makeCtx(root);
  const entry: LandingEntry = { role: "improve", sha: "sha1", run: 3, summary: "the summary", highFriction: true, enqueuedAt: 0 };

  const outcome = await finishRecoveryTickPhase(ctx, { kind: "already_queued", entry }, null, path.join(root, "unused"), "prior failure");
  assert.deepEqual(outcome, { result: "queued", summary: "the summary", commit: "sha1", highFriction: true, recoveredLeftover: true });
  assert.deepEqual(failures, [], "nothing was enqueued this tick, so no prior failure is carried");
});

test("finishRecoveryTickPhase queues a freshly enqueued pin, resets the worktree, and carries the prior failure", async () => {
  const { root, wt } = await initializedWorktree();
  const { ctx, failures } = makeCtx(root);
  const entry: LandingEntry = { role: "improve", sha: "sha1", run: 4, summary: "the summary", enqueuedAt: 0 };
  fs.writeFileSync(path.join(wt, "dirty.txt"), "uncommitted leftover\n");

  const outcome = await finishRecoveryTickPhase(ctx, { kind: "enqueued", entry }, null, wt, "the prior failure");
  assert.equal(outcome.result, "queued");
  assert.equal(outcome.commit, "sha1");
  assert.equal(outcome.recoveredLeftover, true);
  assert.deepEqual(failures, ["the prior failure"], "a re-queued persistent failure rides into the error streak");
  assert.equal(headSha(wt), mainSha(root), "the worktree is freed once the pin owns the commit");
});
