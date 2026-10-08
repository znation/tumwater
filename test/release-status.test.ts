/** scripts/release.mjs --status's read-only inspection: it must report the local state it can
 * read even when origin is unreachable or gh is absent, instead of dying at module load on
 * git's raw fatal output (or refusing to run at all). These run the script as a subprocess in a
 * throwaway repo — deterministic and offline, with a local bare origin and a PATH carrying only
 * git, so nothing touches the network. The release/bump paths stay strict, which the last test
 * pins. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitOnlyBinDir, makeRepo, seedCommit, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { pathReplace } from "./fakes/fake-commands.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/release.mjs", import.meta.url));

function seedPackage(root: string, version: string): void {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tumwater", version }));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "package");
}

function runRelease(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
}

function status(root: string): { status: number | null; stdout: string; stderr: string } {
  return runRelease(root, ["--status"]);
}

test("--status reports local state with no origin instead of leaking a git fatal", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");

  const r = status(root);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /origin\/main: unavailable \(no origin remote, or unreachable\)/);
  assert.match(r.stdout, /tag: not created locally \(origin unavailable\)/);
  assert.doesNotMatch(r.stderr, /fatal:/, "no raw git fatal line leaks beside the report");
});

test("--status names the missing gh instead of dying when origin answers but gh is absent", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");
  const origin = tmpdir("release-origin-");
  sh(origin, "git", "init", "--bare");
  sh(root, "git", "remote", "add", "origin", origin);

  const restore = pathReplace(gitOnlyBinDir("release-no-gh-"));
  try {
    const r = status(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CI: `gh` is not on PATH/);
  } finally {
    restore();
  }
});

test("--status reports an origin/main it cannot count instead of leaking a git fatal", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");
  const origin = tmpdir("release-origin-");
  sh(origin, "git", "init", "--bare");
  sh(root, "git", "remote", "add", "origin", origin);
  sh(root, "git", "push", "origin", "main");
  // A second clone advances origin's main; `root` never fetches the new commit, so its
  // object is absent locally and a strict `rev-list <remote>..HEAD` cannot run.
  const other = tmpdir("release-other-");
  sh(origin, "git", "clone", "-b", "main", origin, other);
  fs.writeFileSync(path.join(other, "advanced.txt"), "advanced\n");
  sh(other, "git", "add", "-A");
  sh(other, "git", "commit", "-m", "advance origin main");
  sh(other, "git", "push", "origin", "main");

  const r = status(root);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /origin\/main: unavailable \(remote main not fetched locally\)/);
  assert.doesNotMatch(r.stderr, /fatal:/, "no raw git fatal line leaks beside the report");
});

test("--status refuses a bump instead of silently reporting and changing nothing", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");

  const r = runRelease(root, ["--status", "bump"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /--status only reports state and never bumps/);
  assert.equal(r.stdout, "", "the report is not printed when the arguments conflict");
});

test("the release path still refuses to act offline rather than treating the tag as free", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");

  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });

  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /release: git ls-remote origin refs\/heads\/main failed:/,
    "the strict release path dies at the remote check rather than treating the tag as free",
  );
});

// --- guardMain and tagTaken: the refusals that keep a release off a bad base -----------------
// Each of these states would let a release or bump run against the wrong commit: a feature
// branch, uncommitted work, an origin with no main, a diverged main, or a tag that already
// exists. They must die before any push/tag, so the tests assert the message and that nothing
// was written (stderr only, no half-done release output).

/** A repo on main with a bare `origin` it has pushed to — the smallest non-diverged base a
 * refusal test can then perturb. Returns [root, origin]. */
function repoPushedToBareOrigin(version = "0.1.0"): [string, string] {
  const root = makeRepo();
  seedPackage(root, version);
  const origin = tmpdir("release-origin-");
  sh(origin, "git", "init", "--bare");
  sh(root, "git", "remote", "add", "origin", origin);
  sh(root, "git", "push", "origin", "main");
  return [root, origin];
}

test("bump refuses when HEAD is not on main", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");
  sh(root, "git", "checkout", "-b", "feature");

  const r = runRelease(root, ["bump", "patch"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD is on feature, not main/);
  assert.equal(r.stdout, "", "nothing is printed before the refusal");
});

test("bump refuses a dirty working tree", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");
  fs.writeFileSync(path.join(root, "stray.txt"), "uncommitted\n");

  const r = runRelease(root, ["bump", "patch"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /working tree is not clean/);
  assert.match(r.stderr, /stray\.txt/, "the refusal names the offending path");
});

test("bump refuses an origin that has no main", () => {
  const root = makeRepo();
  seedPackage(root, "0.1.0");
  const origin = tmpdir("release-origin-");
  sh(origin, "git", "init", "--bare");
  sh(root, "git", "remote", "add", "origin", origin);

  const r = runRelease(root, ["bump", "patch"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /origin has no refs\/heads\/main/);
});

test("bump refuses a main diverged from origin/main", () => {
  const [root, origin] = repoPushedToBareOrigin();
  seedCommit(root, "local.txt", "local\n", "advance local main");
  // A second clone advances origin from the shared base, so origin's main is a sibling of
  // root's main. Fetching brings the commit object local, so guardMain's merge-base check —
  // not a missing-object error — is what refuses the bump.
  const other = tmpdir("release-other-");
  sh(origin, "git", "clone", "-b", "main", origin, other);
  seedCommit(other, "remote.txt", "remote\n", "advance origin main");
  sh(other, "git", "push", "origin", "main");
  sh(root, "git", "fetch", "origin");

  const r = runRelease(root, ["bump", "patch"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /main has diverged from origin\/main/);
});

test("release refuses when the version's tag already exists locally", () => {
  const [root] = repoPushedToBareOrigin("0.1.0");
  sh(root, "git", "tag", "v0.1.0");

  const r = runRelease(root, []);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag v0\.1\.0 already exists/);
  assert.equal(r.stdout, "", "the refusal precedes the release banner and the push");
});

test("argument validation refuses unknown flags, arguments, and bump levels", () => {
  const root = makeRepo();

  const flag = runRelease(root, ["--wat"]);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /unknown flag: --wat/);

  const arg = runRelease(root, ["publish"]);
  assert.equal(arg.status, 1);
  assert.match(arg.stderr, /unknown argument\(s\): publish/);

  const level = runRelease(root, ["bump", "huge"]);
  assert.equal(level.status, 1);
  assert.match(level.stderr, /unknown bump level: huge/);
});
