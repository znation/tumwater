/** Unit coverage for src/observer/remote-ci.ts — the `ci` role's remote-CI ledger and prompt
 * block (plans/remote-ci.md "Shape"). The ci role runs the workflow's steps on this machine and
 * never asks GitHub whether Actions passed, so this module's job is detection (a GitHub remote
 * plus a workflow file) and the read-only record the role reports on its `REMOTE:` line. A
 * missing, torn or wrong-shaped ledger file reads as null — an observer must never fail a run on
 * bookkeeping (the same policy as ci-parity.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  githubRepoOf,
  readRemoteCi,
  recordRemoteCi,
  remoteCiTarget,
  remoteCiStalled,
  renderRemoteCiBlock,
  type RemoteCiEntry,
} from "../src/observer/remote-ci.js";
import { CI_PARITY_STALE_MS } from "../src/observer/ci-parity.js";
import { remoteCiPath } from "../src/paths.js";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { makeRepo, tmpdir, sh } from "./fixtures/repo-fixtures.js";

// --- githubRepoOf: owner/name out of a GitHub remote URL, null otherwise.

test("githubRepoOf reads owner/name from the https, scp and ssh forms", () => {
  assert.equal(githubRepoOf("https://github.com/znation/tumwater.git"), "znation/tumwater");
  assert.equal(githubRepoOf("git@github.com:znation/tumwater.git"), "znation/tumwater");
  assert.equal(githubRepoOf("ssh://git@github.com/znation/tumwater"), "znation/tumwater");
  assert.equal(githubRepoOf("https://GitHub.com/znation/tumwater/"), "znation/tumwater");
});

test("githubRepoOf strips the .git suffix and a trailing slash", () => {
  assert.equal(githubRepoOf("https://github.com/o/r.git"), "o/r");
  assert.equal(githubRepoOf("https://github.com/o/r/"), "o/r");
  assert.equal(githubRepoOf("git@github.com:o/r"), "o/r");
});

test("githubRepoOf returns null for any other host or a path that is not exactly two segments", () => {
  assert.equal(githubRepoOf("https://gitlab.com/a/b.git"), null);
  assert.equal(githubRepoOf("https://github.com/a"), null);
  assert.equal(githubRepoOf("/srv/git/repo.git"), null);
});

// --- remoteCiTarget: detection from git config and the workflow directory.

function githubFixture(): string {
  const repo = makeRepo();
  const workflows = path.join(repo, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "ci.yml"), "name: ci\n");
  sh(repo, "git", "remote", "add", "origin", "https://github.com/znation/tumwater.git");
  return repo;
}

test("remoteCiTarget returns the repo and base branch in a GitHub fixture", async () => {
  const repo = githubFixture();
  const target = await remoteCiTarget(repo, defaultConfig() as TumwaterConfig);
  assert.deepEqual(target, { repo: "znation/tumwater", branch: "main" });
});

test("remoteCiTarget returns null when roles.ci.remote is false", async () => {
  const repo = githubFixture();
  const config = defaultConfig() as TumwaterConfig;
  config.roles!.ci = { enabled: true, remote: false };
  assert.equal(await remoteCiTarget(repo, config), null);
});

test("remoteCiTarget returns null with no workflow file", async () => {
  const repo = makeRepo();
  sh(repo, "git", "remote", "add", "origin", "https://github.com/znation/tumwater.git");
  assert.equal(await remoteCiTarget(repo, defaultConfig() as TumwaterConfig), null);
});

test("remoteCiTarget returns null when origin is on another host", async () => {
  const repo = makeRepo();
  const workflows = path.join(repo, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "ci.yml"), "name: ci\n");
  sh(repo, "git", "remote", "add", "origin", "https://gitlab.com/znation/tumwater.git");
  assert.equal(await remoteCiTarget(repo, defaultConfig() as TumwaterConfig), null);
});

// --- the ledger: a missing, torn or wrong-shaped file reads as null.

test("readRemoteCi returns null for a missing or torn file", () => {
  const root = tmpdir();
  assert.equal(readRemoteCi(root), null, "missing reads as null");
  const file = remoteCiPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  assert.equal(readRemoteCi(root), null, "torn reads as null");
});

test("readRemoteCi returns null for a wrong-shaped record", () => {
  const root = tmpdir();
  const file = remoteCiPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A non-`unavailable` record without a sha, and an `unavailable` record without a reason,
  // are both wrong-shaped and must read as no data.
  fs.writeFileSync(
    file,
    JSON.stringify({ record: { repo: "o/r", result: "passed", checkedAt: 1 } }),
  );
  assert.equal(readRemoteCi(root), null, "a passed record without a sha reads as null");
  fs.writeFileSync(
    file,
    JSON.stringify({ record: { repo: "o/r", result: "unavailable", checkedAt: 1 } }),
  );
  assert.equal(readRemoteCi(root), null, "an unavailable record without a reason reads as null");
});

test("readRemoteCi and recordRemoteCi round trip", () => {
  const root = tmpdir();
  const first = recordRemoteCi(root, "znation/tumwater", "passed", 1000, "3e450b0c4");
  assert.equal(first, null, "the first write returns no previous record");
  const entry = readRemoteCi(root);
  assert.ok(entry);
  assert.deepEqual(entry, {
    repo: "znation/tumwater",
    sha: "3e450b0c4",
    result: "passed",
    checkedAt: 1000,
  });
  // The second write returns the first record — part 2/3's once-per-commit event reads it.
  const second = recordRemoteCi(root, "znation/tumwater", "failed", 2000, "3e450b0c4");
  assert.ok(second);
  assert.equal(second!.result, "passed");
  assert.equal(second!.checkedAt, 1000);
  const after = readRemoteCi(root);
  assert.ok(after);
  assert.equal(after!.result, "failed");
  assert.equal(after!.checkedAt, 2000);
});

test("recordRemoteCi rides the unavailable reason onto the record", () => {
  const root = tmpdir();
  recordRemoteCi(root, "znation/tumwater", "unavailable", 1000, undefined, "gh is not logged in");
  const entry = readRemoteCi(root);
  assert.ok(entry);
  assert.deepEqual(entry, {
    repo: "znation/tumwater",
    result: "unavailable",
    reason: "gh is not logged in",
    checkedAt: 1000,
  });
  assert.equal(entry!.sha, undefined, "an unavailable record carries no sha");
});

// --- renderRemoteCiBlock: the three record states.

const target = { repo: "znation/tumwater", branch: "main" };
const NOW = 1_000_000_000_000;

test("renderRemoteCiBlock names the repo, branch and gh command with no record", () => {
  const block = renderRemoteCiBlock(target, null, NOW);
  assert.equal(
    block,
    [
      `Remote CI (GitHub Actions on znation/tumwater, branch main; from this team's own record):`,
      `  no result recorded yet`,
      `  Check it this run with: gh run list --repo znation/tumwater --branch main --event push --limit 20 --json headSha,status,conclusion,workflowName,databaseId,url,createdAt`,
    ].join("\n"),
  );
});

test("renderRemoteCiBlock renders a passed record with its age", () => {
  const entry: RemoteCiEntry = {
    repo: "znation/tumwater",
    sha: "3e450b0c4",
    result: "passed",
    checkedAt: NOW - 5 * 60_000, // five minutes ago
  };
  const block = renderRemoteCiBlock(target, entry, NOW);
  assert.match(block, /^Remote CI \(GitHub Actions on znation\/tumwater, branch main; from this team's own record\):$/m);
  assert.match(block, /  last checked 3e450b0 — passed 5m ago$/m);
  assert.ok(!block.includes("ago ago"), "the age reads once, not 'ago ago'");
});

test("renderRemoteCiBlock renders a failed record", () => {
  const entry: RemoteCiEntry = {
    repo: "znation/tumwater",
    sha: "3e450b0c4",
    result: "failed",
    checkedAt: NOW - 4 * 3_600_000, // four hours ago
  };
  const block = renderRemoteCiBlock(target, entry, NOW);
  assert.match(block, /  last checked 3e450b0 — failed 4h ago$/m);
});

test("renderRemoteCiBlock renders an unavailable record with its reason", () => {
  const entry: RemoteCiEntry = {
    repo: "znation/tumwater",
    result: "unavailable",
    reason: "gh is not logged in",
    checkedAt: NOW - 5 * 60_000,
  };
  const block = renderRemoteCiBlock(target, entry, NOW);
  assert.match(block, /  last checked — unavailable 5m ago: gh is not logged in$/m);
});

// --- remoteCiStalled: the one stall predicate the doctor's `remote CI` row applies (INV-BW5).

test("remoteCiStalled is true with no record, at the boundary false, one past it true", () => {
  const now = 1_000_000_000_000;
  assert.equal(remoteCiStalled(null, now), true, "no record at all is a stall — nothing has checked");
  const entry: RemoteCiEntry = {
    repo: "znation/tumwater",
    sha: "3e450b0c4",
    result: "passed",
    checkedAt: now - CI_PARITY_STALE_MS,
  };
  assert.equal(remoteCiStalled(entry, now), false, "exactly at the window is not yet stalled");
  const past: RemoteCiEntry = { ...entry, checkedAt: now - CI_PARITY_STALE_MS - 1 };
  assert.equal(remoteCiStalled(past, now), true, "one past the window is stalled");
  const fresh: RemoteCiEntry = { ...entry, checkedAt: now - 60_000 };
  assert.equal(remoteCiStalled(fresh, now), false, "a fresh record is not stalled");
  // The window is the shared three-day parity window, not its own constant.
  assert.equal(CI_PARITY_STALE_MS, 3 * 86_400_000);
});
