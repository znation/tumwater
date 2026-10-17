import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { enqueueLanding, type LandingEntry } from "../src/landing/landing-queue.js";
import path from "node:path";
import { landQueueDir, landingStatePath, orchestratorStatePath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The `queue` command: the durable merge queue in execution order, via the CLI the way the
// cli-diff tests `diff` — an initialized repo, child-process runs, output assertions.

function entry(role: string, sha: string, run = 1, summary = `summary from ${role} #${run}`): LandingEntry {
  return { role, sha, run, summary, enqueuedAt: Date.now() };
}

test("an empty queue prints the empty line and exits 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue empty test");
  assert.ok(!fs.existsSync(landQueueDir(repo)), "no queue dir yet");
  const r = await cli(repo, "queue");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "merge queue empty");
});

test("queue lists each waiting landing in execution order with its fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue list test");
  enqueueLanding(repo, entry("improve", "a".repeat(40), 3, "tidy the parser"));
  enqueueLanding(repo, entry("organize", "b".repeat(40), 4, "split the module"));
  const r = await cli(repo, "queue");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "merge queue (2):");
  // Oldest first, one 1-based line each: role, tick, short sha, age, and summary.
  assert.match(lines[1]!, /^  1\. improve run #3 · aaaaaaaa · \d+s ago · tidy the parser$/);
  assert.match(lines[2]!, /^  2\. organize run #4 · bbbbbbbb · \d+s ago · split the module$/);
});

test("queue --json prints the collector's {entries, unreadable} document with raw fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue json test");
  const sha = "c".repeat(40);
  const before = Date.now();
  enqueueLanding(repo, entry("improve", sha, 7, "raw payload"));
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
  enqueueLanding(repo, entry("improve", sha, 3, "tidy the parser"));
  const marker = { role: "improve", sha, summary: "tidy", startedAt: Date.now() - 120_000, stage: "reviewing" };
  fs.mkdirSync(path.dirname(landingStatePath(repo)), { recursive: true });
  fs.writeFileSync(landingStatePath(repo), JSON.stringify(marker));
  const stopped = await cli(repo, "queue");
  assert.doesNotMatch(stopped.stdout, /\[landing/, "no orchestrator alive: today's line");
  assert.equal(JSON.parse((await cli(repo, "queue", "--json")).stdout).inFlight, undefined);
  // This test process stands in for a live orchestrator (its pid is alive).
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(orchestratorStatePath(repo), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const live = await cli(repo, "queue");
  assert.match(live.stdout, /ago · \[merging 2m · reviewing\] · tidy the parser/);
  assert.equal(JSON.parse((await cli(repo, "queue", "--json")).stdout).inFlight.sha, sha);
});
