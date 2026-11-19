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
