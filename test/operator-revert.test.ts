// --- tumwater revert <sha>: undo one merged change on main, under the primary-worktree lock ---
// The unit surface of src/operator/operator-revert.ts: the fail-closed ref/conflict/branch
// handling, pinned against real git repos. The CLI wiring (usage errors, exit codes, the
// printed head) is pinned in test/cli-operators.test.ts; here we exercise revertMergedCommit
// directly.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { headSha, makeRepo, seedCommit, sh, writeConfig } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { stampedRole } from "../src/git/commit-message.js";
import { previewRevert, revertFollowUp, revertMergedCommit, runRevertSha } from "../src/operator/operator-revert.js";
import type { RunDetail } from "../src/run/run-detail-data.js";

test("reverting a rename commit commits both halves and leaves the tree clean", async () => {
  const repo = makeRepo();
  seedCommit(repo, "old.txt", "keep\n", "add old name");
  seededRename(repo, "old.txt", "new.txt", "rename to new name");
  const renameSha = headSha(repo);

  const r = await revertMergedCommit(repo, renameSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(statusPorcelain(repo), "", "a rename revert leaves no half staged");
  assert.ok(fs.existsSync(path.join(repo, "old.txt")), "the old name is restored");
  assert.ok(!fs.existsSync(path.join(repo, "new.txt")), "the new name is undone");
});

function seededRename(repo: string, from: string, to: string, message: string): void {
  sh(repo, "git", "mv", from, to);
  sh(repo, "git", "commit", "-qm", message);
}

function statusPorcelain(repo: string): string {
  // The revert now logs an operator_revert event under .tumwater/log/, so the successful-revert
  // tests see that untracked dir; it is not a git-state half left behind, so filter it out and
  // keep asserting the revert left nothing staged or tracked-dirty.
  return sh(repo, "git", "status", "--porcelain")
    .split("\n")
    .filter((l) => l !== "" && !/^\?\? \.tumwater\/?$/.test(l))
    .join("\n");
}

test("reverting HEAD on a clean base-branch checkout moves main, stays clean, and names its message", async () => {
  const repo = makeRepo();
  seedCommit(repo, "file.txt", "content\n", "first work commit");
  const reverted = headSha(repo);

  const r = await revertMergedCommit(repo, "HEAD");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(headSha(repo), r.headSha, "returned head is the new HEAD");
  assert.equal(statusPorcelain(repo), "", "worktree is clean after the revert");
  const short = reverted.slice(0, 8);
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), `tumwater(operator): Revert ${short}`);
  assert.ok(!fs.existsSync(path.join(repo, "file.txt")), "the added file is undone by the revert");
});

test("a non-tip commit whose paths no later commit touched reverts cleanly", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  const aSha = headSha(repo);
  seedCommit(repo, "b.txt", "b\n", "add b");

  const r = await revertMergedCommit(repo, aSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(statusPorcelain(repo), "", "worktree is clean after the revert");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n", "b.txt survives the revert of a.txt");
  assert.ok(!fs.existsSync(path.join(repo, "a.txt")), "a.txt is undone");
});

test("reverting a commit a later commit edited in the same region fails closed and leaves HEAD alone", async () => {
  const repo = makeRepo();
  seedCommit(repo, "x.txt", "one\n", "add x");
  const xSha = headSha(repo);
  seedCommit(repo, "x.txt", "two\n", "edit x");
  const before = headSha(repo);

  const r = await revertMergedCommit(repo, xSha);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /conflicted/, `error names the conflict: ${r.error}`);
  assert.equal(headSha(repo), before, "HEAD did not move on a conflicted revert");
  assert.equal(statusPorcelain(repo), "", "worktree is clean after the failed revert");
  assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf8"), "two\n", "the later edit survives");
});

test("an unknown ref writes nothing and names the ref", async () => {
  const repo = makeRepo();
  const before = headSha(repo);

  const r = await revertMergedCommit(repo, "deadbeef");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /no such commit: deadbeef/);
  assert.equal(headSha(repo), before, "HEAD did not move");
  assert.equal(statusPorcelain(repo), "", "worktree is unchanged");
});

test("a ref that exists but is not on the base branch writes nothing and says so", async () => {
  const repo = makeRepo();
  seedCommit(repo, "m.txt", "m\n", "on main");
  const before = headSha(repo);
  // A branch with one extra commit that never reached main.
  sh(repo, "git", "checkout", "-b", "other");
  seedCommit(repo, "off.txt", "off\n", "off main");
  const offSha = headSha(repo);
  sh(repo, "git", "checkout", "main");

  const r = await revertMergedCommit(repo, "other");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, new RegExp(`${offSha.slice(0, 8)} is not on main`));
  assert.equal(headSha(repo), before, "HEAD did not move");
  assert.equal(statusPorcelain(repo), "", "worktree is unchanged");
});

test("checked out on a non-base branch, revert refuses even when the ref resolves", async () => {
  const repo = makeRepo();
  // Configure a base branch the checkout is not on, so the branch guard fires.
  sh(repo, "git", "branch", "base");
  sh(repo, "git", "checkout", "-b", "other");
  writeConfig(repo, { baseBranch: "base" });
  const before = headSha(repo);

  const r = await revertMergedCommit(repo, "HEAD");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /not on base/, `error names the base branch: ${r.error}`);
  assert.equal(headSha(repo), before, "HEAD did not move");
  // The revert wrote nothing: the only change in the tree is the config file the test wrote.
  assert.equal(statusPorcelain(repo), "?? tumwater.json");
});

test("revertMergedCommit refuses a dirty tracked worktree and leaves the edit byte for byte", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  seedCommit(repo, "b.txt", "b\n", "add b");
  const before = headSha(repo);
  fs.writeFileSync(path.join(repo, "b.txt"), "edited\n");

  const r = await revertMergedCommit(repo, "HEAD");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /staged or unstaged changes/, `error names the dirty worktree: ${r.error}`);
  assert.equal(headSha(repo), before, "HEAD did not move on a dirty worktree");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "edited\n", "the dirty edit survives unchanged");
});

test("previewRevert reports a clean revert and writes nothing", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  const aSha = headSha(repo);
  seedCommit(repo, "b.txt", "b\n", "add b");
  const before = headSha(repo);

  const r = await previewRevert(repo, aSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applies, true);
  assert.equal(r.dirty, false);
  assert.equal(r.subject, "add a");
  assert.deepEqual(r.paths, ["a.txt"]);
  assert.equal(headSha(repo), before);
  assert.equal(statusPorcelain(repo), "");
  assert.equal(sh(repo, "git", "stash", "list"), "");
});

test("previewRevert reports a conflict when a later commit edited the same region", async () => {
  const repo = makeRepo();
  seedCommit(repo, "x.txt", "one\n", "add x");
  const xSha = headSha(repo);
  seedCommit(repo, "x.txt", "two\n", "edit x");
  const before = headSha(repo);

  const r = await previewRevert(repo, xSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.applies, false);
  assert.equal(headSha(repo), before);
  assert.equal(statusPorcelain(repo), "");
  assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf8"), "two\n");
});

test("previewRevert flags an unstaged edit and leaves it byte for byte", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  const aSha = headSha(repo);
  seedCommit(repo, "b.txt", "b\n", "add b");
  fs.writeFileSync(path.join(repo, "b.txt"), "edited\n");

  const r = await previewRevert(repo, aSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.dirty, true);
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "edited\n");
});

test("previewRevert refuses an unknown ref and a root commit", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  const unknown = await previewRevert(repo, "deadbeef");
  assert.deepEqual(unknown, { ok: false, error: "no such commit: deadbeef" });
  const root = sh(repo, "git", "rev-list", "--max-parents=0", "HEAD").trim();
  const r = await previewRevert(repo, root);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /has 0 parents/);
});

test("revertMergedCommit refuses a root commit and writes nothing", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  const root = sh(repo, "git", "rev-list", "--max-parents=0", "HEAD").trim();
  const before = headSha(repo);
  const r = await revertMergedCommit(repo, root);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /has 0 parents; tumwater revert undoes a single-parent commit only/);
  assert.equal(headSha(repo), before);
  assert.equal(statusPorcelain(repo), "");
});

test("revertMergedCommit and previewRevert refuse a merge commit", async () => {
  const repo = makeRepo();
  seedCommit(repo, "a.txt", "a\n", "add a");
  const base = sh(repo, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
  sh(repo, "git", "checkout", "-qb", "side");
  seedCommit(repo, "b.txt", "b\n", "add b");
  sh(repo, "git", "checkout", "-q", base);
  seedCommit(repo, "c.txt", "c\n", "add c");
  sh(repo, "git", "merge", "-q", "--no-ff", "-m", "merge", "side");
  const before = headSha(repo);
  const r = await revertMergedCommit(repo, "HEAD");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /has 2 parents/);
  assert.equal(headSha(repo), before);
  assert.equal(statusPorcelain(repo), "");
  const p = await previewRevert(repo, "HEAD");
  assert.deepEqual(p, { ok: false, error: r.error });
});

test("stampedRole reads the role of a stamped subject only", () => {
  assert.equal(stampedRole("tumwater(feature): add x"), "feature");
  assert.equal(stampedRole("tumwater(operator): Revert abc\n\nbody"), "operator");
  assert.equal(stampedRole("work to undo"), undefined);
});

test("reverting a stamped role's commit logs one operator_revert naming the role", async () => {
  const repo = makeRepo();
  seedCommit(repo, "work.txt", "work\n", "tumwater(feature): add work");
  const revertedSha = headSha(repo);

  const r = await revertMergedCommit(repo, revertedSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const events = eventsOfType(repo, "operator_revert");
  assert.equal(events.length, 1, "exactly one operator_revert event");
  const e = events[0]!;
  assert.equal(e.commit, revertedSha);
  assert.equal(e.revert, headSha(repo));
  assert.equal(e.runner, "feature");
  assert.equal(e.subject, "tumwater(feature): add work");
});

test("reverting an unstamped commit's operator_revert carries no runner", async () => {
  const repo = makeRepo();
  seedCommit(repo, "hand.txt", "hand\n", "a hand-made change");
  const before = headSha(repo);

  const r = await revertMergedCommit(repo, "HEAD");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const events = eventsOfType(repo, "operator_revert");
  assert.equal(events.length, 1, "exactly one operator_revert event");
  const e = events[0]!;
  assert.equal(e.commit, before);
  assert.equal("runner" in e, false, "no runner on an unstamped revert");
});

test("revertFollowUp names a role, and is null when no role made the commit", () => {
  assert.equal(revertFollowUp("work to undo"), null);
  assert.equal(revertFollowUp("tumwater(operator): Revert abc"), null);
  assert.equal(revertFollowUp("tumwater(tumwater): Revert abc"), null);
  assert.equal(
    revertFollowUp("tumwater(feature): add x"),
    "the feature role may redo the work, so cancel or edit its PLANS.md/BUGS.md entry if it should not",
  );
});

test("runRevertSha refuses an unmerged run and a merged run naming no commit, and returns the merged sha", () => {
  const base = { role: "clean", run: 3, startTs: null, events: [], mergedSha: null } as unknown as RunDetail;
  const unmerged = runRevertSha("clean", 3, { ...base, result: "changed" });
  assert.deepEqual(unmerged, { ok: false, error: "clean run #3 did not merge (result: changed); there is nothing to revert" });
  const unnamed = runRevertSha("clean", 3, { ...base, result: "merged" });
  assert.ok(!unnamed.ok && unnamed.error.includes("no longer names its commit"));
  assert.deepEqual(runRevertSha("clean", 3, { ...base, result: "merged", mergedSha: "f".repeat(40) }), { ok: true, sha: "f".repeat(40) });
});

test("a deliberate tumwater revert lands and logs exactly one operator_revert", async () => {
  // Forward, never back, part 4/6 deleted the automatic revert subsystem: nothing is taken off
  // main but the operator's own deliberate revert, which goes through revertMergedCommit (under
  // the primary-worktree lock), never through the merge pipeline's slot. This pins that the lone
  // surviving revert path lands and logs one operator_revert.
  const repo = makeRepo();
  seedCommit(repo, "work.txt", "work\n", "tumwater(feature): add work");
  const revertedSha = headSha(repo);

  const r = await revertMergedCommit(repo, revertedSha);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const events = eventsOfType(repo, "operator_revert");
  assert.equal(events.length, 1, "exactly one operator_revert event");
  assert.equal(events[0]?.commit, revertedSha);
  assert.equal(headSha(repo), r.headSha, "the deliberate revert moved main");
});
