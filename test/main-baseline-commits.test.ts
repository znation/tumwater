import test from "node:test";
import assert from "node:assert/strict";
import { baselineCache, commitsAboveFullGreen } from "../src/baseline/main-baseline.js";
import { headSha, makeRepo, seedCommit } from "./fixtures/repo-fixtures.js";

// commitsAboveFullGreen (src/baseline/main-baseline.ts) names the first-parent commits strictly
// above the newest cached FULL-check-green verdict (oldest-first) — the range a fresh red's
// opener is bisected across (main-watch settleOpener, Hourly full check part 3a/4, INV-AZ4).
// Only a full check stamps `checkedAt`, so an inherited or merge-seeded green and a red full
// check never anchor the range. It gained real callers in the 2026-11-02 guardrail fix but had
// no direct tests: the spell suite reaches it only through the full watch machinery, and none
// of its anchor edges (tip-is-anchor, no anchor, a skipped red/inherited verdict above the
// anchor, a failed walk) is pinned. The mirror is per-process (one worker per test file), and
// every repo a process makes shares one seed-commit sha, so each test clears the cache and
// anchors only the content commits it just made.

/** A repo on `main` whose first-parent chain is the seed commit a, then b, c, d, and e, with
 * tip e. Newest-first the `--first-parent` walk reads e, d, c, b, a. */
function chain(): { repo: string; a: string; b: string; c: string; d: string; e: string } {
  const repo = makeRepo();
  const a = headSha(repo);
  seedCommit(repo, "b.txt", "b\n", "B");
  const b = headSha(repo);
  seedCommit(repo, "c.txt", "c\n", "C");
  const c = headSha(repo);
  seedCommit(repo, "d.txt", "d\n", "D");
  const d = headSha(repo);
  seedCommit(repo, "e.txt", "e\n", "E");
  const e = headSha(repo);
  return { repo, a, b, c, d, e };
}

test("commitsAboveFullGreen lists the commits above a mid-chain full-check green, oldest-first", async () => {
  const { repo, c, d, e } = chain();
  baselineCache.clear();
  baselineCache.set(c, { status: "green", sha: c, checkedAt: 7 });
  // Anchor c sits at walk index 2 in [e, d, c, b, a]; its child d through the tip e is the range.
  assert.deepEqual(await commitsAboveFullGreen(repo, e), [d, e]);
});

test("commitsAboveFullGreen returns an empty range when the tip is itself the newest full-check green", async () => {
  const { repo, e } = chain();
  baselineCache.clear();
  baselineCache.set(e, { status: "green", sha: e, checkedAt: 1 });
  assert.deepEqual(await commitsAboveFullGreen(repo, e), []);
});

test("commitsAboveFullGreen returns an empty range when no checkedAt green anchors the walk", async () => {
  const { repo, c, d, e } = chain();
  baselineCache.clear();
  baselineCache.set(d, { status: "red", sha: d, checkedAt: 1 }); // a red full check: no anchor
  baselineCache.set(c, { status: "green", sha: c }); // inherited green, no checkedAt: no anchor
  assert.deepEqual(await commitsAboveFullGreen(repo, e), []);
});

test("commitsAboveFullGreen skips a newer red check and an inherited green, anchoring on the next full-check green", async () => {
  const { repo, b, c, d, e } = chain();
  baselineCache.clear();
  baselineCache.set(d, { status: "red", sha: d, checkedAt: 1 }); // red full check, not an anchor
  baselineCache.set(c, { status: "green", sha: c }); // inherited green (no checkedAt), not an anchor
  baselineCache.set(b, { status: "green", sha: b, checkedAt: 3 }); // the newest full-check green
  // Anchor b sits at walk index 3; its child c through the tip e is the range.
  assert.deepEqual(await commitsAboveFullGreen(repo, e), [c, d, e]);
});

test("commitsAboveFullGreen returns an empty range when the git walk fails", async () => {
  const repo = makeRepo();
  baselineCache.clear();
  assert.deepEqual(await commitsAboveFullGreen(repo, "does-not-exist"), []);
});
