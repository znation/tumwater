/** `tumwater queue --top <n>` (PLANS.md): operator reordering of a waiting merge — the Nth
 * `tumwater queue` lists is moved to the head of the execution order by renaming its queue
 * file to a stamp one below the queue's minimum, and one `merge_topped` event is logged.
 * Pure module test against a temp repo, mirroring merge-cancel.test.ts's pinned-entry setup
 * (enqueueMerge + setRef). */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { moveQueuedMergeToTop } from "../src/merge/merge-top.js";
import { enqueueMerge, queuedMergeFiles, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { mergeQueueDir, mergeRefName } from "../src/paths.js";
import { setRef } from "../src/git/git.js";
import { makeRepo, pinOffMain } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { errnoError, withThrowingFs } from "./helpers/fs-faults.js";

function entry(role: string, sha: string, run = 1, summary = `summary ${role} #${run}`): MergeEntry {
  return { role, sha, run, summary, enqueuedAt: Date.now() };
}

/** A repo with three queued merges — improve, organize, feature — each pinned off main. The
 * three pins are created first, then all three entries are enqueued: pinOffMain's `git add -A`
 * would otherwise commit an earlier enqueued .tumwater queue file into a detached commit, and
 * its trailing `git checkout main` would delete it. */
async function threeQueued(): Promise<string> {
  const root = makeRepo();
  let n = 0;
  const shas: Record<string, string> = {};
  for (const role of ["improve", "organize", "feature"] as const) {
    const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, `f${n++}.txt`), `${role}\n`), `add ${role}`);
    assert.ok(await setRef(root, mergeRefName(role), sha));
    shas[role] = sha;
  }
  const roles = ["improve", "organize", "feature"] as const;
  roles.forEach((role, i) => enqueueMerge(root, entry(role, shas[role]!, i + 1, `add ${role}`)));
  return root;
}

test("topping position 3 makes it the head with its fields unchanged and logs one event", async () => {
  const root = await threeQueued();
  const filesBefore = queuedMergeFiles(root);
  const target = filesBefore[2]!;
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["improve", "organize", "feature"]);

  const outcome = moveQueuedMergeToTop(root, 3);
  assert.deepEqual(outcome, { status: "topped", role: "feature", sha: target.entry.sha, summary: "add feature" });

  const after = queuedMerges(root);
  assert.deepEqual(
    after.map((e) => e.role),
    ["feature", "improve", "organize"],
    "the moved entry is now the head and the rest keep their order",
  );
  // The entry JSON is renamed, never rewritten — every field survives byte for byte.
  const moved = after[0]!;
  assert.equal(moved.sha, target.entry.sha);
  assert.equal(moved.summary, "add feature");
  assert.equal(moved.enqueuedAt, target.entry.enqueuedAt);
  const topped = eventsOfType(root, "merge_topped");
  assert.equal(topped.length, 1, "exactly one merge_topped event is logged");
  assert.equal(topped[0]!.source, "feature");
  assert.equal(topped[0]!.commit, target.entry.sha);
  assert.equal(topped[0]!.summary, "add feature");
});

test("position 1 answers already-first with no rename and no event", async () => {
  const root = await threeQueued();
  const before = queuedMergeFiles(root).map((q) => q.file);
  const outcome = moveQueuedMergeToTop(root, 1);
  assert.deepEqual(outcome, { status: "already-first", role: "improve", sha: before[0] && queuedMerges(root)[0]!.sha, summary: "add improve" });
  assert.deepEqual(
    queuedMergeFiles(root).map((q) => q.file),
    before,
    "no file is renamed",
  );
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event for a no-op");
});

test("an out-of-range position returns out-of-range with the readable depth and changes nothing", async () => {
  const root = await threeQueued();
  const before = queuedMergeFiles(root);
  const outcome = moveQueuedMergeToTop(root, 4);
  assert.deepEqual(outcome, { status: "out-of-range", depth: 3 });
  assert.deepEqual(queuedMergeFiles(root).map((q) => q.file), before.map((q) => q.file), "nothing is renamed");
  // Position 0 is out of range too (positions are 1-based).
  const zero = moveQueuedMergeToTop(root, 0);
  assert.deepEqual(zero, { status: "out-of-range", depth: 3 });

  const empty = makeRepo();
  assert.deepEqual(moveQueuedMergeToTop(empty, 1), { status: "out-of-range", depth: 0 });
});

test("a deferred entry moved to the front keeps its notBefore", async () => {
  const root = await threeQueued();
  const files = queuedMergeFiles(root);
  const deferred = files[2]!.entry;
  // Rewrite the target entry with a notBefore deferral, as the pipeline's re-queue does; it
  // sorts after the identically-stamped original, so it is position 4.
  enqueueMerge(root, { ...deferred, notBefore: Number.MAX_SAFE_INTEGER });
  const moved = moveQueuedMergeToTop(root, 4);
  assert.equal(moved.status, "topped");
  assert.equal(queuedMerges(root)[0]!.enqueuedAt, deferred.enqueuedAt, "the moved entry is the head");
  assert.equal(queuedMerges(root)[0]!.notBefore, Number.MAX_SAFE_INTEGER, "the deferral rides the renamed file");
});

test("with a torn head file present, the target still sorts first among the readable files", async () => {
  const root = await threeQueued();
  // A torn (unreadable) queue file that sorts before every readable entry: readMergeQueue
  // skips it, so the readable depths ignore it, but it stays in the directory.
  const dir = mergeQueueDir(root);
  fs.writeFileSync(path.join(dir, "0000000000000-000000-1.json"), "{ not json");
  assert.equal(queuedMergeFiles(root).length, 3, "the torn head file is not a readable entry");

  const outcome = moveQueuedMergeToTop(root, 3);
  assert.equal(outcome.status, "topped");
  assert.equal(queuedMerges(root)[0]!.role, "feature", "the target is first among the readable entries");
});

test("a concurrent drop mid-move answers gone with no rename and no event", async () => {
  const root = await threeQueued();
  // The orchestrator drained the target between listing and rename: renameSync hits ENOENT,
  // reported as gone, never a throw — the queue-drain race merge-cancel.ts and inbox-top.ts
  // share. The move is one rename, so no guard can see the vanish except at rename time.
  withThrowingFs("renameSync", errnoError("ENOENT"), () => {
    assert.deepEqual(moveQueuedMergeToTop(root, 3), { status: "gone" });
  });
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event for a raced-out move");
  assert.deepEqual(
    queuedMergeFiles(root).map((q) => q.entry.role),
    ["improve", "organize", "feature"],
    "no rename happened, so the queue is untouched",
  );
});
