import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { steerToMain, previewSteer } from "../src/operator/operator-land.js";
import { mergeLockDir } from "../src/paths.js";
import { withLock } from "../src/concurrency/lock.js";
import { sleep } from "./helpers/wait.js";
import { makeRepo, seedCommit, sh, tmpdir, mainSha } from "./fixtures/repo-fixtures.js";

// Coverage for `tumwater land` (PLAN.md, Operator steering part 1/5): put the operator's own
// commit(s) on main under the team's merge lock. The primary checkout stays on main; the
// operator's branch is a separate worktree, so baseBranch resolves to main without a config file.
// The deterministic insert-only backlog resolver is pinned in merge-backlog-conflicts.test.ts;
// here the cherry-pick loop is exercised through the fast-forward, the clean replay, the
// code-conflict refusal (the loop calls the resolver and refuses on a non-backlog file), and
// the dry-run previews.

/** A repo on main plus a second worktree on branch `feat`, checked out at main's head. The
 * `.tumwater/` state dir is created untracked (a real root always has it) so the merge lock
 * acquire, whose atomic rename lands in that parent, has a parent to rename into. */
function repoWithFeat(root: string): { feat: string } {
  const state = path.join(root, ".tumwater");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true }); // a fresh template repo may not carry info/
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".tumwater/\n"); // a real root gitignores it
  const feat = path.join(root, "..", `feat-${path.basename(root)}`);
  sh(root, "git", "worktree", "add", "-b", "feat", feat, "main");
  return { feat };
}

test("land fast-forwards main when main is behind the ref", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.replayed, false);
    assert.equal(result.headSha, sh(feat, "git", "rev-parse", "feat"));
    assert.notEqual(result.headSha, before);
  }
  assert.equal(mainSha(root), sh(feat, "git", "rev-parse", "feat"));
  assert.equal(sh(root, "git", "show", "main:feat.txt"), "feat");
});

test("land moves a local branch that is checked out nowhere to the landed tip", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const featTip = sh(root, "git", "rev-parse", "feat");
  seedCommit(root, "main.txt", "main\n", "main edit"); // diverge: the land replays, so the landed tip is a new commit
  sh(root, "git", "worktree", "remove", feat); // leave `feat` a local branch with no checkout anywhere
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.match(result.refNote, /the feat branch was moved to it$/);
  assert.notEqual(mainSha(root), featTip);
  assert.equal(sh(root, "git", "rev-parse", "refs/heads/feat"), mainSha(root));
});

test("land replays the ref's commits onto a moved main when the two have diverged", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit"); // diverges: A -> feat
  seedCommit(root, "main.txt", "main\n", "main edit"); // A -> main (different file: clean replay)
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.replayed, true);
    assert.equal(result.headSha, mainSha(root));
    assert.notEqual(result.headSha, before);
  }
  // Both the operator's commit and main's move are on main now.
  assert.equal(sh(root, "git", "show", "main:feat.txt"), "feat");
  assert.equal(sh(root, "git", "show", "main:main.txt"), "main");
});

// The acceptance criterion "a branch whose base is behind main, adding a `### ` entry at the top
// of a section while main added a different entry at the same spot, lands with both entries
// present" — the replay's one deterministic conflict path, and the reason the cherry-pick runs
// with merge.conflictStyle=diff3: PLANS-DONE.md is a finished archive, so the entry-by-entry
// merge declines it and only the diff3-hunk insert-only pass can settle it. Expected content is
// spelled from the seeded fixtures, never read back from the code under test.
test("land replays both sides' backlog inserts when main moved under the same section top", async () => {
  const root = makeRepo(tmpdir());
  seedCommit(root, "PLANS.md", "# PLANS\n\n## Planned\n\n### base plan\n\nbase body\n", "seed plans");
  seedCommit(root, "PLANS-DONE.md", "# PLANS DONE\n\n## Done\n\n### base done\n\nbase done body\n", "seed done");
  const { feat } = repoWithFeat(root);
  seedCommit(
    feat,
    "PLANS.md",
    "# PLANS\n\n## Planned\n\n### feat plan\n\nfeat body\n\n### base plan\n\nbase body\n",
    "feat plans",
  );
  seedCommit(
    feat,
    "PLANS-DONE.md",
    "# PLANS DONE\n\n## Done\n\n### feat done\n\nfeat done body\n\n### base done\n\nbase done body\n",
    "feat done",
  );
  seedCommit(
    root,
    "PLANS.md",
    "# PLANS\n\n## Planned\n\n### main plan\n\nmain body\n\n### base plan\n\nbase body\n",
    "main plans",
  );
  seedCommit(
    root,
    "PLANS-DONE.md",
    "# PLANS DONE\n\n## Done\n\n### main done\n\nmain done body\n\n### base done\n\nbase done body\n",
    "main done",
  );
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.replayed, true);
  // Both inserts are on main, and main's own entries and ordering survive around them.
  assert.notEqual(mainSha(root), before);
  const plans = sh(root, "git", "show", "main:PLANS.md");
  for (const heading of ["### feat plan", "### main plan", "### base plan"]) {
    assert.ok(plans.includes(heading), `PLANS.md lost ${heading}:\n${plans}`);
  }
  assert.equal(plans.split("\n").filter((l) => l.startsWith("### ")).length, 3, `PLANS.md duplicated an entry:\n${plans}`);
  assert.ok(plans.indexOf("### base plan") > plans.indexOf("### main plan"), `main's order changed:\n${plans}`);
  const done = sh(root, "git", "show", "main:PLANS-DONE.md");
  for (const heading of ["### feat done", "### main done", "### base done"]) {
    assert.ok(done.includes(heading), `PLANS-DONE.md lost ${heading}:\n${done}`);
  }
  assert.equal(done.split("\n").filter((l) => l.startsWith("### ")).length, 3, `PLANS-DONE.md duplicated an entry:\n${done}`);
  assert.ok(!done.includes("<<<<<<<") && !plans.includes("<<<<<<<"), "a conflict marker reached main");
});

test("land waits for a merge lock another holder owns and lands after it releases", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const before = mainSha(root);
  // A team merge holding the lock: an awaited gate the test opens only after the land is
  // already waiting on the lock, so the land cannot have slipped past the claim.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withLock(mergeLockDir(root), async () => {
    await gate;
  });
  for (let waited = 0; !fs.existsSync(mergeLockDir(root)); waited++) {
    assert.ok(waited < 200, "the merge lock never published");
    await sleep(10);
  }
  const steering = steerToMain(root, "feat");
  await sleep(400); // longer than one withLock retry backoff: a steer that ignored the lock was done
  assert.equal(mainSha(root), before, "main moved while the merge lock was held");
  release();
  const result = await steering;
  await held;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(mainSha(root), sh(feat, "git", "rev-parse", "feat"));
});

test("land refuses when the ref is already on main", async () => {
  const root = makeRepo(tmpdir());
  const before = mainSha(root);
  const result = await steerToMain(root, "main");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /already on main/);
  assert.equal(mainSha(root), before); // main untouched
});

test("land refuses and leaves main unchanged when the replay hits a code conflict", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "shared.txt", "feat version\n", "feat edit"); // A -> feat: shared.txt
  seedCommit(root, "shared.txt", "main version\n", "main edit"); // A -> main: same file, differs
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /code file/);
  assert.equal(mainSha(root), before); // main untouched on refusal
});

test("land skips a range commit whose change main already carries, and lands the rest", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit"); // A -> feat: feat.txt
  seedCommit(feat, "rest.txt", "rest\n", "rest edit"); // the range's next commit: replayed after the skip
  seedCommit(root, "feat.txt", "feat\n", "same edit on main"); // A -> main: the same change, a different commit
  seedCommit(root, "main.txt", "main\n", "main edit"); // main moves on: the replay is not a fast-forward
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.replayed, true);
  // The already-applied change is skipped (git empties the pick); main keeps its content.
  assert.equal(sh(root, "git", "show", "main:feat.txt"), "feat");
  assert.equal(sh(root, "git", "show", "main:main.txt"), "main");
  assert.equal(sh(root, "git", "show", "main:rest.txt"), "rest"); // the commit after the skip still lands
});

test("land refuses a merge commit in the range, leaving main unchanged", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  // A second branch off feat, merged back into it: the range then holds a merge commit.
  sh(feat, "git", "checkout", "-q", "-b", "side");
  seedCommit(feat, "side.txt", "side\n", "side edit");
  sh(feat, "git", "checkout", "-q", "feat");
  sh(feat, "git", "merge", "--no-ff", "-q", "-m", "merge side", "side");
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /merge commit/);
  assert.equal(mainSha(root), before); // main untouched
});

test("land refuses a range that touches tumwater's own state dir", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  // .tumwater/ is gitignored by the fixture (as in a real root), so the commit needs -f.
  fs.mkdirSync(path.join(feat, ".tumwater", "notes"), { recursive: true });
  fs.writeFileSync(path.join(feat, ".tumwater", "notes", "stuck.md"), "hand-written state\n");
  sh(feat, "git", "add", "-f", ".tumwater/notes/stuck.md");
  sh(feat, "git", "commit", "-q", "-m", "state edit");
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /state dir/);
  assert.equal(mainSha(root), before); // main untouched
});

test("land refuses a dirty primary checkout, leaving it and main untouched", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  fs.writeFileSync(path.join(root, "stray.txt"), "uncommitted\n"); // dirty primary checkout
  const before = mainSha(root);
  const result = await steerToMain(root, "feat");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /uncommitted/);
  assert.equal(mainSha(root), before); // main untouched
  assert.equal(fs.existsSync(path.join(root, "stray.txt")), true); // the operator's work is still there
});

test("land --dry-run reports a fast-forward and writes nothing", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const before = mainSha(root);
  const preview = await previewSteer(root, "feat");
  assert.equal(preview.ok, true, JSON.stringify(preview));
  if (preview.ok) {
    assert.equal(preview.replay, false);
    assert.equal(preview.applies, true);
    assert.deepEqual(preview.paths, ["feat.txt"]);
  }
  assert.equal(mainSha(root), before); // a preview moves nothing
  assert.equal(sh(root, "git", "log", "--oneline", "-1", "main"), sh(root, "git", "log", "--oneline", "-1", "HEAD"));
});

test("land --dry-run on a diverged, cleanly-replayable range reports replay and applies", async () => {
  const root = makeRepo(tmpdir());
  const { feat } = repoWithFeat(root);
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  seedCommit(root, "main.txt", "main\n", "main edit");
  const before = mainSha(root);
  const preview = await previewSteer(root, "feat");
  assert.equal(preview.ok, true, JSON.stringify(preview));
  if (preview.ok) {
    assert.equal(preview.replay, true);
    assert.equal(preview.applies, true);
  }
  assert.equal(mainSha(root), before); // a preview moves nothing
});
