import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { enqueueMerge, type MergeEntry } from "../src/merge/merge-queue.js";
import { scopeMergeQueue } from "../src/merge/merge-queue-render.js";
import { mergeQueueDir, mergeStatePath, orchestratorStatePath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// The `queue` command: the durable merge queue in execution order, via the CLI the way the
// cli-diff tests `diff` — an initialized repo, child-process runs, output assertions.

function entry(role: string, sha: string, run = 1, summary = `summary from ${role} #${run}`): MergeEntry {
  return { role, sha, run, summary, enqueuedAt: Date.now() };
}

test("an empty queue prints the empty line and exits 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue empty test");
  assert.ok(!fs.existsSync(mergeQueueDir(repo)), "no queue dir yet");
  const r = await cli(repo, "queue");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "merge queue empty");
});

test("queue lists each waiting merge in execution order with its fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue list test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 3, "tidy the parser"));
  enqueueMerge(repo, entry("organize", "b".repeat(40), 4, "split the module"));
  const r = await cli(repo, "queue");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "merge queue (2):");
  // Oldest first, one 1-based line each: role, run, short sha, age, and summary.
  assert.match(lines[1]!, /^  1\. improve run #3 · aaaaaaaa · \d+s ago · tidy the parser$/);
  assert.match(lines[2]!, /^  2\. organize run #4 · bbbbbbbb · \d+s ago · split the module$/);
});

test("queue --json prints the collector's {entries, unreadable} document with raw fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue json test");
  const sha = "c".repeat(40);
  const before = Date.now();
  enqueueMerge(repo, entry("improve", sha, 7, "raw payload"));
  const r = await cli(repo, "queue", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as {
    entries: Array<{ role: string; sha: string; run: number; summary: string; enqueuedAt: number }>;
    unreadable: number;
  };
  assert.equal(payload.unreadable, 0);
  assert.equal(payload.entries.length, 1);
  const e = payload.entries[0]!;
  assert.equal(e.role, "improve");
  assert.equal(e.sha, sha, "the raw sha, not the render's short form");
  assert.equal(e.run, 7);
  assert.ok(!("tick" in e));
  assert.equal(e.summary, "raw payload");
  assert.ok(typeof e.enqueuedAt === "number" && e.enqueuedAt >= before, "numeric enqueuedAt");
});

test("queue rejects an unknown flag, naming it", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue flag test");
  const r = await cli(repo, "queue", "--wat");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--wat"));
});

test("queue prints the in-flight label only while an orchestrator is alive", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue inflight test");
  const sha = "a".repeat(40);
  enqueueMerge(repo, entry("improve", sha, 3, "tidy the parser"));
  const marker = { role: "improve", sha, summary: "tidy", startedAt: Date.now() - 120_000, stage: "reviewing" };
  writeFileDeep(mergeStatePath(repo), JSON.stringify(marker));
  const stopped = await cli(repo, "queue");
  assert.doesNotMatch(stopped.stdout, /\[merge/, "no orchestrator alive: today's line");
  assert.equal(JSON.parse((await cli(repo, "queue", "--json")).stdout).inFlight, undefined);
  // This test process stands in for a live orchestrator (its pid is alive).
  writeFileDeep(orchestratorStatePath(repo), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const live = await cli(repo, "queue");
  assert.match(live.stdout, /ago · \[merging 2m · reviewing\] · tidy the parser/);
  assert.equal(JSON.parse((await cli(repo, "queue", "--json")).stdout).inFlight.sha, sha);
});

async function scopedQueueRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "queue role test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 1));
  enqueueMerge(repo, entry("feature-2", "b".repeat(40), 2));
  enqueueMerge(repo, entry("organize", "c".repeat(40), 3));
  enqueueMerge(repo, entry("feature", "d".repeat(40), 4));
  return repo;
}

test("queue --role lists only the listed roles' merges under their whole-queue positions", async () => {
  const repo = await scopedQueueRepo();
  const r = await cli(repo, "queue", "--role", "feature");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "merge queue (2 of 4, --role feature):");
  assert.match(lines[1]!, /^  2\. feature #2 run #2 · /);
  assert.match(lines[2]!, /^  4\. feature run #4 · /);
  const other = (await cli(repo, "queue", "--role", "improve,organize")).stdout.trimEnd().split("\n");
  assert.match(other[1]!, /^  1\. improve /);
  assert.match(other[2]!, /^  3\. organize /);
});

test("queue --role with no matching merge names the role and the queue depth", async () => {
  const repo = await scopedQueueRepo();
  const r = await cli(repo, "queue", "--role", "clean");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no queued merges for clean (merge queue holds 4)");
  const empty = makeRepo();
  await initProject(empty, "queue role empty");
  const e = await cli(empty, "queue", "--role", "clean");
  assert.equal(e.code, 0);
  assert.equal(e.stdout.trim(), "merge queue empty");
});

test("queue --role --json filters entries and keeps the unreadable count", async () => {
  const repo = await scopedQueueRepo();
  const r = await cli(repo, "queue", "--role", "feature", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as { entries: Array<{ role: string }>; unreadable: number };
  assert.deepEqual(doc.entries.map((e) => e.role), ["feature-2", "feature"]);
  assert.equal(doc.unreadable, 0);
});

test("queue --role rejects an unknown or empty role id", async () => {
  const repo = await scopedQueueRepo();
  const bad = await cli(repo, "queue", "--role", "nosuch");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /nosuch/);
  assert.notEqual((await cli(repo, "queue", "--role", "")).code, 0);
});

test("scopeMergeQueue keeps the matching entries under their whole-queue positions", () => {
  const whole = { entries: [entry("feature", "a".repeat(40)), entry("clean", "b".repeat(40)), entry("clean-2", "c".repeat(40))], unreadable: 1 };
  const { view, scope } = scopeMergeQueue(whole, ["clean"], (r) => r === "clean");
  assert.deepEqual(view.entries.map((e) => e.role), ["clean"]);
  assert.deepEqual(scope.positions, [2]);
  assert.equal(scope.total, 3);
  assert.equal(view.unreadable, 1);
});

test("queue --cancel <n> removes the entry and prints the cancelled line, leaving an empty queue", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue cancel test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 1, "tidy the parser"));
  enqueueMerge(repo, entry("organize", "b".repeat(40), 2, "split the module"));
  const r = await cli(repo, "queue", "--cancel", "1");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "cancelled queue entry 1: improve aaaaaaaa — tidy the parser");
  const after = await cli(repo, "queue");
  assert.equal(after.code, 0);
  const lines = after.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "merge queue (1):");
  assert.match(lines[1]!, /^  1\. organize run #2 /);
});

test("queue --cancel --json prints the cancelled object", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue cancel json test");
  enqueueMerge(repo, entry("organize", "b".repeat(40), 2, "split the module"));
  const r = await cli(repo, "queue", "--cancel", "1", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { cancelled: { role: string; commit: string; summary: string } };
  assert.deepEqual(payload.cancelled, { role: "organize", commit: "b".repeat(40), summary: "split the module" });
  assert.equal((await cli(repo, "queue")).stdout.trim(), "merge queue empty");
});

test("queue --cancel refuses --role, -f/--follow, and an unknown flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue cancel refuse test");
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const role = await cli(repo, "queue", "--role", "improve", "--cancel", "1");
  assert.notEqual(role.code, 0);
  assert.match(role.stderr, /tumwater queue/);
  for (const flag of ["-f", "--follow"]) {
    const follow = await cli(repo, "queue", flag, "--cancel", "1");
    assert.notEqual(follow.code, 0);
    assert.match(follow.stderr, /repaints a live view/);
  }
  const wat = await cli(repo, "queue", "--cancel", "1", "--wat");
  assert.notEqual(wat.code, 0);
  assert.match(wat.stderr, /--wat/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(1\):\n  1\. improve /, "a refused cancel changes nothing");
});

test("queue --cancel with an out-of-range position fails naming the depth", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue cancel range test");
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  enqueueMerge(repo, entry("organize", "b".repeat(40)));
  const r = await cli(repo, "queue", "--cancel", "7");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no queued merge at position 7 \(merge queue holds 2\)/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(2\):\n  1\. improve /, "out-of-range changes nothing");
});

test("queue --cancel refuses an entry a live merge marker names", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue cancel inflight test");
  const sha = "a".repeat(40);
  enqueueMerge(repo, entry("improve", sha, 3, "tidy the parser"));
  // This test process stands in for a live orchestrator (its pid is alive); the marker names
  // the queued sha mid-merge.
  writeFileDeep(orchestratorStatePath(repo), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  writeFileDeep(mergeStatePath(repo), JSON.stringify({ role: "improve", sha, summary: "tidy", startedAt: Date.now() - 120_000, stage: "reviewing" }));
  const r = await cli(repo, "queue", "--cancel", "1");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /queue entry 1 is being merged right now — wait for it to land, then `tumwater revert aaaaaaaa`/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(1\):\n  1\. improve /, "the refusal changes nothing");
});

test("queue --top <n> moves the entry to the front and prints the moved line", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 1, "tidy the parser"));
  enqueueMerge(repo, entry("organize", "b".repeat(40), 2, "split the module"));
  enqueueMerge(repo, entry("feature", "c".repeat(40), 3, "add the widget"));
  const r = await cli(repo, "queue", "--top", "3");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "moved queue entry 3 to the front: feature cccccccc — add the widget");
  const after = await cli(repo, "queue");
  assert.equal(after.code, 0);
  const lines = after.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "merge queue (3):");
  assert.match(lines[1]!, /^  1\. feature /, "the moved entry is now at position 1");
  assert.match(lines[2]!, /^  2\. improve /);
  assert.match(lines[3]!, /^  3\. organize /);
});

test("queue --top 1 prints the already-first line and exits 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top first test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 1, "tidy the parser"));
  enqueueMerge(repo, entry("organize", "b".repeat(40), 2, "split the module"));
  const r = await cli(repo, "queue", "--top", "1");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queue entry 1 is already first: improve aaaaaaaa — tidy the parser/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(2\):\n  1\. improve /, "a no-op changes nothing");
});

test("queue --top --json prints the topped object", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top json test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 1, "tidy the parser"));
  enqueueMerge(repo, entry("organize", "b".repeat(40), 2, "split the module"));
  const r = await cli(repo, "queue", "--top", "2", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { topped: { role: string; commit: string; summary: string } };
  assert.deepEqual(payload.topped, { role: "organize", commit: "b".repeat(40), summary: "split the module" });
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(2\):\n  1\. organize /);
});

test("queue --top --json prints an already-first key for a no-op position 1", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top json first test");
  enqueueMerge(repo, entry("improve", "a".repeat(40), 1, "tidy the parser"));
  const r = await cli(repo, "queue", "--top", "1", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { "already-first": { role: string; commit: string; summary: string } };
  assert.deepEqual(payload["already-first"], { role: "improve", commit: "a".repeat(40), summary: "tidy the parser" });
  assert.equal("topped" in payload, false, "a no-op must not be reported as topped");
});

test("queue --top with an out-of-range position fails naming the depth", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top range test");
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  enqueueMerge(repo, entry("organize", "b".repeat(40)));
  const r = await cli(repo, "queue", "--top", "9");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no queued merge at position 9 \(merge queue holds 2\)/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(2\):\n  1\. improve /, "out-of-range changes nothing");
});

test("queue --top refuses --role, -f/--follow, and an unknown flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top refuse test");
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const role = await cli(repo, "queue", "--role", "improve", "--top", "1");
  assert.notEqual(role.code, 0);
  assert.match(role.stderr, /tumwater queue/);
  for (const flag of ["-f", "--follow"]) {
    const follow = await cli(repo, "queue", flag, "--top", "1");
    assert.notEqual(follow.code, 0);
    assert.match(follow.stderr, /repaints a live view/);
  }
  const wat = await cli(repo, "queue", "--top", "1", "--wat");
  assert.notEqual(wat.code, 0);
  assert.match(wat.stderr, /--wat/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(1\):\n  1\. improve /, "a refused top changes nothing");
});

test("queue --top refuses an entry a live merge marker names", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue top inflight test");
  const sha = "a".repeat(40);
  enqueueMerge(repo, entry("improve", sha, 3, "tidy the parser"));
  enqueueMerge(repo, entry("organize", "b".repeat(40), 2, "split the module"));
  writeFileDeep(orchestratorStatePath(repo), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  writeFileDeep(mergeStatePath(repo), JSON.stringify({ role: "organize", sha: "b".repeat(40), summary: "split", startedAt: Date.now() - 120_000, stage: "reviewing" }));
  const r = await cli(repo, "queue", "--top", "2");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /queue entry 2 is being merged right now — it's already heading into the merge, so there's nothing to top/);
  assert.match((await cli(repo, "queue")).stdout, /^merge queue \(2\):\n  1\. improve /, "the refusal changes nothing");
});
