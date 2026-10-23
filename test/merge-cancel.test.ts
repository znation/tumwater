/** `tumwater queue --cancel <n>` (PLANS.md): operator cancellation of a waiting merge — the
 * Nth `tumwater queue` lists is removed (file gone), that role's merge pin is deleted so
 * next-run leftover recovery cannot re-enqueue the change, and one `merge_cancelled` event is
 * logged. Pure module test against a temp repo, mirroring merge-requeue.test.ts's pinned-entry
 * setup (enqueueMerge + setRef). */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cancelQueuedMerge } from "../src/merge/merge-cancel.js";
import { enqueueMerge, queuedMergeFiles, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { mergeRefName } from "../src/paths.js";
import { refSha, setRef } from "../src/git/git.js";
import { makeRepo, pinOffMain } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";

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

test("cancelling position 2 removes only that file, keeps 1 and 3 in order, and deletes the role's pin", async () => {
  const root = await threeQueued();
  const roles = queuedMerges(root).map((e) => e.role);
  assert.deepEqual(roles, ["improve", "organize", "feature"]);
  const targetSha = queuedMerges(root)[1]!.sha;

  const outcome = await cancelQueuedMerge(root, 2);
  assert.deepEqual(outcome, { status: "cancelled", role: "organize", sha: targetSha, summary: "add organize" });

  const remaining = queuedMerges(root).map((e) => e.role);
  assert.deepEqual(remaining, ["improve", "feature"], "positions 1 and 3 keep their order");
  assert.equal(await refSha(root, mergeRefName("organize")), null, "the cancelled role's pin is deleted");
  // The surviving entries' pins are untouched.
  assert.ok(await refSha(root, mergeRefName("improve")));
  assert.ok(await refSha(root, mergeRefName("feature")));
});

test("a pin naming a different sha survives (a newer pin is never removed)", async () => {
  const root = await threeQueued();
  const entries = queuedMerges(root);
  const role = entries[1]!.role;
  const newer = entries[0]!.sha; // a real, different sha still present in the repo
  assert.ok(await setRef(root, mergeRefName(role), newer));

  await cancelQueuedMerge(root, 2);
  assert.equal(await refSha(root, mergeRefName(role)), newer, "the newer pin is left alone");
  assert.equal(queuedMerges(root).length, 2, "the entry file still drops");
});

test("an out-of-range position returns out-of-range with the readable depth and changes nothing", async () => {
  const root = await threeQueued();
  const files = queuedMergeFiles(root);
  const outcome = await cancelQueuedMerge(root, 5);
  assert.deepEqual(outcome, { status: "out-of-range", depth: 3 });
  assert.equal(queuedMergeFiles(root).length, files.length, "nothing is removed");
  // Position 0 is out of range too (positions are 1-based).
  const zero = await cancelQueuedMerge(root, 0);
  assert.deepEqual(zero, { status: "out-of-range", depth: 3 });

  const empty = makeRepo();
  assert.deepEqual(await cancelQueuedMerge(empty, 1), { status: "out-of-range", depth: 0 });
});

test("cancelling logs one merge_cancelled event naming the role, commit and summary", async () => {
  const root = await threeQueued();
  const sha = queuedMerges(root)[1]!.sha;
  await cancelQueuedMerge(root, 2);
  const cancelled = eventsOfType(root, "merge_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.source, "organize");
  assert.equal(cancelled[0]!.commit, sha);
  assert.equal(cancelled[0]!.summary, "add organize");
});
