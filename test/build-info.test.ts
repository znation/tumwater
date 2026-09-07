import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_INPUTS,
  buildInfoPath,
  buildStaleness,
  isSelfHosted,
  readBuildInfo,
  stampBuild,
} from "../src/build-info.js";
import { makeRepo, sh, tmpdir } from "./util.js";

// Build provenance (src/build-info.ts): the stamp `npm run build` writes into dist/, and the
// comparison against main that tells a self-hosting fleet whether it is running the code main
// describes. Pinned against real git repos — the whole point is agreement with git's view.

function commitFile(repo: string, rel: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", message);
  return sh(repo, "git", "rev-parse", "HEAD");
}

test("stampBuild writes the checkout's HEAD and root; readBuildInfo reads it back", async () => {
  const repo = makeRepo();
  const dist = path.join(tmpdir(), "dist");
  const info = await stampBuild(repo, dist);
  assert.ok(info, "a git checkout with a HEAD is stampable");
  assert.equal(info.sha, sh(repo, "git", "rev-parse", "HEAD"));
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
  const head = sh(repo, "git", "rev-parse", "HEAD");
  assert.equal(await isSelfHosted(repo, { sha: head, builtAt: 1, root: path.resolve(repo) }), true);
  // Same root, unknown commit (a dist copied in from elsewhere): not this repo's build.
  assert.equal(await isSelfHosted(repo, { sha: "a".repeat(40), builtAt: 1, root: path.resolve(repo) }), false);
  // A harness installed elsewhere and pointed at this project: never self-hosted here.
  const other = makeRepo();
  assert.equal(await isSelfHosted(repo, { sha: head, builtAt: 1, root: path.resolve(other) }), false);
});

test("buildStaleness counts main's commits but goes stale only when build inputs change", async () => {
  const repo = makeRepo();
  const build = sh(repo, "git", "rev-parse", "HEAD");
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
    const base = sh(fresh, "git", "rev-parse", "HEAD");
    const moved = commitFile(fresh, input, "{}\n", `touch ${input}`);
    assert.equal((await buildStaleness(fresh, base, moved))?.stale, true, `${input} is a build input`);
  }
});

test("buildStaleness is null for a build sha this repo does not have", async () => {
  const repo = makeRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  assert.equal(await buildStaleness(repo, "b".repeat(40), head), null);
});
