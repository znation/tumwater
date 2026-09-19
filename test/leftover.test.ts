import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recoverLeftover, type LeftoverContext } from "../src/leftover.js";
import { commitTrailer } from "../src/commit-message.js";
import { deleteRef, isMergedInto, refSha, setRef } from "../src/git.js";
import { eventsLogPath, landingRefName } from "../src/paths.js";
import { ensureWorktree } from "../src/worktree.js";
import type { TickResult } from "../src/types.js";
import { makeRepo, sh, tmpdir } from "./util.js";

// Unit coverage for src/leftover.ts's recoverLeftover — the salvage path that re-lands a commit
// a previous tick left unlanded (merge queue 2/5): normally pinned by
// refs/tumwater/landing/<role>, or unpinned on the branch when a crash landed in the commit→pin
// window. The lander seam is faked; the ref mechanics are real git. The loop e2e tests
// (test/loop.test.ts) exercise the full recovery flow end-to-end through a live tick.

const ROLE = "improve";

/** A LeftoverContext whose land records every call (sha + recovered metadata) and returns
 * `landResult`. */
function makeCtx(
  root: string,
  wt: string,
  landResult: TickResult = "changed",
): { ctx: LeftoverContext; landed: string[]; metas: Array<{ body?: string; highFriction?: boolean }> } {
  const landed: string[] = [];
  const metas: Array<{ body?: string; highFriction?: boolean }> = [];
  const ctx: LeftoverContext = {
    root,
    role: ROLE,
    mainBranch: "main",
    wt,
    land: async (sha, meta) => {
      landed.push(sha);
      metas.push(meta);
      return landResult;
    },
  };
  return { ctx, landed, metas };
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

test("no landing ref and nothing ahead of main: no-op without calling the lander", async () => {
  const root = makeRepo(); // nothing pinned, branch at main
  const wt = await ensureWorktree(root, ROLE, "main");
  const { ctx, landed } = makeCtx(root, wt);

  assert.equal(await recoverLeftover(ctx), null);

  assert.equal(landed.length, 0, "the lander never runs when there is no pin and nothing ahead");
});

test("a pinned commit not in main is re-landed through the lander", async () => {
  const { root, sha } = await pinnedFixture();
  const wt = await ensureWorktree(root, ROLE, "main"); // branch at main: only the pin matters
  const { ctx, landed, metas } = makeCtx(root, wt);

  assert.equal(await recoverLeftover(ctx), "changed", "the lander's outcome passes through");
  assert.deepEqual(landed, [sha], "the lander gets exactly the pinned sha");
  assert.deepEqual(metas, [{ body: undefined, highFriction: undefined }], "a routine commit carries no recovered metadata");
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
  const { ctx, landed, metas } = makeCtx(root, wt);

  assert.equal(await recoverLeftover(ctx), "changed");
  assert.deepEqual(landed, [sha]);
  assert.equal(metas[0]?.highFriction, true, "the Friction trailer sets the review flag");
  assert.equal(
    metas[0]?.body,
    "WHY: the fix was fiddly\nRISK: touches the landing path\nVERIFIED: npm test, all pass",
    "the commit body rides into the review gate",
  );
});

test("a stale ref already contained in main is deleted without a landing run", async () => {
  const { root, sha } = await pinnedFixture();
  // Simulate the crash window: the work landed on main but the ref deletion never ran.
  sh(root, "git", "merge", "--ff-only", "stray");
  assert.ok(await isMergedInto(root, sha, "main"), "fixture sanity: the pin is now contained in main");
  const wt = await ensureWorktree(root, ROLE, "main");
  const { ctx, landed } = makeCtx(root, wt);

  assert.equal(await recoverLeftover(ctx), null);

  assert.equal(landed.length, 0, "contained work is never re-landed");
  assert.equal(await refSha(root, landingRefName(ROLE)), null, "the stale pin was cleaned up");
});

test("a non-terminal landing outcome passes through unchanged (no throw)", async () => {
  const { root } = await pinnedFixture();
  // merge_conflict keeps the ref for next-tick recovery — that bookkeeping is the lander's;
  // recoverLeftover must neither swallow it nor treat it as an error.
  const wt = await ensureWorktree(root, ROLE, "main");
  const { ctx, landed } = makeCtx(root, wt, "merge_conflict");

  assert.equal(await recoverLeftover(ctx), "merge_conflict", "the caller sees the abort/conflict to act on");
  assert.equal(landed.length, 1);
});

test("an unpinned commit ahead of main (crash in the commit→pin window) is adopted and recovered from the branch tip", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "unpinned work\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "committed but the pin write never happened");
  const tip = sh(wt, "git", "rev-parse", "HEAD").trim();
  assert.equal(await refSha(root, landingRefName(ROLE)), null, "fixture sanity: no pin exists");
  const { ctx, landed } = makeCtx(root, wt);

  assert.equal(await recoverLeftover(ctx), "changed");
  assert.deepEqual(landed, [tip], "the branch tip is the sha to re-land when no pin survived");
  // The unpinned commit was adopted into the pin scheme: an under-cap review failure would keep
  // this ref for the strike cap's retry exactly as for a normally pinned one. (The fake lander
  // does not delete it, so it is still here.)
  assert.equal(await refSha(root, landingRefName(ROLE)), tip, "the fallback adopts the pin");
});

test("a failed pin adoption is logged, and the landing proceeds with the branch tip anyway", async () => {
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
    const { ctx, landed } = makeCtx(root, wt);

    assert.equal(await recoverLeftover(ctx), "changed", "a failed adoption never stops the landing");
    assert.deepEqual(landed, [tip], "the lander still gets the branch tip");
    assert.equal(await refSha(root, landingRefName(ROLE)), null, "no pin was created");
    // The failed adoption is recorded for the transcript, not swallowed.
    const events = fs
      .readFileSync(eventsLogPath(root), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const warn = events.find((e) => e.type === "warning");
    assert.ok(warn, "the adoption failure is logged as a warning event");
    assert.match(String(warn.message), /failed to adopt unpinned leftover/);
    assert.equal(warn.loop, ROLE);
  } finally {
    sh(root, "chmod", "-R", "u+w", ".git");
  }
});

test("an unreadable ref read and an unreadable worktree both read as no leftover: no lander call", async () => {
  const root = tmpdir(); // not a git repo at all — every git command in it fails
  const bogusWt = tmpdir();
  const { ctx, landed } = makeCtx(root, bogusWt);

  assert.equal(await recoverLeftover(ctx), null, "a failed ref read never reaches the lander");
  assert.equal(landed.length, 0);
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
