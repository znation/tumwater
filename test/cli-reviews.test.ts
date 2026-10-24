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

test("reviews prints an entry's waiting age and omits it for an entry without a timestamp", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews age test");
  writeFileDeep(
    postReviewPath(repo),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "tidy the parser", enqueuedAt: Date.now() - 3_600_000 },
        { commit: "b".repeat(40), role: "clean", summary: "rejected", rejected: ["no tests"] },
      ],
    }),
  );
  const r = await cli(repo, "reviews");
  assert.equal(r.code, 0);
  // The enqueued entry prints `1. improve sha · <age> ago · tidy the parser`; the no-timestamp
  // entry prints no age between its sha and its summary — the same `\d+s ago` regex convention
  // test/cli-queue.test.ts pins `tumwater queue`'s age with.
  assert.match(
    r.stdout,
    new RegExp(`1\\. improve ${'a'.repeat(8)} · \\d+[mhd] ago · tidy the parser`),
  );
  assert.match(r.stdout, new RegExp(`2\\. clean ${'b'.repeat(8)} · rejected · \\[rejected — waiting to revert: no tests\\]`));
});

test("reviews --role keeps only the listed roles' entries under their whole-queue positions", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews role test");
  seed(repo); // improve then clean

  const scoped = await cli(repo, "reviews", "--role", "clean");
  assert.equal(scoped.code, 0);
  assert.match(scoped.stdout, /post-merge review queue \(1 of 2, --role clean\):/);
  assert.match(scoped.stdout, /\n\s+2\. clean/);
  assert.ok(!scoped.stdout.includes("improve"), "only the clean entry prints");

  const nomatch = await cli(repo, "reviews", "--role", "feature");
  assert.equal(nomatch.code, 0);
  assert.match(nomatch.stdout, /no post-merge reviews for feature \(post-merge review queue holds 2\)/);

  const json = await cli(repo, "reviews", "--json", "--role", "clean");
  assert.equal(json.code, 0);
  const doc = JSON.parse(json.stdout) as { pending: { role: string }[] };
  assert.equal(doc.pending.length, 1);
  assert.equal(doc.pending[0]!.role, "clean");

  const accept = await cli(repo, "reviews", "--accept", "1", "--role", "clean");
  assert.notEqual(accept.code, 0);
  assert.match(accept.stderr, /--role/);
  assert.deepEqual(
    readPostReviews(repo).map((e) => e.role),
    ["improve", "clean"],
    "a refused --role accept changes nothing",
  );
});

test("reviews --status keeps only the listed states under their whole-queue positions", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews status test");
  seed(repo); // improve (waiting) then clean (rejected)

  const rejected = await cli(repo, "reviews", "--status", "rejected");
  assert.equal(rejected.code, 0);
  assert.match(rejected.stdout, /post-merge review queue \(1 of 2, --status rejected\):/);
  assert.match(rejected.stdout, /\n\s+2\. clean/);
  assert.ok(!rejected.stdout.includes("improve"), "only the rejected entry prints");

  const waiting = await cli(repo, "reviews", "--status", "waiting");
  assert.equal(waiting.code, 0);
  assert.match(waiting.stdout, /post-merge review queue \(1 of 2, --status waiting\):/);
  assert.match(waiting.stdout, /\n\s+1\. improve/);
  assert.ok(!waiting.stdout.includes("clean"), "only the waiting entry prints");

  const failing = await cli(repo, "reviews", "--status", "failing");
  assert.equal(failing.code, 0);
  assert.match(failing.stdout, /no post-merge reviews matching --status failing \(post-merge review queue holds 2\)/);

  const composed = await cli(repo, "reviews", "--status", "rejected", "--role", "clean");
  assert.equal(composed.code, 0);
  assert.match(composed.stdout, /post-merge review queue \(1 of 2, --role clean --status rejected\):/);
  assert.match(composed.stdout, /\n\s+2\. clean/);
  assert.ok(!composed.stdout.includes("improve"));

  const json = await cli(repo, "reviews", "--json", "--status", "rejected");
  assert.equal(json.code, 0);
  const doc = JSON.parse(json.stdout) as { pending: { role: string }[] };
  assert.equal(doc.pending.length, 1);
  assert.equal(doc.pending[0]!.role, "clean");

  const bogus = await cli(repo, "reviews", "--status", "bogus");
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.stderr, /waiting/);
  assert.match(bogus.stderr, /failing/);
  assert.match(bogus.stderr, /rejected/);
  assert.deepEqual(
    readPostReviews(repo).map((e) => e.role),
    ["improve", "clean"],
    "a refused --status value changes nothing",
  );

  const acceptStatus = await cli(repo, "reviews", "--accept", "1", "--status", "rejected");
  assert.notEqual(acceptStatus.code, 0);
  assert.match(acceptStatus.stderr, /--status/);
  assert.deepEqual(
    readPostReviews(repo).map((e) => e.role),
    ["improve", "clean"],
    "a refused --status accept changes nothing",
  );
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

function seedAccept(repo: string): void {
  writeFileDeep(
    postReviewPath(repo),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
        { commit: "b".repeat(40), role: "clean", summary: "rework the docs" },
        { commit: "c".repeat(40), role: "coverage", summary: "add integration tests" },
      ],
    }),
  );
}

test("reviews --accept <n> removes the entry and prints the accepted line", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews accept test");
  seedAccept(repo);
  const r = await cli(repo, "reviews", "--accept", "2");
  assert.equal(r.code, 0);
  assert.match(
    r.stdout,
    new RegExp(`accepted post-merge review entry 2 unreviewed: clean ${"b".repeat(8)} — rework the docs`),
  );
  assert.deepEqual(
    readPostReviews(repo).map((e) => e.role),
    ["improve", "coverage"],
    "the accepted entry is gone, the others keep order",
  );
});

test("reviews --accept <n> --json prints the accepted object", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews accept json test");
  seedAccept(repo);
  const r = await cli(repo, "reviews", "--accept", "2", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as { accepted: { role: string; commit: string; summary: string } };
  assert.deepEqual(doc.accepted, {
    role: "clean",
    commit: "b".repeat(40),
    summary: "rework the docs",
  });
});

test("reviews --accept failures leave the file unchanged", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews accept fail test");
  seedAccept(repo);
  const before = readPostReviews(repo);

  const noPos = await cli(repo, "reviews", "--accept");
  assert.notEqual(noPos.code, 0);
  assert.match(noPos.stderr, /--accept needs a position number/);
  assert.deepEqual(readPostReviews(repo), before, "missing position changes no file");

  const outOfRange = await cli(repo, "reviews", "--accept", "9");
  assert.notEqual(outOfRange.code, 0);
  assert.match(outOfRange.stderr, /no post-merge review at position 9 \(post-merge review queue holds 3\)/);
  assert.deepEqual(readPostReviews(repo), before, "out-of-range changes no file");

  const bogus = await cli(repo, "reviews", "--accept", "1", "--bogus");
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.stderr, /--bogus/);
  assert.deepEqual(readPostReviews(repo), before, "unknown flag changes no file");
});

test("reviews --accept refuses a rejected entry", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews accept reject test");
  seed(repo); // position 2 is clean, rejected
  const before = readPostReviews(repo);
  const r = await cli(repo, "reviews", "--accept", "2");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /post-merge review 2 is rejected and waiting on its revert — let the revert run, then review the revision/);
  assert.deepEqual(readPostReviews(repo), before, "a rejected entry changes no file");
});
