/** The re-verification policy behind main's baseline verdict (src/baseline/main-baseline.ts),
 * which keeps one worktree's environmental red from miscoloring the team's verdict: a red seen
 * in one worktree is provisional, so the next worktree of the same SHA re-runs it unasked and a
 * green there promotes the SHA for everyone, while a red two worktrees agree on is trusted.
 * mainIsGreen, the redeploy gate's boolean view, re-verifies the same way in its mirror. The
 * per-SHA cache this builds on lives in main-baseline.test.ts, and which check verifies main
 * (with the check permit) in main-baseline-check.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkMainBaseline, mainIsGreen } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { ensureDetachedWorktree } from "../src/git/worktree.js";
import { mirrorWorktreePath } from "../src/paths.js";
import { ensureParentDir } from "../src/files/files.js";
import { headSha, makeRepo, sh, tmpdir, worktreeAt } from "./fixtures/repo-fixtures.js";
import { projManifest } from "./fakes/fake-commands.js";

const ROLE = "improve";
/** The live config checkMainBaseline requires (plans/portability.md §6/7): the tests here all
 * exercise npm auto-detection, so the defaults (no `check` configured) are the fixture. */
const CFG = defaultConfig();

// Each worktree is a real linked worktree of one git repo at the real location
// (.tumwater/worktrees/<role>): the verdict is keyed by the worktree's HEAD, so two worktrees
// of pristine main share a SHA but not an environment.

test("a red in one worktree is re-verified by the next, and a green there promotes the SHA", async () => {
  const counter = path.join(tmpdir(), "runs");
  // Fails only where an untracked marker sits: identical tree, different environment.
  const { root, wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; if [ -f ./RED_MARKER ]; then echo env-failure; exit 1; fi; echo ok`,
  );
  fs.writeFileSync(path.join(wt, "RED_MARKER"), "");
  const other = worktreeAt(root, "dedupe");

  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red", "the first worktree sees red");
  assert.equal(
    (await checkMainBaseline(other, CFG)).baseline?.status,
    "green",
    "the next worktree re-runs a single-worktree red instead of trusting it",
  );
  assert.equal(runsOf(counter), 2);
  // The promotion is what clears the team's read of main: even the worktree that produced the
  // false red now reads green, without main having to move.
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "green");
  assert.equal(runsOf(counter), 2, "a green is authoritative — nothing re-ran");
});

test("a red confirmed by a second worktree is authoritative: a third trusts the cache", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; echo real-failure; exit 1`);
  const second = worktreeAt(root, "dedupe");
  const third = worktreeAt(root, "clean");

  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(second, CFG)).baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "one confirmation run, paid by the second worktree");
  assert.equal((await checkMainBaseline(third, CFG)).baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "two agreeing worktrees settle it — no run per role");
  // What the flag still buys: the redeploy gate pays for its own opinion even on a red two
  // worktrees already agree on, because stranding the team on a stale build costs more.
  assert.equal((await checkMainBaseline(third, CFG, undefined, true)).baseline?.status, "red");
  assert.equal(runsOf(counter), 3, "reverifyRed always runs");
});

test("a red is provisional: the next worktree re-runs it unasked, and a pass promotes the SHA", async () => {
  // The 2026-09-08 shape: one worktree's environment, not the tree, produced the red — here a
  // `marker` file standing in for the missing node_modules — and it became the team's verdict.
  // Since 2026-09-18 no caller has to ASK for that second opinion: the role runners never passed
  // the flag, so one environmental red blocked every code role until main moved — which it could
  // not, because blocking the code roles is what stops main moving (BUGS.md).
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; node -e "process.exit(require('fs').existsSync('marker') ? 0 : 1)"`,
  );
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red", "the worktree that saw it does not re-run it");
  assert.equal(runsOf(counter), 1);

  // A second worktree of the same SHA where the check passes.
  const other = path.join(root, ".tumwater", "worktrees", "other");
  sh(root, "git", "worktree", "add", "-q", "--detach", other, "main");
  fs.writeFileSync(path.join(other, "marker"), "");
  assert.equal(
    (await checkMainBaseline(other, CFG)).baseline?.status,
    "green",
    "the next worktree re-verifies a one-worktree red without being asked",
  );
  assert.equal(runsOf(counter), 2, "…paying exactly one confirmation run");
  assert.equal(
    (await checkMainBaseline(wt, CFG)).baseline?.status,
    "green",
    "green is authoritative: it promotes the SHA even for the worktree that reported red",
  );
  assert.equal(runsOf(counter), 2);
  assert.equal((await checkMainBaseline(wt, CFG, undefined, true)).baseline?.status, "green", "a green is never re-run");
  assert.equal(runsOf(counter), 2);
});

test("mainIsGreen re-verifies another worktree's red in the mirror, and its green promotes the SHA team-wide", async () => {
  // The 2026-09-08 failure in miniature: one worktree's ENVIRONMENT, not the tree, decides the
  // verdict — here a `marker` file standing in for the missing node_modules. A red from such a
  // worktree must not be what blocks the harness's own restart (BUGS.md).
  const counter = path.join(tmpdir(), "runs");
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: `echo run >> ${counter}; node -e "process.exit(require('fs').existsSync('marker') ? 0 : 1)"` }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker detectBuildCheck walks up to
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");
  const head = headSha(root);

  // A role worktree without the marker judges main red and caches that verdict.
  const role = path.join(root, ".tumwater", "worktrees", "role");
  ensureParentDir(role);
  sh(root, "git", "worktree", "add", "-q", "--detach", role, head);
  assert.equal((await checkMainBaseline(role, CFG)).baseline?.status, "red");

  // The redeploy gate's mirror, where the same tree passes: it re-runs instead of inheriting.
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  fs.writeFileSync(path.join(mirror, "marker"), "");
  assert.equal(await mainIsGreen(mirror, CFG), true, "the red is re-verified here, not believed");
  assert.equal(runsOf(counter), 2);

  assert.equal(await mainIsGreen(mirror, CFG), true);
  assert.equal(runsOf(counter), 2, "a cached green short-circuits — re-verification is for reds only");
  assert.equal(
    (await checkMainBaseline(role, CFG)).baseline?.status,
    "green",
    "and the green promotes the SHA for every other consumer of main's verdict",
  );
  assert.equal(runsOf(counter), 2, "the promotion re-runs nothing");
});
