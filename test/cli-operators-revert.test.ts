// The `tumwater revert` slice of the operator commands; cli-operators.test.ts lists the split.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { commitIn, headSha, makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { runNotFoundMessage } from "../src/run/run-detail.js";
import { writeEvents } from "./fixtures/log-fixtures.js";

// --- revert: undo one merged change on main ---
// The CLI renderer for src/operator/operator-revert.ts (its fail-closed unit surface lives in
// test/operator-revert.test.ts). Here we pin the arity gate, the exit code and printed head on
// success, and that the usage errors write no commit.

test("revert succeeds on main, prints the new head, and revers to a clean tree", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert success");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "work\n");
  commitIn(repo, "work to undo");
  const before = headSha(repo);

  const r = await cli(repo, "revert", before);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /main is now [0-9a-f]{8}/);
  assert.doesNotMatch(r.stdout, /may redo/);
  assert.notEqual(headSha(repo), before, "the revert committed the inverse");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "tree is clean after the revert");
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), `tumwater(operator): Revert ${before.slice(0, 8)}`);
});

test("revert of a role-stamped commit names that role as the one that may redo the work", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert role");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "work\n");
  commitIn(repo, "tumwater(feature): add x");
  const r = await cli(repo, "revert", headSha(repo));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /the feature role may redo the work, so cancel or edit its PLANS\.md\/BUGS\.md entry if it should not/);
});

test("revert rejects a flag-shaped token as a flag, before a lookup or a write", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert flag");
  const before = headSha(repo);

  const r = await cli(repo, "revert", "--stat");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revert takes only --dry-run, --last and --json \(got --stat\)/);
  assert.equal(headSha(repo), before, "no commit was written");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "the tree is clean");
});

test("revert --dry-run previews without writing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert dry run");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "one\n");
  commitIn(repo, "work to undo");
  const clean = headSha(repo);
  let r = await cli(repo, "revert", clean, "--dry-run");
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^would revert ${clean.slice(0, 8)}`));
  assert.match(r.stdout, /\n {2}to-undo\.txt\n/);
  assert.match(r.stdout, /applies cleanly/);
  assert.equal(headSha(repo), clean);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");

  fs.writeFileSync(path.join(repo, "to-undo.txt"), "two\n");
  commitIn(repo, "edit it again");
  const tip = headSha(repo);
  r = await cli(repo, "revert", "--dry-run", clean);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /would conflict/);
  assert.equal(headSha(repo), tip);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

test("revert --dry-run --json prints the preview as data and writes nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert dry json");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "one\n");
  commitIn(repo, "work to undo");
  const clean = headSha(repo);
  let r = await cli(repo, "revert", clean, "--dry-run", "--json");
  assert.equal(r.code, 0);
  let out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.run, null);
  assert.equal(out.sha, clean);
  assert.deepEqual(out.paths, ["to-undo.txt"]);
  assert.equal(out.applies, true);
  assert.equal(headSha(repo), clean);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");

  fs.writeFileSync(path.join(repo, "to-undo.txt"), "two\n");
  commitIn(repo, "edit it again");
  const tip = headSha(repo);
  r = await cli(repo, "revert", "--json", "--dry-run", clean);
  assert.equal(r.code, 1);
  out = JSON.parse(r.stdout);
  assert.equal(out.applies, false);
  assert.equal(headSha(repo), tip);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

test("revert --json prints the new head as data", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert json");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "work\n");
  commitIn(repo, "work to undo");
  const before = headSha(repo);
  const r = await cli(repo, "revert", before, "--json");
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, false);
  assert.equal(out.headSha, headSha(repo));
  assert.equal(out.beforeSha, before);
  assert.equal(out.followUp, null);
});

const REVERT_USAGE_RE = /revert needs a commit or a run \(usage: tumwater revert <sha>\|<role> <n>\|<role> --last \[--dry-run\] \[--json\]\)/;

test("revert with zero or three positionals fails with usage, and a sha plus extra is an unknown role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert arity");
  const before = headSha(repo);

  let r = await cli(repo, "revert");
  assert.equal(r.code, 1);
  assert.match(r.stderr, REVERT_USAGE_RE);

  r = await cli(repo, "revert", before, "extra", "more");
  assert.equal(r.code, 1);
  assert.match(r.stderr, REVERT_USAGE_RE);

  r = await cli(repo, "revert", before, "--last");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role/);

  r = await cli(repo, "revert", before, "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: [0-9a-f]{40}/);

  assert.equal(headSha(repo), before, "no usage error moved HEAD");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "no commit was written");
});

/** A repo whose `clean` run 1 merged a real commit on main, run 2 was rejected and (when
 * `zeroRun3`) run 3 merged a sha git does not have. */
async function revertRunRepo(zeroRun3: boolean): Promise<{ repo: string; merged: string }> {
  const repo = makeRepo();
  await initProject(repo, "cli revert run");
  seedCommit(repo, "to-undo.txt", "work\n", "work to undo");
  const merged = headSha(repo);
  const events: unknown[] = [
    { ts: 1000, source: "clean", type: "run_start", run: 1 },
    { ts: 1100, source: "clean", type: "merge_done", run: 1, commit: merged },
    { ts: 1200, source: "clean", type: "run_end", run: 1, result: "merged" },
    { ts: 2000, source: "clean", type: "run_start", run: 2 },
    { ts: 2100, source: "clean", type: "merge_queued", run: 2, commit: "1".repeat(40) },
    { ts: 2200, source: "clean", type: "run_end", run: 2, result: "rejected" },
  ];
  if (zeroRun3)
    events.push(
      { ts: 3000, source: "clean", type: "run_start", run: 3 },
      { ts: 3100, source: "clean", type: "merge_done", run: 3, commit: "0".repeat(40) },
      { ts: 3200, source: "clean", type: "run_end", run: 3, result: "merged" },
    );
  writeEvents(repo, events);
  return { repo, merged };
}

test("revert <role> <n> reverts the commit that run merged as", async () => {
  const { repo, merged } = await revertRunRepo(true);
  const short = merged.slice(0, 8);
  const r = await cli(repo, "revert", "clean", "1");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith(`run clean #1 merged as ${short}`), r.stdout);
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), `tumwater(operator): Revert ${short}`);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

test("revert <role> <n> --dry-run previews the run's commit and writes nothing", async () => {
  const { repo, merged } = await revertRunRepo(true);
  const before = headSha(repo);
  const r = await cli(repo, "revert", "clean", "1", "--dry-run");
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^run clean #1 merged as ${merged.slice(0, 8)}\\nwould revert ${merged.slice(0, 8)}`));
  assert.equal(headSha(repo), before);
});

test("revert <role> --last takes the newest completed run", async () => {
  const { repo } = await revertRunRepo(true);
  let r = await cli(repo, "revert", "clean", "--last", "--dry-run");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no such commit/);

  const one = await revertRunRepo(false);
  // Run 2 (rejected) is the newest here, so --last refuses it rather than skipping to run 1.
  r = await cli(one.repo, "revert", "clean", "--last", "--dry-run");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /run #2 did not merge/);

  writeEvents(one.repo, [
    { ts: 1000, source: "clean", type: "run_start", run: 1 },
    { ts: 1100, source: "clean", type: "merge_done", run: 1, commit: one.merged },
    { ts: 1200, source: "clean", type: "run_end", run: 1, result: "merged" },
  ]);
  r = await cli(one.repo, "revert", "clean", "--last", "--dry-run");
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^run clean #1 merged as ${one.merged.slice(0, 8)}\\nwould revert`));
});

test("revert refuses a run that did not merge, an unknown run and an unknown role, writing nothing", async () => {
  const { repo } = await revertRunRepo(true);
  const before = headSha(repo);
  let r = await cli(repo, "revert", "clean", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not merge \(result: rejected\)/);
  r = await cli(repo, "revert", "clean", "9");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(runNotFoundMessage("clean", 9)), r.stderr);
  r = await cli(repo, "revert", "nosuchrole", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nosuchrole/);
  assert.equal(headSha(repo), before);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});
