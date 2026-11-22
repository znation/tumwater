// The `tumwater land` CLI body (src/cli/cli-land-command.ts). The lock, refusals and replay live in
// src/operator/operator-land.ts and are pinned in test/operator-land.test.ts; here we pin what the
// CLI parses, prints in its text and `--json` shapes, and the exit code it maps each outcome to.
// Expected values come from the fixture commits we seed, never from reading back the output.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { headSha, makeRepo, seedCommit, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

/** A repo initialised as a tumwater root, plus a second worktree on branch `feat` at main's head,
 * the way an operator's own branch sits beside the primary checkout. The `.tumwater/` state dir
 * is created untracked, as a real root has it, so the merge lock's atomic rename has a parent. */
async function rootWithFeat(label: string): Promise<{ repo: string; feat: string }> {
  const repo = makeRepo();
  await initProject(repo, label);
  fs.mkdirSync(path.join(repo, ".tumwater"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".tumwater/\n");
  const feat = path.join(tmpdir(), "feat-wt");
  sh(repo, "git", "worktree", "add", "-b", "feat", feat, "main");
  return { repo, feat };
}

test("land --dry-run --json lists the commits, their paths, and a plain fast-forward", async () => {
  const { repo, feat } = await rootWithFeat("cli land dry run json");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const featSha = sh(repo, "git", "rev-parse", "feat");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "feat", "--dry-run", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.replay, false, "main is an ancestor of feat, so no replay");
  assert.equal(payload.applies, true);
  assert.deepEqual(payload.commits, [{ sha: featSha, subject: "feat edit" }]);
  assert.deepEqual(payload.paths, ["feat.txt"]);
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore, "a dry run writes nothing");
});

test("land --dry-run reports a replay when main has moved past the ref's base", async () => {
  const { repo, feat } = await rootWithFeat("cli land dry run replay");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  seedCommit(repo, "main.txt", "main\n", "main moves on");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "feat", "--dry-run");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /would land 1 commit on main \(main has moved, so it would replay them onto a fresh main\)/);
  assert.match(r.stdout, /applies cleanly; nothing was written/);
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore);
});

test("land --dry-run exits 1 when the replay would conflict, and writes nothing", async () => {
  const { repo, feat } = await rootWithFeat("cli land dry run conflict");
  seedCommit(repo, "shared.txt", "base\n", "shared base");
  seedCommit(feat, "shared.txt", "feat\n", "feat edits shared");
  seedCommit(repo, "shared.txt", "main\n", "main edits shared");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "feat", "--dry-run");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /would conflict; nothing was written/);
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "the tree is clean");
});

test("land fast-forwards main to the ref and prints the new head and commit count", async () => {
  const { repo, feat } = await rootWithFeat("cli land fast forward");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const featSha = sh(repo, "git", "rev-parse", "feat");

  const r = await cli(repo, "land", "feat");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^main is now [0-9a-f]{8} \(fast-forwarded 1 commit\)$/m);
  assert.equal(sh(repo, "git", "rev-parse", "main"), featSha, "main is now the landed commit");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "the tree is clean");
});

test("land --json names the before and after heads, and says the checked-out branch was left in place", async () => {
  const { repo, feat } = await rootWithFeat("cli land json");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const featSha = sh(repo, "git", "rev-parse", "feat");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "feat", "--json");
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.steered, true);
  assert.equal(payload.beforeSha, mainBefore);
  assert.equal(payload.headSha, featSha);
  assert.equal(payload.replayed, false);
  assert.deepEqual(payload.commits, [{ sha: featSha, subject: "feat edit" }]);
  assert.match(payload.refNote, /is checked out, so it was left in place/);
});

test("land replays the ref's commits onto a moved main and says so", async () => {
  const { repo, feat } = await rootWithFeat("cli land replay");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  seedCommit(repo, "main.txt", "main\n", "main moves on");

  const r = await cli(repo, "land", "feat");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^main is now [0-9a-f]{8} \(replayed 1 commit onto a moved main\)$/m);
  assert.equal(sh(repo, "git", "show", "main:feat.txt"), "feat", "the replayed commit landed");
  assert.equal(sh(repo, "git", "show", "main:main.txt"), "main", "main's own commit survived");
  assert.notEqual(headSha(repo), sh(repo, "git", "rev-parse", "feat"), "the replay made a new commit");
});

test("land --dry-run on a commit that touches no files says so without an empty path list", async () => {
  const { repo, feat } = await rootWithFeat("cli land empty commit");
  sh(feat, "git", "commit", "--allow-empty", "-m", "empty edit");

  const r = await cli(repo, "land", "feat", "--dry-run");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^  touches 0 files$/m);
  assert.match(r.stdout, /^applies cleanly; nothing was written$/m);
});

test("land refuses a flag-shaped token and a second positional, writing nothing", async () => {
  const { repo, feat } = await rootWithFeat("cli land refusals");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  let r = await cli(repo, "land", "feat", "--stat");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /land takes only --dry-run and --json \(got --stat\)/);

  r = await cli(repo, "land", "feat", "main");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /land takes at most one ref \(usage: tumwater land \[<ref>\] \[--dry-run\] \[--json\]\)/);
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore, "no land was written");
});

test("land exits 1 with a nothing-to-land message when the ref is already on main", async () => {
  const { repo } = await rootWithFeat("cli land nothing");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "main");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nothing to land: [0-9a-f]{7,} is already on main/);
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore);
});

test("land --dry-run on a ref already on main exits 1 with the refusal, and prints no preview", async () => {
  const { repo } = await rootWithFeat("cli land dry run nothing");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "main", "--dry-run");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nothing to land: [0-9a-f]{7,} is already on main/);
  assert.doesNotMatch(r.stdout, /would land/, "a refused preview prints no commit list");
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore);
});

test("land refuses a dirty checkout before it writes, and names the uncommitted changes", async () => {
  const { repo, feat } = await rootWithFeat("cli land dirty");
  seedCommit(feat, "feat.txt", "feat\n", "feat edit");
  fs.writeFileSync(path.join(repo, "scratch.txt"), "unsaved\n");
  const mainBefore = sh(repo, "git", "rev-parse", "main");

  const r = await cli(repo, "land", "feat");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /your checkout has uncommitted changes/);
  assert.equal(sh(repo, "git", "rev-parse", "main"), mainBefore);
});
