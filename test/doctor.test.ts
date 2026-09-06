import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkBuildCheck,
  checkGitBinary,
  checkInit,
  checkMergeLock,
  checkPiBinary,
  checkRepo,
  checkStateDir,
  renderDoctor,
  runDoctor,
} from "../src/doctor.js";
import { GIT_MISSING_MESSAGE } from "../src/git.js";
import { allRoleIds } from "../src/roles.js";
import { makeRepo, sh, tmpdir } from "./util.js";

// Unit coverage for the pre-flight environment check (src/doctor.ts): every check's ok/fail/warn
// branches plus report composition and rendering. The binary checks take an explicit PATH so the
// missing branch is exercised by passing "" — no PATH mutation, no spawning. The CLI wiring
// (`tumwater doctor` exit codes) is covered in cli.test.ts territory; here we pin the module's
// own behavior, including its read-only guarantee against .tumwater/.

/** A bin dir holding executable files with the given names — a deterministic PATH for the binary checks. */
function fakeBins(...names: string[]): string {
  const dir = tmpdir("doctor-bins-");
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

function writeConfig(root: string, json: unknown): void {
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify(json));
}

/** A ready repo: one commit on main plus a valid tumwater.json (the empty object — all
 * defaults). */
function readyRepo(): string {
  const root = makeRepo();
  writeConfig(root, {});
  return root;
}

test("checkGitBinary resolves git from the given PATH and fails with the shared message when absent", () => {
  const ok = checkGitBinary(process.env.PATH ?? "");
  assert.equal(ok.level, "ok");
  assert.ok(fs.statSync(ok.detail).isFile(), `detail is a resolved file: ${ok.detail}`);

  const missing = checkGitBinary("");
  assert.deepEqual(missing, { level: "fail", detail: GIT_MISSING_MESSAGE });
});

test("checkPiBinary resolves pi from the given PATH and fails with the install hint when absent", () => {
  const binDir = fakeBins("pi");
  const ok = checkPiBinary(binDir);
  assert.equal(ok.level, "ok");
  assert.equal(ok.detail, path.join(binDir, "pi"));

  const missing = checkPiBinary("");
  assert.equal(missing.level, "fail");
  assert.match(missing.detail, /install it/);
});

test("checkRepo reports not-a-repo, no-commits-yet, and detached HEAD as distinct failures", async () => {
  const notRepo = await checkRepo(tmpdir());
  assert.equal(notRepo.level, "fail");
  assert.match(notRepo.detail, /not a git repository/);

  const empty = tmpdir();
  sh(empty, "git", "init", "-b", "main");
  const noCommits = await checkRepo(empty);
  assert.equal(noCommits.level, "fail");
  assert.match(noCommits.detail, /no commits yet/);

  const detached = makeRepo();
  sh(detached, "git", "checkout", "--detach");
  const det = await checkRepo(detached);
  assert.equal(det.level, "fail");
  assert.match(det.detail, /detached/);

  const ok = await checkRepo(makeRepo());
  assert.deepEqual(ok, { level: "ok", detail: "on branch main" });
});

test("checkInit fails when uninitialized and reports the enabled role count for a valid config", () => {
  const notInit = checkInit(makeRepo());
  assert.equal(notInit.level, "fail");
  assert.match(notInit.detail, /not initialized/);

  // An empty config enables every catalog role by default.
  const allEnabled = checkInit(readyRepo());
  assert.deepEqual(allEnabled, { level: "ok", detail: `${allRoleIds().length} roles enabled` });

  // The count reflects only the enabled entries: disable every role but one.
  const oneEnabled = makeRepo();
  const roles: Record<string, { enabled: boolean }> = {};
  for (const id of allRoleIds()) roles[id] = { enabled: id === "feature" };
  writeConfig(oneEnabled, { roles });
  assert.deepEqual(checkInit(oneEnabled), { level: "ok", detail: "1 roles enabled" });
});

test("checkInit carries the config error verbatim — invalid JSON and validation problems alike", () => {
  const badJson = makeRepo();
  fs.writeFileSync(path.join(badJson, "tumwater.json"), "{ not json");
  assert.match(checkInit(badJson).detail, /not valid JSON/);

  const unknownKey = readyRepo();
  writeConfig(unknownKey, { bogusKey: 1 });
  const fail = checkInit(unknownKey);
  assert.equal(fail.level, "fail");
  assert.match(fail.detail, /unknown key "bogusKey" in tumwater\.json/);
});

test("checkStateDir accepts an absent dir and proves writability without leaving a trace", () => {
  const root = makeRepo();
  assert.deepEqual(checkStateDir(root), { level: "ok", detail: "absent — created on first run" });

  const stateDir = path.join(root, ".tumwater");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "keep.txt"), "x\n");
  assert.deepEqual(checkStateDir(root), { level: "ok", detail: "writable" });
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ["keep.txt"], "the probe file is deleted again");
});

test("checkStateDir fails with the OS error when .tumwater is not writable", () => {
  // Skip under root, where chmod cannot stop the write and the probe would succeed.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;

  const root = makeRepo();
  const stateDir = path.join(root, ".tumwater");
  fs.mkdirSync(stateDir);
  try {
    fs.chmodSync(stateDir, 0o555);
    const fail = checkStateDir(root);
    assert.equal(fail.level, "fail");
    assert.match(fail.detail, /not writable/);
  } finally {
    fs.chmodSync(stateDir, 0o755);
  }
});

test("checkMergeLock classifies absent, live (with and without pid), and stale locks", () => {
  const root = makeRepo();
  assert.deepEqual(checkMergeLock(root), { level: "ok", detail: "not held" });

  const lockDir = path.join(root, ".tumwater", "merge.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  try {
    // Fresh dir with no pid file yet: the holder may be mid-creation — live, not stale.
    assert.deepEqual(checkMergeLock(root), { level: "ok", detail: "held (pid not yet written)" });

    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
    const live = checkMergeLock(root);
    assert.equal(live.level, "ok");
    assert.match(live.detail, new RegExp(`held by running loop \\(pid ${process.pid}\\)`));

    // A dead pid makes the lock stale — a warning, never a failure (it self-heals on next merge).
    fs.writeFileSync(path.join(lockDir, "pid"), "999999999");
    assert.deepEqual(checkMergeLock(root), { level: "warn", detail: "stale — will be broken on next merge" });

    // Age alone breaks a lock even when its pid is still alive (a reused pid).
    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lockDir, elevenMinutesAgo, elevenMinutesAgo);
    assert.deepEqual(checkMergeLock(root), { level: "warn", detail: "stale — will be broken on next merge" });
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("checkBuildCheck names the declared script and walks up from a worktree to the installed root", () => {
  const none = checkBuildCheck(makeRepo());
  assert.deepEqual(none, { level: "ok", detail: "none declared — the review gate's deterministic pre-check will be skipped" });

  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "node_modules"));
  assert.deepEqual(checkBuildCheck(root), { level: "ok", detail: "npm test" });

  // The real worktree layout: the install lives at the repo root, three levels above the worktree.
  const wt = path.join(root, ".tumwater", "worktrees", "cov");
  fs.mkdirSync(wt, { recursive: true });
  assert.deepEqual(checkBuildCheck(wt), { level: "ok", detail: "npm test in ../../.." });
});

test("runDoctor composes the full report — fixed check order, not-running header, ready verdict", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tumwater", "keep.txt"), "x\n");
  const before = fs.readdirSync(path.join(root, ".tumwater")).sort();

  const report = await runDoctor(root, fakeBins("git", "pi"));
  assert.equal(report.header, "tumwater doctor — harness not running");
  assert.deepEqual(
    report.checks.map((c) => c.name),
    ["git binary", "repo", "init", "pi binary", "state dir", "merge lock", "build check"],
  );
  for (const c of report.checks) assert.equal(c.level, "ok", `${c.name}: ${c.detail}`);
  assert.equal(report.verdict, "ready to run");

  // Read-only guarantee: a full doctor run changes nothing under .tumwater/.
  const after = fs.readdirSync(path.join(root, ".tumwater")).sort();
  assert.deepEqual(after, before);
});

test("runDoctor counts failures in the verdict — plural and singular", async () => {
  // No tumwater.json (init fails) plus an empty PATH (git and pi fail): three problems.
  const report = await runDoctor(makeRepo(), "");
  assert.equal(report.verdict, "3 problems");
  assert.deepEqual(
    report.checks.filter((c) => c.level === "fail").map((c) => c.name),
    ["git binary", "init", "pi binary"],
  );

  // A ready repo whose PATH has git but no pi: exactly one problem (singular).
  const singular = await runDoctor(readyRepo(), fakeBins("git"));
  assert.equal(singular.verdict, "1 problem");
});

test("runDoctor's header names the live orchestrator pid when the harness is running", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".tumwater", "state", "orchestrator.json"),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: [] }),
  );
  const report = await runDoctor(root, fakeBins("git", "pi"));
  assert.equal(report.header, `tumwater doctor — harness running (pid ${process.pid})`);
});

test("renderDoctor prints one padded line per check between the header and the verdict", () => {
  const rendered = renderDoctor({
    header: "tumwater doctor — harness not running",
    checks: [
      { name: "git binary", level: "ok", detail: "/usr/bin/git" },
      { name: "merge lock", level: "warn", detail: "stale — will be broken on next merge" },
      { name: "repo", level: "fail", detail: "not a git repository (run `git init` first)" },
    ],
    verdict: "1 problem",
  });
  assert.equal(
    rendered,
    [
      "tumwater doctor — harness not running",
      "ok    git binary   /usr/bin/git",
      "warn  merge lock   stale — will be broken on next merge",
      "fail  repo         not a git repository (run `git init` first)",
      "1 problem",
    ].join("\n"),
  );
});
