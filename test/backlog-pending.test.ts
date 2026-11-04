/** Tests for src/backlog/backlog-pending.ts — what unmerged changes do to PLANS.md's
 * `## Planned`, read from the merge pins and role branches (plans/duplicate-plans.md
 * "Decision" 1, part 2/6): the snapshot refresh, its memo, and the projection the plan
 * role's stop count and Needs-review check read. Against a temp git repo, never a team. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  pendingPlanChanges,
  projectedPlannedEntries,
  refreshPendingPlans,
  type PendingGitRunner,
} from "../src/backlog/backlog-pending.js";
import { planBacklogFull, projectedPlanEligibleCount } from "../src/scheduling/claims.js";
import { eligibleEntries } from "../src/backlog/backlog-eligibility.js";
import { defaultConfig } from "../src/config/config.js";
import { makeRepo, commitIn, headSha, sh } from "./fixtures/repo-fixtures.js";
import { gitTry } from "../src/git/git-run.js";

const CFG = defaultConfig();
const PLANS = (entries: string[]): string => `# Plans\n\n## Planned\n\n${entries.join("\n")}\n## Done\n\n_None yet._\n`;
const entry = (title: string, note = ""): string => `### ${title} (planned 2026-01-01 by plan)\n${note}Body.\n`;

/** A makeRepo'd repo whose reflog is on (so for-each-ref's --no-merged, which falls back to
 * reflog dates, sees a fresh branch as unmerged) and whose main holds a committed PLANS.md.
 * `marker` makes the seed commit unique to this repo: makeRepo shares one seed SHA, and the
 * same-content, same-second pins these tests make would otherwise collide and carry the
 * sha-keyed memo across tests. Returns the repo and a writer that rewrites and commits
 * PLANS.md on the current branch. */
function plansRepo(body: string, marker: string): { dir: string; write: (next: string) => void } {
  const dir = makeRepo();
  fs.appendFileSync(path.join(dir, "seed.txt"), `\n${marker}\n`);
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", `seed ${marker}`);
  sh(dir, "git", "config", "core.logAllRefUpdates", "true");
  fs.writeFileSync(path.join(dir, "PLANS.md"), body);
  commitIn(dir, "plans");
  return { dir, write: (next: string) => { fs.writeFileSync(path.join(dir, "PLANS.md"), next); commitIn(dir, "plans"); } };
}

/** A pin at `refs/tumwater/merge/<role>` on the commit that `change` makes, back on main. */
function pinAt(dir: string, role: string, change: (dir: string) => void): string {
  sh(dir, "git", "checkout", "--detach");
  change(dir);
  commitIn(dir, "pin");
  const sha = headSha(dir);
  sh(dir, "git", "update-ref", `refs/tumwater/merge/${role}`, sha);
  sh(dir, "git", "checkout", "main");
  return sha;
}

test("a pinned addition: planBacklogFull sees the pin's entry, and without it does not", async () => {
  const { dir } = plansRepo(PLANS([entry("A")]), "marker-one");
  // No pin yet: one eligible entry, target two — the stop count is false on main alone.
  await refreshPendingPlans(dir, "main");
  assert.equal(planBacklogFull(dir, CFG), false);
  // Pin a second entry: the projection counts it and the stop count turns true.
  const pinSha = pinAt(dir, "feature", (d) => fs.writeFileSync(path.join(d, "PLANS.md"), PLANS([entry("A"), entry("B")])));
  await refreshPendingPlans(dir, "main");
  assert.equal(projectedPlanEligibleCount(dir), 2);
  assert.equal(planBacklogFull(dir, CFG), true);
  // The pin's change records the addition with the pin's ref and role.
  const change = pendingPlanChanges(dir)[0]!;
  assert.equal(change.ref, "refs/tumwater/merge/feature");
  assert.equal(change.role, "feature");
  assert.deepEqual(change.added.map((e) => e.title), ["B (planned 2026-01-01 by plan)"]);
  assert.deepEqual(change.removedKeys, []);
  assert.deepEqual(change.changed, []);
  // Main's reader is untouched: it still sees one entry, still eligible.
  assert.equal(eligibleEntries(dir, "feature").length, 1);
  // Simulate the merge: main fast-forwards to the pin's commit, so the pin is contained in
  // main and for-each-ref's --no-merged excludes it.
  sh(dir, "git", "update-ref", "refs/heads/main", pinSha);
  await refreshPendingPlans(dir, "main");
  assert.equal(pendingPlanChanges(dir).length, 0, "a pin already contained in main contributes nothing");
});

test("a held branch that splits a Needs-review entry: the projection lists the parts and the hold is gone", async () => {
  const { dir } = plansRepo(PLANS([entry("Big, part 1/1: x", "**Needs review 2026-01-02 by feature: too large for one run**\n")]), "marker-two");
  assert.equal(planBacklogFull(dir, CFG), false, "the marked entry keeps the plan role running");
  sh(dir, "git", "checkout", "-b", "tumwater/plan");
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    PLANS([entry("Big, part 1/2: x"), entry("Big, part 2/2: x", "requires part 1/2 landed")]),
  );
  commitIn(dir, "split");
  await refreshPendingPlans(dir, "main");
  const change = pendingPlanChanges(dir)[0]!;
  assert.equal(change.ref, "refs/heads/tumwater/plan");
  assert.deepEqual(change.added.map((e) => e.title), ["Big, part 1/2: x (planned 2026-01-01 by plan)", "Big, part 2/2: x (planned 2026-01-01 by plan)"]);
  // The removed key is the Needs-review entry's stamp-free identity.
  assert.equal(change.removedKeys.length, 1);
  assert.match(change.removedKeys[0]!, /big, part 1\/1: x/);
  const projected = projectedPlannedEntries(dir);
  assert.equal(projected.length, 2, "the projection lists the two parts");
  // The needs-review hold is gone from the projection, and both parts are eligible, so the
  // stop count (target two, no needs-review hold) reports full — the plan role stops instead
  // of re-splitting the same entry.
  assert.equal(projected.some((e) => e.body.includes("**Needs review")), false);
  assert.equal(planBacklogFull(dir, CFG), true, "two eligible projected entries, no needs-review hold");
});

test("a pin and a branch of one role on one sha count once", async () => {
  const { dir } = plansRepo(PLANS([entry("A")]), "marker-three");
  const edit = (d: string): void => fs.writeFileSync(path.join(d, "PLANS.md"), PLANS([entry("A"), entry("B")]));
  const sha = pinAt(dir, "plan", edit);
  sh(dir, "git", "branch", "-f", "tumwater/plan", sha);
  await refreshPendingPlans(dir, "main");
  assert.equal(pendingPlanChanges(dir).length, 1, "pin and branch on one sha count once");
  assert.equal(pendingPlanChanges(dir)[0]!.sha, sha);
});

test("an unreadable PLANS.md contributes nothing and leaves the earlier snapshot", async () => {
  const { dir } = plansRepo(PLANS([entry("A")]), "marker-four");
  // A good pin first, so the role has an earlier entry to keep.
  const goodSha = pinAt(dir, "plan", (d) => fs.writeFileSync(path.join(d, "PLANS.md"), PLANS([entry("A"), entry("B")])));
  await refreshPendingPlans(dir, "main");
  assert.equal(pendingPlanChanges(dir).length, 1);
  // A second role's pin whose file read fails: it contributes nothing and the plan pin's
  // entry stays.
  sh(dir, "git", "checkout", "--detach");
  sh(dir, "git", "reset", "--hard", "main");
  sh(dir, "git", "commit", "--allow-empty", "-m", "empty pin");
  sh(dir, "git", "update-ref", "refs/tumwater/merge/feature", headSha(dir));
  sh(dir, "git", "checkout", "main");
  const failing: PendingGitRunner = async (cwd, ...args) =>
    args.includes("PLANS.md") ? null : gitTry(cwd, ...args);
  await refreshPendingPlans(dir, "main", failing);
  const changes = pendingPlanChanges(dir);
  assert.equal(changes.length, 1, "the failing pin contributes nothing and keeps no new entry");
  assert.equal(changes[0]!.sha, goodSha, "the plan pin's earlier entry stays in place");
});

test("a second refresh with unchanged refs re-reads no commit: only the one for-each-ref runs", async () => {
  const { dir } = plansRepo(PLANS([entry("A")]), "marker-five");
  pinAt(dir, "plan", (d) => fs.writeFileSync(path.join(d, "PLANS.md"), PLANS([entry("A"), entry("B")])));
  const calls: string[][] = [];
  const counting: PendingGitRunner = async (cwd, ...args) => {
    calls.push(args);
    return gitTry(cwd, ...args);
  };
  await refreshPendingPlans(dir, "main", counting);
  const afterFirst = calls.length;
  assert.ok(afterFirst > 1, "the first refresh reads the pin's commit");
  await refreshPendingPlans(dir, "main", counting);
  const second = calls.slice(afterFirst);
  assert.equal(second.length, 1, "the repeat refresh runs only the for-each-ref");
  assert.match(second[0]![0]!, /for-each-ref/);
});
