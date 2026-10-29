import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { changedSinceBase, splitAffectedArgv, splitBudgetArgv } from "./test-runner.js";
import { commitIn, makeRepo, sh } from "./fixtures/repo-fixtures.js";

// The runner's `--affected` mode (`npm run test:gate`): its argv and the change it measures.
// The selection itself is pinned in affected-tests.test.ts.

test("splitAffectedArgv lifts --affected out of the argv, defaulting the branch to main", () => {
  assert.deepEqual(splitAffectedArgv([]), { rest: [], ref: undefined });
  assert.deepEqual(splitAffectedArgv(["--affected"]), { rest: [], ref: "main" });
  assert.deepEqual(splitAffectedArgv(["--affected=trunk", "loop"]), { rest: ["loop"], ref: "trunk" });
  assert.deepEqual(splitAffectedArgv(["--affected="]), { rest: [], ref: "main" });
});

test("splitBudgetArgv lifts --budget=<seconds> off the argv and rejects bad budgets", () => {
  assert.deepEqual(splitBudgetArgv(["--budget=30"]), { rest: [], budgetMs: 30_000 });
  assert.deepEqual(splitBudgetArgv(["runner"]), { rest: ["runner"] });
  assert.equal(splitBudgetArgv(["--budget=5", "--budget=45"]).budgetMs, 45_000, "the last occurrence wins");
  for (const bad of ["--budget", "--budget=0", "--budget=1.5", "--budget=3601", "--budget=soon"])
    assert.match(splitBudgetArgv([bad]).error ?? "", /whole number of seconds/, bad);
});

test("changedSinceBase lists committed, staged, unstaged and untracked changes since the merge-base", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "old.txt"), "old\n");
  fs.writeFileSync(path.join(root, "edit.txt"), "v1\n");
  commitIn(root, "base files");
  sh(root, "git", "checkout", "-b", "work");
  sh(root, "git", "mv", "old.txt", "renamed.txt");
  commitIn(root, "rename on the branch");
  sh(root, "git", "checkout", "main");
  fs.writeFileSync(path.join(root, "main-only.txt"), "main moved\n");
  commitIn(root, "main moves");
  sh(root, "git", "checkout", "work");
  fs.writeFileSync(path.join(root, "edit.txt"), "v2\n"); // unstaged
  fs.writeFileSync(path.join(root, "staged.txt"), "s\n");
  sh(root, "git", "add", "staged.txt");
  fs.writeFileSync(path.join(root, "new.txt"), "untracked\n");
  assert.deepEqual(changedSinceBase(root, "main"), {
    files: ["edit.txt", "new.txt", "old.txt", "renamed.txt", "staged.txt"],
  }, "main's own later commit is not the change's; a rename lists both paths");
});

test("changedSinceBase names what git cannot answer instead of guessing", () => {
  const root = makeRepo();
  assert.deepEqual(changedSinceBase(root, "no-such-branch"), { error: "no merge-base between HEAD and no-such-branch" });
});
