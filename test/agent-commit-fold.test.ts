/** INV-H1: commits the agent makes during a run fold into the harness's single commit. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { foldCommitsSince, headOf } from "../src/git/git.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { mergeHead } from "./fixtures/orchestrator-fixtures.js";
import { commitIn, initializedRepo, sh } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { APPROVE_PI, assistantLine } from "./fixtures/pi-events.js";

const PI_COMMIT = `git add -A && git -c user.name=t -c user.email=t@t commit -q -m "pi commit"`;
const FOLD_WARNING = "folded into tumwater's commit";

async function runAndMerge(script: string[]): Promise<{ repo: string; before: string }> {
  const repo = await initializedRepo();
  const before = sh(repo, "git", "rev-parse", "main");
  await withPi([APPROVE_PI, ...script].join("\n"), async () => {
    const runner = makeRoleRunner(repo, "organize");
    assert.equal((await runner.run()).result, "queued");
    assert.equal(await mergeHead(repo, runner, defaultConfig(), "organize"), "changed");
  });
  return { repo, before };
}

function assertOneHarnessCommit(repo: string, before: string): void {
  assert.equal(sh(repo, "git", "rev-list", "--count", `${before}..main`), "1");
  assert.match(sh(repo, "git", "log", "-1", "--format=%s", "main"), /^tumwater\(organize\):/);
}

test("an agent commit beside uncommitted edits becomes one harness commit", async () => {
  const { repo, before } = await runAndMerge([
    `printf '%s\n' '${assistantLine("did it\nSUMMARY: add two files")}'`,
    `echo a > a.txt`,
    PI_COMMIT,
    `echo b > b.txt`,
  ]);
  assertOneHarnessCommit(repo, before);
  assert.ok(fs.existsSync(path.join(repo, "a.txt")) && fs.existsSync(path.join(repo, "b.txt")));
  assert.ok(warningMessages(repo).some((w) => w.includes(FOLD_WARNING)));
});

test("an agent commit with a clean tree is not dropped as no_change", async () => {
  const { repo, before } = await runAndMerge([
    `printf '%s\n' '${assistantLine("did it\nSUMMARY: add a file")}'`,
    `echo a > a.txt`,
    PI_COMMIT,
  ]);
  assertOneHarnessCommit(repo, before);
  assert.ok(fs.existsSync(path.join(repo, "a.txt")));
  assert.ok(warningMessages(repo).some((w) => w.includes(FOLD_WARNING)));
});

test("foldCommitsSince returns 0 and touches nothing when HEAD equals base", async () => {
  const repo = await initializedRepo();
  fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
  const base = await headOf(repo, "HEAD");
  assert.equal(await foldCommitsSince(repo, base), 0);
  assert.equal(await headOf(repo, "HEAD"), base);
  assert.equal(sh(repo, "git", "diff", "--cached", "--name-only"), "");
});

test("foldCommitsSince folds N commits and leaves their content staged", async () => {
  const repo = await initializedRepo();
  const base = await headOf(repo, "HEAD");
  fs.writeFileSync(path.join(repo, "one.txt"), "1");
  commitIn(repo, "one");
  fs.writeFileSync(path.join(repo, "two.txt"), "2");
  commitIn(repo, "two");
  assert.equal(await foldCommitsSince(repo, base), 2);
  assert.equal(await headOf(repo, "HEAD"), base);
  assert.deepEqual(sh(repo, "git", "diff", "--cached", "--name-only").split("\n").sort(), ["one.txt", "two.txt"]);
});
