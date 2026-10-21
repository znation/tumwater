import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectRoleChange, fileOverlaps, scopeChangeOverlaps } from "../src/change/change-data.js";
import { renderTeamChange, renderRoleChange, renderChangeOverlaps } from "../src/change/change-render.js";
import { initProject } from "../src/init/init.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { commitIn, makeRepo, sh } from "./fixtures/repo-fixtures.js";

// `collectRoleChange`/`renderRoleChange` behind `tumwater diff --role <id>`, called directly
// (the cli-diff tests reach them through child-process CLI runs, whose coverage node --test
// never sees). These pin the degraded and bounded paths the CLI tests cannot reach: a
// half-deleted worktree, untracked-only dirt, the uncommitted-diff cap, and the plural forms.

test("a half-deleted worktree — the directory survives, its git link does not — degrades to absent", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-render dead worktree");
  const wt = await ensureWorktree(repo, "ghost", "main");
  // A registered worktree's .git is a file pointing at the gitdir; one whose target is
  // gone leaves a directory existsSync accepts but every git call rejects — the "pruned,
  // half-deleted" situation collectRoleChange folds into the same answer as a missing dir.
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nonexistent/tumwater/worktrees/ghost.git\n");
  const view = await collectRoleChange(repo, "ghost");
  assert.equal(view.state, "absent");
  assert.equal(view.ahead, 0);
  assert.deepEqual(view.commits, []);
  assert.deepEqual(view.dirtyFiles, []);
  assert.equal(renderRoleChange(view), "no worktree for ghost");
});

test("untracked files show in the dirty list with no patch text", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-render untracked");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "notes.md"), "scratch\n");
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready");
  assert.equal(view.ahead, 0);
  assert.deepEqual(view.dirtyFiles, ["notes.md"]);
  // `git diff HEAD` has no content for an untracked path, so the patch stays empty while
  // the file still counts as uncommitted — the render must show the list without a patch.
  assert.equal(view.uncommittedDiff, "");
  const text = renderRoleChange(view);
  assert.ok(text.includes("0 commits ahead of main, 1 uncommitted file"));
  assert.ok(text.includes("uncommitted (1 file): notes.md"));
  assert.ok(!text.includes("+scratch"));
});

test("an uncommitted diff over the cap truncates to a note plus the --stat summary", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-render truncation");
  const wt = await ensureWorktree(repo, "feature", "main");
  // ~360KB of staged additions: past the 200KB cap the full patch must never print.
  const big =
    Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n") + "\n";
  fs.writeFileSync(path.join(wt, "big.md"), big);
  sh(wt, "git", "add", "-A");
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready");
  assert.ok(view.uncommittedDiff.startsWith("[uncommitted diff truncated: the full diff is "));
  assert.ok(view.uncommittedDiff.includes("big.md"), "the --stat summary names the file");
  assert.ok(view.uncommittedDiff.length < big.length, "the capped view is smaller than the diff");
  assert.ok(renderRoleChange(view).includes("[uncommitted diff truncated"));
});

test("a detached primary checkout still resolves a baseline: main", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-render detached");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "w.md"), "w\n");
  commitIn(wt, "feature work");
  // With no configured baseBranch the view falls back to the primary checkout's current
  // branch — and a checkout mid-rebase or on a detached HEAD has none, so the doctor-style
  // resolution bottoms out at "main" instead of failing the query.
  sh(repo, "git", "checkout", "--detach", "HEAD");
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.mainBranch, "main");
  assert.equal(view.state, "ready");
  assert.equal(view.ahead, 1);
  assert.ok(renderRoleChange(view).includes("1 commit ahead of main"));
});

test("two uncommitted files pluralize in the header and the file list", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-render plural");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "a.md"), "a\n");
  fs.writeFileSync(path.join(wt, "b.md"), "b\n");
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready");
  const text = renderRoleChange(view);
  assert.ok(text.includes("0 commits ahead of main, 2 uncommitted files"));
  assert.ok(text.includes("uncommitted (2 files): a.md, b.md"));
});

test("a lagging branch renders its behind count in the role header and the team roster", () => {
  const base = {
    role: "feature",
    branch: "tumwater/feature",
    mainBranch: "main",
    state: "ready" as const,
    ahead: 1,
    commits: [{ sha: "abc1234", subject: "work" }],
    diff: "",
    dirtyFiles: [],
    uncommittedDiff: "",
  };
  const lagging = { ...base, behind: 2 };
  assert.ok(renderRoleChange(lagging).startsWith("feature: tumwater/feature, 1 commit ahead of main, 2 commits behind"));
  assert.equal(
    renderTeamChange({ mainBranch: "main", roles: [lagging] }),
    "feature: 1 commit ahead of main, 2 commits behind",
  );
  assert.ok(renderRoleChange({ ...base, behind: 0 }).includes("1 commit ahead of main\n"));
});

test("fileOverlaps keeps only paths two or more roles hold, each role once", () => {
  assert.deepEqual(
    fileOverlaps([
      { role: "feature", files: ["b.md", "a.md", "a.md"] },
      { role: "clean", files: ["a.md", "c.md"] },
      { role: "bugfix", files: ["b.md", "a.md"] },
    ]),
    [
      { path: "a.md", roles: ["feature", "clean", "bugfix"] },
      { path: "b.md", roles: ["feature", "bugfix"] },
    ],
  );
  assert.equal(
    renderChangeOverlaps({ mainBranch: "main", state: "ready", overlaps: [] }),
    "no file is touched by two pending changes",
  );
  assert.equal(
    renderChangeOverlaps({ mainBranch: "main", state: "no-base", overlaps: [] }),
    "main branch main does not exist",
  );
});

test("scopeChangeOverlaps keeps entries naming a listed role, each with every holder", () => {
  const view = {
    mainBranch: "main",
    state: "ready" as const,
    overlaps: [
      { path: "a.md", roles: ["feature", "clean", "bugfix"] },
      { path: "b.md", roles: ["clean", "bugfix"] },
    ],
  };
  assert.deepEqual(scopeChangeOverlaps(view, ["feature"]).overlaps, [view.overlaps[0]]);
  assert.deepEqual(scopeChangeOverlaps(view, ["bugfix"]).overlaps, view.overlaps);
  const none = scopeChangeOverlaps(view, ["qa"]);
  assert.deepEqual(none.overlaps, []);
  assert.equal(renderChangeOverlaps(none, ["qa"]), "no file held by qa is touched by another pending change");
  const noBase = { mainBranch: "main", state: "no-base" as const, overlaps: [] };
  assert.equal(renderChangeOverlaps(scopeChangeOverlaps(noBase, ["qa"]), ["qa"]), "main branch main does not exist");
});
