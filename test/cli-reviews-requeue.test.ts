import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { eventsLogPath, postReviewPath } from "../src/paths.js";
import { DAY_MS, dayKey } from "../src/text/datetime.js";
import { headSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// `tumwater reviews --requeue-dropped --since <day>`: the dropped post-merge reviews the event log
// names go back into the queue. Each test writes its own fixture events and commits on main.

function writeEvents(repo: string, events: Record<string, unknown>[]): void {
  writeFileDeep(eventsLogPath(repo), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function commitOnMain(repo: string, subject: string): string {
  sh(repo, "git", "commit", "--allow-empty", "-q", "-m", subject);
  return headSha(repo);
}

test("requeue-dropped queues a review_dropped commit and a legacy drop warning, then queues nothing on a second run", async () => {
  const repo = makeRepo();
  await initProject(repo, "requeue dropped test");
  const today = dayKey(Date.now());
  const fixed = commitOnMain(repo, "fix the parser");
  const tidied = commitOnMain(repo, "tidy the cache");
  writeEvents(repo, [
    { ts: Date.now(), source: "clean", type: "review_dropped", commit: fixed, summary: "fix the parser" },
    { ts: Date.now(), source: "improve", type: "warning", message: `dropping the post-merge review of ${tidied.slice(0, 8)} after 3 failed runs; it stays on main unreviewed` },
  ]);

  const first = await cli(repo, "reviews", "--requeue-dropped", "--since", today);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /queued 2 dropped post-merge reviews/);
  assert.deepEqual(
    readPostReviews(repo).map((e) => ({ commit: e.commit, role: e.role, summary: e.summary })),
    [
      { commit: fixed, role: "clean", summary: "fix the parser" },
      { commit: tidied, role: "improve", summary: "tidy the cache" },
    ],
  );

  const second = await cli(repo, "reviews", "--requeue-dropped", "--since", today);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /queued 0 dropped post-merge reviews/);
  assert.match(second.stdout, /skipped 2 already in the queue/);
  assert.equal(readPostReviews(repo).length, 2, "a second run leaves the queue as it was");
});

test("requeue-dropped skips a drop before --since, a commit not on main and an unresolved short sha, and counts each", async () => {
  const repo = makeRepo();
  await initProject(repo, "requeue skips test");
  const today = dayKey(Date.now());
  const old = commitOnMain(repo, "older change");
  const offMain = "f".repeat(40);
  writeEvents(repo, [
    { ts: Date.now() - 3 * DAY_MS, source: "clean", type: "review_dropped", commit: old, summary: "older change" },
    { ts: Date.now(), source: "clean", type: "review_dropped", commit: offMain, summary: "not on main" },
    { ts: Date.now(), source: "improve", type: "warning", message: "dropping the post-merge review of 0000000 after 3 failed runs; it stays on main unreviewed" },
  ]);

  const r = await cli(repo, "reviews", "--requeue-dropped", "--since", today, "--json");
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { since: string; queued: number; skipped: Record<string, number> };
  assert.equal(out.since, today);
  assert.equal(out.queued, 0);
  assert.deepEqual(out.skipped, { alreadyQueued: 0, notOnMain: 1, unresolved: 1 });
  assert.equal(fs.existsSync(postReviewPath(repo)), false, "nothing is queued, so the queue file is not written");
});

test("requeue-dropped refuses a missing or malformed --since and a combined mode, and changes nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "requeue usage test");
  const today = dayKey(Date.now());
  const fixed = commitOnMain(repo, "fix the parser");
  writeEvents(repo, [{ ts: Date.now(), source: "clean", type: "review_dropped", commit: fixed, summary: "fix the parser" }]);

  const missing = await cli(repo, "reviews", "--requeue-dropped");
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /--since/);

  const impossible = await cli(repo, "reviews", "--requeue-dropped", "--since", "2026-02-30");
  assert.notEqual(impossible.code, 0);
  assert.match(impossible.stderr, /YYYY-MM-DD/);

  const combined = await cli(repo, "reviews", "--requeue-dropped", "--since", today, "--role", "clean");
  assert.notEqual(combined.code, 0);
  assert.match(combined.stderr, /does not combine/);

  assert.equal(fs.existsSync(postReviewPath(repo)), false, "a refused invocation writes no queue");
});
