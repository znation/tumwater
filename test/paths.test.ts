import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  STATE_DIR,
  abortRequestPath,
  branchName,
  configPath,
  eventsLogPath,
  inboxDir,
  mergeLockDir,
  orchestratorStatePath,
  pausedPath,
  piLogPath,
  resetRequestPath,
  reviewSessionDir,
  sessionDir,
  sessionsRootDir,
  statePath,
  worktreePath,
} from "../src/paths.js";
import { allRoleIds } from "../src/roles.js";

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
  assert.equal(resetRequestPath(ROOT), path.join(S, "reset-counters.json"));
  assert.equal(abortRequestPath(ROOT, "qa"), path.join(S, "abort-qa.json"));
  assert.equal(pausedPath(ROOT), path.join(S, "paused.json"));
  assert.equal(eventsLogPath(ROOT), path.join(S, "log", "events.jsonl"));
  assert.equal(piLogPath(ROOT, "qa"), path.join(S, "log", "qa.pi.jsonl"));
  assert.equal(sessionsRootDir(ROOT), path.join(S, "sessions"));
  assert.equal(sessionDir(ROOT, "qa"), path.join(S, "sessions", "qa"));
  assert.equal(reviewSessionDir(ROOT, "qa"), path.join(S, "sessions", "_review", "qa"));
  assert.equal(inboxDir(ROOT), path.join(S, "inbox"));
  assert.equal(mergeLockDir(ROOT), path.join(S, "merge.lock"));
});

test("branch names are tumwater/<role> for every role, director included", () => {
  for (const id of allRoleIds()) assert.equal(branchName(id), `tumwater/${id}`);
});

// The resume-after-shutdown guard (hasResumableSession in loop.ts) reads ONLY the role's own
// session dir to decide whether an interrupted tick may --continue. Reviewer sessions must be
// invisible to it — a leftover reviewer file would make an interrupted authoring tick "resume"
// into a review context it never had. So the review dir sits OUTSIDE the role's session dir,
// yet still UNDER the shared sessions root so the same age-based prune collects its files.
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
  // A role named "orchestrator" would collide with the orchestrator's own state file — pin that it cannot.
  shared.push(orchestratorStatePath(ROOT));
  assert.equal(new Set(shared).size, shared.length);
});
