import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/config.js";
import { commitOperatorBacklogEdit } from "../src/backlog/backlog-commit.js";
import { handleBacklogFile } from "../src/gui/gui-endpoint-commands.js";
import { assertClean, initializedRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";
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

test("off the base branch the entry is rolled back, and the helper returns false without throwing", async () => {
  const repo = await initializedRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const clean = sh(repo, "git", "show", "HEAD:BUGS.md");
  sh(repo, "git", "checkout", "-q", "-b", "side");
  const cfg = loadConfig(repo);
  cfg.baseBranch = "main";
  writeConfig(repo, cfg);
  const filed = await cli(repo, "bug", "q");
  assert.equal(filed.code, 0);
  // The write could not be committed (off the base branch), so it is rolled back rather than
  // left dirty to block every merge touching BUGS.md (the bugfix for the stuck primary).
  // tumwater.json stays the one dirty path: writeConfig's own uncommitted edit, not the write.
  assert.match(filed.stderr, /warning: BUGS\.md was written but not committed to main/);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  assert.ok(!sh(repo, "git", "status", "--porcelain").includes("BUGS.md"));
  assert.equal(sh(repo, "git", "show", "HEAD:BUGS.md"), clean);
  assert.equal(await commitOperatorBacklogEdit(repo, "BUGS.md", "tumwater(operator): x"), false);
  assert.equal(await commitOperatorBacklogEdit(tmpdir(), "BUGS.md", "tumwater(operator): x"), false);
});

test("a backlog write whose commit fails is rolled back to its committed state, leaving the checkout clean", async () => {
  const repo = await initializedRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const committed = sh(repo, "git", "show", "HEAD:PLANS.md");
  // A planted git-commit failure (a pre-commit hook that exits nonzero) after a write: the
  // failed commit must restore the file so the primary checkout never stays dirty (the
  // reproduce in the "stuck primary" bug: BUGS.md lines 70-79).
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "pre-commit"), 0o755);
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  fs.writeFileSync(path.join(repo, "PLANS.md"), plans.replace("## Planned\n", "## Planned\n\n### stuck\n\nbody\n"));
  const ok = await commitOperatorBacklogEdit(repo, "PLANS.md", "tumwater(operator): x");
  assert.equal(ok, false);
  // The failed commit left the checkout clean: PLANS.md is back to its committed state, so no
  // merge is refused over an uncommitted backlog file.
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  assert.equal(sh(repo, "git", "show", "HEAD:PLANS.md"), committed);
});

test("POST /api/backlog-file commits the entry on main", async () => {
  const repo = await initializedRepo();
  const req = fakeReq(JSON.stringify({ kind: "bug", title: "dash" }));
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
  assert.match(none.stderr, /plan #1 "first" carries no Refused, Waiting for the next failure, or held-for-operator note/);
  assert.notEqual((await cli(repo, "plan", "--release", "9")).code, 0);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  assertClean(repo);
  const out = await cli(repo, "plan", "--release", "2");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /released plan in PLANS\.md: parked \(lifted the Refused note\)/);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Release plan: parked");
  assert.ok(!fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").includes("**Refused"));
  assert.ok(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").includes("### parked\n\n**Goal.** g"));
  const json = await cli(repo, "bug", "--release", "1", "--json");
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { file: "BUGS.md", title: "broken", lifted: "refused" });
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Release bug: broken");
});

const HELD_NOTE = "**Refused 2026-10-12 by feature: nope**";
function seedHeldSeries(repo: string, extra = "", note = HELD_NOTE): void {
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const seed =
    "## Planned\n\n### Export series, part 1/2: a (planned 2026-10-01)\n\nbody\n\n" +
    `### Export series, part 2/2: b (planned 2026-10-02; requires part 1/2 landed)\n\n${note}\n\nbody\n${extra}`;
  fs.writeFileSync(path.join(repo, "PLANS.md"), plans.replace("## Planned\n", seed));
  sh(repo, "git", "commit", "-qam", "seed");
}

test("plan --release says when the entry stays held and --json carries the hold", async () => {
  const repo = await initializedRepo();
  seedHeldSeries(repo, `\n### both\n\n${HELD_NOTE}\n\n**Needs review 2026-10-13 by feature: big**\n`);
  const out = await cli(repo, "plan", "--release", "2");
  assert.equal(out.code, 0);
  assert.equal(subject(repo), "tumwater(operator): Release plan: Export series, part 2/2: b (planned 2026-10-02; requires part 1/2 landed)");
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").split("**Refused").length - 1, 1);
  assert.match(out.stdout, /still held \[blocked: requires Export series 1\/2\]/);
  const both = await cli(repo, "plan", "--release", "3");
  assert.equal(both.code, 0);
  assert.match(both.stdout, /still held \[blocked: needs review\]/);
});

test("plan --release --json carries hold for a still-held entry", async () => {
  const repo = await initializedRepo();
  seedHeldSeries(repo);
  const json = await cli(repo, "plan", "--release", "2", "--json");
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout).hold, { blockedBy: ["Export series 1/2"] });
});

test("plan --top on a held entry names the hold; an unheld move prints none", async () => {
  const repo = await initializedRepo();
  seedHeldSeries(repo, "", "plain note");
  const out = await cli(repo, "plan", "--top", "2");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /still held \[blocked: requires Export series 1\/2\]/);
  const free = await cli(repo, "plan", "--top", "2", "--json");
  assert.equal(free.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(free.stdout)), ["file", "title"]);
  const heldRepo = await initializedRepo();
  seedHeldSeries(heldRepo, "", "plain note");
  const json = await cli(heldRepo, "plan", "--top", "2", "--json");
  assert.deepEqual(JSON.parse(json.stdout).hold, { blockedBy: ["Export series 1/2"] });
});

test("plan and bug --top move an entry to the head of its section and commit it on main", async () => {
  const repo = await initializedRepo();
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  fs.writeFileSync(path.join(repo, "PLANS.md"), plans.replace("## Planned\n", "## Planned\n\n### first\n\nbody\n\n### second\n\nbody\n"));
  const bugs = fs.readFileSync(path.join(repo, "BUGS.md"), "utf8");
  fs.writeFileSync(path.join(repo, "BUGS.md"), bugs.replace("## Open\n", "## Open\n\n### b1\nx\n\n### b2\ny\n"));
  sh(repo, "git", "commit", "-qam", "seed");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  for (const bad of [["--top", "1"], ["--top", "9"], ["--top"], ["--top", "2", "extra"]]) {
    assert.notEqual((await cli(repo, "plan", ...bad)).code, 0, bad.join(" "));
  }
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  const out = await cli(repo, "plan", "--top", "2");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /moved plan to the top of PLANS\.md: second/);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Prioritize plan: second");
  const list = JSON.parse((await cli(repo, "plan", "--list", "--json")).stdout);
  assert.match(JSON.stringify(list[0] ?? list.entries?.[0]), /second/);
  const json = await cli(repo, "bug", "--top", "2", "--json");
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { file: "BUGS.md", title: "b2" });
  assert.equal(subject(repo), "tumwater(operator): Prioritize bug: b2");
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
