// --- retire --role <id>: remove a disabled role's worktree, branch, and per-role state ---
// The removal is plain git + file work on the repo (no running harness involved), so the whole
// surface is testable with fixtures: an initialized repo plus the ensureWorktree artifacts a
// retired role leaves behind. The safety rails (enabled role, unmerged commits, dirty worktree,
// mid-run) must refuse without removing anything; --force overrides; a second run is
// idempotent, reporting what was already gone.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { branchName, mergeRefName, legacyLandingRefName, pausedRolesPath, slotWorktreePath, worktreePath } from "../src/paths.js";
import { collectRetire, hasRetirableLeftovers, previewRetire, retireRole, type RetireResult, type RetireStatus } from "../src/operator/retire.js";
import { mergeRefExists } from "./fixtures/orchestrator-fixtures.js";
import { initializedRepo, initializedWorktree, mainSha, sh } from "./fixtures/repo-fixtures.js";
import { ensureDetachedWorktree } from "../src/git/worktree.js";
import { readSlotsState, writeSlotsState } from "../src/git/slots-state.js";
import { cli } from "./helpers/cli-harness.js";
import { readJson } from "./helpers/json-read.js";
import { disableRole } from "./helpers/disable-role.js";
import { branchHead, setRef } from "../src/git/git.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { writeJsonAtomic } from "../src/files/json-files.js";
import { helpTopic } from "../src/cli/help.js";

// `feature` is enabled by default config, so a retire of it must refuse; `clean` is a
// user-defined role the tests disable in tumwater.json first.

test("retire removes a disabled role's worktree, branch, and merge ref", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");

  // A merge ref pinning a sha already merged into main (the stale-pin crash state) must not block —
  // only a pin holding unmerged work counts against the retire.
  await setRef(root, mergeRefName("improve"), mainSha(root));

  const r = await cli(root, "retire", "--role", "improve", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout) as { role: string; removed: string[]; skipped: string[] };
  assert.deepEqual(payload.removed, ["worktree", "branch", "mergeRef"]);
  assert.deepEqual(payload.skipped, ["pausedMarker"]);
  assert.ok(!fs.existsSync(worktreePath(root, "improve")), "worktree directory gone");
  assert.equal(
    sh(root, "git", "worktree", "list").includes("improve"),
    false,
    "no worktree registration left",
  );
  assert.equal(mergeRefExists(root, "improve"), false, "merge ref deleted");
  // Branch gone: rev-parse fails.
  const branchGone = await import("../src/git/git.js").then((m) => m.branchHead(root, branchName("improve")));
  assert.equal(branchGone, null, "branch deleted");
});

test("retire refuses an enabled role, unmerged commits, a dirty worktree, and a mid-run role; --force goes through", async () => {
  const { root, wt } = await initializedWorktree();

  // Enabled role: refuse, nothing removed.
  let r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /still enabled in tumwater\.json/);
  assert.ok(fs.existsSync(wt), "enabled-role refusal removes nothing");

  disableRole(root, "improve");

  // Unmerged commits: refuse.
  fs.writeFileSync(path.join(wt, "work.txt"), "unmerged\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "unmerged work");
  r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unmerged commit/);
  assert.ok(fs.existsSync(wt), "unmerged-commit refusal removes nothing");

  // --force overrides and removes everything, unmerged commits included.
  r = await cli(root, "retire", "--role", "improve", "--force", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(worktreePath(root, "improve")));
});

test("retire refuses a dirty worktree and a mid-run role before removing anything", async () => {
  const { root, wt } = await initializedWorktree();
  disableRole(root, "improve");

  fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");
  const r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted changes/);
  assert.ok(fs.existsSync(wt), "dirty refusal removes nothing");
  fs.rmSync(path.join(wt, "scratch.txt"));

  // A persisted running flag (runner-state.json) refuses too.
  const state = freshRunnerState("improve");
  state.running = true;
  saveRunnerState(root, state);
  const r2 = await cli(root, "retire", "--role", "improve");
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /run is in progress/);
  assert.ok(fs.existsSync(wt), "mid-run refusal removes nothing");
  const status: RetireStatus = await collectRetire(root, "improve");
  assert.equal(status.midRun, true);
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
  assert.deepEqual(payload.skipped, ["worktree", "branch", "mergeRef", "pausedMarker"]);

  // The human-readable form says what was already gone, in lines, not an error.
  const text = await cli(root, "retire", "--role", "improve");
  assert.equal(text.code, 0);
  assert.match(text.stdout, /nothing to remove: the worktree/);
});

test("retire a pinned slot clears the pin and resets it in place instead of removing it", async () => {
  const root = await initializedRepo();
  disableRole(root, "improve");
  sh(root, "git", "branch", branchName("improve"), "main");
  const slot = slotWorktreePath(root, 1);
  await ensureDetachedWorktree(root, slot, branchName("improve"));
  writeSlotsState(root, {
    slots: [
      { dir: slot, lease: null, pinnedFor: "improve", lastRole: null, lastReleasedAt: null },
    ],
  });
  // A stray untracked file the reset must clean; --force carries past the dirty rail.
  fs.writeFileSync(path.join(slot, "scratch.txt"), "stray\n");

  const r = await cli(root, "retire", "--role", "improve", "--force", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(slot), "the slot directory survives");
  assert.equal(sh(slot, "git", "status", "--porcelain").trim(), "", "the slot is left clean");
  assert.equal(
    sh(slot, "git", "rev-parse", "--abbrev-ref", "HEAD").trim(),
    "HEAD",
    "the slot is left detached",
  );
  assert.equal(readSlotsState(root).slots.find((s) => s.dir === slot)?.pinnedFor, null, "the pin is cleared");
  assert.equal(sh(root, "git", "branch", "--list", branchName("improve")).trim(), "", "the branch is deleted");
});

test("retire clears a pinned slot whose directory is already gone", async () => {
  const root = await initializedRepo();
  disableRole(root, "improve");
  sh(root, "git", "branch", branchName("improve"), "main");
  const slot = slotWorktreePath(root, 1);
  // The pin survives while the pooled checkout is gone (a failed `worktree add`, a hand-deleted
  // directory): the retire must still release the claim, or the dead dir resolves this role's
  // checkout forever and the slot can never be reused.
  writeSlotsState(root, {
    slots: [
      { dir: slot, lease: null, pinnedFor: "improve", lastRole: null, lastReleasedAt: null },
    ],
  });
  assert.ok(!fs.existsSync(slot), "precondition: the slot directory is absent");

  const r = await cli(root, "retire", "--role", "improve", "--force", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    readSlotsState(root).slots.find((s) => s.dir === slot)?.pinnedFor,
    null,
    "the pin is cleared even though the slot directory is gone",
  );
  assert.equal(sh(root, "git", "branch", "--list", branchName("improve")).trim(), "", "the branch is deleted");
});

test("retire drops a paused-state marker entry for the role", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  writeJsonAtomic(pausedRolesPath(root), { roles: ["improve", "clean"], at: Date.now() });

  const result: RetireResult = await retireRole(root, "improve", { force: false });
  assert.ok(result.removed.includes("pausedMarker"));
  const remaining = readJson(pausedRolesPath(root)) as { roles: string[] };
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

test("retire counts a dead worktree's unmerged branch commits even when the directory is gone", async () => {
  const { root, wt } = await initializedWorktree();
  disableRole(root, "improve");

  // Unmerged work on the branch, then the worktree directory disappears (rm'd, registration stale)
  // — collectRetire can no longer read HEAD from the worktree, but the branch ref still holds the
  // commit, so the safety rail must still refuse.
  fs.writeFileSync(path.join(wt, "work.txt"), "unmerged\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "unmerged work");
  fs.rmSync(wt, { recursive: true, force: true });

  const status: RetireStatus = await collectRetire(root, "improve");
  assert.equal(status.aheadOfMain, 1, "the branch ref's unmerged commit is counted");

  const r = await cli(root, "retire", "--role", "improve");
  assert.equal(r.code, 1, "refuses without --force");
  assert.match(r.stderr, /unmerged commit/);
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
  sh(root, "git", "update-ref", "refs/heads/tumwater/x", "HEAD");
  r = await cli(root, "retire", "--role", "../x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role/);
});

function leftoverInstanceRepo() {
  return initializedRepo().then((root) => {
    const file = path.join(root, "tumwater.json");
    const cfg = readJson(file) as { roles: Record<string, { instances?: number }> };
    cfg.roles.feature = { ...cfg.roles.feature, instances: 2 };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    sh(root, "git", "branch", branchName("feature-5"));
    return root;
  });
}

test("retire accepts a leftover instance id above the configured instances and removes its branch", async () => {
  const root = await leftoverInstanceRepo();
  const dry = await cli(root, "retire", "--role", "feature-5", "--dry-run");
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would remove the branch \(tumwater\/feature-5\)/);
  const r = await cli(root, "retire", "--role", "feature-5", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.ok((JSON.parse(r.stdout) as { removed: string[] }).removed.includes("branch"));
  assert.equal(await branchHead(root, branchName("feature-5")), null);
});

test("retire still refuses a leftover id whose branch holds unmerged commits", async () => {
  const root = await leftoverInstanceRepo();
  const tree = sh(root, "git", "rev-parse", "HEAD^{tree}").trim();
  const commit = sh(root, "git", "commit-tree", tree, "-p", "HEAD", "-m", "unmerged").trim();
  sh(root, "git", "update-ref", `refs/heads/${branchName("feature-5")}`, commit);
  const r = await cli(root, "retire", "--role", "feature-5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unmerged commit/);
  assert.equal(await branchHead(root, branchName("feature-5")), commit);
});

test("hasRetirableLeftovers gates on a well-formed non-director id with a branch or merge ref", async () => {
  const root = await initializedRepo();
  sh(root, "git", "branch", branchName("director"));
  assert.equal(await hasRetirableLeftovers(root, "director"), false);
  assert.equal(await hasRetirableLeftovers(root, "nothing-here"), false);
  await setRef(root, mergeRefName("gone"), mainSha(root));
  assert.equal(await hasRetirableLeftovers(root, "gone"), true);
});

test("tumwater help retire shows the command's usage stanza", () => {
  const topic = helpTopic("retire");
  assert.ok(topic !== null, "retire is a help topic");
  assert.match(topic ?? "", /tumwater retire --role <id>/);
  assert.match(topic ?? "", /--force/);
  assert.match(topic ?? "", /accepted while its branch or merge ref remains/);
});

test("retire refuses an enabled work instance id, not just its bare base role (part 5b/7)", async () => {
  const root = await initializedRepo();
  const file = path.join(root, "tumwater.json");
  const cfg = readJson(file) as { roles: Record<string, { enabled?: boolean; instances?: number }> };
  cfg.roles.feature = { ...cfg.roles.feature, enabled: true, instances: 2 };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");

  // `knownRoleIds` accepts `feature-2`, so retire must agree it is a live role: the
  // still-enabled rail trips and nothing is removed.
  const status = await collectRetire(root, "feature-2");
  assert.equal(status.enabledInConfig, true, "an enabled instance is not reported disabled");
  await assert.rejects(
    () => retireRole(root, "feature-2", {}),
    /still enabled in tumwater\.json/,
  );
});

test("retire refuses when tumwater.json cannot be read, even with --force", async () => {
  const { root } = await initializedWorktree();
  // An unreadable config means retire cannot resolve baseBranch (what "unmerged" counts against) or
  // which roles are enabled, so it must surface the error instead of acting on unknown state — and
  // no safety rail, not even --force, may bypass that.
  fs.writeFileSync(path.join(root, "tumwater.json"), "{ not json\n");

  await assert.rejects(() => collectRetire(root, "improve"), /cannot read tumwater\.json/);
  await assert.rejects(
    () => retireRole(root, "improve", { force: true }),
    /cannot read tumwater\.json/,
  );
  assert.ok(fs.existsSync(worktreePath(root, "improve")), "nothing removed when config is unreadable");
});

test("retire --dry-run previews the removal and changes nothing", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  await setRef(root, mergeRefName("improve"), mainSha(root));

  const r = await cli(root, "retire", "--role", "improve", "--dry-run", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout) as {
    dryRun: boolean;
    wouldRemove: string[];
    skipped: string[];
    objections: string[];
  };
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.wouldRemove, ["worktree", "branch", "mergeRef"]);
  assert.deepEqual(payload.skipped, ["pausedMarker"]);
  assert.deepEqual(payload.objections, []);
  assert.ok(fs.existsSync(worktreePath(root, "improve")), "worktree directory kept");
  const head = await import("../src/git/git.js").then((m) => m.branchHead(root, branchName("improve")));
  assert.notEqual(head, null, "branch kept");
  assert.equal(mergeRefExists(root, "improve"), true, "merge ref kept");
});

test("retire --dry-run reports rail objections without failing; --force reframes them", async () => {
  const { root } = await initializedWorktree();
  const plain = await cli(root, "retire", "--role", "feature", "--dry-run");
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /would refuse: .*still enabled in tumwater\.json/);
  assert.ok(plain.stdout.trimEnd().endsWith("dry run — nothing removed"));
  const forced = await cli(root, "retire", "--role", "feature", "--dry-run", "--force");
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /--force overrides: .*still enabled in tumwater\.json/);
  assert.doesNotMatch(forced.stdout, /would refuse/);
});

test("previewRetire lists a paused marker and leaves it in place", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  writeJsonAtomic(pausedRolesPath(root), { roles: ["improve", "clean"], at: Date.now() });
  const preview = await previewRetire(root, "improve");
  assert.ok(preview.wouldRemove.includes("pausedMarker"));
  assert.deepEqual((readJson(pausedRolesPath(root)) as { roles: string[] }).roles, ["improve", "clean"]);
});

test("retire --dry-run leaves a pinned slot's pin alone and rejects a misspelled flag", async () => {
  const root = await initializedRepo();
  disableRole(root, "improve");
  sh(root, "git", "branch", branchName("improve"), "main");
  const slot = slotWorktreePath(root, 1);
  await ensureDetachedWorktree(root, slot, branchName("improve"));
  writeSlotsState(root, {
    slots: [{ dir: slot, lease: null, pinnedFor: "improve", lastRole: null, lastReleasedAt: null }],
  });
  const r = await cli(root, "retire", "--role", "improve", "--dry-run");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readSlotsState(root).slots.find((s) => s.dir === slot)?.pinnedFor, "improve");
  const bad = await cli(root, "retire", "--role", "improve", "--dry-runn");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /unknown argument: --dry-runn/);
  assert.match(helpTopic("retire") ?? "", /--dry-run/);
});

test("hasRetirableLeftovers counts a legacy-named pin", async () => {
  const root = await initializedRepo();
  await setRef(root, legacyLandingRefName("oldpin"), mainSha(root));
  assert.equal(await hasRetirableLeftovers(root, "oldpin"), true);
});
