import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cli, spawnCli } from "./helpers/cli-harness.js";
import { initProject } from "../src/init/init.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { commitIn, makeRepo } from "./fixtures/repo-fixtures.js";

// `diff -f` repaints the pending-change view (the team roster, a role's change, or the
// --overlaps list) every couple of seconds until the process that started it exits. Its frame
// re-reads the change by running git plumbing, so — per exit-capture.ts's SCOPE LIMIT — it is
// tested through the CLI child process (spawnCli/cli), never captureStdout: a capture held
// across the git spawn would swallow the node --test runner's report traffic and under-count
// the suite. The follow's parent-death and clear-screen-on-TTY shapes are shared followView
// behavior already pinned by status-follow and cli-queue-follow, so here only the diff shapes
// themselves matter.

const CLEAR = "\x1b[H\x1b[2J";

/** Spawn a `diff -f` child at `repo` and wait for its marker to repaint, killing it in the
 * caller's finally. The child repaints on the real 2s interval, so two frames need ~4s even
 * unloaded; the 30s wait deadline leaves the loaded suite a wide margin (cli-logs.test.ts's
 * follow waits use the same order of deadline). */
function waitForFollow(waitFor: (pred: (out: string) => boolean, what: string, ms?: number) => Promise<void>, marker: RegExp, what: string): Promise<void> {
  return waitFor((o) => (o.match(marker) ?? []).length >= 2, `${what} to repaint at least twice`, 30_000);
}

/** Seed a repo with a feature worktree holding one committed widget.md edit, returning the repo. */
async function seededFeatureRepo(repo: string): Promise<void> {
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "widget.md"), "# widget\n");
  commitIn(wt, "add widget.md");
}

test("diff -f repaints the roster until stopped", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff follow");
  await seededFeatureRepo(repo);

  const s = spawnCli(repo, ["diff", "-f"]);
  try {
    await waitForFollow(s.waitFor.bind(s), /feature: 1 commit ahead of main/g, "the roster line");
    // A piped follow prints frames without the TTY clear-screen (followView's tty branch).
    assert.ok(!s.out().includes(CLEAR), "a piped follow never clears the screen");
  } finally {
    s.kill();
  }
});

test("diff -f --role repaints that role's change view", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff follow role");
  await seededFeatureRepo(repo);

  const s = spawnCli(repo, ["diff", "--role", "feature", "-f"]);
  try {
    await waitForFollow(s.waitFor.bind(s), /1 commit ahead of main/g, "the role change header");
    assert.ok(s.out().includes("add widget.md"), "each frame lists the pending commit");
  } finally {
    s.kill();
  }
});

test("diff -f --overlaps repaints the shared-file list", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff follow overlaps");
  const featureWt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(featureWt, "widget.md"), "# widget\n");
  commitIn(featureWt, "add widget.md");
  const cleanWt = await ensureWorktree(repo, "clean", "main");
  fs.writeFileSync(path.join(cleanWt, "widget.md"), "# other\n");

  const s = spawnCli(repo, ["diff", "--overlaps", "-f"]);
  try {
    await waitForFollow(s.waitFor.bind(s), /^widget\.md: feature, clean$/gm, "the shared-file line");
  } finally {
    s.kill();
  }
});

test("diff -f --json is refused", async () => {
  const repo = makeRepo();
  await initProject(repo, "diff follow json");

  const r = await cli(repo, "diff", "-f", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /diff --json prints one document/);
  assert.ok(!r.stdout.includes("feature:"), "no roster frame before the refusal");
  assert.ok(!r.stdout.includes(CLEAR), "no clear-screen before the refusal");
});
