import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { postReviewPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// The `reviews` command: the post-merge review queue, via the CLI the way cli-queue.test.ts
// tests `queue` — an initialized repo, child-process runs, output assertions.

function seed(repo: string): void {
  writeFileDeep(
    postReviewPath(repo),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
        { commit: "b".repeat(40), role: "clean", summary: "rejected", rejected: ["no tests"] },
      ],
    }),
  );
}

test("with no post-review file, reviews prints the empty line and exits 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews empty test");
  assert.ok(!fs.existsSync(postReviewPath(repo)), "no post-review file yet");
  const r = await cli(repo, "reviews");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "post-merge review queue empty");
});

test("reviews lists each entry in FIFO order with its role, sha, summary and status", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews list test");
  seed(repo);
  const r = await cli(repo, "reviews");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /post-merge review queue \(2 entries\):/);
  assert.ok(r.stdout.indexOf("1. improve") < r.stdout.indexOf("2. clean"), "improve first, FIFO");
  assert.match(r.stdout, /rejected — waiting to revert: no tests/);
});

test("reviews --json prints the normalized pending list", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews json test");
  seed(repo);
  const r = await cli(repo, "reviews", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as { pending: { commit: string; role: string; summary: string; rejected?: string[] }[] };
  assert.equal(doc.pending.length, 2);
  assert.deepEqual(
    doc.pending.map((p) => [p.role, p.rejected]),
    [
      ["improve", undefined],
      ["clean", ["no tests"]],
    ],
  );
  assert.equal(doc.pending[0]!.commit, "a".repeat(40));
  assert.equal(doc.pending[0]!.summary, "tidy the parser");
});

test("a torn entry is dropped but the rest render", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews torn test");
  writeFileDeep(
    postReviewPath(repo),
    JSON.stringify({ pending: [{ commit: 7 }, { commit: "c".repeat(40), role: "feature", summary: "ok" }] }),
  );
  const r = await cli(repo, "reviews");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1\. feature/);
  assert.ok(!r.stdout.includes("7"), "the torn entry is dropped");
});

test("reviews --bogus exits nonzero naming the flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews flag test");
  const r = await cli(repo, "reviews", "--bogus");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--bogus/);
});

test("reviews is read-only: readPostReviews reads back the same entries", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews readonly test");
  seed(repo);
  const before = readPostReviews(repo);
  await cli(repo, "reviews");
  const after = readPostReviews(repo);
  assert.deepEqual(after, before);
  assert.equal(after.length, 2);
});
