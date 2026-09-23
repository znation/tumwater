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
  const heads = [sh(root, "git", "rev-parse", "HEAD").trim()];
  for (let i = 1; i <= 201; i++) heads.push(commit(root, `tumwater(feature): work ${i}`));
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
  const heads = [sh(root, "git", "rev-parse", "HEAD").trim()];
  for (let i = 1; i <= 200; i++) heads.push(commit(root, `tumwater(organize): tidy ${i}`));
  const end = heads[heads.length - 1]!;
  const cache = new WorkLandedCache(root, "main");

  // 201 distinct since-heads each with a maintenance-only range — the insert that trips
  // noWorkAtHead's 200-entry clear, plus the two repeats below re-populating past it.
  for (const since of heads) assert.equal(await cache.since(since, end), false);
  assert.equal(await cache.since(heads[0]!, end), false, "still false after the overflow clear wiped the cache");

  const f1 = commit(root, "tumwater(feature): ship it");
  assert.equal(await cache.since(heads[0]!, f1), true, "and a main move after the clear still re-checks and flips");
});
