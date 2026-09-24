import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkLandedCache } from "../src/work-landed-cache.js";
import { makeRepo, sh } from "./util.js";

// Unit coverage for src/work-landed-cache.ts — the caching layer around scheduling.workLanded
// that the orchestrator's need-based deferral consults. The caching rule (PLANS.md
// "Prioritize loops by need") is the thing under test: a TRUE verdict is monotone under
// fast-forward-only main movement and may be cached forever; a FALSE verdict is valid exactly
// while main sits at the head it was checked against — caching it unconditionally would defer
// a role forever after the very commit that should wake it. Fixtures are real git history;
// the seed commit's subject ("seed") counts as qualifying work under workLanded, but only
// commits INSIDE the checked range are consulted, so maintenance-only ranges read false.

/** Commit (empty, subjects are all these fixtures need) and return the new head sha. */
function commit(root: string, subject: string): string {
  sh(root, "git", "commit", "--allow-empty", "-q", "-m", subject);
  return sh(root, "git", "rev-parse", "HEAD").trim();
}

/** The 200-entry bound tests below need 201 distinct since-heads; a commit()+rev-parse spawn
 * pair per head put ~50 s of fork/exec into the gate suite. One `git fast-import` stream
 * builds the whole empty-commit history instead — author/committer matching makeRepo's user
 * config, all timestamps epoch 0 (subjects are the only thing the verdicts read). Returns the
 * new commits' shas, oldest first. */
function bulkCommits(root: string, subjects: string[]): string[] {
  const base = sh(root, "git", "rev-parse", "HEAD");
  let stream = "";
  for (const [i, subject] of subjects.entries()) {
    // `from` on the first commit chains the history onto the repo's existing head; later
    // commits default their parent to the stream's previous commit on the branch.
    stream +=
      `commit refs/heads/main\nauthor test <test@example.com> 0 +0000\ncommitter test <test@example.com> 0 +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n` +
      (i === 0 ? `from ${base}\n` : "");
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: root, input: stream });
  return sh(root, "git", "rev-list", "--reverse", "refs/heads/main").split("\n");
}

test("a false verdict is cached at the main head it was checked against, and re-checked once main moves", async () => {
  const root = makeRepo();
  const base = sh(root, "git", "rev-parse", "HEAD").trim();
  const m1 = commit(root, "tumwater(organize): tidy"); // maintenance-only since base
  const cache = new WorkLandedCache(root, "main");

  assert.equal(await cache.since(base, m1), false, "only maintenance work has landed since base");

  const f1 = commit(root, "tumwater(feature): ship it"); // main moves; the range now holds work
  assert.equal(
    await cache.since(base, m1),
    false,
    "a cached false is valid exactly at the head it was checked at — even though the real range has grown, the caller's stale head must not re-query",
  );
  assert.equal(await cache.since(base, f1), true, "main moved: the cached false is stale and the check runs again");
});

test("a true verdict stays true as main moves — qualifying work never un-lands", async () => {
  const root = makeRepo();
  const base = sh(root, "git", "rev-parse", "HEAD").trim();
  commit(root, "tumwater(feature): ship it");
  const m1 = commit(root, "tumwater(organize): tidy");
  const cache = new WorkLandedCache(root, "main");

  assert.equal(await cache.since(base, m1), true);
  const m2 = commit(root, "tumwater(organize): tidy again");
  assert.equal(await cache.since(base, m2), true, "still true after more maintenance-only commits land");
  assert.equal(await cache.since(m1, m2), false, "the verdict is per since-head: nothing qualifying since m1");
});

test("an unresolvable main head is never trusted or stored", async () => {
  const root = makeRepo();
  const base = sh(root, "git", "rev-parse", "HEAD").trim();
  commit(root, "tumwater(organize): tidy");
  const cache = new WorkLandedCache(root, "main");

  assert.equal(await cache.since(base, ""), false, "an empty main head still runs the real check");
  const f1 = commit(root, "tumwater(feature): ship it");
  assert.equal(
    await cache.since(base, ""),
    true,
    "the empty-head check stored nothing: the next one re-evaluates instead of serving the stale false",
  );
  assert.equal(await cache.since(base, f1), true, "a resolvable head sees the qualifying work too");
});

test("a range that cannot be evaluated reads as work landed — conservative", async () => {
  const root = makeRepo();
  const head = sh(root, "git", "rev-parse", "HEAD").trim();
  const cache = new WorkLandedCache(root, "main");
  const ghost = "0123456789abcdef0123456789abcdef01234567";

  assert.equal(await cache.since(ghost, head), true, "an unknown since-head cannot be evaluated: run the tick");
  assert.equal(
    await cache.since(ghost, head),
    true,
    "the conservative verdict is cached like a real true — it is monotone by construction",
  );
});

test("the true-verdict cache stays correct past its 200-entry bound", async () => {
  const root = makeRepo();
  const heads = [
    sh(root, "git", "rev-parse", "HEAD").trim(),
    ...bulkCommits(root, Array.from({ length: 201 }, (_, i) => `tumwater(feature): work ${i + 1}`)),
  ];
  const end = heads[heads.length - 1]!;
  const cache = new WorkLandedCache(root, "main");

  // 201 distinct since-heads each with qualifying work in range — one insert past the bound,
  // which clears the cache; every verdict must still be right afterwards.
  for (const since of heads.slice(0, -1)) assert.equal(await cache.since(since, end), true);
  assert.equal(await cache.since(heads[0]!, end), true, "still true after the overflow clear wiped the cache");
  assert.equal(await cache.since(heads[100]!, end), true);
});

test("the false-verdict cache stays correct past its 200-entry bound", async () => {
  const root = makeRepo();
  const heads = [
    sh(root, "git", "rev-parse", "HEAD").trim(),
    ...bulkCommits(root, Array.from({ length: 200 }, (_, i) => `tumwater(organize): tidy ${i + 1}`)),
  ];
  const end = heads[heads.length - 1]!;
  const cache = new WorkLandedCache(root, "main");

  // 201 distinct since-heads each with a maintenance-only range — the insert that trips
  // noWorkAtHead's 200-entry clear, plus the two repeats below re-populating past it.
  for (const since of heads) assert.equal(await cache.since(since, end), false);
  assert.equal(await cache.since(heads[0]!, end), false, "still false after the overflow clear wiped the cache");

  const f1 = commit(root, "tumwater(feature): ship it");
  assert.equal(await cache.since(heads[0]!, f1), true, "and a main move after the clear still re-checks and flips");
});
