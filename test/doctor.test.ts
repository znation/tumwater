import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkBuild,
  checkBuildCheck,
  checkFallbackModel,
  checkGitBinary,
  checkInit,
  checkMergeLock,
  checkNodeVersion,
  checkAgentBinary,
  checkRepo,
  checkStateDir,
  renderDoctor,
  runDoctor,
} from "../src/doctor.js";
import { GIT_MISSING_MESSAGE } from "../src/git.js";
import { initProject } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { allRoleIds } from "../src/roles.js";
import type { TumwaterConfig } from "../src/types.js";
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

test("checkNodeVersion reports this runtime as ok and warns below the declared floor", () => {
  const current = checkNodeVersion();
  assert.equal(current.level, "ok");
  assert.equal(current.detail, `v${process.versions.node}`);

  const old = checkNodeVersion("18.20.4");
  assert.equal(old.level, "warn");
  assert.match(old.detail, /v18\.20\.4 is below the v20 minimum/);
  assert.match(old.detail, /upgrade Node/);

  const atFloor = checkNodeVersion("20.0.0");
  assert.equal(atFloor.level, "ok");

  // An unparseable version string is a warning, never a thrown failure.
  const odd = checkNodeVersion("not-a-version");
  assert.equal(odd.level, "warn");
  assert.match(odd.detail, /unrecognized Node version/);
});

test("checkGitBinary resolves git from the given PATH and fails with the shared message when absent", () => {
  const ok = checkGitBinary(process.env.PATH ?? "");
  assert.equal(ok.level, "ok");
  assert.ok(fs.statSync(ok.detail).isFile(), `detail is a resolved file: ${ok.detail}`);

  const missing = checkGitBinary("");
  assert.deepEqual(missing, { level: "fail", detail: GIT_MISSING_MESSAGE });
});

test("checkAgentBinary resolves the default pi from the given PATH and fails with the install hint when absent", () => {
  const root = readyRepo();
  const binDir = fakeBins("pi");
  const ok = checkAgentBinary(root, binDir);
  assert.equal(ok.level, "ok");
  assert.equal(ok.detail, path.join(binDir, "pi"));

  const missing = checkAgentBinary(root, "");
  assert.equal(missing.level, "fail");
  assert.match(missing.detail, /install it/);
});

// plans/portability.md §5/7: a configured agent binary must be reported with its source, so
// a configured binary is never mistaken for the ambient one — and a wrong one must not read
// as "pi is not installed".
test("checkAgentBinary names the resolved path and TUMWATER_PI_BIN as its source", () => {
  const root = readyRepo();
  const binDir = fakeBins("wrapped-pi");
  const bin = path.join(binDir, "wrapped-pi");
  process.env.TUMWATER_PI_BIN = bin;
  try {
    const ok = checkAgentBinary(root, ""); // PATH deliberately empty: only the override resolves
    assert.equal(ok.level, "ok");
    assert.equal(ok.detail, `${bin} — resolved from TUMWATER_PI_BIN`);
  } finally {
    delete process.env.TUMWATER_PI_BIN;
  }

  process.env.TUMWATER_PI_BIN = path.join(binDir, "no-such-bin");
  try {
    const missing = checkAgentBinary(root, "");
    assert.equal(missing.level, "fail");
    assert.match(missing.detail, new RegExp(`${binDir}/no-such-bin[^ ]* from TUMWATER_PI_BIN`));
    assert.match(missing.detail, /install it/);
  } finally {
    delete process.env.TUMWATER_PI_BIN;
  }
});

test("checkAgentBinary resolves agentBin from tumwater.json — bare name via PATH, path via accessSync", () => {
  const binDir = fakeBins("pi-stub");

  // A bare name resolves through the same PATH lookup the git check uses, and the ok
  // detail names both the resolved path and the config source.
  const bareRepo = readyRepo();
  writeConfig(bareRepo, { agentBin: "pi-stub" });
  const bareOk = checkAgentBinary(bareRepo, binDir);
  assert.equal(bareOk.level, "ok");
  assert.equal(bareOk.detail, `${path.join(binDir, "pi-stub")} — resolved from agentBin in tumwater.json`);
  const bareMissing = checkAgentBinary(bareRepo, "");
  assert.equal(bareMissing.level, "fail");
  assert.match(bareMissing.detail, /"pi-stub" from agentBin in tumwater\.json/);

  // A path-shaped value is tested directly: an existing executable is ok, a missing one
  // fails naming the value, its source, and the install hint.
  const pathRepo = readyRepo();
  writeConfig(pathRepo, { agentBin: path.join(binDir, "pi-stub") });
  const pathOk = checkAgentBinary(pathRepo, "");
  assert.equal(pathOk.level, "ok");
  assert.equal(pathOk.detail, `${path.join(binDir, "pi-stub")} — resolved from agentBin in tumwater.json`);

  const goneRepo = readyRepo();
  const gone = path.join(binDir, "gone-pi");
  writeConfig(goneRepo, { agentBin: gone });
  const goneOut = checkAgentBinary(goneRepo, "");
  assert.equal(goneOut.level, "fail");
  assert.match(goneOut.detail, new RegExp(`"${gone}" from agentBin in tumwater\\.json`));
  assert.match(goneOut.detail, /install it/);
});

test("checkAgentBinary falls back to the default when tumwater.json is malformed", () => {
  // A broken config must not throw inside a check: checkInit reports it separately, and the
  // pi check still stands on its own default resolution.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tumwater.json"), "{ not json");
  const out = checkAgentBinary(root, fakeBins("pi"));
  assert.equal(out.level, "ok");
  assert.match(out.detail, /pi$/);
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
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, /repo at \S+ — on branch main$/);
});

test("checkRepo reports the toplevel and honors a configured baseBranch", async () => {
  // A configured baseBranch that exists is the target, whatever is checked out.
  const repo = makeRepo();
  sh(repo, "git", "branch", "integration");
  sh(repo, "git", "checkout", "integration");
  const targeting = await checkRepo(repo, { baseBranch: "main" } as TumwaterConfig);
  assert.equal(targeting.level, "ok");
  assert.match(targeting.detail, /repo at \S+ — targeting branch main$/);

  // A configured branch that does not exist fails, listing what does — at doctor time, not
  // at the first tick.
  const missing = await checkRepo(repo, { baseBranch: "ghost" } as TumwaterConfig);
  assert.equal(missing.level, "fail");
  assert.match(missing.detail, /configured baseBranch ghost does not exist/);
  assert.match(missing.detail, /branches: .*integration/);

  // No config (the standalone check) falls back to the checked-out branch, as before.
  const checkedOut = await checkRepo(repo);
  assert.match(checkedOut.detail, /on branch integration$/);
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

/** A models.json with one unpriced (free) model and one paid model, for the fallback check. */
function writeModels(): string {
  const dir = tmpdir("doctor-models-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: { models: [{ id: "free-model" }] },
        paid: { models: [{ id: "gpt-x", cost: { input: 1, output: 2 } }] },
      },
    }),
  );
  return file;
}

test("checkFallbackModel reports the cap behavior and verifies a free fallback pair", () => {
  const models = writeModels();

  // No fallbackModel: informational — the fleet pauses at the cap by design. The definitions
  // file is not even consulted, so an absent path is still ok.
  const none = readyRepo();
  assert.deepEqual(checkFallbackModel(none, path.join(tmpdir(), "absent.json")), {
    level: "ok",
    detail: "none configured — role loops pause at the cap",
  });

  // A free local pair is the case the fallback exists for.
  const free = readyRepo();
  writeConfig(free, { fallbackModel: { provider: "local", model: "free-model" } });
  assert.deepEqual(checkFallbackModel(free, models), {
    level: "ok",
    detail: "local/free-model — priced at zero (cost n/a)",
  });

  // A priced or unknown id would be refused by the gate, so role loops would pause at the cap
  // instead of switching — warn before the day's budget is spent on discovering it.
  const paid = readyRepo();
  writeConfig(paid, { fallbackModel: { provider: "paid", model: "gpt-x" } });
  const warned = checkFallbackModel(paid, models);
  assert.equal(warned.level, "warn");
  assert.match(warned.detail, /paid\/gpt-x is not priced at zero/);
  assert.match(warned.detail, /role loops pause instead of switching/);
});

test("checkFallbackModel cannot run on an invalid config and says so without failing", () => {
  const root = readyRepo();
  writeConfig(root, { bogusKey: 1 });
  const outcome = checkFallbackModel(root, path.join(tmpdir(), "absent.json"));
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /cannot check — invalid tumwater\.json/);
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
    ["node", "git binary", "repo", "init", "fallback", "pi binary", "state dir", "merge lock", "build check", "build"],
  );
  // The node check reflects the runtime running the suite, which is at or above the declared
  // floor in practice; assert it is never a failure rather than pinning CI's Node version.
  for (const c of report.checks)
    if (c.name !== "node") assert.equal(c.level, "ok", `${c.name}: ${c.detail}`);
  const nodeCheck = report.checks.find((c) => c.name === "node");
  assert.ok(nodeCheck, "the node check is part of the report");
  assert.notEqual(nodeCheck.level, "fail");
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

test("runDoctor's header carries the running build's sha, staleness, and restart block", async () => {
  // orchestrator.json's build field is what an operator reads to answer "why is doctor saying
  // STALE / restart blocked" — the header must surface all three states, not just the pid.
  const sha = "a".repeat(40);
  const writeInfo = (build: Record<string, unknown>) => {
    const root = readyRepo();
    fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".tumwater", "state", "orchestrator.json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: [], build }),
    );
    return root;
  };

  // Fresh, un-stale build: just the sha.
  const fresh = await runDoctor(writeInfo({ sha, builtAt: Date.now() }), fakeBins("git", "pi"));
  assert.match(fresh.header, new RegExp(`harness running \\(pid ${process.pid}, build ${sha.slice(0, 8)}\\)`));
  assert.doesNotMatch(fresh.header, /STALE|restart blocked/);

  // Stale build whose auto-restart is under way: STALE, no block note.
  const stale = await runDoctor(
    writeInfo({ sha, builtAt: Date.now(), stale: true, aheadCommits: 2 }),
    fakeBins("git", "pi"),
  );
  assert.match(stale.header, new RegExp(`build ${sha.slice(0, 8)} — STALE\\)`));

  // Stale build whose auto-restart was REFUSED: the block reason is the operator's answer.
  const blocked = await runDoctor(
    writeInfo({ sha, builtAt: Date.now(), stale: true, aheadCommits: 3, restartBlocked: "main deadbeef is red" }),
    fakeBins("git", "pi"),
  );
  assert.match(blocked.header, new RegExp(`build ${sha.slice(0, 8)} — STALE \\(restart blocked\\)`));
});

test("runDoctor survives a corrupt config and lets the init check report it", async () => {
  // loadConfig throwing must not take down the one command an operator runs to find out why
  // nothing works — doctor degrades to the init check's failure detail instead.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tumwater.json"), "{ not json");
  const report = await runDoctor(root, fakeBins("git", "pi"));
  assert.match(report.header, /harness not running/);
  const init = report.checks.find((c) => c.name === "init");
  assert.equal(init?.level, "fail");
  assert.ok(init && init.detail.length > 0, "the init check names the config problem");
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

// Build provenance check (src/build-info.ts): does dist/ hold the code main describes? The
// stamp and head are injected so every branch runs without compiling anything.
test("checkBuild reports an unstamped dist, a foreign harness, a matching build, and a stale one", async () => {
  const repo = makeRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const here = { sha: head, builtAt: 1, root: path.resolve(repo) };

  const unstamped = await checkBuild(repo, null);
  assert.equal(unstamped.level, "ok");
  assert.match(unstamped.detail, /no build stamp/);

  // A tumwater installed elsewhere and pointed at this project: its build is never stale here.
  const foreign = await checkBuild(repo, { ...here, root: "/somewhere/else" });
  assert.equal(foreign.level, "ok");
  assert.match(foreign.detail, /not the harness itself/);

  const fresh = await checkBuild(repo, here, head);
  assert.equal(fresh.level, "ok");
  assert.match(fresh.detail, /matches main/);

  // Two commits later, one touching src/: stale — a warning (the fleet runs, just old code), never a fail.
  fs.writeFileSync(path.join(repo, "README.md"), "docs\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", "docs");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/x.ts"), "export {};\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", "src");
  const stale = await checkBuild(repo, here); // head resolved from the repo itself
  assert.equal(stale.level, "warn");
  assert.match(stale.detail, /is stale — main has 2 later commit\(s\) touching src, package\.json, tsconfig\.json/);
  assert.match(stale.detail, /npm run build/);

  // With a fleet up, doctor reports what auto-restart is actually doing rather than the advice
  // that it will handle this — a refused restart never retries until main moves (BUGS.md).
  const running = { sha: head, builtAt: 1, stale: true, aheadCommits: 2, checkedHead: head };
  const pending = await checkBuild(repo, here, undefined, { ...running, restartPending: true });
  assert.match(pending.detail, /auto-restart is under way/);
  assert.doesNotMatch(pending.detail, /npm run build/);
  const blocked = await checkBuild(repo, here, undefined, { ...running, restartBlocked: "main deadbeef is red" });
  assert.equal(blocked.level, "warn");
  assert.match(blocked.detail, /auto-restart is BLOCKED \(main deadbeef is red\) and will not retry until main moves/);
});

test("runDoctor includes the build check and never fails the exit on a stale build", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{}");
  const report = await runDoctor(repo, fakeBins("git", "pi"));
  const build = report.checks.find((c) => c.name === "build");
  assert.ok(build, "the build check is part of the report");
  assert.notEqual(build.level, "fail");
});

test("checkInit warns naming drifted template keys, never rewrites, and its remedy works", async () => {
  const root = readyRepo();
  fs.writeFileSync(
    path.join(root, "tumwater.example.json"),
    JSON.stringify({ minTickIntervalSeconds: 45, landBatchMax: 2 }),
  );
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const warn = checkInit(root);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /minTickIntervalSeconds, landBatchMax/);
  assert.match(warn.detail, /re-run `tumwater init`/);
  // Read-only: the warning never touches the local file.
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);

  // The remedy is a real path, not a no-op: init skips an existing config, so reseeding means
  // deleting it first — and then the drift is gone because the seed is the full template merge.
  fs.rmSync(path.join(root, "tumwater.json"));
  await initProject(root, "prompt");
  const ok = checkInit(root);
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, /roles enabled/);
  assert.equal(loadConfig(root).minTickIntervalSeconds, 45);
});

test("checkInit warns on a template that cannot serve as one, naming the file and the fix", async () => {
  const root = readyRepo();
  // Unparseable template: seedConfig would silently seed bare defaults and exampleDrift would
  // report no drift — this warn is the broken template's only signal.
  fs.writeFileSync(path.join(root, "tumwater.example.json"), "{ not json");
  const warn = checkInit(root);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /broken template: tumwater\.example\.json is not valid JSON/);
  assert.match(warn.detail, /fix the file/);

  // An invalid (but parseable) template warns under the example's name too, listing the
  // actual problems so one edit fixes them all.
  fs.writeFileSync(path.join(root, "tumwater.example.json"), JSON.stringify({ noSuchKey: true }));
  const invalid = checkInit(root);
  assert.equal(invalid.level, "warn");
  assert.match(invalid.detail, /invalid tumwater\.example\.json/);

  // The template problem outranks drift: the drift parse has already failed.
  fs.writeFileSync(path.join(root, "tumwater.example.json"), JSON.stringify({ noSuchKey: true, minTickIntervalSeconds: 45 }));
  const both = checkInit(root);
  assert.equal(both.level, "warn");
  assert.doesNotMatch(both.detail, /template drift/);

  // A valid template restores the ordinary paths: no warn, drift wording again.
  fs.writeFileSync(path.join(root, "tumwater.example.json"), JSON.stringify({ minTickIntervalSeconds: 45 }));
  const healthy = checkInit(root);
  assert.equal(healthy.level, "warn"); // drift reappears: tumwater.json lacks the key again
  assert.match(healthy.detail, /template drift/);
});
