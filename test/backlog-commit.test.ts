import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { loadConfig } from "../src/config/config.js";
import { commitOperatorBacklogEdit } from "../src/backlog/backlog-commit.js";
import { handleBacklogFile } from "../src/gui/gui-endpoint-commands.js";
import { assertClean, initializedRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { captureJson } from "./fakes/fake-res.js";
import { cli } from "./helpers/cli-harness.js";

// INV-B5: an operator-filed entry is committed on main under the primary-worktree lock.

const subject = (repo: string) => sh(repo, "git", "log", "-1", "--format=%s");

test("tumwater bug and plan commit the filed entry on main, leaving the checkout clean", async () => {
  const repo = await initializedRepo();
  assertClean(repo);
  assert.equal((await cli(repo, "bug", "x")).code, 0);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): File bug: x");
  assert.equal((await cli(repo, "plan", "y")).code, 0);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): File plan: y");
  const file = path.join(tmpdir(), "entry.md");
  fs.writeFileSync(file, "# from file\n\nbody line\n");
  assert.equal((await cli(repo, "plan", "--file", file)).code, 0);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): File plan: from file");
});

test("filing commits only the backlog file and leaves other staged paths staged", async () => {
  const repo = await initializedRepo();
  fs.writeFileSync(path.join(repo, "other.txt"), "x\n");
  sh(repo, "git", "add", "other.txt");
  assert.equal((await cli(repo, "bug", "z")).code, 0);
  assert.equal(sh(repo, "git", "show", "--name-only", "--format=", "HEAD").trim(), "BUGS.md");
  assert.equal(sh(repo, "git", "status", "--porcelain").trim(), "A  other.txt");
});

test("off the base branch the entry stays uncommitted, and the helper returns false without throwing", async () => {
  const repo = await initializedRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  sh(repo, "git", "checkout", "-q", "-b", "side");
  const cfg = loadConfig(repo);
  cfg.baseBranch = "main";
  writeConfig(repo, cfg);
  const filed = await cli(repo, "bug", "q");
  assert.equal(filed.code, 0);
  assert.match(filed.stderr, /warning: BUGS\.md was written but not committed to main/);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  assert.match(sh(repo, "git", "status", "--porcelain"), /BUGS\.md/);
  assert.equal(await commitOperatorBacklogEdit(repo, "BUGS.md", "tumwater(operator): x"), false);
  assert.equal(await commitOperatorBacklogEdit(tmpdir(), "BUGS.md", "tumwater(operator): x"), false);
});

test("POST /api/backlog-file commits the entry on main", async () => {
  const repo = await initializedRepo();
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  process.nextTick(() => {
    req.emit("data", Buffer.from(JSON.stringify({ kind: "bug", title: "dash" })));
    req.emit("end");
  });
  const { captured } = await captureJson((res) => handleBacklogFile(req, res, repo));
  assert.equal(captured.status, 200);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): File bug: dash");
});

test("plan and bug --release lift the Refused note and commit it on main", async () => {
  const repo = await initializedRepo();
  const note = "**Refused 2026-10-12 by feature: nope**";
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  fs.writeFileSync(path.join(repo, "PLANS.md"), plans.replace("## Planned\n", `## Planned\n\n### first\n\nbody\n\n### parked\n\n${note}\n\n**Goal.** g\n`));
  const bugs = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  fs.writeFileSync(path.join(repo, "BUGS.md"), bugs.replace("## Open\n", `## Open\n\n### broken\n${note}\n`));
  sh(repo, "git", "commit", "-qam", "seed");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const none = await cli(repo, "plan", "--release", "1");
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /plan #1 "first" carries no Refused note/);
  assert.notEqual((await cli(repo, "plan", "--release", "9")).code, 0);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  assertClean(repo);
  const out = await cli(repo, "plan", "--release", "2");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /released plan in PLANS\.md: parked/);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Release plan: parked");
  assert.ok(!fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").includes("**Refused"));
  assert.ok(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").includes("### parked\n\n**Goal.** g"));
  const json = await cli(repo, "bug", "--release", "1", "--json");
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { file: "BUGS.md", title: "broken" });
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Release bug: broken");
});

test("bug --cancel, plan --edit, and questions answer each commit on main; a missing position commits nothing", async () => {
  const repo = await initializedRepo();
  assert.equal((await cli(repo, "bug", "b1")).code, 0);
  assert.equal((await cli(repo, "plan", "p1")).code, 0);
  fs.appendFileSync(path.join(repo, "QUESTIONS.md"), "");
  const q = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  fs.writeFileSync(path.join(repo, "QUESTIONS.md"), q.replace(/## Open\n(\s*_None yet\._\n)?/, "## Open\n\n### ask?\n\ncontext\n\n"));
  sh(repo, "git", "commit", "-qam", "seed question");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  assert.notEqual((await cli(repo, "bug", "--cancel", "9")).code, 0);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  const cancelled = await cli(repo, "bug", "--cancel", "1");
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.stderr, "");
  assertClean(repo);
  assert.match(subject(repo), /^tumwater\(operator\): Cancel bug: b1/);
  assert.equal((await cli(repo, "plan", "--edit", "1", "z")).code, 0);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Edit plan: z");
  assert.equal((await cli(repo, "questions", "answer", "1", "yes")).code, 0);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Answer question: ask?");
});
