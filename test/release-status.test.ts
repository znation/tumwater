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
import { gitOnlyBinDir, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
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
