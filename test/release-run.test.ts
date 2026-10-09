/** scripts/release.mjs's execution path — the part that actually pushes main, waits for CI,
 * and tags. release-status.test.ts pins the read-only --status report and the refusals; this
 * file drives the happy path and a red CI run through a fake `gh`, with real git against a
 * local bare origin. The fake gh answers every poll as an already-completed run, so the real
 * 15s/30s sleeps never fire and nothing touches the network. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { headSha, pushedRepo, seedCommit, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { pathPrepend, writeScript } from "./fakes/fake-commands.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/release.mjs", import.meta.url));

/** Install a fake gh at the front of PATH that reports one CI run with `conclusion`. Both the
 * `run list` and `run view` polls get an immediate completed answer, so ciWait returns without
 * sleeping. Returns the restore function. */
function fakeGh(conclusion: string): () => void {
  const dir = tmpdir("release-gh-");
  const run = JSON.stringify({ databaseId: 4242, status: "completed", conclusion });
  writeScript(
    path.join(dir, "gh"),
    `if [ "$1" = "run" ] && [ "$2" = "list" ]; then echo '[${run}]'; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then echo '${run}'; exit 0; fi
echo "unexpected gh args: $@" >&2; exit 1`,
  );
  return pathPrepend(dir);
}

function runRelease(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
}

test("release pushes main, tags the CI-green commit locally and on origin", () => {
  const { root } = pushedRepo("0.1.0");
  const restore = fakeGh("success");
  try {
    const r = runRelease(root, []);

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /releasing 0\.1\.0 → tag v0\.1\.0/);
    assert.match(r.stdout, /CI green \(run 4242\); pushing tag v0\.1\.0/);
    assert.match(r.stdout, /tag v0\.1\.0 pushed/);
    assert.equal(sh(root, "git", "tag", "-l", "v0.1.0"), "v0.1.0", "the tag exists locally");
    assert.match(
      sh(root, "git", "ls-remote", "--tags", "origin", "refs/tags/v0.1.0"),
      /refs\/tags\/v0\.1\.0/,
      "the tag reached origin",
    );
    // The tag must name the commit CI just green-lit, not later history: HEAD did not move
    // after the push, and the bump is a separate future commit.
    assert.equal(sh(root, "git", "rev-parse", "v0.1.0^{commit}"), headSha(root));
  } finally {
    restore();
  }
});

test("release refuses to tag when CI is red, leaving no tag on either side", () => {
  const { root } = pushedRepo("0.1.0");
  // The release path re-pushes main, so the base must still match origin before faking gh red.
  seedCommit(root, "fix.txt", "fix\n", "advance main");
  sh(root, "git", "push", "origin", "main");
  const restore = fakeGh("failure");
  try {
    const r = runRelease(root, []);

    assert.equal(r.status, 1);
    assert.match(r.stderr, /CI run 4242 concluded failure — fix and re-cut/);
    assert.equal(sh(root, "git", "tag", "-l", "v0.1.0"), "", "no local tag on a red run");
    assert.equal(
      sh(root, "git", "ls-remote", "--tags", "origin", "refs/tags/v0.1.0"),
      "",
      "no tag was pushed to origin",
    );
  } finally {
    restore();
  }
});

// --- bump: the version commit that follows a release -------------------------
// The bump path stages package.json + package-lock.json and commits them, then pushes with a
// retry when the fleet moved origin under it. None of it ran before these tests.

/** A pushedRepo carrying the committed package-lock.json `npm version` updates, so the bump's
 * `git add package.json package-lock.json` finds both paths and the tree stays clean. */
function pushedRepoWithLock(version = "0.1.0"): { root: string; origin: string } {
  const { root, origin } = pushedRepo(version);
  seedCommit(root, "package-lock.json", JSON.stringify({ name: "tumwater", version }) + "\n", "lock");
  sh(root, "git", "push", "origin", "main");
  return { root, origin };
}

/** Reject the first `git push` from `root` and let every later one through, so the bump's
 * replay-on-rejection branch runs without a real concurrent writer. The marker lives outside
 * the repo so the failed push leaves no untracked file to trip the rebase. */
function installRejectOncePushHook(root: string): void {
  const marker = path.join(tmpdir("release-hook-"), "pushed");
  const hook = path.join(root, ".git", "hooks", "pre-push");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nif [ -f "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
}

test("bump commits the next patch version and pushes it to origin", () => {
  const { root } = pushedRepoWithLock("0.1.0");

  const r = runRelease(root, ["bump", "patch"]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bumped 0\.1\.0 → 0\.1\.1 \(patch\); committed and pushed/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
    "0.1.1",
    "package.json carries the bumped version",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).version,
    "0.1.1",
    "package-lock.json carries the bumped version",
  );
  assert.equal(sh(root, "git", "log", "-1", "--format=%s"), "tumwater(release): 0.1.1");
  assert.equal(
    sh(root, "git", "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0],
    headSha(root),
    "origin/main names the bump commit",
  );
});

test("bump replays on the new main when the first push is rejected", () => {
  const { root } = pushedRepoWithLock("0.1.0");
  installRejectOncePushHook(root);

  const r = runRelease(root, ["bump", "patch"]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /push rejected — origin moved; replaying the bump on the new main…/);
  assert.match(r.stdout, /bumped 0\.1\.0 → 0\.1\.1 \(patch\); committed and pushed/);
  assert.equal(
    sh(root, "git", "log", "-1", "--format=%s"),
    "tumwater(release): 0.1.1",
    "the replayed bump survived the rebase",
  );
  assert.equal(
    sh(root, "git", "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0],
    headSha(root),
    "the retried push landed the bump commit",
  );
});
