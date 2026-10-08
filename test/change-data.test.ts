import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectFleetChanges, collectRoleChange } from "../src/change/change-data.js";
import { loadConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { ensureDetachedWorktree, ensureWorktree } from "../src/git/worktree.js";
import { slotWorktreePath, slotsStatePath } from "../src/paths.js";
import { writeSlotsState } from "../src/git/slots-state.js";
import { commitIn, makeRepo, sh, writeConfig } from "./repo-fixtures.js";

// `tumwater diff`'s collector (src/change/change-data.ts), called directly: the cli-diff tests reach
// it through child-process CLI runs, whose coverage node --test never sees, and the collector
// edges they do not exercise at all — a configured base branch that does not exist, a branch
// that is fully merged while the worktree stays dirty, and a commit with an empty subject —
// had no test anywhere before this file. (test/change-render.test.ts pins the renderer beside
// the collector's absent-worktree and truncation paths; this file is the collector's
// remaining half.)

test("a configured base branch that does not exist degrades to no-base", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data no-base");
  const cfg = loadConfig(repo);
  cfg.baseBranch = "ghost";
  writeConfig(repo, cfg);
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "no-base");
  assert.equal(view.mainBranch, "ghost");
  assert.equal(view.ahead, 0);
  assert.deepEqual(view.commits, []);
  assert.deepEqual(view.dirtyFiles, []);
  assert.equal(view.diff, "");
  assert.equal(view.uncommittedDiff, "");

  // The fleet view degrades the same way, per role, and takes its baseline from the entries.
  const fleet = await collectFleetChanges(repo);
  assert.equal(fleet.mainBranch, "ghost");
  assert.ok(fleet.roles.length > 0, "every known role gets an entry");
  assert.ok(fleet.roles.every((r) => r.state === "no-base"));
});

test("a fully merged branch with a dirty worktree shows only the uncommitted half", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data merged but dirty");
  fs.writeFileSync(path.join(repo, "notes.txt"), "seeded\n");
  commitIn(repo, "seed notes.txt");
  const wt = await ensureWorktree(repo, "feature", "main");
  // No commits ahead: the tracked edit is the only pending change, so the ahead-of-main
  // patch stays "" while the uncommitted half carries it.
  fs.appendFileSync(path.join(wt, "notes.txt"), "uncommitted work\n");
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready");
  assert.equal(view.ahead, 0);
  assert.deepEqual(view.commits, []);
  assert.equal(view.diff, "");
  assert.deepEqual(view.dirtyFiles, ["notes.txt"]);
  assert.match(view.uncommittedDiff, /notes\.txt/);
});

test("a commit with an empty message parses to a sha with an empty subject", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data empty subject");
  const wt = await ensureWorktree(repo, "feature", "main");
  sh(wt, "git", "commit", "--allow-empty", "--allow-empty-message", "-m", "");
  sh(wt, "git", "commit", "--allow-empty", "-m", "a real subject");
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready");
  assert.equal(view.ahead, 2);
  // Newest first: the subjectful commit leads, the empty-subject one follows with its sha
  // intact and nothing to say — an empty message must not crash the parse or shift the order.
  assert.equal(view.commits[0]?.subject, "a real subject");
  assert.equal(view.commits[1]?.subject, "");
  assert.match(view.commits[1]?.sha ?? "", /^[0-9a-f]+$/);
});

test("a slot leased for a role's tick serves its change to the diff reader", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data slot lease");
  // The role's legacy worktree stays at main; its only work lives in the detached pool slot,
  // the way a role tick holds it. The reader must read the slot, not the stale legacy worktree.
  const legacy = await ensureWorktree(repo, "feature", "main");
  const slot = slotWorktreePath(repo, 1);
  await ensureDetachedWorktree(repo, slot, "main");
  fs.writeFileSync(path.join(slot, "feature.md"), "work\n");
  commitIn(slot, "feature work");
  writeSlotsState(repo, {
    slots: [
      {
        dir: slot,
        lease: { role: "feature", purpose: "tick", since: Date.now(), pid: process.pid },
        pinnedFor: null,
        lastRole: null,
        lastReleasedAt: null,
      },
    ],
  });

  // The legacy checkout still points at main, so only the resolver can yield the slot's work.
  assert.equal(sh(legacy, "git", "rev-parse", "HEAD"), sh(repo, "git", "rev-parse", "main"));
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready");
  assert.equal(view.ahead, 1);
  assert.deepEqual(
    view.commits.map((c) => c.subject),
    ["feature work"],
    "the slot's ahead-of-main commit is read",
  );
});

test("a malformed slots.json degrades to no pooled slot instead of crashing the reader", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data malformed slots");
  const legacy = await ensureWorktree(repo, "feature", "main");
  // A stray null in the persisted pool (a hand edit, an older writer): every reader of
  // slots.json — `tumwater diff`, the dashboard, retire — must degrade, not throw.
  fs.mkdirSync(path.dirname(slotsStatePath(repo)), { recursive: true });
  fs.writeFileSync(slotsStatePath(repo), JSON.stringify({ slots: [null] }));
  const view = await collectRoleChange(repo, "feature");
  assert.equal(view.state, "ready", "the legacy worktree still answers");
  assert.equal(view.ahead, 0);
  // The fleet-wide reader (the dashboard's /api/diff) survives the same file.
  const fleet = await collectFleetChanges(repo);
  assert.ok(fleet.roles.some((r) => r.role === "feature"));
  // The raw legacy path still resolves past the corrupt pool.
  assert.ok(fs.existsSync(legacy));
});

test("the fleet view keeps the counts and drops the patch fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data fleet view");
  fs.writeFileSync(path.join(repo, "notes.txt"), "seeded\n");
  commitIn(repo, "seed notes.txt");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.writeFileSync(path.join(wt, "feature.md"), "work\n");
  commitIn(wt, "feature work");
  fs.appendFileSync(path.join(wt, "notes.txt"), "uncommitted\n");

  const fleet = await collectFleetChanges(repo);
  assert.equal(fleet.mainBranch, "main");
  const feature = fleet.roles.find((r) => r.role === "feature");
  assert.ok(feature, "the holding role appears");
  assert.equal(feature.state, "ready");
  assert.equal(feature.ahead, 1);
  assert.deepEqual(feature.commits.map((c) => c.subject), ["feature work"]);
  assert.deepEqual(feature.dirtyFiles, ["notes.txt"]);
  assert.ok(!("diff" in feature) && !("uncommittedDiff" in feature), "the patch halves never ride the fleet view");
});
