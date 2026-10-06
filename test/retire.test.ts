// --- retire --role <id>: remove a disabled loop's worktree, branch, and per-role state ---
// The removal is plain git + file work on the repo (no running harness involved), so the whole
// surface is testable with fixtures: an initialized repo plus the ensureWorktree artifacts a
// retired loop leaves behind. The safety rails (enabled role, unlanded commits, dirty worktree,
// mid-tick) must refuse without removing anything; --force overrides; a second run is
// idempotent, reporting what was already gone.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { branchName, landingRefName, pausedRolesPath, worktreePath } from "../src/paths.js";
import { collectRetire, retireRole, type RetireResult, type RetireStatus } from "../src/retire.js";
import { landingRefExists } from "./orchestrator-fixtures.js";
import { initializedWorktree, mainSha, sh } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";
import { setRef } from "../src/git/git.js";
import { freshLoopState, saveLoopState } from "../src/loop-state.js";
import { writeJsonAtomic } from "../src/json-files.js";
import { helpTopic } from "../src/help.js";

// `feature` is enabled by default config, so a retire of it must refuse; `clean` is a
// user-defined loop the tests disable in tumwater.json first.

test("retire removes a disabled role's worktree, branch, and landing ref", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");

  // A landing ref pinning a sha already merged into main (the stale-pin crash state) must not
  // block — only a pin holding unlanded work counts against the retire.
  await setRef(root, landingRefName("improve"), mainSha(root));

  const r = await cli(root, "retire", "--role", "improve", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout) as { role: string; removed: string[]; skipped: string[] };
  assert.deepEqual(payload.removed, ["worktree", "branch", "landingRef"]);
  assert.deepEqual(payload.skipped, ["pausedMarker"]);
  assert.ok(!fs.existsSync(worktreePath(root, "improve")), "worktree directory gone");
  assert.equal(
    sh(root, "git", "worktree", "list").includes("improve"),
    false,
    "no worktree registration left",
  );
  assert.equal(await landingRefExists(root, "improve"), false, "landing ref deleted");
  // Branch gone: rev-parse fails.
  const branchGone = await import("../src/git/git.js").then((m) => m.branchHead(root, branchName("improve")));
  assert.equal(branchGone, null, "branch deleted");
});

test("retire refuses an enabled role, unlanded commits, a dirty worktree, and a mid-tick loop; --force goes through", async () => {
  const { root, wt } = await initializedWorktree();

  // Enabled role: refuse, nothing removed.
  let r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /still enabled in tumwater\.json/);
  assert.ok(fs.existsSync(wt), "enabled-role refusal removes nothing");

  disableRole(root, "improve");

  // Unlanded commits: refuse.
  fs.writeFileSync(path.join(wt, "work.txt"), "unlanded\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "unlanded work");
  r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unlanded commit/);
  assert.ok(fs.existsSync(wt), "unlanded-commit refusal removes nothing");

  // --force overrides and removes everything, unlanded commits included.
  r = await cli(root, "retire", "--role", "improve", "--force", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(worktreePath(root, "improve")));
});

test("retire refuses a dirty worktree and a mid-tick loop before removing anything", async () => {
  const { root, wt } = await initializedWorktree();
  disableRole(root, "improve");

  fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");
  const r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted changes/);
  assert.ok(fs.existsSync(wt), "dirty refusal removes nothing");
  fs.rmSync(path.join(wt, "scratch.txt"));

  // A persisted running flag (loop-state.json) refuses too.
  const state = freshLoopState("improve");
  state.running = true;
  saveLoopState(root, state);
  const r2 = await cli(root, "retire", "--role", "improve");
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /tick is in flight/);
  assert.ok(fs.existsSync(wt), "mid-tick refusal removes nothing");
  const status: RetireStatus = await collectRetire(root, "improve");
  assert.equal(status.midTick, true);
});

test("retire refuses an unusable worktree it cannot check for uncommitted changes", async () => {
  const { root, wt } = await initializedWorktree();
  disableRole(root, "improve");

  // Present but unusable: the .git pointer is broken, so isDirty cannot run — yet uncommitted
  // work may sit in the directory. Retire must refuse rather than remove it sight unseen.
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /gone/nowhere\n");
  fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");

  const r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1, "refuses without --force");
  assert.match(r.stderr, /unusable/);
  assert.ok(fs.existsSync(path.join(wt, "scratch.txt")), "uncommitted work survives");

  // --force overrides: the removal goes through.
  const rf = await cli(root, "retire", "--role", "improve", "--force", "--json");
  assert.equal(rf.code, 0, rf.stderr);
  assert.ok(!fs.existsSync(worktreePath(root, "improve")), "worktree removed with --force");
});

test("a second retire is idempotent: skipped artifacts, exit 0", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");

  const first = await cli(root, "retire", "--role", "improve", "--json");
  assert.equal(first.code, 0, first.stderr);
  const second = await cli(root, "retire", "--role", "improve", "--json");
  assert.equal(second.code, 0, second.stderr);
  const payload = JSON.parse(second.stdout) as { removed: string[]; skipped: string[] };
  assert.deepEqual(payload.removed, []);
  assert.deepEqual(payload.skipped, ["worktree", "branch", "landingRef", "pausedMarker"]);

  // The human-readable form says what was already gone, in lines, not an error.
  const text = await cli(root, "retire", "--role", "improve");
  assert.equal(text.code, 0);
  assert.match(text.stdout, /nothing to remove: the worktree/);
});

test("retire drops a paused-state marker entry for the role", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  writeJsonAtomic(pausedRolesPath(root), { roles: ["improve", "clean"], at: Date.now() });

  const result: RetireResult = await retireRole(root, "improve", { force: false });
  assert.ok(result.removed.includes("pausedMarker"));
  const remaining = JSON.parse(fs.readFileSync(pausedRolesPath(root), "utf8")) as { roles: string[] };
  assert.deepEqual(remaining.roles, ["clean"]);
});

test("retire removes a dead worktree registration (directory already gone, branch remains)", async () => {
  const { root, wt } = await initializedWorktree();
  disableRole(root, "improve");
  fs.rmSync(wt, { recursive: true, force: true });

  const r = await cli(root, "retire", "--role", "improve", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout) as { removed: string[] };
  // The worktree was already gone (skipped), but the branch and its registration are removed.
  assert.ok(payload.removed.includes("branch"));
  assert.equal(sh(root, "git", "worktree", "list").includes("improve"), false);
  assert.equal(sh(root, "git", "branch", "--list", branchName("improve")).trim(), "");
});

test("retire counts a dead worktree's unlanded branch commits even when the directory is gone", async () => {
  const { root, wt } = await initializedWorktree();
  disableRole(root, "improve");

  // Unlanded work on the branch, then the worktree directory disappears (rm'd, registration
  // stale) — collectRetire can no longer read HEAD from the worktree, but the branch ref
  // still holds the commit, so the safety rail must still refuse.
  fs.writeFileSync(path.join(wt, "work.txt"), "unlanded\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "unlanded work");
  fs.rmSync(wt, { recursive: true, force: true });

  const status: RetireStatus = await collectRetire(root, "improve");
  assert.equal(status.aheadOfMain, 1, "the branch ref's unlanded commit is counted");

  const r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1, "refuses without --force");
  assert.match(r.stderr, /unlanded commit/);
  assert.ok(sh(root, "git", "branch", "--list", branchName("improve")).trim() !== "", "branch survives");
});

test("retire validates its arguments like the other operator commands", async () => {
  const { root } = await initializedWorktree();
  let r = await cli(root, "retire");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /retire requires --role <id>/);
  r = await cli(root, "retire", "--rol", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  r = await cli(root, "retire", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
});

test("tumwater help retire shows the command's usage stanza", () => {
  const topic = helpTopic("retire");
  assert.ok(topic !== null, "retire is a help topic");
  assert.match(topic ?? "", /tumwater retire --role <id>/);
  assert.match(topic ?? "", /--force/);
});

/** Disable one role in the repo's tumwater.json in place. */
function disableRole(root: string, role: string): void {
  const file = path.join(root, "tumwater.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { roles: Record<string, { enabled?: boolean }> };
  cfg.roles ??= {};
  cfg.roles[role] = { ...cfg.roles[role], enabled: false };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}