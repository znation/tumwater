import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkAgentBinary,
  checkBrief,
  checkBuild,
  checkBuildCheck,
  checkFallbackModel,
  checkGitBinary,
  checkInit,
  checkMergeLock,
  checkNodeVersion,
  checkRepo,
  checkStateDir,
  checkTierModels,
} from "../src/doctor/doctor-checks.js";
import { piProviderAuth } from "../src/doctor/doctor-checks.js";
import { GIT_MISSING_MESSAGE } from "../src/git/git-run.js";
import { initProject } from "../src/init/init.js";
import { loadConfig } from "../src/config/config.js";
import { allRoleIds } from "../src/roles/roles.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { makeRepo, runningAsRoot, sh, tmpdir, writeConfig, writeMalformedJson } from "./repo-fixtures.js";
import { backdate } from "./backdate.js";
import { fakeBins, readyRepo } from "./doctor-fixtures.js";
import { writeScript } from "./fake-commands.js";

// Unit coverage for the pre-flight environment checks (src/doctor/doctor-checks.ts): every check's
// ok/fail/warn branches. The binary checks take an explicit PATH so the missing branch is
// exercised by passing "" — no PATH mutation, no spawning. Report composition, rendering, and
// the CLI wiring (`tumwater doctor` exit codes through main()) are pinned in
// test/doctor.test.ts; the orphan check's own unit coverage lives in test/doctor-orphans.test.ts
// (it pins src/doctor/doctor-orphans.ts), and the fixtures the three files share live in
// test/doctor-fixtures.ts.
test("checkNodeVersion reports this runtime as ok and warns below the declared floor", () => {
  const current = checkNodeVersion();
  assert.equal(current.level, "ok");
  assert.equal(current.detail, `v${process.versions.node}`);

  const old = checkNodeVersion("18.20.4");
  assert.equal(old.level, "warn");
  assert.match(old.detail, /v18\.20\.4 is below the >=20\.3 Node floor/);
  assert.match(old.detail, /upgrade Node/);

  // The floor is the engines spec, compared component-wise: a runtime the old major-only
  // check blessed (20.0.0) now warns, because the gate below the engines floor refuses it.
  const belowPatchFloor = checkNodeVersion("20.2.0");
  assert.equal(belowPatchFloor.level, "warn");
  const atFloor = checkNodeVersion("20.3.0");
  assert.equal(atFloor.level, "ok");

  // An unparseable version string is a warning, never a thrown failure.
  const odd = checkNodeVersion("not-a-version");
  assert.equal(odd.level, "warn");
  assert.match(odd.detail, /unrecognized Node version/);

  // A string that parses fine but to a non-positive major (a "0.x" runtime) is unrecognized
  // too — the integer check alone would bless it and then compare 0 against the floor.
  const zero = checkNodeVersion("0.1.0");
  assert.equal(zero.level, "warn");
  assert.match(zero.detail, /unrecognized Node version "0\.1\.0"/);
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

// The PATH parameter defaults to `process.env.PATH ?? ""` — a PATH deleted from the
// environment entirely must hit the same empty-PATH fail as an explicitly empty one, not
// read `undefined` as a search path.
test("checkGitBinary and checkAgentBinary treat an unset PATH as empty", () => {
  const hadPath = process.env.PATH;
  delete process.env.PATH;
  try {
    assert.deepEqual(checkGitBinary(), { level: "fail", detail: GIT_MISSING_MESSAGE });
    const agent = checkAgentBinary(readyRepo());
    assert.equal(agent.level, "fail");
    assert.match(agent.detail, /install it/);
  } finally {
    if (hadPath !== undefined) process.env.PATH = hadPath;
  }
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
  writeMalformedJson(path.join(root, "tumwater.json"));
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
  writeMalformedJson(path.join(badJson, "tumwater.json"));
  assert.match(checkInit(badJson).detail, /not valid JSON/);

  const unknownKey = readyRepo();
  writeConfig(unknownKey, { bogusKey: 1 });
  const fail = checkInit(unknownKey);
  assert.equal(fail.level, "fail");
  assert.match(fail.detail, /unknown key "bogusKey" in tumwater\.json/);
});

test("checkBrief reports which file holds the managed sections, and warns when none does", () => {
  // No brief at all: a warn (a repo between clone and init is legitimate but blind).
  const bare = makeRepo();
  assert.deepEqual(checkBrief(bare), { level: "warn", detail: "no brief file — run `tumwater init <prompt>` to seed one" });

  // README.md without markers: warn, naming what is missing — this is what 7b's adopt path
  // fixes by writing TUMWATER.md instead.
  const readmeOnly = makeRepo();
  fs.writeFileSync(path.join(readmeOnly, "README.md"), "# mine\n");
  const readmeWarn = checkBrief(readmeOnly);
  assert.equal(readmeWarn.level, "warn");
  assert.match(readmeWarn.detail, /README\.md carries no tumwater:prompt markers/);

  // A marked README.md — the compatibility path every tumwater-created repo has — is ok.
  const marked = makeRepo();
  fs.writeFileSync(
    path.join(marked, "README.md"),
    `# p\n\n<!-- tumwater:prompt:start -->\nbrief\n<!-- tumwater:prompt:end -->\n`,
  );
  assert.deepEqual(checkBrief(marked), { level: "ok", detail: "brief in README.md" });

  // A marked TUMWATER.md outranks it: the resolution order is visible in the report.
  fs.writeFileSync(
    path.join(marked, "TUMWATER.md"),
    `# p\n\n<!-- tumwater:prompt:start -->\nbrief\n<!-- tumwater:prompt:end -->\n`,
  );
  assert.deepEqual(checkBrief(marked), { level: "ok", detail: "brief in TUMWATER.md" });
});

test("checkBrief reports a brief file that exists but cannot be read as a failure, not a crash", () => {
  // A directory at the README.md path makes existsSync true and readFileSync fail with
  // EISDIR, user-independently. briefFile throws (the message is readme.ts's, naming the
  // file and the fix), and the check must turn that throw into a fail outcome — a crashed
  // doctor would hide why every loop is about to run without its project brief.
  const dirReadme = makeRepo();
  fs.mkdirSync(path.join(dirReadme, "README.md"));
  const readmeFail = checkBrief(dirReadme);
  assert.equal(readmeFail.level, "fail");
  assert.match(readmeFail.detail, /cannot read the project brief "README\.md"/);
  assert.match(readmeFail.detail, /EISDIR/, "the underlying errno rides along");

  // The candidates are scanned TUMWATER.md first, and the failure names whichever one is
  // unreadable — a directory at the TUMWATER.md path (no README.md) reports that file.
  const dirTumwater = makeRepo();
  fs.mkdirSync(path.join(dirTumwater, "TUMWATER.md"));
  const tumwaterFail = checkBrief(dirTumwater);
  assert.equal(tumwaterFail.level, "fail");
  assert.match(tumwaterFail.detail, /cannot read the project brief "TUMWATER\.md"/);
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
        paid: { models: [{ id: "gpt-x", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 } }] },
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

  // A free local pair is the case the fallback exists for — but a price is not readiness: a
  // backend that rejects every prompt is priced at zero too (BUGS.md 2026-09-20), so the line
  // must not claim more than it checked.
  const free = readyRepo();
  writeConfig(free, { fallbackModel: { provider: "local", model: "free-model" } });
  assert.deepEqual(checkFallbackModel(free, models), {
    level: "ok",
    detail: "local/free-model — priced at zero (cost n/a), serving not verified",
  });
  // The running fleet's breaker demoted it (runDoctor passes orchestrator.json's
  // fallbackDemoted only while that orchestrator is alive): warn with the evidence and the retry.
  const probeAt = new Date(2026, 8, 19, 23, 10, 56).getTime();
  const demoted = checkFallbackModel(free, models, { pair: "local/free-model", failures: 3, probeAt });
  assert.equal(demoted.level, "warn");
  assert.match(demoted.detail, /^local\/free-model is priced at zero but not serving/);
  assert.match(demoted.detail, /demoted it after 3 consecutive failed ticks, so role loops pause at the cap/);
  assert.match(demoted.detail, /one probe tick retries it from 23:10:56$/);

  // A pair naming only one half falls through to pi's own default and can never be free —
  // the warning names the half-resolved pair instead of rendering a bare "?/model".
  const half = readyRepo();
  writeConfig(half, { fallbackModel: { model: "solo-model" } });
  const halfWarn = checkFallbackModel(half, models);
  assert.equal(halfWarn.level, "warn");
  assert.match(halfWarn.detail, /^a half-resolved pair is not priced at zero/);
  assert.match(halfWarn.detail, /role loops pause instead of switching/);

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
  if (runningAsRoot()) return;

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
    backdate(lockDir, 11 * 60 * 1000);
    assert.deepEqual(checkMergeLock(root), { level: "warn", detail: "stale — will be broken on next merge" });
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("checkBuildCheck names the declared script and walks up from a worktree to the installed root", () => {
  const none = checkBuildCheck(makeRepo());
  // The no-check case is a warn naming the consequence (plans/portability.md §6/7): the three
  // gates degrade to "no check" and a silently absent safety layer is what doctor must surface.
  assert.deepEqual(none, {
    level: "warn",
    detail: "none declared — the review gate's build pre-check, the red-main baseline, and redeploy's green check are all off (set `check.command` in tumwater.json for a non-npm repo)",
  });

  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "node_modules"));
  assert.deepEqual(checkBuildCheck(root), { level: "ok", detail: "npm test" });

  // The real worktree layout: the install lives at the repo root, three levels above the worktree.
  const wt = path.join(root, ".tumwater", "worktrees", "cov");
  fs.mkdirSync(wt, { recursive: true });
  assert.deepEqual(checkBuildCheck(wt), { level: "ok", detail: "npm test in ../../.." });

  // A configured command wins over npm detection and is named verbatim; its cwd (resolved
  // against the start dir) shows when it is not the root itself.
  const configured = makeRepo();
  fs.writeFileSync(path.join(configured, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(configured, "node_modules"));
  assert.deepEqual(checkBuildCheck(configured, { check: { command: "pytest -q" } }), {
    level: "ok",
    detail: "pytest -q",
  });
  assert.deepEqual(checkBuildCheck(configured, { check: { command: "pytest -q", cwd: "sub" } }), {
    level: "ok",
    detail: `pytest -q (cwd ${path.join("sub")})`,
  });
});

// Build provenance check (src/build/build-info.ts): does dist/ hold the code main describes? The
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
  // The foreign stamp is the harness install's own build — it must not read as this project's
  // dist/, which a non-harness project does not even have.
  assert.match(foreign.detail, /^harness build [0-9a-f]{8} /);
  assert.doesNotMatch(foreign.detail, /dist\//);

  const fresh = await checkBuild(repo, here, head);
  assert.equal(fresh.level, "ok");
  assert.match(fresh.detail, /matches main/);

  // A main head that cannot be resolved (git failed, or the caller had none) is not evidence
  // of staleness: the check stays ok and reports the build it did see.
  const noHead = await checkBuild(repo, here, null);
  assert.equal(noHead.level, "ok");
  assert.match(noHead.detail, /^dist\/ from [0-9a-f]{8}$/);

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
  writeMalformedJson(path.join(root, "tumwater.example.json"));
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

// --- checkTierModels (plans/model-tiers.md "Doctor", part 7c/8) ---

// Every pair the config can put on a seam is checked once: the `auth` stub records which
// providers were probed so a config naming the same provider through several surfaces
// (top-level tiers, a role override, the reviewer) probes it a single time.
test("checkTierModels verifies declared tier models and probes each provider once", async () => {
  const models = writeModels();
  const probed: string[] = [];
  const root = readyRepo();
  writeConfig(root, {
    model: { small: "local/free-model", default: "paid/gpt-x" },
    review: { enabled: true },
  });
  const outcome = await checkTierModels(root, models, async (p) => {
    probed.push(p);
    return "ready";
  });
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /2 declared models resolve/);
  assert.match(outcome.detail, /all providers local, paid report ready/);
  assert.deepEqual(probed.sort(), ["local", "paid"]);

  // A tier with no entry of its own resolves to default's model, and the reviewer with no
  // override runs there too — the same pair, checked once.

  // With no top-level model the seams all use pi's own default: nothing to check.
  const none = readyRepo();
  assert.deepEqual(await checkTierModels(none, models, async () => "ready"), {
    level: "ok",
    detail: "no models declared — every seam uses pi's own default",
  });
});

test("checkTierModels fails a pair pi cannot resolve and warns on an unready provider", async () => {
  const models = writeModels();

  // A typo'd model id fails: a strong tier pi cannot resolve would fail every review.
  const typoRoot = readyRepo();
  writeConfig(typoRoot, { model: "paid/no-such-model" });
  const typo = await checkTierModels(typoRoot, models, async () => "ready");
  assert.equal(typo.level, "fail");
  assert.match(typo.detail, /paid\/no-such-model does not resolve/);

  // A provider pi has never heard of fails too.
  const unknownRoot = readyRepo();
  writeConfig(unknownRoot, { model: "nowhere/mystery" });
  const unknownProvider = await checkTierModels(unknownRoot, models, async () => "ready");
  assert.equal(unknownProvider.level, "fail");
  assert.match(unknownProvider.detail, /provider nowhere is not in pi's definitions/);

  // Credentials are a separate question from resolution: a resolvable model on a provider
  // without credentials warns, so a config edit and a re-login are distinguishable.
  const authRoot = readyRepo();
  writeConfig(authRoot, { model: "paid/gpt-x" });
  const notReady = await checkTierModels(authRoot, models, async () => "not-ready");
  assert.equal(notReady.level, "warn");
  assert.match(notReady.detail, /provider paid reports not ready — check its credentials/);

  // A probe that could not run is unknown, never conflated with not-ready.
  const unknownAuth = await checkTierModels(authRoot, models, async () => "unknown");
  assert.equal(unknownAuth.level, "warn");
  assert.match(unknownAuth.detail, /could not verify provider paid/);

  // A role override naming a selector is one of the declared pairs.
  const roleRoot = readyRepo();
  writeConfig(roleRoot, { roles: { qa: { model: "paid/no-such-qa-model" } } });
  const roleModel = await checkTierModels(roleRoot, models, async () => "ready");
  assert.equal(roleModel.level, "fail");
  assert.match(roleModel.detail, /paid\/no-such-qa-model does not resolve/);
});

test("checkTierModels warns when a priced model's cache reads are declared free", async () => {
  const dir = tmpdir("doctor-models-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        local: { models: [{ id: "free-model" }] },
        paid: {
          models: [
            { id: "zero-cache", cost: { input: 0.15, output: 0.5, cacheRead: 0 } },
            { id: "missing-cache", cost: { input: 0.15, output: 0.5 } },
            { id: "priced-cache", cost: { input: 0.15, output: 0.5, cacheRead: 0.03 } },
          ],
        },
      },
    }),
  );

  // `cacheRead: 0` on a priced model means "billed free", not "unpriced": the daily budget
  // undercounts every cached prompt token (BUGS.md 2026-10-06), so the check warns.
  const zero = readyRepo();
  writeConfig(zero, { model: "paid/zero-cache" });
  const zeroOutcome = await checkTierModels(zero, file, async () => "ready");
  assert.equal(zeroOutcome.level, "warn");
  assert.match(zeroOutcome.detail, /paid\/zero-cache prices cache reads at \$0/);

  // An absent cacheRead field is the same hazard.
  const missing = readyRepo();
  writeConfig(missing, { model: "paid/missing-cache" });
  const missingOutcome = await checkTierModels(missing, file, async () => "ready");
  assert.equal(missingOutcome.level, "warn");
  assert.match(missingOutcome.detail, /paid\/missing-cache prices cache reads at \$0/);

  // A model that declares a cache price stays silent.
  const priced = readyRepo();
  writeConfig(priced, { model: "paid/priced-cache" });
  assert.equal((await checkTierModels(priced, file, async () => "ready")).level, "ok");

  // An unpriced model's real spend is zero, so its zero cache price undercounts nothing.
  const free = readyRepo();
  writeConfig(free, { model: "local/free-model" });
  assert.equal((await checkTierModels(free, file, async () => "ready")).level, "ok");
});

test("checkTierModels degrades to a warning when the definitions file is unreadable", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "paid/gpt-x" });
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent-models.json"), async () => "ready");
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /cannot check — could not read pi's model definitions/);
});

test("checkTierModels reports set PI_*_MODEL variables and points at the tier keys", async () => {
  const models = writeModels();
  const root = readyRepo();

  // Set: the note appends and the level warns (a warn never touches the exit code).
  const withVar = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "x" });
  assert.equal(withVar.level, "warn");
  assert.match(withVar.detail, /PI_SMOL_MODEL is set: tumwater does not read it/);
  assert.match(withVar.detail, /model\.small \/ model\.strong/);

  // Several at once are listed together.
  const withBoth = await checkTierModels(root, models, async () => "ready", {
    PI_SLOW_MODEL: "x",
    PI_PLAN_MODEL: "y",
  });
  assert.equal(withBoth.level, "warn");
  assert.match(withBoth.detail, /PI_SLOW_MODEL and PI_PLAN_MODEL are set: tumwater does not read them/);

  // Unset: no note anywhere.
  const without = await checkTierModels(root, models, async () => "ready", {});
  assert.equal(without.level, "ok");
  assert.ok(!without.detail.includes("PI_"), `no PI note when unset: ${without.detail}`);

  // A fail outranks the note's warn; the note still travels with the detail.
  writeConfig(root, { model: "paid/missing" });
  const failWithNote = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "x" });
  assert.equal(failWithNote.level, "fail");
  assert.match(failWithNote.detail, /does not resolve .*PI_SMOL_MODEL is set/);

  // The empty-string form counts as unset: an exported-but-empty variable is no signal.
  writeConfig(root, {}); // back to the clean config: no declared pairs, nothing to fail on
  const emptyVar = await checkTierModels(root, models, async () => "ready", { PI_SMOL_MODEL: "" });
  assert.equal(emptyVar.level, "ok");
});

test("checkTierModels cannot run on an invalid config and says so without failing", async () => {
  const root = readyRepo();
  writeConfig(root, { bogusKey: 1 });
  const outcome = await checkTierModels(root, path.join(tmpdir(), "absent.json"), async () => "ready");
  assert.equal(outcome.level, "warn");
  assert.match(outcome.detail, /cannot check — invalid tumwater\.json/);
});

// The default probe runs the resolved agent binary's own auth check; pinned against a fake
// pi on PATH (never a real model) for each verdict shape.
test("piProviderAuth reads ready out of the agent binary's auth check and never throws", async () => {
  const binDir = tmpdir("doctor-auth-bins-");
  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":true}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "ready");

  writeScript(path.join(binDir, "pi"), 'echo \'{"ready":false}\'');
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "not-ready");

  writeScript(path.join(binDir, "pi"), "echo not-json");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  writeScript(path.join(binDir, "pi"), "exit 3");
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", binDir), "unknown");

  // A binary that does not exist is unknown, not a thrown error.
  assert.equal(await piProviderAuth({} as TumwaterConfig, "local", tmpdir("doctor-empty-bins-")), "unknown");
});
