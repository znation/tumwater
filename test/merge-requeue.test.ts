/** The merge pipeline re-queues a kept change itself (plans/fast-merge.md "Lever 1"): after a
 * retriable result drops its entry, settleMergeOutcome puts the pinned change back on the queue
 * with the original summary and a `retry` field — no author run between. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { newMergePipeline, settleMergeOutcome } from "../src/merge/merge-pipeline.js";
import { drainVerify } from "../src/merge/merge-verify.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { defaultConfig } from "../src/config/config.js";
import { enqueueMerge, headMerge, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { MERGE_CONFLICT_LIMIT } from "../src/runner/runner-leftover.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { mergeRefName } from "../src/paths.js";
import { deleteRef, refSha, setRef } from "../src/git/git.js";
import { makeRepo, mainSha, pinOffMain } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";

const NO_USAGE = { tokens: 0, cost: 0, providerCost: {} };

/** A repo with one change pinned off main for `improve` and its entry queued; `file` is the
 * queue file a settled merge drops. */
async function pinnedEntry(): Promise<{ root: string; entry: MergeEntry; file: string }> {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "a.txt"), "a\n"), "add a");
  assert.ok(await setRef(root, mergeRefName("improve"), sha));
  const entry: MergeEntry = {
    role: "improve",
    sha,
    run: 7,
    summary: "add a",
    body: "WHY: x",
    highFriction: true,
    revisionRound: 2,
    enqueuedAt: Date.now(),
  };
  enqueueMerge(root, entry);
  const head = headMerge(root);
  assert.ok(head);
  return { root, entry, file: head.file };
}

test("a merge_blocked change is re-queued at once with its original summary and a retry field", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  await settleMergeOutcome(root, entry, state, "merge_blocked", 5, NO_USAGE, file, "main");
  const queued = queuedMerges(root);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.sha, entry.sha);
  assert.equal(queued[0]!.summary, "add a");
  assert.equal(queued[0]!.body, "WHY: x");
  assert.equal(queued[0]!.highFriction, true);
  assert.equal(queued[0]!.revisionRound, 2);
  assert.equal(queued[0]!.run, 7);
  assert.equal(queued[0]!.retry, "merge_blocked");
  assert.equal(queued[0]!.notBefore, undefined);
  assert.equal(queued[0]!.retryCount, 1);
  const ev = eventsOfType(root, "merge_queued").at(-1)!;
  assert.equal(ev.retry, "merge_blocked");
  assert.equal(ev.summary, "add a");

  // Re-queue the re-queued entry again: the count survives, and the fields an entry carries
  // are unchanged by it.
  const second = headMerge(root);
  assert.ok(second);
  await settleMergeOutcome(root, second.entry, state, "merge_blocked", 5, NO_USAGE, second.file, "main");
  const again = queuedMerges(root);
  assert.equal(again.length, 1);
  assert.equal(again[0]!.retryCount, 2);
  assert.equal(again[0]!.retry, "merge_blocked");
  assert.equal(again[0]!.sha, entry.sha);
  assert.equal(again[0]!.summary, "add a");
  assert.equal(again[0]!.run, 7);
});

test("a review_error re-queue waits 60 s", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  const before = Date.now();
  await settleMergeOutcome(root, entry, state, "review_error", 5, NO_USAGE, file, "main");
  const [queued] = queuedMerges(root);
  assert.ok(queued?.notBefore !== undefined);
  assert.ok(queued.notBefore >= before + 60_000 && queued.notBefore <= Date.now() + 60_000);
});

test("a change at MERGE_CONFLICT_LIMIT is not re-queued; a gone pin is not either", async () => {
  const { root, entry, file } = await pinnedEntry();
  const state = freshRunnerState("improve");
  state.mergeConflicts = { sha: entry.sha, count: MERGE_CONFLICT_LIMIT - 1 };
  // This conflict makes the streak reach the limit.
  await settleMergeOutcome(root, entry, state, "merge_conflict", 5, NO_USAGE, file, "main");
  assert.equal(state.mergeConflicts.count, MERGE_CONFLICT_LIMIT);
  assert.equal(queuedMerges(root).length, 0);

  const under = await pinnedEntry();
  const underState = freshRunnerState("improve");
  await settleMergeOutcome(under.root, under.entry, underState, "merge_conflict", 5, NO_USAGE, under.file, "main");
  assert.equal(queuedMerges(under.root).length, 1, "under the limit it re-queues");

  const gone = await pinnedEntry();
  await deleteRef(gone.root, mergeRefName("improve"));
  await settleMergeOutcome(gone.root, gone.entry, freshRunnerState("improve"), "merge_blocked", 5, NO_USAGE, gone.file, "main");
  assert.equal(queuedMerges(gone.root).length, 0);
  assert.equal(await refSha(gone.root, mergeRefName("improve")).catch(() => null), null);
});

test("drainVerify leaves an entry queued until its notBefore passes", async () => {
  const { root, entry, file } = await pinnedEntry();
  fs.rmSync(file);
  enqueueMerge(root, { ...entry, notBefore: Date.now() + 60_000 });
  const pipeline = newMergePipeline();
  const config = defaultConfig();
  await drainVerify(
    {
      root,
      mainBranch: "main",
      signal: new AbortController().signal,
      semaphore: new Semaphore(2),
      runners: [],
      liveConfig: config,
      roleConfig: config,
      directorConfig: config,
      startHeld: () => false,
    },
    pipeline,
  );
  assert.equal(pipeline.verifying.size, 0, "no verification started");
  assert.equal(queuedMerges(root).length, 1, "the entry is still queued");
});

test("drainVerify reports, not throws, when a deduped entry's file cannot be dropped", async () => {
  // drainVerify's dedupe branch drops an entry whose sha main already holds (a crash between the
  // fast-forward and the drop). That drop is the same fs.rmSync dropMerge whose failure the two
  // sibling settle paths (dropTornHead, settleAbortedApproved) already guard: it runs in the poll
  // body with nothing to catch it, so a queue file that is locked or on a read-only filesystem
  // (the shape an ENOSPC or immutable queue file takes) throwing out of drainVerify would end the
  // whole team's run. The drop must be reported and the entry left for the next poll, not thrown.
  const root = makeRepo();
  const sha = mainSha(root);
  const entry: MergeEntry = { role: "improve", sha, run: 1, summary: "on main", enqueuedAt: Date.now() };
  enqueueMerge(root, entry);
  const head = headMerge(root);
  assert.ok(head, "the entry is queued and readable");
  const pipeline = newMergePipeline();
  const config = defaultConfig();
  const undo = patchFsMethod("rmSync", (orig) => (...args: unknown[]) => {
    if (String(args[0]) === head.file) throw errnoError("EBUSY");
    return orig(...args);
  });
  try {
    await drainVerify(
      {
        root,
        mainBranch: "main",
        signal: new AbortController().signal,
        semaphore: new Semaphore(2),
        runners: [],
        liveConfig: config,
        roleConfig: config,
        directorConfig: config,
        startHeld: () => false,
      },
      pipeline,
    ); // must resolve, not reject out of the poll
  } finally {
    undo();
  }
  assert.ok(fs.existsSync(head.file), "the undroppable entry is left for the next poll");
  const warns = eventsOfType(root, "warning");
  assert.equal(warns.length, 1, "one warning for the failed drop");
  assert.match(JSON.stringify(warns), /could not be dropped/, "the warning explains the drop failed");
  assert.match(JSON.stringify(warns), /EBUSY/, "the warning carries the underlying error");
});

