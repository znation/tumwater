import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { ensureWorktree } from "../src/worktree.js";
import { commitIn, makeRepo, sh, writeConfig } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";
import { ROLE_VALUE_ERROR } from "../src/cli-args.js";

// The `diff` command: the change a loop holds — its branch's unlanded commits (with the
// patch) and its worktree's uncommitted edits — via the CLI the way cli-history tests
// `history`: seeded repos, child-process runs, output assertions.

/** An initialized repo whose feature worktree holds one unlanded commit ("add widget.md"). */
async function seededFeatureRepo(): Promise<{ repo: string; wt: string }> {
  const repo = makeRepo();
  await initProject(repo, "diff test");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "widget.md"), "# widget\n");
  commitIn(wt, "add widget.md");
  return { repo, wt };
}

test("a role with no worktree yet degrades to a line, exit 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff absent test");
  const r = await cli(repo, "diff", "--role", "feature");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no worktree for feature");
});

test("diff shows the unlanded commit and its patch, then uncommitted edits", async () => {
  const { repo, wt } = await seededFeatureRepo();
  const committed = await cli(repo, "diff", "--role", "feature");
  assert.equal(committed.code, 0);
  assert.ok(committed.stdout.includes("1 commit ahead of main"));
  assert.ok(committed.stdout.includes("add widget.md"));
  assert.ok(committed.stdout.includes("+# widget"));

  // An uncommitted edit adds the file list and the patch on top of the committed half.
  fs.appendFileSync(path.join(wt, "widget.md"), "more\n");
  const dirty = await cli(repo, "diff", "--role", "feature");
  assert.ok(dirty.stdout.includes("1 commit ahead of main"));
  assert.ok(dirty.stdout.includes("uncommitted (1 file): widget.md"));
  assert.ok(dirty.stdout.includes("+more"));

  // A staged-only edit still shows in the patch: `git diff HEAD` covers staged and
  // unstaged tracked edits, matching the porcelain file list it prints beside.
  fs.writeFileSync(path.join(wt, "widget.md"), "# widget\nstaged line\n");
  sh(wt, "git", "add", "-A");
  const staged = await cli(repo, "diff", "--role", "feature");
  assert.ok(staged.stdout.includes("uncommitted (1 file): widget.md"));
  assert.ok(staged.stdout.includes("+staged line"));
});

test("a worktree with nothing pending prints no pending change, exit 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff empty test");
  await ensureWorktree(repo, "clean", "main");
  const r = await cli(repo, "diff", "--role", "clean");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no pending change for clean");
});

test("diff --json prints the collector's payload", async () => {
  const { repo } = await seededFeatureRepo();
  const r = await cli(repo, "diff", "--role", "feature", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as {
    role: string;
    branch: string;
    mainBranch: string;
    state: string;
    ahead: number;
    commits: { sha: string; subject: string }[];
    diff: string;
    dirtyFiles: string[];
    uncommittedDiff: string;
  };
  assert.equal(payload.role, "feature");
  assert.equal(payload.branch, "tumwater/feature");
  assert.equal(payload.mainBranch, "main");
  assert.equal(payload.state, "ready");
  assert.equal(payload.ahead, 1);
  assert.deepEqual(
    payload.commits.map((c) => c.subject),
    ["add widget.md"],
  );
  assert.ok(payload.diff.includes("widget.md"));
  assert.deepEqual(payload.dirtyFiles, []);
  assert.equal(payload.uncommittedDiff, "");
});

test("diff fails fast on a missing, empty, or unknown --role and rejects unknown flags", async () => {
  const { repo } = await seededFeatureRepo();
  const missing = await cli(repo, "diff");
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes("diff needs --role"));

  const empty = await cli(repo, "diff", "--role");
  assert.equal(empty.code, 1);
  assert.ok(empty.stderr.includes(ROLE_VALUE_ERROR));

  const unknown = await cli(repo, "diff", "--role", "nope");
  assert.equal(unknown.code, 1);
  assert.ok(unknown.stderr.includes("nope"));

  const stray = await cli(repo, "diff", "--role", "feature", "--wat");
  assert.equal(stray.code, 1);
  assert.ok(stray.stderr.includes("--wat"));
});

test("a configured baseBranch is the diff's baseline, not the checked-out branch", async () => {
  // main gains commits after develop forks, so the two baselines count differently: the
  // worktree branch (seed + second + init's created-files commit + feature work) is 1
  // ahead of main but 3 ahead of develop — the config choice must be visible in the output.
  const repo = makeRepo();
  sh(repo, "git", "commit", "--allow-empty", "-m", "second on main");
  sh(repo, "git", "branch", "develop", "HEAD~1");
  await initProject(repo, "diff baseline test");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "feature.md"), "work\n");
  commitIn(wt, "feature work");

  const againstMain = await cli(repo, "diff", "--role", "feature");
  assert.ok(againstMain.stdout.includes("1 commit ahead of main"));

  const cfg = loadConfig(repo);
  cfg.baseBranch = "develop";
  writeConfig(repo, cfg);
  const againstDevelop = await cli(repo, "diff", "--role", "feature");
  assert.ok(againstDevelop.stdout.includes("3 commits ahead of develop"));

  // A configured base that does not exist degrades to a line instead of a git failure.
  cfg.baseBranch = "ghost";
  writeConfig(repo, cfg);
  const ghost = await cli(repo, "diff", "--role", "feature");
  assert.equal(ghost.code, 0);
  assert.equal(ghost.stdout.trim(), "main branch ghost does not exist");
});
