import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  STATE_DIR,
  abortRequestPath,
  branchName,
  configPath,
  eventsLogPath,
  inboxDir,
  mergeRefName,
  mergeLockDir,
  mergeWorktreePath,
  modelChecksPath,
  orchestratorStatePath,
  pausedPath,
  piLogPath,
  qaCoveragePath,
  resetRequestPath,
  reviewSessionDir,
  reviewRunSessionDir,
  sessionDir,
  slotWorktreePath,
  sessionsRootDir,
  statePath,
  nearestTumwaterRoot,
  isOsTempRoot,
  owningTeamRoot,
  worktreePath,
} from "../src/paths.js";
import { teamWorkspace, tmpdir } from "./fixtures/repo-fixtures.js";
import { setEnv } from "./helpers/env.js";
import { allRoleIds } from "../src/roles/roles.js";

/** Unit coverage for src/paths.ts — the single source of truth for where every piece of
 * harness runtime state lives. The functions are pure path builders (no I/O), so a fixed
 * root exercises them fully; the interesting failures they must prevent are layout drift:
 * two roles sharing one file, a marker colliding with long-lived state, or review sessions
 * leaking into an author's session dir and corrupting the resume-after-shutdown guard. */

const ROOT = "/repo"; // any root works — the builders never touch the filesystem
const S = path.join(ROOT, STATE_DIR);

test("config lives at the repo root; every other runtime state lives under .tumwater", () => {
  assert.equal(configPath(ROOT), path.join(ROOT, "tumwater.json"));
  const insideStateDir = (p: string) => p.startsWith(S + path.sep);
  for (const p of [
    worktreePath(ROOT, "qa"),
    statePath(ROOT, "qa"),
    orchestratorStatePath(ROOT),
    qaCoveragePath(ROOT),
    modelChecksPath(ROOT),
    resetRequestPath(ROOT),
    abortRequestPath(ROOT, "qa"),
    pausedPath(ROOT),
    eventsLogPath(ROOT),
    piLogPath(ROOT, "qa"),
    sessionsRootDir(ROOT),
    inboxDir(ROOT),
    mergeLockDir(ROOT),
  ]) {
    assert.ok(insideStateDir(p), `${p} escapes the .tumwater state dir`);
  }
});

test("pins the full runtime layout", () => {
  assert.equal(worktreePath(ROOT, "qa"), path.join(S, "worktrees", "qa"));
  assert.equal(statePath(ROOT, "qa"), path.join(S, "state", "qa.json"));
  assert.equal(orchestratorStatePath(ROOT), path.join(S, "state", "orchestrator.json"));
  assert.equal(qaCoveragePath(ROOT), path.join(S, "state", "qa-coverage.json"));
  assert.equal(modelChecksPath(ROOT), path.join(S, "state", "model-checks.json"));
  assert.equal(resetRequestPath(ROOT), path.join(S, "reset-counters.json"));
  assert.equal(abortRequestPath(ROOT, "qa"), path.join(S, "abort-qa.json"));
  assert.equal(pausedPath(ROOT), path.join(S, "paused.json"));
  assert.equal(eventsLogPath(ROOT), path.join(S, "log", "events.jsonl"));
  assert.equal(piLogPath(ROOT, "qa"), path.join(S, "log", "qa.pi.jsonl"));
  assert.equal(sessionsRootDir(ROOT), path.join(S, "sessions"));
  assert.equal(sessionDir(ROOT, "qa"), path.join(S, "sessions", "qa"));
  assert.equal(reviewSessionDir(ROOT, "qa"), path.join(S, "sessions", "_review", "qa"));
  assert.equal(
    reviewRunSessionDir(ROOT, "qa", "1-abcd1234"),
    path.join(S, "sessions", "_review", "qa", "1-abcd1234"),
  );
  assert.equal(inboxDir(ROOT), path.join(S, "inbox"));
  assert.equal(mergeLockDir(ROOT), path.join(S, "merge.lock"));
  assert.equal(mergeWorktreePath(ROOT), path.join(S, "worktrees", "_merge"));
  assert.equal(slotWorktreePath(ROOT, 2), path.join(S, "worktrees", "_slot-2"));
});

test("branch names are tumwater/<role> for every role, director included", () => {
  for (const id of allRoleIds()) assert.equal(branchName(id), `tumwater/${id}`);
});

// The resume-after-shutdown guard (hasResumableSession in src/agent/session-ledger.ts) reads
// ONLY the role's own session dir to decide whether an interrupted run may --continue.
// Reviewer sessions must be invisible to it — a leftover reviewer file would make an interrupted
// authoring run "resume" into a review context it never had. So the review dir sits OUTSIDE the
// role's session dir, yet still UNDER the shared sessions root so the same age-based prune
// collects its files.
test("review sessions live outside the role's own session dir but inside the pruned sessions root", () => {
  for (const id of allRoleIds()) {
    const author = sessionDir(ROOT, id);
    const review = reviewSessionDir(ROOT, id);
    assert.ok(!review.startsWith(author + path.sep), `review dir ${review} is inside author dir ${author}`);
    assert.ok(!author.startsWith(review + path.sep), `author dir ${author} is inside review dir ${review}`);
    assert.ok(
      !path.relative(sessionsRootDir(ROOT), review).startsWith(".."),
      `review dir ${review} escapes the sessions root and would never be pruned`,
    );
  }
});

// The merge ref's namespace (plans/merge-queue.md): one ref per role, and never equal to a
// role's worktree path.
test("a merge ref is unique per role and never collides with a role worktree path", () => {
  const ids = allRoleIds();
  const seen = new Map<string, string>();
  for (const id of ids) {
    const ref = mergeRefName(id);
    assert.notEqual(ref, worktreePath(ROOT, id), `role ${id} shares its merge ref with its worktree path`);
    assert.ok(!seen.has(ref), `role ${id} shares ${ref} with role ${seen.get(ref)}`);
    seen.set(ref, id);
  }
});

test("no two roles share a worktree, state file, log, session dir, or abort marker", () => {
  const ids = allRoleIds();
  const seen = new Map<string, string>();
  for (const id of ids) {
    for (const p of [
      worktreePath(ROOT, id),
      statePath(ROOT, id),
      piLogPath(ROOT, id),
      sessionDir(ROOT, id),
      reviewSessionDir(ROOT, id),
      abortRequestPath(ROOT, id),
    ]) {
      assert.ok(!seen.has(p), `role ${id} shares ${p} with role ${seen.get(p)}`);
      seen.set(p, id);
    }
  }
});

test("one-shot markers and per-role state never collide with each other or long-lived files", () => {
  const shared = [resetRequestPath(ROOT), pausedPath(ROOT), eventsLogPath(ROOT), inboxDir(ROOT), mergeLockDir(ROOT)];
  for (const id of allRoleIds()) shared.push(abortRequestPath(ROOT, id), statePath(ROOT, id));
  // A role named "orchestrator" would collide with the orchestrator's own state file — pin that
  // it cannot.
  shared.push(orchestratorStatePath(ROOT));
  assert.equal(new Set(shared).size, shared.length);
});

test("owningTeamRoot names the team root only for a directory inside its worktrees", () => {
  const { root, slot } = teamWorkspace();
  assert.equal(owningTeamRoot(slot), root);
  assert.equal(owningTeamRoot(root), undefined);
  assert.equal(owningTeamRoot(path.join(root, "src")), undefined);
});

// nearestTumwaterRoot is the one lookup answering "which team root owns this directory?" —
// owningTeamRoot and teamRootOf both delegate the search to it. Its three outcomes are each a
// different real answer, but the only live test sees the {root, undefined} that owningTeamRoot
// computes FROM it, so none of the walk's own branches were pinned. Pin them through the
// exported function: a walk that returned a non-directory .tumwater, or stopped at the wrong
// ancestor, is exactly how the 2026-10-18 phantom $TMPDIR/.tumwater was minted. Each case uses
// a fresh realpath'd tmpdir() child, whose ancestors (the per-run root, the OS tmp mount) hold
// no .tumwater directory — the same isolation the owningTeamRoot test assumes.

test("nearestTumwaterRoot returns the directory itself the moment it holds a .tumwater directory", () => {
  const dir = fs.realpathSync(tmpdir());
  fs.mkdirSync(path.join(dir, ".tumwater"));
  assert.equal(nearestTumwaterRoot(dir), dir);
});

test("nearestTumwaterRoot climbs to the nearest ancestor holding a .tumwater directory", () => {
  const team = fs.realpathSync(tmpdir());
  const slot = path.join(team, ".tumwater", "worktrees", "_slot-1"); // real role-worktree shape
  fs.mkdirSync(slot, { recursive: true }); // creates team/.tumwater as a directory along the way
  assert.equal(nearestTumwaterRoot(slot), team);
});

test("nearestTumwaterRoot returns undefined when no ancestor holds a .tumwater directory", () => {
  const dir = fs.realpathSync(tmpdir()); // fresh, empty, no .tumwater here or above
  assert.equal(nearestTumwaterRoot(dir), undefined);
});

test("nearestTumwaterRoot does not read a non-directory .tumwater entry as a root", () => {
  const dir = fs.realpathSync(tmpdir());
  fs.writeFileSync(path.join(dir, ".tumwater"), "x"); // a .tumwater FILE, not a directory
  assert.equal(nearestTumwaterRoot(dir), undefined);
});

// The OS temp root guard (isOsTempRoot) is the one rule that keeps the root walks from claiming
// a stale .tumwater at os.tmpdir() as a team root (BUGS.md 2026-11-16). It compares the resolved
// temp root (realpath'd, so macOS /var <-> /private/var agree) against the resolved candidate
// directory, likewise realpath'd: the resolved temp root itself matches, its children do not.
// The walk-level pin for the same rule (BUGS.md 2026-11-16). A poison built with a raw
// mkdtempSync under os.tmpdir() trips the tmpdir() convention guard — that is what f85f56e5
// removed from the two sibling walk files — and an assertion on bare `undefined` is decided by a
// SECOND stale .tumwater above the redirected temp root, not by this guard. So this one poisons
// a tmpdir() child (the per-run root sweeps it), redirects TMPDIR onto it so it IS the temp
// root, and asserts only what the guard promises: the temp root itself is never claimed, and a
// real root below it still is.
test("nearestTumwaterRoot never claims a stale .tumwater at the OS temp root", () => {
  const poison = tmpdir("temp-root-poison-");
  fs.mkdirSync(path.join(poison, ".tumwater"));
  const restore = setEnv("TMPDIR", poison); // os.tmpdir() re-reads TMPDIR on each call
  try {
    assert.notEqual(nearestTumwaterRoot(poison), poison, "the temp root's own .tumwater is not a root");
    const real = path.join(poison, "checkout"); // a team root in a CHILD of the temp root
    fs.mkdirSync(path.join(real, ".tumwater", "worktrees", "_slot-1"), { recursive: true });
    assert.equal(nearestTumwaterRoot(path.join(real, ".tumwater", "worktrees", "_slot-1")), real,
      "the guard is not overbroad: a root below the temp root is still found");
  } finally {
    restore();
  }
});

test("isOsTempRoot matches the resolved OS temp root and rejects a child of it", () => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert.equal(isOsTempRoot(tempRoot), true, "the resolved temp root is the OS temp root");
  assert.equal(isOsTempRoot(os.tmpdir()), true, "the raw os.tmpdir() form matches once resolved");
  const child = fs.realpathSync(tmpdir()); // a fresh dir under the per-run root, under the temp root
  assert.equal(isOsTempRoot(child), false, "a child of the temp root is not the temp root");
  assert.equal(isOsTempRoot(path.join(child, "a")), false, "a deeper descendant is not the temp root");
});
