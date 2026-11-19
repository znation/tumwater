import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_INPUTS,
  buildInfoPath,
  buildLabel,
  buildStaleness,
  isSelfHosted,
  readBuildInfo,
  stampBuild,
} from "../src/build/build-info.js";
import { patchFsMethod } from "./helpers/fs-faults.js";
import { headSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";

// Build provenance (src/build/build-info.ts): the stamp `npm run build` writes into dist/, and the
// comparison against main that tells a self-hosting team whether it is running the code main
// describes. Pinned against real git repos — the whole point is agreement with git's view.

function commitFile(repo: string, rel: string, content: string, message: string): string {
  ensureParentDir(path.join(repo, rel));
  fs.writeFileSync(path.join(repo, rel), content);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", message);
  return headSha(repo);
}

test("stampBuild writes the checkout's HEAD and root; readBuildInfo reads it back", async () => {
  const repo = makeRepo();
  const dist = path.join(tmpdir(), "dist");
  const info = await stampBuild(repo, dist);
  assert.ok(info, "a git checkout with a HEAD is stampable");
  assert.equal(info.sha, headSha(repo));
  assert.equal(info.root, path.resolve(repo));
  assert.ok(info.builtAt > 0);
  assert.ok(fs.existsSync(buildInfoPath(dist)), "the stamp lives in the dist dir");
  assert.deepEqual(readBuildInfo(dist), info);
});

test("stampBuild takes an explicit sha (redeploy compiles a specific head) and skips non-repos", async () => {
  const repo = makeRepo();
  const dist = tmpdir();
  const stamped = await stampBuild(repo, dist, "f".repeat(40));
  assert.equal(stamped?.sha, "f".repeat(40));
  // No git HEAD to record: no stamp is written — provenance stays unknown, the honest answer.
  const notARepo = tmpdir();
  assert.equal(await stampBuild(notARepo, path.join(notARepo, "dist")), null);
  assert.equal(fs.existsSync(buildInfoPath(path.join(notARepo, "dist"))), false);
});

test("a stamp write interrupted before its atomic swap leaves the previous stamp intact", async () => {
  const dist = tmpdir();
  // A previous, valid stamp — what a running harness would have read at startup.
  const previous = { sha: "a".repeat(40), builtAt: 1, root: path.resolve(tmpdir()) };
  ensureParentDir(buildInfoPath(dist));
  fs.writeFileSync(buildInfoPath(dist), JSON.stringify(previous));
  // The swap fails (a crash, EIO, ENOSPC): the target must not have been touched yet.
  const restoreRename = patchFsMethod("renameSync", () => () => {
    throw new Error("injected: the atomic swap failed");
  });
  try {
    await assert.rejects(stampBuild(tmpdir(), dist, "f".repeat(40)), /injected/);
  } finally {
    restoreRename();
  }
  assert.deepEqual(readBuildInfo(dist), previous, "the old stamp survives a failed write");
  assert.deepEqual(
    fs.readdirSync(dist).filter((n) => n.startsWith("build-info.json.tmp-")),
    [],
    "no temp remnant is left behind",
  );
});

test("readBuildInfo is null for a missing, torn, or shapeless stamp", () => {
  const dist = tmpdir();
  assert.equal(readBuildInfo(dist), null);
  fs.writeFileSync(buildInfoPath(dist), '{"sha": "abc'); // torn write
  assert.equal(readBuildInfo(dist), null);
  fs.writeFileSync(buildInfoPath(dist), JSON.stringify({ sha: 42, root: "/x" })); // wrong types
  assert.equal(readBuildInfo(dist), null);
  fs.writeFileSync(buildInfoPath(dist), JSON.stringify({ sha: "abc", root: "/x" })); // builtAt optional
  assert.deepEqual(readBuildInfo(dist), { sha: "abc", root: "/x", builtAt: 0 });
});

test("isSelfHosted: built from this root AND a commit of this repo", async () => {
  const repo = makeRepo();
  const head = headSha(repo);
  assert.equal(await isSelfHosted(repo, { sha: head, builtAt: 1, root: path.resolve(repo) }), true);
  // Same root, unknown commit (a dist copied in from elsewhere): not this repo's build.
  assert.equal(await isSelfHosted(repo, { sha: "a".repeat(40), builtAt: 1, root: path.resolve(repo) }), false);
  // A harness installed elsewhere and pointed at this project: never self-hosted here.
  const other = makeRepo();
  assert.equal(await isSelfHosted(repo, { sha: head, builtAt: 1, root: path.resolve(other) }), false);
});

test("buildStaleness counts main's commits but goes stale only when build inputs change", async () => {
  const repo = makeRepo();
  const build = headSha(repo);
  assert.deepEqual(await buildStaleness(repo, build, build), { stale: false, aheadCommits: 0 });
  // Docs and tests move main without changing the running code.
  const docs = commitFile(repo, "README.md", "# hi\n", "docs only");
  assert.deepEqual(await buildStaleness(repo, build, docs), { stale: false, aheadCommits: 1 });
  const tests = commitFile(repo, "test/x.test.ts", "// t\n", "tests only");
  assert.deepEqual(await buildStaleness(repo, build, tests), { stale: false, aheadCommits: 2 });
  // A src change does.
  const src = commitFile(repo, "src/x.ts", "export const x = 1;\n", "src change");
  assert.deepEqual(await buildStaleness(repo, build, src), { stale: true, aheadCommits: 3 });
  // So does every other declared input.
  for (const input of BUILD_INPUTS) {
    if (input === "src") continue;
    const fresh = makeRepo();
    const base = headSha(fresh);
    const moved = commitFile(fresh, input, "{}\n", `touch ${input}`);
    assert.equal((await buildStaleness(fresh, base, moved))?.stale, true, `${input} is a build input`);
  }
});

test("buildStaleness is null for a build sha this repo does not have", async () => {
  const repo = makeRepo();
  const head = headSha(repo);
  assert.equal(await buildStaleness(repo, "b".repeat(40), head), null);
});

// The release half of the stamp (BuildInfo.release): the npm version, recorded only when the
// stamped commit is the one the tag v<version> points at. Expected values come from the tag and
// version the test itself writes, never from the code under test.

/** A makeRepo'd repo whose committed package.json declares `version` (absent when null). */
function versionedRepo(version: string | null): { repo: string; sha: string } {
  const repo = makeRepo();
  const body = JSON.stringify(version === null ? { name: "tumwater" } : { name: "tumwater", version });
  return { repo, sha: commitFile(repo, "package.json", body, "package") };
}

test("a stamp of the commit the v<version> tag points at records that release", async () => {
  const { repo, sha } = versionedRepo("1.2.3");
  sh(repo, "git", "tag", "v1.2.3");
  const dist = path.join(tmpdir(), "dist");
  const info = await stampBuild(repo, dist);
  assert.equal(info?.sha, sha);
  assert.equal(info?.release, "1.2.3");
  // readBuildInfo round-trips it, so the running harness sees the same release the build wrote.
  assert.deepEqual(readBuildInfo(dist), info);
});

test("an annotated tag peels to its commit and still records the release", async () => {
  const { repo } = versionedRepo("1.2.3");
  sh(repo, "git", "tag", "-a", "v1.2.3", "-m", "release 1.2.3");
  assert.equal((await stampBuild(repo, path.join(tmpdir(), "dist")))?.release, "1.2.3");
});

test("no release is recorded for an untagged commit, another version's tag, or a tag elsewhere", async () => {
  // Untagged HEAD.
  const plain = versionedRepo("1.2.3");
  assert.equal((await stampBuild(plain.repo, path.join(tmpdir(), "d1")))?.release, undefined);
  // HEAD is tagged v1.2.2 while package.json says 1.2.3: not the 1.2.3 release.
  const mismatched = versionedRepo("1.2.3");
  sh(mismatched.repo, "git", "tag", "v1.2.2");
  assert.equal((await stampBuild(mismatched.repo, path.join(tmpdir(), "d2")))?.release, undefined);
  // v1.2.3 sits on an older commit, so HEAD is not that release.
  const repo = makeRepo();
  const older = commitFile(repo, "a.txt", "1\n", "first");
  sh(repo, "git", "tag", "v1.2.3", older);
  commitFile(repo, "package.json", JSON.stringify({ name: "tumwater", version: "1.2.3" }), "package");
  assert.equal((await stampBuild(repo, path.join(tmpdir(), "d3")))?.release, undefined);
});

test("a missing or version-less package.json stamps normally with no release", async () => {
  const bare = makeRepo();
  assert.equal((await stampBuild(bare, path.join(tmpdir(), "d4")))?.release, undefined);
  assert.equal((await stampBuild(versionedRepo(null).repo, path.join(tmpdir(), "d5")))?.release, undefined);
  // A failed git read (no repository) never fails the stamp: an explicit sha still stamps, and
  // a version it cannot check against a tag stays out.
  const notARepo = tmpdir();
  fs.writeFileSync(path.join(notARepo, "package.json"), JSON.stringify({ name: "tumwater", version: "1.2.3" }));
  const info = await stampBuild(notARepo, path.join(tmpdir(), "d6"), "f".repeat(40));
  assert.equal(info?.sha, "f".repeat(40));
  assert.equal(info?.release, undefined);
});

// The observer-facing name of the running build (part 2/3): the GUI's Version row and doctor's
// running line both read it, so the release-vs-commit decision has one home.
test("buildLabel names a release build by its version and every other build by its 8-character sha", () => {
  assert.equal(buildLabel({ sha: "a".repeat(40) }), "aaaaaaaa", "a checkout build is its commit");
  assert.equal(buildLabel({ sha: "a".repeat(40), release: "0.8.1" }), "0.8.1", "a release build is its version");
  assert.equal(buildLabel({ sha: "a".repeat(40), release: "0.8.1" }).length, 5, "the version, not a sha");
  assert.equal(buildLabel(null), "", "no harness, no stamp: nothing to name");
});

test("readBuildInfo drops a foreign or empty release and keeps the rest of the stamp", () => {
  const dist = tmpdir();
  fs.writeFileSync(buildInfoPath(dist), JSON.stringify({ sha: "abc", root: "/x", builtAt: 5, release: 7 }));
  assert.deepEqual(readBuildInfo(dist), { sha: "abc", root: "/x", builtAt: 5 });
  fs.writeFileSync(buildInfoPath(dist), JSON.stringify({ sha: "abc", root: "/x", builtAt: 5, release: "" }));
  assert.deepEqual(readBuildInfo(dist), { sha: "abc", root: "/x", builtAt: 5 });
  fs.writeFileSync(buildInfoPath(dist), JSON.stringify({ sha: "abc", root: "/x", builtAt: 5, release: "0.8.1" }));
  assert.deepEqual(readBuildInfo(dist), { sha: "abc", root: "/x", builtAt: 5, release: "0.8.1" });
});
