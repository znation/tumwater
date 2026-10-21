import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { loadConfig } from "../src/config/config.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { commitIn, makeRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { ROLE_VALUE_ERROR } from "../src/cli/cli-flag-specs.js";
import { NOT_A_REPO_MESSAGE, NOT_INITIALIZED_MESSAGE } from "../src/gates/readiness.js";
import { allRoleIds } from "../src/roles/roles.js";

// The `diff` command: the change a role holds — its branch's unmerged commits (with the
// patch) and its worktree's uncommitted edits — via the CLI the way cli-history tests
// `history`: seeded repos, child-process runs, output assertions.

/** An initialized repo whose feature worktree holds one unmerged commit ("add widget.md"). */
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

test("diff shows the unmerged commit and its patch, then uncommitted edits", async () => {
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

test("diff fails fast on an empty or unknown --role and rejects unknown flags", async () => {
  const { repo } = await seededFeatureRepo();
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

test("diff in a directory tumwater cannot read yet names the readiness problem, not the branch", async () => {
  // Before the repo gate, both views degraded to the change collector's no-base line —
  // "main branch main does not exist" — which misreports a missing/never-initialized repo
  // as a missing branch. The shared readiness wording answers instead, like every sibling
  // command; the absent-worktree degradation past the gate keeps its exit-0 line above.
  const notRepo = await cli(tmpdir("diff-not-a-repo-"), "diff");
  assert.equal(notRepo.code, 1);
  assert.ok(notRepo.stderr.includes(NOT_A_REPO_MESSAGE));

  const notRepoRole = await cli(tmpdir("diff-not-a-repo-"), "diff", "--role", "feature");
  assert.equal(notRepoRole.code, 1);
  assert.ok(notRepoRole.stderr.includes(NOT_A_REPO_MESSAGE));

  // A git repo with no tumwater.json: the init hint, not a branch complaint.
  const uninitialized = await cli(makeRepo(), "diff");
  assert.equal(uninitialized.code, 1);
  assert.ok(uninitialized.stderr.includes(NOT_INITIALIZED_MESSAGE));
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

// The team-wide form (`diff` with no --role): one line per role holding pending work.

test("team diff prints exactly the holding role's line with both counts", async () => {
  const { repo, wt } = await seededFeatureRepo();
  fs.appendFileSync(path.join(wt, "widget.md"), "more\n");
  const r = await cli(repo, "diff");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "feature: 1 commit ahead of main, 1 uncommitted file");
});

test("team diff with nothing pending anywhere prints no pending changes, exit 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff team empty test");
  const r = await cli(repo, "diff");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no pending changes");
});

test("team diff on a missing baseline degrades to the per-role line, exit 0", async () => {
  const { repo } = await seededFeatureRepo();
  const cfg = loadConfig(repo);
  cfg.baseBranch = "ghost";
  writeConfig(repo, cfg);
  const r = await cli(repo, "diff");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "main branch ghost does not exist");
});

test("team diff --json prints the roster: one entry per known role, no patch fields", async () => {
  const { repo } = await seededFeatureRepo();
  const r = await cli(repo, "diff", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as {
    mainBranch: string;
    roles: { role: string; branch: string; state: string; ahead: number; commits: unknown[]; dirtyFiles: string[] }[];
  };
  assert.equal(payload.mainBranch, "main");
  assert.deepEqual(
    payload.roles.map((e) => e.role),
    allRoleIds(),
  );
  const feature = payload.roles.find((e) => e.role === "feature")!;
  assert.equal(feature.state, "ready");
  assert.equal(feature.branch, "tumwater/feature");
  assert.equal(feature.ahead, 1);
  assert.deepEqual(
    (feature.commits as { subject: string }[]).map((c) => c.subject),
    ["add widget.md"],
  );
  assert.deepEqual(feature.dirtyFiles, []);
  for (const entry of payload.roles) {
    assert.ok(!("diff" in entry));
    assert.ok(!("uncommittedDiff" in entry));
  }
});

test("diff --stat prints per-file summaries in place of the patches", async () => {
  const { repo, wt } = await seededFeatureRepo();
  fs.appendFileSync(path.join(wt, "widget.md"), "more\n");
  const r = await cli(repo, "diff", "--role", "feature", "--stat");
  assert.equal(r.code, 0);
  for (const s of ["1 commit ahead of main", "add widget.md", "uncommitted (1 file): widget.md", "widget.md |"]) {
    assert.ok(r.stdout.includes(s), s);
  }
  assert.ok(!r.stdout.includes("+# widget"));
  assert.ok(!r.stdout.includes("+more"));
  const j = await cli(repo, "diff", "--role", "feature", "--stat", "--json");
  const view = JSON.parse(j.stdout);
  for (const half of [view.diff, view.uncommittedDiff]) {
    assert.ok(half.includes("widget.md |"));
    assert.ok(!half.includes("+# widget"));
  }
  const plain = await cli(repo, "diff", "--role", "feature");
  assert.ok(plain.stdout.includes("+# widget"));
});

test("diff --stat without --role fails", async () => {
  const { repo } = await seededFeatureRepo();
  const r = await cli(repo, "diff", "--stat");
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("diff --stat needs --role"));
});

test("diff --role takes a comma list and prints each listed role's view in order", async () => {
  const { repo } = await seededFeatureRepo();
  await ensureWorktree(repo, "clean", "main");
  const r = await cli(repo, "diff", "--role", "clean,feature");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith("no pending change for clean\n\nfeature: "));
  assert.ok(r.stdout.includes("1 commit ahead of main"));
  assert.ok(r.stdout.includes("+# widget"));
  const dup = await cli(repo, "diff", "--role", "feature,feature");
  const one = await cli(repo, "diff", "--role", "feature");
  assert.equal(dup.stdout, one.stdout);
});

test("diff --role list --json prints one per-role payload per listed role", async () => {
  const { repo } = await seededFeatureRepo();
  await ensureWorktree(repo, "clean", "main");
  const r = await cli(repo, "diff", "--role", "feature,clean", "--json");
  const view = JSON.parse(r.stdout);
  assert.equal(view.mainBranch, "main");
  assert.deepEqual(view.roles.map((x: { role: string }) => x.role), ["feature", "clean"]);
  assert.equal(view.roles[0].state, "ready");
  assert.equal(view.roles[0].ahead, 1);
  assert.ok(view.roles[0].diff.includes("+# widget"));
  assert.equal(view.roles[1].diff, "");
});

test("diff --role list composes with --stat and degrades a missing baseline once", async () => {
  const { repo } = await seededFeatureRepo();
  await ensureWorktree(repo, "clean", "main");
  const stat = await cli(repo, "diff", "--role", "feature,clean", "--stat");
  assert.equal(stat.code, 0);
  assert.ok(stat.stdout.includes("widget.md |"));
  assert.ok(!stat.stdout.includes("+# widget"));
  const cfg = loadConfig(repo);
  cfg.baseBranch = "ghost";
  writeConfig(repo, cfg);
  const ghost = await cli(repo, "diff", "--role", "feature,clean");
  assert.equal(ghost.code, 0);
  assert.equal(ghost.stdout.trim(), "main branch ghost does not exist");
});

test("diff --role list names an unknown piece", async () => {
  const { repo } = await seededFeatureRepo();
  const r = await cli(repo, "diff", "--role", "feature,nope");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("nope"));
});

test("diff --overlaps names each file two roles' pending changes touch", async () => {
  const { repo } = await seededFeatureRepo();
  const cleanWt = await ensureWorktree(repo, "clean", "main");
  fs.writeFileSync(path.join(cleanWt, "widget.md"), "# other\n");
  fs.writeFileSync(path.join(cleanWt, "solo.md"), "# solo\n");
  const r = await cli(repo, "diff", "--overlaps");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "widget.md: feature, clean");
  const json = await cli(repo, "diff", "--overlaps", "--json");
  assert.deepEqual(JSON.parse(json.stdout), {
    mainBranch: "main",
    state: "ready",
    overlaps: [{ path: "widget.md", roles: ["feature", "clean"] }],
  });
});

test("diff --overlaps --role keeps the listed roles' shared files", async () => {
  const { repo } = await seededFeatureRepo();
  const cleanWt = await ensureWorktree(repo, "clean", "main");
  fs.writeFileSync(path.join(cleanWt, "widget.md"), "# other\n");
  fs.writeFileSync(path.join(cleanWt, "solo.md"), "# solo\n");
  const bugWt = await ensureWorktree(repo, "bugfix", "main");
  fs.writeFileSync(path.join(bugWt, "solo.md"), "# solo2\n");
  const out = async (...a: string[]) => (await cli(repo, "diff", "--overlaps", ...a)).stdout.trim();
  assert.equal(await out(), "solo.md: bugfix, clean\nwidget.md: feature, clean");
  assert.equal(await out("--role", "feature"), "widget.md: feature, clean");
  assert.equal(await out("--role", "bugfix"), "solo.md: bugfix, clean");
  assert.equal(await out("--role", "feature,bugfix"), "solo.md: bugfix, clean\nwidget.md: feature, clean");
  assert.deepEqual(JSON.parse(await out("--role", "feature", "--json")), {
    mainBranch: "main",
    state: "ready",
    overlaps: [{ path: "widget.md", roles: ["feature", "clean"] }],
  });
});

test("diff --overlaps with no shared file says so, and rejects --stat", async () => {
  const { repo } = await seededFeatureRepo();
  const r = await cli(repo, "diff", "--overlaps");
  assert.equal(r.stdout.trim(), "no file is touched by two pending changes");
  const role = await cli(repo, "diff", "--overlaps", "--role", "feature");
  assert.equal(role.code, 0);
  assert.equal(role.stdout.trim(), "no file held by feature is touched by another pending change");
  const nope = await cli(repo, "diff", "--overlaps", "--role", "nope");
  assert.notEqual(nope.code, 0);
  assert.ok(nope.stderr.includes("nope"));
  const stat = await cli(repo, "diff", "--overlaps", "--stat");
  assert.notEqual(stat.code, 0);
  assert.ok(stat.stderr.includes("drop --stat"));
});

/** seededFeatureRepo plus a second commit `add gadget.md` and an uncommitted edit to both files. */
async function scopedRepo(): Promise<{ repo: string; wt: string }> {
  const { repo, wt } = await seededFeatureRepo();
  fs.writeFileSync(path.join(wt, "gadget.md"), "# gadget\n");
  commitIn(wt, "add gadget.md");
  fs.appendFileSync(path.join(wt, "widget.md"), "more widget\n");
  fs.appendFileSync(path.join(wt, "gadget.md"), "more gadget\n");
  return { repo, wt };
}

test("diff --path limits the view to one file's commits, patch and uncommitted edits", async () => {
  const { repo } = await scopedRepo();
  const r = await cli(repo, "diff", "--role", "feature", "--path", "widget.md");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.split("\n")[0]!.endsWith("; limited to widget.md"));
  assert.ok(r.stdout.includes("add widget.md"));
  assert.ok(!r.stdout.includes("add gadget.md"));
  assert.ok(r.stdout.includes("+# widget"));
  assert.ok(r.stdout.includes("uncommitted (1 file): widget.md"));
  assert.ok(!r.stdout.includes("gadget.md"));
  const dotted = await cli(repo, "diff", "--role", "feature", "--path", "./widget.md");
  assert.equal(dotted.stdout, r.stdout);
});

test("diff --path accepts a directory", async () => {
  const { repo, wt } = await scopedRepo();
  fs.mkdirSync(path.join(wt, "docs"));
  fs.writeFileSync(path.join(wt, "docs", "a.md"), "# a doc\n");
  commitIn(wt, "add docs/a.md");
  const r = await cli(repo, "diff", "--role", "feature", "--path", "docs/");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("+# a doc"));
  assert.ok(!r.stdout.includes("widget.md"));
});

test("diff --path with nothing pending prints one line", async () => {
  const { repo } = await scopedRepo();
  const r = await cli(repo, "diff", "--role", "feature", "--path", "nothing.md");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no pending change to nothing.md for feature");
});

test("diff --path composes with --stat, --json and a comma list", async () => {
  const { repo } = await scopedRepo();
  const stat = await cli(repo, "diff", "--role", "feature", "--path", "widget.md", "--stat");
  assert.ok(stat.stdout.includes("widget.md |"));
  assert.ok(!stat.stdout.includes("gadget.md |"));
  const json = JSON.parse((await cli(repo, "diff", "--role", "feature", "--path", "widget.md", "--json")).stdout);
  assert.equal(json.path, "widget.md");
  assert.deepEqual(json.dirtyFiles, ["widget.md"]);
  assert.equal(json.commits.length, 1);
  const plain = JSON.parse((await cli(repo, "diff", "--role", "feature", "--json")).stdout);
  assert.ok(!("path" in plain));
  const list = await cli(repo, "diff", "--role", "feature,bugfix", "--path", "widget.md");
  assert.equal(list.code, 0);
  assert.ok(list.stdout.includes("feature: ") && list.stdout.includes("bugfix"));
});

test("diff --overlaps --path keeps the shared files at or under the path", async () => {
  const { repo, wt } = await seededFeatureRepo();
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs/b.md"), "f\n");
  commitIn(wt, "feature docs/b.md");
  const cleanWt = await ensureWorktree(repo, "clean", "main");
  const bugWt = await ensureWorktree(repo, "bugfix", "main");
  fs.mkdirSync(path.join(cleanWt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cleanWt, "widget.md"), "# c\n");
  fs.writeFileSync(path.join(cleanWt, "docs/a.md"), "c\n");
  commitIn(cleanWt, "clean work");
  fs.mkdirSync(path.join(bugWt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(bugWt, "docs/a.md"), "b\n");
  fs.writeFileSync(path.join(bugWt, "docs/b.md"), "b\n");
  commitIn(bugWt, "bugfix work");
  const out = async (...a: string[]): Promise<string> => (await cli(repo, "diff", "--overlaps", ...a)).stdout.trim();
  const docs = "docs/a.md: bugfix, clean\ndocs/b.md: feature, bugfix";
  assert.equal(await out("--path", "docs"), docs);
  assert.equal(await out("--path", "docs/a.md"), "docs/a.md: bugfix, clean");
  assert.equal(await out("--path", "./docs/"), docs);
  assert.equal(await out("--path", "widget.md", "--role", "bugfix"),
    "no file under widget.md held by bugfix is touched by another pending change");
  assert.equal(await out("--path", "src"), "no file under src is touched by two pending changes");
  const json = JSON.parse(await out("--path", "docs", "--json"));
  assert.deepEqual(json, {
    mainBranch: "main",
    state: "ready",
    overlaps: [
      { path: "docs/a.md", roles: ["bugfix", "clean"] },
      { path: "docs/b.md", roles: ["feature", "bugfix"] },
    ],
  });
});

test("diff --path rejects misuse with its wording", async () => {
  const { repo } = await scopedRepo();
  const bad = async (msg: string, ...args: string[]): Promise<void> => {
    const r = await cli(repo, "diff", ...args);
    assert.notEqual(r.code, 0, args.join(" "));
    assert.ok((r.stderr + r.stdout).includes(msg), `${args.join(" ")}: ${r.stderr}${r.stdout}`);
  };
  await bad("diff --path needs --role <id>", "--path", "widget.md");
  await bad("diff --path takes a repo-relative path", "--overlaps", "--path", "../x");
  await bad("diff --overlaps prints paths, not patches", "--overlaps", "--stat");
  const rel = "diff --path takes a repo-relative path";
  await bad(rel, "--role", "feature", "--path", "/abs/x");
  await bad(rel, "--role", "feature", "--path", "../x");
  await bad(rel, "--role", "feature", "--path", ".");
  await bad("diff --path needs a path", "--role", "feature", "--path");
  await bad("--path may only be given once", "--role", "feature", "--path", "a", "--path", "b");
});
