import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_CONFLICT_LIMIT, recoverLeftover, type LeftoverContext } from "../src/runner/leftover.js";
import { commitTrailer } from "../src/git/commit-message.js";
import { readEvents } from "../src/events/event-read.js";
import { deleteRef, isMergedInto, refSha, setRef } from "../src/git/git.js";
import { enqueueMerge, queuedMerges } from "../src/merge/merge-queue.js";
import { mergeQueueDir, mergeRefName } from "../src/paths.js";
import { shortSha } from "../src/text/format.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { eventsOfType, unwritableEvents, warningMessages } from "./fixtures/log-fixtures.js";
import { headSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";

// Unit coverage for src/runner/leftover.ts's recoverLeftover — the salvage path that puts a commit
// a
// previous tick left unmerged back on the durable merge queue (merge-queue speed 3c: the slot is
// main's one writer): normally pinned by refs/tumwater/landing/<role>, or unpinned on the branch
// when a crash landed in the commit→pin window. The queue and the ref mechanics are real; no
// merge runs here. The loop e2e tests (test/runner-leftover-recovery.test.ts) drive the queued
// entry through
// the merge slot end-to-end.

const ROLE = "improve";

function makeCtx(root: string, wt: string): LeftoverContext {
  return { root, role: ROLE, mainBranch: "main", tick: 7, wt };
}

/** A repo with one commit NOT contained in main, pinned by the merge ref — the leftover to
 * salvage. The commit sits on a throwaway branch so it stays reachable after leaving it.
 * `message` is the commit subject/body; `commitArgs` carries extra git-commit flags an
 * unreadable-subject case needs. */
async function pinnedFixture(message = "stranded work", commitArgs: string[] = []): Promise<{ root: string; sha: string }> {
  const root = makeRepo();
  sh(root, "git", "checkout", "-b", "stray");
  fs.appendFileSync(path.join(root, "seed.txt"), "leftover change\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", ...commitArgs, "-m", message);
  const sha = headSha(root);
  sh(root, "git", "checkout", "main");
  await setRef(root, mergeRefName(ROLE), sha);
  return { root, sha };
}

test("no merge ref and nothing ahead of main: no-op, nothing queued", async () => {
  const root = makeRepo(); // nothing pinned, branch at main
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal(await recoverLeftover(makeCtx(root, wt)), null);

  assert.deepEqual(queuedMerges(root), [], "nothing is queued when there is no pin and nothing ahead");
});

test("a pinned commit not in main is put on the merge queue, not merged", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main"); // branch at main: only the pin matters

  const recovered = await recoverLeftover(makeCtx(root, wt));

  assert.equal(recovered?.kind, "enqueued");
  const queued = queuedMerges(root);
  assert.equal(queued.length, 1, "exactly one entry is queued");
  // A routine hand-made commit still names what merges — its whole subject, un-stamped — and
  // carries no recovered body or flag.
  assert.deepEqual(
    { ...queued[0], enqueuedAt: 0 },
    { role: ROLE, sha, run: 7, summary: "recovered leftover work from improve: stranded work", enqueuedAt: 0 },
  );
  assert.ok(!(await isMergedInto(root, sha, "main")), "nothing was written to main");
  assert.equal(await refSha(root, mergeRefName(ROLE)), sha, "the pin stays for the merge slot");
  const events = readEvents(root);
  assert.deepEqual(
    events.filter((e) => e.type === "merge_queued").map((e) => [e.commit, e.summary]),
    [[sha, "recovered leftover work from improve: stranded work"]],
    "the enqueue is logged like a fresh tick's",
  );
  assert.equal(events.filter((e) => e.type === "merged").length, 0, "no in-tick merge");
});

test("a pin whose merges hit the merge-conflict cap is handed back, not re-queued", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");

  // One short of the cap: still a retry.
  const below = { ...makeCtx(root, wt), mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT - 1 } };
  assert.equal((await recoverLeftover(below))?.kind, "enqueued");
  fs.rmSync(mergeQueueDir(root), { recursive: true, force: true }); // the slot took the entry
  assert.deepEqual(queuedMerges(root), []);

  // A streak for another sha says nothing about this pin.
  const other = { ...makeCtx(root, wt), mergeConflicts: { sha: "0".repeat(40), count: MERGE_CONFLICT_LIMIT } };
  assert.equal((await recoverLeftover(other))?.kind, "enqueued");
  fs.rmSync(mergeQueueDir(root), { recursive: true, force: true });

  // At the cap with no prior hand-back: the pin stays and the author gets it back to resolve.
  const atCap = { ...makeCtx(root, wt), mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT } };
  const recovered = await recoverLeftover(atCap);

  assert.deepEqual(recovered, { kind: "handback", sha, summary: "stranded work", attempts: MERGE_CONFLICT_LIMIT });
  assert.equal(await refSha(root, mergeRefName(ROLE)), sha, "the pin stays for the author's re-apply");
  assert.deepEqual(queuedMerges(root), [], "nothing is queued");
});

test("a pin at the cap whose lineage was already handed back is discarded, naming the hand-back", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");

  const atCap = {
    ...makeCtx(root, wt),
    mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT },
    conflictHandback: { sha, at: Date.now(), reason: "merge" as const, applied: true },
  };
  const recovered = await recoverLeftover(atCap);

  assert.deepEqual(recovered, { kind: "discarded", sha, summary: "stranded work", attempts: MERGE_CONFLICT_LIMIT });
  assert.equal(await refSha(root, mergeRefName(ROLE)), null, "the pin is deleted");
  assert.deepEqual(queuedMerges(root), [], "nothing is queued");
  const warned = warningMessages(root);
  assert.ok(
    warned.some((m) =>
      m.includes(`discarding leftover ${shortSha(sha)} after ${MERGE_CONFLICT_LIMIT} merges`),
    ),
    "the discard is warned, naming the sha",
  );
  assert.ok(warned.some((m) => m.includes("even after sending it back to the role to resolve")), "the warning names the hand-back");
});

test("a role whose merge is already queued is not enqueued twice", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");
  enqueueMerge(root, { role: ROLE, sha, run: 3, summary: "the original entry", enqueuedAt: Date.now() });

  const recovered = await recoverLeftover(makeCtx(root, wt));

  assert.equal(recovered?.kind, "already_queued");
  assert.equal(recovered?.kind === "already_queued" && recovered.entry.summary, "the original entry");
  assert.equal(queuedMerges(root).length, 1, "the queue still holds one entry for the role");
  assert.equal(eventsOfType(root, "merge_queued").length, 0, "no second merge_queued");
  assert.equal(await refSha(root, mergeRefName(ROLE)), sha, "the pin is untouched");
});

// BUGS.md 2026-09-19: recovery re-merged a high-friction commit without its flag (and its
// body), so the reviewer skipped the extra scrutiny the flag exists to trigger. Both are
// already durable in the commit message the harness stamped; recovery reads them back.
test("recovery reads the pinned commit's body and high-friction flag back out of its message", async () => {
  const { root, sha } = await pinnedFixture(
    [
      "tumwater(improve): slow but worthwhile",
      "",
      "WHY: the fix was fiddly",
      "RISK: touches the merge path",
      "VERIFIED: npm test, all pass",
      "",
      commitTrailer("improve", 5, 44, 20_000, 4.2),
    ].join("\n"),
  );
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal((await recoverLeftover(makeCtx(root, wt)))?.kind, "enqueued");
  const [entry] = queuedMerges(root);
  assert.equal(entry?.sha, sha);
  assert.equal(entry?.highFriction, true, "the Friction trailer sets the review flag");
  assert.equal(
    entry?.body,
    "WHY: the fix was fiddly\nRISK: touches the merge path\nVERIFIED: npm test, all pass",
    "the commit body rides into the review gate",
  );
  assert.equal(
    entry?.summary,
    "recovered leftover work from improve: slow but worthwhile",
    "the subject rides into the merged summary with the harness stamp stripped",
  );
});

test("a stale ref already contained in main is deleted without queuing anything", async () => {
  const { root, sha } = await pinnedFixture();
  // Simulate the crash window: the work merged on main but the ref deletion never ran.
  sh(root, "git", "merge", "--ff-only", "stray");
  assert.ok(await isMergedInto(root, sha, "main"), "fixture sanity: the pin is now contained in main");
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal(await recoverLeftover(makeCtx(root, wt)), null);

  assert.deepEqual(queuedMerges(root), [], "contained work is never re-queued");
  assert.equal(await refSha(root, mergeRefName(ROLE)), null, "the stale pin was cleaned up");
});

test("an unpinned commit ahead of main (crash in the commit→pin window) is adopted and queued from the branch tip", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "unpinned work\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "committed but the pin write never happened");
  const tip = headSha(wt);
  assert.equal(await refSha(root, mergeRefName(ROLE)), null, "fixture sanity: no pin exists");

  assert.equal((await recoverLeftover(makeCtx(root, wt)))?.kind, "enqueued");
  assert.deepEqual(
    queuedMerges(root).map((e) => e.sha),
    [tip],
    "the branch tip is the sha to queue when no pin survived",
  );
  // The unpinned commit was adopted into the pin scheme: an under-cap review failure keeps this
  // ref for the strike cap's retry exactly as for a normally pinned one.
  assert.equal(await refSha(root, mergeRefName(ROLE)), tip, "the fallback adopts the pin");
});

test("a failed pin adoption is logged and queues nothing: the commit stays on the branch", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "unpinned work\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "committed but the pin write never happened");
  const tip = headSha(wt);
  // A read-only .git tree makes `git update-ref` fail (cannot create or lock the ref) while
  // every read (rev-parse, rev-list) still succeeds — a standing stand-in for a failed pin
  // write. Recursive: git needs write permission on the specific ref directory it locks.
  sh(root, "chmod", "-R", "a-w", ".git");
  try {
    const recovered = await recoverLeftover(makeCtx(root, wt));

    assert.deepEqual(recovered, { kind: "unpinned", sha: tip }, "the caller learns the commit is still unpinned");
    assert.deepEqual(queuedMerges(root), [], "a merge without its pin is never queued");
    assert.equal(await refSha(root, mergeRefName(ROLE)), null, "no pin was created");
    assert.equal(headSha(wt), tip, "the commit is still on the branch");
    // The failed adoption is recorded for the transcript, not swallowed.
    const warn = readEvents(root).find((e) => e.type === "warning");
    assert.ok(warn, "the adoption failure is logged as a warning event");
    assert.match(String(warn.message), /failed to adopt unpinned leftover/);
    assert.equal(warn.source, ROLE);
  } finally {
    sh(root, "chmod", "-R", "u+w", ".git");
  }
});

test("an unreadable ref read and an unreadable worktree both read as no leftover: nothing queued", async () => {
  const root = tmpdir(); // not a git repo at all — every git command in it fails
  const bogusWt = tmpdir();

  assert.equal(await recoverLeftover(makeCtx(root, bogusWt)), null, "a failed ref read never queues anything");
  assert.deepEqual(queuedMerges(root), []);
});

test("deleteRef is idempotent (terminal-outcome cleanup can run twice)", async () => {
  const root = makeRepo();
  sh(root, "git", "commit", "--allow-empty", "-m", "pin target");
  const sha = headSha(root);
  await setRef(root, mergeRefName(ROLE), sha);

  await deleteRef(root, mergeRefName(ROLE));
  await assert.doesNotReject(() => deleteRef(root, mergeRefName(ROLE)));

  assert.equal(await refSha(root, mergeRefName(ROLE)), null);
});

// The metadata recovery presents to the review gate comes from the pinned commit's own
// message; when that message is unreadable — commitMessage trims %B to "" for an empty-message
// commit, so recoveredMetadata returns {} — recovery must still work and fall back to the bare
// provenance label instead of leaking "undefined" into the queue entry or the failure digest.

test("a pinned commit with no readable subject is queued under the bare provenance label", async () => {
  const { root, sha } = await pinnedFixture("", ["--allow-empty-message"]);
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal((await recoverLeftover(makeCtx(root, wt)))?.kind, "enqueued");
  const [entry] = queuedMerges(root);
  assert.equal(entry?.sha, sha);
  assert.equal(entry?.summary, "recovered leftover work from improve", "no subject: the bare label");
  assert.equal(entry?.body, undefined, "no body without a message");
  assert.equal(entry?.highFriction, undefined, "no flag without a message");
});

test("a handed-back commit with no readable subject falls back to the bare sha label", async () => {
  const { root, sha } = await pinnedFixture("", ["--allow-empty-message"]);
  const wt = await ensureWorktree(root, ROLE, "main");

  const atCap = { ...makeCtx(root, wt), mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT } };
  assert.deepEqual(await recoverLeftover(atCap), {
    kind: "handback",
    sha,
    summary: `leftover ${shortSha(sha)}`,
    attempts: MERGE_CONFLICT_LIMIT,
  });
  assert.equal(await refSha(root, mergeRefName(ROLE)), sha, "the pin stays for the author's re-apply");
});

// recoverLeftover's event writes are best-effort (src/events/events.ts): the enqueue, the pin
// delete, and the unpinned return are durable before the warning/log runs, so an unwritable
// events feed (ENOSPC, EACCES, the path replaced by a directory) must not throw out of recovery
// and turn a completed salvage into a tick error. Fault injected as in
// test/gate-event-best-effort.test.ts — a directory where events.jsonl belongs, so every append
// throws EISDIR while the rest of the root still writes.
test("a pinned leftover is still queued when the events feed is unwritable", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");
  unwritableEvents(root);

  const recovered = await recoverLeftover(makeCtx(root, wt));

  assert.equal(recovered?.kind, "enqueued", "the enqueue result survives the failed log");
  assert.deepEqual(queuedMerges(root).map((e) => e.sha), [sha], "the entry is on the queue");
});

test("a failed pin adoption still returns unpinned when the events feed is unwritable", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "unpinned work\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "committed but the pin write never happened");
  const tip = headSha(wt);
  sh(root, "chmod", "-R", "a-w", ".git");
  try {
    unwritableEvents(root);
    assert.deepEqual(await recoverLeftover(makeCtx(root, wt)), { kind: "unpinned", sha: tip });
  } finally {
    sh(root, "chmod", "-R", "u+w", ".git");
  }
});

test("a discarded leftover is still deleted when the events feed is unwritable", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");
  const atCap = {
    ...makeCtx(root, wt),
    mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT },
    conflictHandback: { sha, at: Date.now(), reason: "merge" as const, applied: true },
  };
  unwritableEvents(root);

  const recovered = await recoverLeftover(atCap);

  assert.equal(recovered?.kind, "discarded", "the discard result survives the failed warning");
  assert.equal(await refSha(root, mergeRefName(ROLE)), null, "the pin is deleted");
});
