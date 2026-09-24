import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_CONFLICT_LIMIT, recoverLeftover, type LeftoverContext } from "../src/leftover.js";
import { commitTrailer } from "../src/commit-message.js";
import { readEvents } from "../src/events.js";
import { deleteRef, isMergedInto, refSha, setRef } from "../src/git.js";
import { enqueueLanding, queuedLandings } from "../src/land-queue.js";
import { landQueueDir, landingRefName } from "../src/paths.js";
import { shortSha } from "../src/text.js";
import { ensureWorktree } from "../src/worktree.js";
import { makeRepo, sh, tmpdir } from "./util.js";

// Unit coverage for src/leftover.ts's recoverLeftover — the salvage path that puts a commit a
// previous tick left unlanded back on the durable land queue (land-queue speed 3c: the slot is
// main's one writer): normally pinned by refs/tumwater/landing/<role>, or unpinned on the branch
// when a crash landed in the commit→pin window. The queue and the ref mechanics are real; no
// landing runs here. The loop e2e tests (test/loop-3.test.ts) drive the queued entry through
// the landing slot end-to-end.

const ROLE = "improve";

function makeCtx(root: string, wt: string): LeftoverContext {
  return { root, role: ROLE, mainBranch: "main", tick: 7, wt };
}

/** A repo with one commit NOT contained in main, pinned by the landing ref — the leftover to
 * salvage. The commit sits on a throwaway branch so it stays reachable after leaving it. */
async function pinnedFixture(): Promise<{ root: string; sha: string }> {
  const root = makeRepo();
  sh(root, "git", "checkout", "-b", "stray");
  fs.appendFileSync(path.join(root, "seed.txt"), "leftover change\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "stranded work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  await setRef(root, landingRefName(ROLE), sha);
  return { root, sha };
}

test("no landing ref and nothing ahead of main: no-op, nothing queued", async () => {
  const root = makeRepo(); // nothing pinned, branch at main
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal(await recoverLeftover(makeCtx(root, wt)), null);

  assert.deepEqual(queuedLandings(root), [], "nothing is queued when there is no pin and nothing ahead");
});

test("a pinned commit not in main is put on the land queue, not landed", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main"); // branch at main: only the pin matters

  const recovered = await recoverLeftover(makeCtx(root, wt));

  assert.equal(recovered?.kind, "enqueued");
  const queued = queuedLandings(root);
  assert.equal(queued.length, 1, "exactly one entry is queued");
  // A routine hand-made commit still names what lands — its whole subject, un-stamped — and
  // carries no recovered body or flag.
  assert.deepEqual(
    { ...queued[0], enqueuedAt: 0 },
    { role: ROLE, sha, tick: 7, summary: "recovered leftover work from improve: stranded work", enqueuedAt: 0 },
  );
  assert.ok(!(await isMergedInto(root, sha, "main")), "nothing was written to main");
  assert.equal(await refSha(root, landingRefName(ROLE)), sha, "the pin stays for the landing slot");
  const events = readEvents(root);
  assert.deepEqual(
    events.filter((e) => e.type === "land_queued").map((e) => [e.commit, e.summary]),
    [[sha, "recovered leftover work from improve: stranded work"]],
    "the enqueue is logged like a fresh tick's",
  );
  assert.equal(events.filter((e) => e.type === "merged").length, 0, "no in-tick merge");
});

test("a pin whose landings hit the merge-conflict cap is discarded, not re-queued", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");

  // One short of the cap: still a retry.
  const below = { ...makeCtx(root, wt), mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT - 1 } };
  assert.equal((await recoverLeftover(below))?.kind, "enqueued");
  fs.rmSync(landQueueDir(root), { recursive: true, force: true }); // the slot took the entry
  assert.deepEqual(queuedLandings(root), []);

  // A streak for another sha says nothing about this pin.
  const other = { ...makeCtx(root, wt), mergeConflicts: { sha: "0".repeat(40), count: MERGE_CONFLICT_LIMIT } };
  assert.equal((await recoverLeftover(other))?.kind, "enqueued");
  fs.rmSync(landQueueDir(root), { recursive: true, force: true });

  const atCap = { ...makeCtx(root, wt), mergeConflicts: { sha, count: MERGE_CONFLICT_LIMIT } };
  const recovered = await recoverLeftover(atCap);

  assert.deepEqual(recovered, { kind: "discarded", sha, summary: "stranded work", attempts: MERGE_CONFLICT_LIMIT });
  assert.equal(await refSha(root, landingRefName(ROLE)), null, "the pin is deleted");
  assert.deepEqual(queuedLandings(root), [], "nothing is queued");
  const warned = readEvents(root).filter((e) => e.type === "warning").map((e) => String(e.message));
  assert.ok(
    warned.some((m) => m.includes(`discarding leftover ${shortSha(sha)} after ${MERGE_CONFLICT_LIMIT} landings`)),
    "the discard is warned, naming the sha",
  );
});

test("a role whose landing is already queued is not enqueued twice", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main");
  enqueueLanding(root, { role: ROLE, sha, tick: 3, summary: "the original entry", enqueuedAt: Date.now() });

  const recovered = await recoverLeftover(makeCtx(root, wt));

  assert.equal(recovered?.kind, "already_queued");
  assert.equal(recovered?.kind === "already_queued" && recovered.entry.summary, "the original entry");
  assert.equal(queuedLandings(root).length, 1, "the queue still holds one entry for the role");
  assert.equal(readEvents(root).filter((e) => e.type === "land_queued").length, 0, "no second land_queued");
  assert.equal(await refSha(root, landingRefName(ROLE)), sha, "the pin is untouched");
});

// BUGS.md 2026-09-19: recovery re-landed a high-friction commit without its flag (and its
// body), so the reviewer skipped the extra scrutiny the flag exists to trigger. Both are
// already durable in the commit message the harness stamped; recovery reads them back.
test("recovery reads the pinned commit's body and high-friction flag back out of its message", async () => {
  const root = makeRepo();
  sh(root, "git", "checkout", "-b", "stray");
  fs.appendFileSync(path.join(root, "seed.txt"), "leftover change\n");
  sh(root, "git", "add", "-A");
  sh(
    root,
    "git",
    "commit",
    "-m",
    [
      "tumwater(improve): slow but worthwhile",
      "",
      "WHY: the fix was fiddly",
      "RISK: touches the landing path",
      "VERIFIED: npm test, all pass",
      "",
      commitTrailer("improve", 5, 44, 20_000, 4.2),
    ].join("\n"),
  );
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  await setRef(root, landingRefName(ROLE), sha);
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal((await recoverLeftover(makeCtx(root, wt)))?.kind, "enqueued");
  const [entry] = queuedLandings(root);
  assert.equal(entry?.sha, sha);
  assert.equal(entry?.highFriction, true, "the Friction trailer sets the review flag");
  assert.equal(
    entry?.body,
    "WHY: the fix was fiddly\nRISK: touches the landing path\nVERIFIED: npm test, all pass",
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
  // Simulate the crash window: the work landed on main but the ref deletion never ran.
  sh(root, "git", "merge", "--ff-only", "stray");
  assert.ok(await isMergedInto(root, sha, "main"), "fixture sanity: the pin is now contained in main");
  const wt = await ensureWorktree(root, ROLE, "main");

  assert.equal(await recoverLeftover(makeCtx(root, wt)), null);

  assert.deepEqual(queuedLandings(root), [], "contained work is never re-queued");
  assert.equal(await refSha(root, landingRefName(ROLE)), null, "the stale pin was cleaned up");
});

test("an unpinned commit ahead of main (crash in the commit→pin window) is adopted and queued from the branch tip", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "unpinned work\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "committed but the pin write never happened");
  const tip = sh(wt, "git", "rev-parse", "HEAD").trim();
  assert.equal(await refSha(root, landingRefName(ROLE)), null, "fixture sanity: no pin exists");

  assert.equal((await recoverLeftover(makeCtx(root, wt)))?.kind, "enqueued");
  assert.deepEqual(
    queuedLandings(root).map((e) => e.sha),
    [tip],
    "the branch tip is the sha to queue when no pin survived",
  );
  // The unpinned commit was adopted into the pin scheme: an under-cap review failure keeps this
  // ref for the strike cap's retry exactly as for a normally pinned one.
  assert.equal(await refSha(root, landingRefName(ROLE)), tip, "the fallback adopts the pin");
});

test("a failed pin adoption is logged and queues nothing: the commit stays on the branch", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "unpinned work\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "committed but the pin write never happened");
  const tip = sh(wt, "git", "rev-parse", "HEAD").trim();
  // A read-only .git tree makes `git update-ref` fail (cannot create or lock the ref) while
  // every read (rev-parse, rev-list) still succeeds — a standing stand-in for a failed pin
  // write. Recursive: git needs write permission on the specific ref directory it locks.
  sh(root, "chmod", "-R", "a-w", ".git");
  try {
    const recovered = await recoverLeftover(makeCtx(root, wt));

    assert.deepEqual(recovered, { kind: "unpinned", sha: tip }, "the caller learns the commit is still unpinned");
    assert.deepEqual(queuedLandings(root), [], "a landing without its pin is never queued");
    assert.equal(await refSha(root, landingRefName(ROLE)), null, "no pin was created");
    assert.equal(sh(wt, "git", "rev-parse", "HEAD").trim(), tip, "the commit is still on the branch");
    // The failed adoption is recorded for the transcript, not swallowed.
    const warn = readEvents(root).find((e) => e.type === "warning");
    assert.ok(warn, "the adoption failure is logged as a warning event");
    assert.match(String(warn.message), /failed to adopt unpinned leftover/);
    assert.equal(warn.loop, ROLE);
  } finally {
    sh(root, "chmod", "-R", "u+w", ".git");
  }
});

test("an unreadable ref read and an unreadable worktree both read as no leftover: nothing queued", async () => {
  const root = tmpdir(); // not a git repo at all — every git command in it fails
  const bogusWt = tmpdir();

  assert.equal(await recoverLeftover(makeCtx(root, bogusWt)), null, "a failed ref read never queues anything");
  assert.deepEqual(queuedLandings(root), []);
});

test("deleteRef is idempotent (terminal-outcome cleanup can run twice)", async () => {
  const root = makeRepo();
  sh(root, "git", "commit", "--allow-empty", "-m", "pin target");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  await setRef(root, landingRefName(ROLE), sha);

  await deleteRef(root, landingRefName(ROLE));
  await assert.doesNotReject(() => deleteRef(root, landingRefName(ROLE)));

  assert.equal(await refSha(root, landingRefName(ROLE)), null);
});
