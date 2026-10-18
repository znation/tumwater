import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkAgentBinary,
  checkBootstrap,
  checkBrief,
  checkBuild,
  checkBuildCheck,
  checkDurationPhrase,
  checkClaudeTranscripts,
  checkDiskSpace,
  checkFunes,
  checkPiExtensions,
  diskReclaimPhrase,
  checkEventLog,
  checkFlakyChecks,
  checkGitBinary,
  checkInit,
  checkMergeLock,
  checkNodeVersion,
  checkOpencodeVersion,
  checkProviderConcurrency,
  checkProviderContention,
  checkRepo,
  checkStateDir,
  checkLeftoverRoleBranches,
  checkWorkInstances,
  checkWorktreePool,
} from "../src/doctor/doctor-checks.js";
import { GIT_MISSING_MESSAGE } from "../src/git/git-run.js";
import { initProject } from "../src/init/init.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { envPath } from "../src/files/files.js";
import { allRoleIds } from "../src/roles/roles.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { headSha, makeRepo, runningAsRoot, sh, tmpdir, twoPlansDoc, writeConfig, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { writeScript } from "./fakes/fake-commands.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { TUMWATER_SOURCE, logEvent, type HarnessEvent } from "../src/events/events.js";
import { writeSlotsState } from "../src/git/slots-state.js";
import { bootstrapLatchPath, slotWorktreePath, worktreesDir } from "../src/paths.js";
import { FLAKY_WARNING_PREFIX } from "../src/review/known-flakes.js";
import { backdate } from "./helpers/backdate.js";
import { withEnv } from "./helpers/env.js";
import { fakeBins, readyRepo } from "./fixtures/doctor-fixtures.js";
import { writeEvents, writeLogLines } from "./fixtures/log-fixtures.js";

// Unit coverage for the pre-flight environment and repo checks
// (src/doctor/doctor-checks.ts): every check's ok/fail/warn branches. The binary checks take an
// explicit PATH so the missing branch is exercised by passing "" — no PATH mutation, no
// spawning. Report composition, rendering, and the CLI wiring (`tumwater doctor` exit codes
// through main()) are pinned in test/doctor.test.ts; the model-readiness checks' own coverage
// lives in test/doctor-model-checks.test.ts, the orphan check's in
// test/doctor-orphans.test.ts, and the fixtures these files share live in
// test/fixtures/doctor-fixtures.ts and test/fixtures/repo-fixtures.ts.
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
  const ok = checkGitBinary(envPath());
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

// The PATH parameter defaults to `envPath()` (the process PATH, or "") — a PATH deleted
// from the environment entirely must hit the same empty-PATH fail as an explicitly empty
// one, not read `undefined` as a search path.
test("checkGitBinary and checkAgentBinary treat an unset PATH as empty", () => {
  withEnv("PATH", undefined, () => {
    assert.deepEqual(checkGitBinary(), { level: "fail", detail: GIT_MISSING_MESSAGE });
    const agent = checkAgentBinary(readyRepo());
    assert.equal(agent.level, "fail");
    assert.match(agent.detail, /install it/);
  });
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

// A claude-only team must not fail on a missing pi: the check follows the enabled seams'
// agents (the startup gate's agentsInUse), not always pi.
test("checkAgentBinary checks the enabled seams' agents, not always pi", () => {
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });

  const present = checkAgentBinary(root, fakeBins("claude"));
  assert.equal(present.level, "ok");
  assert.match(present.detail, /claude/);

  const missing = checkAgentBinary(root, "");
  assert.equal(missing.level, "fail");
  assert.match(missing.detail, /claude not found/);
});

test("checkAgentBinary joins each agent's verdict for a mixed pi and claude team", () => {
  const root = readyRepo();
  writeConfig(root, { agent: "claude", roles: { coverage: { model: "pi/some-model" } } });

  const both = checkAgentBinary(root, fakeBins("claude", "pi"));
  assert.equal(both.level, "ok");
  assert.match(both.detail, /^claude: .*claude; pi: .*pi$/);

  // One missing agent fails the whole check, naming that agent.
  const onlyClaude = checkAgentBinary(root, fakeBins("claude"));
  assert.equal(onlyClaude.level, "fail");
  assert.match(onlyClaude.detail, /pi not found/);
});

// A registered backend an enabled seam routes to that has no installed binary must fail: an
// opencode model with no `opencode` on PATH reads "opencode not found on PATH" rather than
// falling through to pi. The no-registered-adapter guard this test originally stood in for
// (a build with no adapter for a configured backend) now has no reachable trigger — pi,
// claude and opencode are all registered and no provider maps to any other id.
test("checkAgentBinary fails on a registered opencode seam with no installed binary, naming it", () => {
  const root = readyRepo();
  writeConfig(root, { model: "opencode/deepseek-v4.1-flash-free" });
  const out = checkAgentBinary(root, fakeBins("pi"));
  assert.equal(out.level, "fail");
  assert.match(
    out.detail,
    /opencode not found on PATH/,
  );
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

  // An empty config enables every catalog role but the opt-in selfcheck by default.
  const defaults = checkInit(readyRepo());
  const enabledByDefault = Object.values(defaultConfig().roles).filter((r) => r.enabled).length;
  assert.equal(enabledByDefault, allRoleIds().length - 1);
  assert.deepEqual(defaults, { level: "ok", detail: `${enabledByDefault} roles enabled` });

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
  // EISDIR, user-independently. briefFile throws (the message is brief.ts's, naming the
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

test("checkStateDir accepts an absent dir and proves writability without leaving a trace", () => {
  const root = makeRepo();
  assert.deepEqual(checkStateDir(root), { level: "ok", detail: "absent — created on first run" });

  const stateDir = path.join(root, ".tumwater");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "keep.txt"), "x\n");
  assert.deepEqual(checkStateDir(root), { level: "ok", detail: "writable" });
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ["keep.txt"], "the probe file is deleted again");
});

test("checkStateDir sweeps a stale probe a killed prior run left behind", () => {
  const root = makeRepo();
  const stateDir = path.join(root, ".tumwater");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "keep.txt"), "x\n");
  // A probe from a run killed between its write and delete: a pid no live process owns.
  fs.writeFileSync(path.join(stateDir, ".doctor-probe-99999"), "");

  const outcome = checkStateDir(root);

  assert.equal(outcome.level, "ok");
  assert.deepEqual(
    fs.readdirSync(stateDir).sort(),
    ["keep.txt"],
    "the stale probe is swept along with the fresh one",
  );
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

test("checkEventLog fails an events.jsonl whose permissions deny reading", { skip: runningAsRoot() }, () => {
  const root = makeRepo();
  writeEvents(root, [{ ts: Date.now(), loop: "feature", type: "run_end" }]);
  const log = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.chmodSync(log, 0o000);
  try {
    const out = checkEventLog(root);
    assert.equal(out.level, "fail");
    assert.match(out.detail, /^unreadable: .*events\.jsonl/);
  } finally {
    fs.chmodSync(log, 0o644);
  }
});

test("checkEventLog passes an absent log, fails an unreadable one, and passes a readable one", () => {
  const absent = makeRepo();
  assert.deepEqual(checkEventLog(absent), { level: "ok", detail: "no events yet" });

  const blank = makeRepo();
  writeEvents(blank, []);
  assert.equal(checkEventLog(blank).level, "ok", "a newline-only log is a young project, not damage");

  const empty = makeRepo();
  writeEvents(empty, []);
  fs.truncateSync(path.join(empty, ".tumwater", "log", "events.jsonl"), 0); // a genuinely zero-byte file
  assert.equal(checkEventLog(empty).level, "ok", "a zero-byte log is a young project, not damage");

  const corrupt = makeRepo();
  writeEvents(corrupt, ["{not json"]);
  const bad = checkEventLog(corrupt);
  assert.equal(bad.level, "fail");
  assert.match(bad.detail, /unreadable/);

  // The class of filesystem damage a crash can leave: a directory at the log path. A readable
  // rotated archive must not mask it — rotation is the steady state.
  const damaged = makeRepo();
  fs.mkdirSync(path.join(damaged, ".tumwater", "log", "events.jsonl"), { recursive: true });
  writeLogLines(path.join(damaged, ".tumwater", "log", "events.jsonl.1"), [
    { ts: Date.now(), loop: "feature", type: "run_end" },
  ]);
  assert.equal(checkEventLog(damaged).level, "fail");

  const good = makeRepo();
  writeEvents(good, [{ ts: Date.now(), loop: "feature", type: "run_end" }]);
  assert.equal(checkEventLog(good).level, "ok");
});

test("checkDiskSpace fails below the floor, warns in the reclaim band, passes above it, and warns when unmeasurable", () => {
  // plans/disk-floor.md parts 1/4 and 2/4: the check shares the gate's floor, so doctor and
  // the running team agree on when the disk is a problem, and warns while pressure reclaim
  // will run but new work still starts.
  const root = tmpdir("doctor-disk-");
  const below = checkDiskSpace(root, 10, 40, () => 9_000_000_000);
  assert.equal(below.level, "fail");
  assert.match(below.detail, /9\.0 GB free/);
  assert.match(below.detail, /10 GB diskHoldGB floor/);
  const reclaiming = checkDiskSpace(root, 10, 40, () => 20_000_000_000);
  assert.equal(reclaiming.level, "warn");
  assert.match(reclaiming.detail, /40 GB diskReclaimGB threshold/);
  assert.equal(checkDiskSpace(root, 10, 40, () => 50_000_000_000).level, "ok");
  assert.equal(
    checkDiskSpace(root, 0, 0, () => 1).level,
    "ok",
    "0 disables the hold and reclaim, so the check always passes",
  );
  const unmeasurable = checkDiskSpace(root, 10, 40, () => null);
  assert.equal(unmeasurable.level, "warn");
  assert.match(unmeasurable.detail, /cannot measure free space/);
});

test("diskReclaimPhrase sums freed space and counts pressure passes", () => {
  const pass = (mode: string, freedGB: unknown) =>
    ({ ts: Date.now(), source: "reclaim", type: "disk_reclaim", message: "", mode, freedGB }) as HarnessEvent;
  assert.equal(
    diskReclaimPhrase([pass("pressure", 4.0), pass("idle", 2.4), pass("pressure", 6.0), buildEvent({ durationMs: 1000 })]),
    "reclaim in the last 24h freed 12.4 GB over 3 passes, 2 under pressure",
  );
  assert.equal(diskReclaimPhrase([pass("idle", 2.4)]), "reclaim in the last 24h freed 2.4 GB over 1 pass");
  assert.equal(diskReclaimPhrase([]), undefined);
  assert.equal(
    diskReclaimPhrase([pass("idle", "lots")]),
    "reclaim in the last 24h freed 0.0 GB over 1 pass",
  );
});

test("checkDiskSpace appends the last 24h of reclaim passes", () => {
  const root = tmpdir("doctor-disk-reclaim-");
  logEvent(root, { source: "reclaim", type: "disk_reclaim", message: "p", mode: "pressure", freedGB: 3 } as never);
  logEvent(root, { ts: Date.now() - 48 * 3_600_000, source: "reclaim", type: "disk_reclaim", message: "old", mode: "pressure", freedGB: 50 } as never);
  const out = checkDiskSpace(root, 10, 40, () => 50_000_000_000);
  assert.equal(out.level, "ok");
  assert.match(out.detail, /· reclaim in the last 24h freed 3\.0 GB over 1 pass, 1 under pressure$/);
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
    assert.match(live.detail, new RegExp(`held by running role \\(pid ${process.pid}\\)`));

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
  const head = headSha(repo);
  const here = { sha: head, builtAt: 1, root: path.resolve(repo) };

  const unstamped = await checkBuild(repo, null);
  assert.equal(unstamped.level, "ok");
  assert.match(unstamped.detail, /no build stamp/);

  // A tumwater installed elsewhere and pointed at this project: its build is never stale here.
  const foreign = await checkBuild(repo, { ...here, root: "/somewhere/else" });
  assert.equal(foreign.level, "ok");
  assert.match(foreign.detail, /not tumwater itself/);
  // The foreign stamp is the harness install's own build — it must not read as this project's
  // dist/, which a non-harness project does not even have.
  assert.match(foreign.detail, /^tumwater version [0-9a-f]{8} /);
  assert.doesNotMatch(foreign.detail, /dist\//);

  const fresh = await checkBuild(repo, here, head);
  assert.equal(fresh.level, "ok");
  assert.match(fresh.detail, /matches main/);

  // A main head that cannot be resolved (git failed, or the caller had none) is not evidence
  // of staleness: the check stays ok and reports the build it did see.
  const noHead = await checkBuild(repo, here, null);
  assert.equal(noHead.level, "ok");
  assert.match(noHead.detail, /^dist\/ from [0-9a-f]{8}$/);

  // Two commits later, one touching src/: stale — a warning (the team runs, just old code),
  // never a fail.
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

  // With a team up, doctor reports what auto-restart is actually doing rather than the advice
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
    JSON.stringify({ minRunIntervalSeconds: 45, mergeBatchMax: 2 }),
  );
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const warn = checkInit(root);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /minRunIntervalSeconds, mergeBatchMax/);
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
  assert.equal(loadConfig(root).minRunIntervalSeconds, 45);
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
  fs.writeFileSync(path.join(root, "tumwater.example.json"), JSON.stringify({ noSuchKey: true, minRunIntervalSeconds: 45 }));
  const both = checkInit(root);
  assert.equal(both.level, "warn");
  assert.doesNotMatch(both.detail, /template drift/);

  // A valid template restores the ordinary paths: no warn, drift wording again.
  fs.writeFileSync(path.join(root, "tumwater.example.json"), JSON.stringify({ minRunIntervalSeconds: 45 }));
  const healthy = checkInit(root);
  assert.equal(healthy.level, "warn"); // drift reappears: tumwater.json lacks the key again
  assert.match(healthy.detail, /template drift/);
});

test("checkWorktreePool reports the pool, warns on a 25 h pin and on leftover legacy checkouts", () => {
  const root = readyRepo();
  assert.deepEqual(checkWorktreePool(root), { level: "ok", detail: "0 workspaces, 0 leased, 0 pinned" });

  const now = Date.now();
  // A stale pin — a paused role holding a checkout — is the doctor's stuck-pin warning.
  writeSlotsState(root, {
    slots: [
      {
        dir: slotWorktreePath(root, 1),
        lease: null,
        pinnedFor: "feature",
        pinnedAt: now - 25 * 3_600_000,
        lastRole: null,
        lastReleasedAt: null,
      },
    ],
  });
  const pinned = checkWorktreePool(root, now);
  assert.equal(pinned.level, "warn");
  assert.match(pinned.detail, /feature pinned on _slot-1 for 25h/);

  // A fresh pin is ordinary: ok.
  writeSlotsState(root, {
    slots: [
      {
        dir: slotWorktreePath(root, 1),
        lease: null,
        pinnedFor: "feature",
        pinnedAt: now - 1_000,
        lastRole: null,
        lastReleasedAt: null,
      },
    ],
  });
  assert.equal(checkWorktreePool(root, now).level, "ok");

  // A legacy per-role checkout and a `_land-*` checkout still present warn; the dedicated
  // director and `_slot-<n>` checkouts do not.
  fs.mkdirSync(path.join(worktreesDir(root), "clean"), { recursive: true });
  fs.mkdirSync(path.join(worktreesDir(root), "_land-feature"), { recursive: true });
  fs.mkdirSync(path.join(worktreesDir(root), "director"), { recursive: true });
  fs.mkdirSync(path.join(worktreesDir(root), "_slot-1"), { recursive: true });
  const leftover = checkWorktreePool(root, now);
  assert.equal(leftover.level, "warn");
  assert.match(leftover.detail, /legacy worktrees still present: .*clean/);
  assert.match(leftover.detail, /_land-feature/);
  assert.doesNotMatch(leftover.detail, /director/);
  assert.doesNotMatch(leftover.detail, /_slot-1/);
});

// Parallel work instances, part 6/7: the work-instance doctor check — ok with no claims,
// warns on a claim whose entry left the section, on one idle past the release window, and on
// instances sharing a pool smaller than maxConcurrent.
test("checkWorkInstances warns on a gone claim, a stale claim, and too few slots", () => {
  const root = readyRepo();
  assert.deepEqual(checkWorkInstances(root, loadConfig(root)), { level: "ok", detail: "no claimed plans or bugs" });

  // A listed PLANS.md entry, held for 25 h: stale past CLAIM_IDLE_MAX_MS.
  writeConfig(root, { roles: { feature: { instances: 2 } } });
  fs.writeFileSync(path.join(root, "PLANS.md"), twoPlansDoc());
  const now = Date.now();
  saveLoopState(root, {
    ...freshLoopState("feature-2"),
    claim: { file: "PLANS.md", key: "alpha", title: "Alpha", at: now - 25 * 3_600_000, source: "assigned" },
  });
  const stale = checkWorkInstances(root, loadConfig(root), now);
  assert.equal(stale.level, "warn");
  assert.match(stale.detail, /claimed plan "Alpha" \(feature-2\) has been idle 25h/);

  // A claim whose key is no longer listed under ## Planned.
  saveLoopState(root, {
    ...freshLoopState("feature-2"),
    claim: { file: "PLANS.md", key: "gone", title: "Gone", at: now, source: "assigned" },
  });
  assert.match(checkWorkInstances(root, loadConfig(root), now).detail, /claimed plan "Gone" \(feature-2\) names an entry no longer listed/);

  // A multi-instance feature with a pool below maxConcurrent.
  writeConfig(root, { roles: { feature: { instances: 2 } }, worktreeSlots: 1 });
  const tiny = checkWorkInstances(root, loadConfig(root), now);
  assert.match(tiny.detail, /worktreeSlots 1 is below maxConcurrent/);
});

test("checkWorkInstances names each claim by its file and counts plans and bugs apart", () => {
  const root = readyRepo();
  writeConfig(root, { roles: { feature: { instances: 2 }, bugfix: { instances: 2 } } });
  fs.writeFileSync(path.join(root, "PLANS.md"), twoPlansDoc());
  fs.writeFileSync(path.join(root, "BUGS.md"), "# Bugs\n\n## Open\n\n### An open bug\n\n## Fixed\n\n_None yet._\n");
  const now = Date.now();
  saveLoopState(root, {
    ...freshLoopState("feature-2"),
    claim: { file: "PLANS.md", key: "alpha", title: "Alpha", at: now, source: "assigned" },
  });
  const bugClaim = (at: number) =>
    saveLoopState(root, {
      ...freshLoopState("bugfix-2"),
      claim: { file: "BUGS.md", key: "an open bug", title: "An open bug", at, source: "assigned" },
    });
  bugClaim(now);
  assert.deepEqual(checkWorkInstances(root, loadConfig(root), now), { level: "ok", detail: "1 claimed plan, 1 claimed bug" });
  bugClaim(now - 25 * 3_600_000);
  assert.match(checkWorkInstances(root, loadConfig(root), now).detail, /claimed bug ".*" \(bugfix-2\) has been idle 25h/);
});

// A disabled role runs no instances, so its `instances` count cannot contend for the checkout
// pool: the work-instance check must stay silent for it rather than warn about a role that is
// not running.
test("checkWorkInstances does not warn about a disabled instance role's pool", () => {
  const root = readyRepo();
  writeConfig(root, { roles: { feature: { enabled: false, instances: 2 } }, worktreeSlots: 1 });
  assert.deepEqual(checkWorkInstances(root, loadConfig(root)), { level: "ok", detail: "no claimed plans or bugs" });
});

// Provider concurrency caps, part 5/5 (plans/provider-concurrency.md §8): the doctor check
// audits the maxConcurrentPerProvider map against the seams the config can actually spawn.
// A well-formed map whose key a seam resolves to is fine; a cap key no seam resolves to (a
// typo or an unused provider) and a cap at or above maxConcurrent (which never binds) both
// warn. A map-less config is fine — per-provider caps are optional.
test("checkProviderConcurrency passes a well-formed map whose key a seam resolves to", () => {
  // Every seam (each role, the director, the review gate) rides the default tier's omlx
  // provider, so the omlx cap names a provider the team actually runs on and no seam is
  // key-less: nothing to warn about.
  const cfg = {
    ...defaultConfig(),
    maxConcurrent: 4,
    model: { default: "omlx/m" },
    maxConcurrentPerProvider: { omlx: 3 },
  };
  const out = checkProviderConcurrency(cfg, readyRepo());
  assert.equal(out.level, "ok");
  assert.match(out.detail, /1 provider cap/);
});

test("checkProviderConcurrency warns on a cap key no seam resolves to", () => {
  // Every seam resolves to claude (the default tier's provider), so the omlx cap names a
  // provider nothing runs on: a typo or a provider not in use.
  const cfg = {
    ...defaultConfig(),
    maxConcurrent: 4,
    model: { default: "claude/m" },
    maxConcurrentPerProvider: { omlx: 3 },
  };
  const out = checkProviderConcurrency(cfg, readyRepo());
  assert.equal(out.level, "warn");
  assert.match(out.detail, /cap key \"omlx\" resolves to no model job/);
});

test("checkProviderConcurrency warns on a cap at or above maxConcurrent", () => {
  const cfg = {
    ...defaultConfig(),
    maxConcurrent: 3,
    model: { default: "omlx/m" },
    maxConcurrentPerProvider: { omlx: 3 },
  };
  const out = checkProviderConcurrency(cfg, readyRepo());
  assert.equal(out.level, "warn");
  assert.match(out.detail, /cap \"omlx\" 3 is at or above maxConcurrent 3/);
});

test("checkProviderConcurrency is fine without a per-provider map", () => {
  const out = checkProviderConcurrency(defaultConfig(), readyRepo());
  assert.equal(out.level, "ok");
  assert.match(out.detail, /no per-provider caps configured/);
});

// claude transcript disk (plans/agent-backends.md "Sessions" retention, part 4e/7): doctor
// reports the total size for a claude team and reads nothing for a pi-only one.
test("checkClaudeTranscripts totals the transcript dirs for a claude team", () => {
  const home = tmpdir("doctor-claude-home-");
  const projects = path.join(home, ".claude", "projects");
  fs.mkdirSync(path.join(projects, "-slot-one"), { recursive: true });
  fs.mkdirSync(path.join(projects, "-slot-two"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-slot-one", "a.jsonl"), "x".repeat(1500));
  fs.writeFileSync(path.join(projects, "-slot-two", "b.jsonl"), "y".repeat(500));

  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  const claudeConfig = loadConfig(root);
  const outcome = checkClaudeTranscripts(claudeConfig, home);
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /2\.0 KB across 2 projects/);

  // A pi-only team reads no claude state at all.
  writeConfig(root, {});
  assert.deepEqual(checkClaudeTranscripts(loadConfig(root), home), {
    level: "ok",
    detail: "no model jobs run on claude",
  });

  // A missing transcript dir is informational, not a warning.
  assert.match(
    checkClaudeTranscripts(claudeConfig, tmpdir("doctor-empty-home-")).detail,
    /no transcript dir/,
  );
});

test("checkClaudeTranscripts follows CLAUDE_CONFIG_DIR when it is set", () => {
  const home = tmpdir("doctor-claude-home-");
  const reloc = tmpdir("doctor-claude-reloc-");
  const projects = path.join(reloc, "projects");
  fs.mkdirSync(path.join(projects, "-slot"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-slot", "a.jsonl"), "x".repeat(1500));

  // The default `~/.claude` tree stays empty so a two-arg call must not pick it up.
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });

  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  const outcome = checkClaudeTranscripts(loadConfig(root), home, { CLAUDE_CONFIG_DIR: reloc });
  assert.equal(outcome.level, "ok");
  assert.match(outcome.detail, /^1\.5 KB across 1 project in /);
  assert.ok(outcome.detail.includes(reloc), "the relocated dir is named");

  // Without the env var the default `~/.claude` tree is read (empty here).
  assert.match(checkClaudeTranscripts(loadConfig(root), home).detail, /0 B across 0 projects in /);
});

test("checkPiExtensions names what a team run skips and stands down without a pi seam", () => {
  const home = tmpdir("doctor-pi-home-");
  fs.mkdirSync(path.join(home, ".pi", "agent", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "extensions", "my-tool.js"), "");
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "mcp.json"),
    JSON.stringify({ mcpServers: { funes: { command: "funes" }, aux: { command: "aux" } } }),
  );
  const root = readyRepo();
  // A model on pi makes the row appear.
  writeConfig(root, { model: "local/free-model" });
  const piCfg = loadConfig(root);
  const outcome = checkPiExtensions(piCfg, home, ""); // empty PATH: no `pi list` subprocess
  assert.equal(outcome?.level, "ok");
  assert.match(outcome!.detail, /mcp\.json servers: funes, aux/);
  assert.match(outcome!.detail, /\.pi\/agent\/extensions: my-tool\.js/);

  // No pi seam: the row is omitted entirely (doctor would not reach this host ~/.pi).
  writeConfig(root, { agent: "claude" });
  assert.equal(checkPiExtensions(loadConfig(root), home, ""), null);
});

test("checkPiExtensions keeps only source lines from `pi list` and shows for a default pi team", () => {
  const home = tmpdir("doctor-pi-home2-");
  // A `pi list` that is NOT line-per-package: each package is a two-space source line ("(filtered)"
  // marks a filtered source) optionally followed by its installed path at four spaces, under the
  // bold `User packages:` / `Project packages:` headers.
  const bins = tmpdir("doctor-pi-list-bins-");
  writeScript(path.join(bins, "pi"),
    [
      "echo 'User packages:'",
      "echo '  @goose/one (filtered)'",
      "echo '    /Users/zach/.pi/packages/@goose/one'",
      "echo '  locals'",
      "echo ''",
      "echo 'Project packages:'",
      "echo '  ops-tool'",
      "echo '    /work/.pi/agent/packages/ops-tool'",
      "exit 0",
    ].join("\n"),
  );
  const root = readyRepo();
  // A default pi team — no explicit model — is the feature's main scenario: the run routes to
  // pi and installs pi's own default model, so the row must appear rather than be silently
  // omitted because no model was declared in the config.
  const outcome = checkPiExtensions(loadConfig(root), home, bins);
  assert.equal(outcome?.level, "ok");
  assert.match(outcome!.detail, /packages: @goose\/one \(filtered\), locals, ops-tool/);
  // The headers and the installed paths are never mistaken for packages.
  assert.doesNotMatch(outcome!.detail, /User packages|Project packages|\.pi\/packages|agent\/packages/);
});

test("checkFunes warns for a Claude Code team without a config dir and is ok once one is set", () => {
  const home = tmpdir("doctor-funes-home-");
  fs.mkdirSync(path.join(home, ".funes", "integrations", "claude-plugin"), { recursive: true });
  const funesBin = fakeBins("funes");
  const root = readyRepo();

  // A Claude Code team with no backends.claude.configDir while funes's hook is installed.
  writeConfig(root, { agent: "claude" });
  const claudeCfg = loadConfig(root);
  const warn = checkFunes(claudeCfg, funesBin, home);
  assert.equal(warn?.level, "warn");
  assert.match(warn!.detail, /set backends\.claude\.configDir and log in there once/);

  // Once a team config dir is set, the row is ok (the hook can no longer index team runs).
  writeConfig(root, { agent: "claude", backends: { claude: { configDir: "/team/claude" } } });
  const ok = checkFunes(loadConfig(root), funesBin, home);
  assert.equal(ok?.level, "ok");
  assert.match(ok!.detail, /no team reach/);

  // No funes on PATH: the row is omitted entirely.
  assert.equal(checkFunes(claudeCfg, "", home), null);
});

test("checkClaudeTranscripts reports a sub-KB tree in plain bytes", () => {
  const home = tmpdir("doctor-claude-tiny-");
  const slug = path.join(home, ".claude", "projects", "-tiny");
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, "t.jsonl"), "x".repeat(100));
  const root = readyRepo();
  writeConfig(root, { agent: "claude" });
  assert.match(checkClaudeTranscripts(loadConfig(root), home).detail, /^100 B across 1 project in /);
});

test("checkClaudeTranscripts walks nested dirs, skips an unreadable one, and scales to MB", () => {
  const home = tmpdir("doctor-claude-nested-");
  const slug = path.join(home, ".claude", "projects", "-only-slot");
  fs.mkdirSync(path.join(slug, "sub", "deep"), { recursive: true });
  fs.writeFileSync(path.join(slug, "top.jsonl"), "x".repeat(1024 ** 2));
  fs.writeFileSync(path.join(slug, "sub", "deep", "d.jsonl"), "y".repeat(1024 ** 2 / 2));
  // A stray file beside the slug dirs is not a project.
  fs.writeFileSync(path.join(home, ".claude", "projects", "stray.txt"), "z");
  const locked = path.join(slug, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "hidden.jsonl"), "h".repeat(4096));
  const lockable = !runningAsRoot();
  if (lockable) fs.chmodSync(locked, 0o000);
  try {
    const root = readyRepo();
    writeConfig(root, { agent: "claude" });
    const outcome = checkClaudeTranscripts(loadConfig(root), home);
    assert.equal(outcome.level, "ok");
    assert.match(outcome.detail, /^1\.5 MB across 1 project in /);
  } finally {
    if (lockable) fs.chmodSync(locked, 0o755);
  }
});

// checkBootstrap is informational: it reports the gate's state without writing the latch.
test("checkBootstrap reports an active bootstrap, and stands down without config, entry, or with the latch", () => {
  const root = readyRepo();
  assert.deepEqual(checkBootstrap(root, undefined), { level: "ok", detail: "not bootstrapping" });

  writeConfig(root, {});
  assert.equal(checkBootstrap(root, loadConfig(root)).detail, "not bootstrapping");

  writeConfig(root, { bootstrap: { untilPlansDone: 3 } });
  const config = loadConfig(root);
  const active = checkBootstrap(root, config);
  assert.equal(active.level, "ok");
  assert.match(active.detail, /^bootstrapping: \d+\/3 plans done — plan, feature and director runs$/);

  fs.mkdirSync(path.dirname(bootstrapLatchPath(root)), { recursive: true });
  fs.writeFileSync(bootstrapLatchPath(root), "");
  assert.equal(checkBootstrap(root, config).detail, "not bootstrapping");
});

test("checkWorktreePool sums the last day of slot_wait events and warns at ten minutes", () => {
  const root = readyRepo();
  const wait = (role: string, purpose: string, waitedMs: number) =>
    logEvent(root, { source: TUMWATER_SOURCE, type: "slot_wait", message: "waited", role, purpose, waitedMs });
  wait("feature", "run", 45_000);
  wait("clean", "verify", 90_000);
  const quiet = checkWorktreePool(root);
  assert.equal(quiet.level, "ok");
  assert.match(quiet.detail, /2 waits to start in the last 24h, 2m total, longest 90s \(clean check\)/);

  wait("feature", "run", 600_000);
  const busy = checkWorktreePool(root);
  assert.equal(busy.level, "warn");
  assert.match(busy.detail, /raise worktreeSlots above 0/);

  const later = checkWorktreePool(root, Date.now() + 48 * 3_600_000);
  assert.equal(later.level, "ok");
  assert.doesNotMatch(later.detail, /wait to start/);
});

test("checkProviderContention sums the last day of provider_wait events and warns at ten minutes", () => {
  const root = readyRepo();
  const wait = (role: string, key: string | undefined, waitedMs: number) =>
    logEvent(root, { source: TUMWATER_SOURCE, type: "provider_wait", role, key, waitedMs });
  wait("feature", "omlx", 240_000);
  wait("clean", undefined, 60_000);
  const quiet = checkProviderContention(root, undefined);
  assert.equal(quiet.level, "ok");
  assert.match(quiet.detail, /2 waits for a provider slot in the last 24h, 5m total, longest 4m \(the omlx slot 4m, also the run cap 60s\)/);

  wait("feature", "omlx", 600_000);
  const cfg = { ...defaultConfig(), maxConcurrentPerProvider: { omlx: 2 } };
  const busy = checkProviderContention(root, cfg);
  assert.equal(busy.level, "warn");
  assert.match(busy.detail, /raise maxConcurrentPerProvider\.omlx above 2/);

  const later = checkProviderContention(root, cfg, Date.now() + 48 * 3_600_000);
  assert.equal(later.level, "ok");
  assert.equal(later.detail, "no provider waits");
});

test("checkProviderContention names every keyed provider that waited and its cap in rank order", () => {
  const root = readyRepo();
  const wait = (role: string, key: string | undefined, waitedMs: number) =>
    logEvent(root, { source: TUMWATER_SOURCE, type: "provider_wait", role, key, waitedMs });
  // omlx is busier but entered second; rank must still put it first and name both caps.
  wait("clean", "acme", 400_000);
  wait("feature", "omlx", 800_000);
  const cfg = { ...defaultConfig(), maxConcurrentPerProvider: { omlx: 2, acme: 1 } };
  const out = checkProviderContention(root, cfg);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /\(the omlx slot 13m, also the acme slot 7m\)/);
  assert.match(
    out.detail,
    /raise maxConcurrentPerProvider\.omlx above 2 and raise maxConcurrentPerProvider\.acme above 1/,
  );
});

test("checkProviderContention keeps single-bucket wording and skips advice for an uncapped key", () => {
  const root = readyRepo();
  const wait = (role: string, key: string | undefined, waitedMs: number) =>
    logEvent(root, { source: TUMWATER_SOURCE, type: "provider_wait", role, key, waitedMs });
  wait("feature", "omlx", 700_000);
  const single = checkProviderContention(root, { ...defaultConfig(), maxConcurrentPerProvider: { omlx: 2 } });
  assert.equal(single.level, "warn");
  assert.match(single.detail, /\(the omlx slot\)/);
  assert.doesNotMatch(single.detail, /also/);
  assert.match(single.detail, /raise maxConcurrentPerProvider\.omlx above 2/);

  const root2 = readyRepo();
  const wait2 = (role: string, key: string, waitedMs: number) =>
    logEvent(root2, { source: TUMWATER_SOURCE, type: "provider_wait", role, key, waitedMs });
  wait2("feature", "omlx", 700_000); // wait whose key has no configured cap
  const noCap = checkProviderContention(root2, { ...defaultConfig(), maxConcurrentPerProvider: {} });
  assert.equal(noCap.level, "warn");
  assert.match(noCap.detail, /\(the omlx slot\)/);
  assert.doesNotMatch(noCap.detail, /raise/);
});

test("checkFlakyChecks stays quiet for no flake and for a single one-off flake", () => {
  const quiet = readyRepo();
  assert.deepEqual(checkFlakyChecks(quiet), { level: "ok", detail: "no check flapped more than once in the last 24h" });

  const one = readyRepo();
  logEvent(one, { source: "review", type: "warning", message: `${FLAKY_WARNING_PREFIX}test failed on flaky network` });
  assert.deepEqual(checkFlakyChecks(one), { level: "ok", detail: "no check flapped more than once in the last 24h" });
});

test("checkFlakyChecks warns naming a check that flapped twice and aggregates across a duration difference", () => {
  const root = readyRepo();
  const flake = (headline: string) =>
    logEvent(root, { source: "review", type: "warning", message: `${FLAKY_WARNING_PREFIX}${headline}` });
  // Same normalized check, different durations: two firings must read as one check's count of 2.
  flake("test failed after 3s");
  flake("test failed after 9s");
  const out = checkFlakyChecks(root);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /flapped more than once in the last 24h: "test failed after <dur>" ×2/);
});

test("checkFlakyChecks warns naming both when two distinct checks flapped, most frequent first", () => {
  const root = readyRepo();
  const flake = (headline: string) =>
    logEvent(root, { source: "review", type: "warning", message: `${FLAKY_WARNING_PREFIX}${headline}` });
  flake("network test failed");
  flake("network test failed");
  flake("database test failed");
  flake("database test failed");
  flake("database test failed");
  const out = checkFlakyChecks(root);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /checks flapped more than once in the last 24h: "database test failed" ×3 \(and 1 more: "network test failed" ×2\)/);
});

test("checkFlakyChecks ignores flake warnings older than the window", () => {
  const root = readyRepo();
  // An old event outside the 24h window, stamped directly with writeEvents so its ts is ancient.
  writeEvents(root, [
    { ts: Date.now() - 48 * 3_600_000, loop: "review", type: "warning", message: `${FLAKY_WARNING_PREFIX}old test failed` },
  ]);
  assert.deepEqual(checkFlakyChecks(root), { level: "ok", detail: "no check flapped more than once in the last 24h" });
});

test("checkLeftoverRoleBranches names disabled roles' branches and unknown ones, skipping enabled roles and the director", async () => {
  const root = readyRepo();
  const ok = { level: "ok", detail: "no branches left by disabled roles" };
  assert.deepEqual(await checkLeftoverRoleBranches(root, loadConfig(root)), ok);
  sh(root, "git", "branch", "tumwater/feature");
  sh(root, "git", "branch", "tumwater/director");
  assert.deepEqual(await checkLeftoverRoleBranches(root, loadConfig(root)), ok);
  sh(root, "git", "branch", "tumwater/selfcheck");
  const warn = await checkLeftoverRoleBranches(root, loadConfig(root));
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /selfcheck is disabled but still has a branch — `tumwater retire --role <id>`/);
  assert.doesNotMatch(warn.detail, /feature|director/);
  sh(root, "git", "branch", "tumwater/ghost");
  const ghost = await checkLeftoverRoleBranches(root, loadConfig(root));
  assert.match(ghost.detail, /(selfcheck, ghost|ghost, selfcheck) are disabled but still have a branch/);
  sh(root, "git", "branch", "tumwater/old.role");
  assert.match((await checkLeftoverRoleBranches(root, loadConfig(root))).detail, /; tumwater\/old\.role names no role retire accepts/);
  sh(root, "git", "branch", "tumwater/feature-2");
  writeConfig(root, { roles: { feature: { instances: 2 } } });
  assert.doesNotMatch((await checkLeftoverRoleBranches(root, loadConfig(root))).detail, /feature-2/);
  writeConfig(root, {});
  assert.match((await checkLeftoverRoleBranches(root, loadConfig(root))).detail, /feature-2/);
  assert.deepEqual(await checkLeftoverRoleBranches(root, null), { level: "ok", detail: "no readable tumwater.json — nothing to verify" });
});

const buildEvent = (fields: Record<string, unknown>): HarnessEvent =>
  ({ ts: Date.now(), source: "merge", type: "build_check", status: "passed", scope: "merge", durationMs: 1000, ...fields }) as HarnessEvent;

test("checkDurationPhrase reports the lower median and slowest of passing full-suite runs", () => {
  assert.equal(
    checkDurationPhrase([
      buildEvent({ scope: "merge", durationMs: 60_000 }),
      buildEvent({ scope: "batch", durationMs: 125_000 }),
      buildEvent({ scope: "baseline", durationMs: 90_000 }),
    ]),
    "passing merge checks in the last 24h took 90s median, 2m slowest (3 runs)",
  );
  assert.match(
    checkDurationPhrase([buildEvent({ durationMs: 40_000 }), buildEvent({ durationMs: 100_000 })])!,
    /took 40s median, 100s slowest \(2 runs\)/,
  );
});

test("checkDurationPhrase skips gate, failed, untimed, and non-check events", () => {
  assert.equal(
    checkDurationPhrase([
      buildEvent({ scope: "gate" }),
      buildEvent({ status: "failed" }),
      buildEvent({ durationMs: undefined }),
      buildEvent({ type: "warning" }),
    ]),
    undefined,
  );
});

test("checkBuildCheck appends the passing merge check timing from the last 24h", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "node_modules"));
  for (const durationMs of [30_000, 50_000])
    logEvent(root, { source: "merge", type: "build_check", scope: "merge", status: "passed", script: "test", durationMs });
  const out = checkBuildCheck(root);
  assert.equal(out.level, "ok");
  assert.match(out.detail, /^npm test · passing merge checks in the last 24h took .*\(2 runs\)$/);
});

// --- OpenCode version readiness (part 7/7) --------------------------------------------------
// The team targets OpenCode V2 at 2.0.32 (the H1-verified version). checkOpencodeVersion fails
// an older CLI — a 1.x binary included — naming the install command, and stands down without an
// opencode seam.
test("checkOpencodeVersion fails a 1.x or too-old opencode and passes at the floor", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "opencode/deepseek-v4.1-flash-free" });
  const bin = tmpdir("doctor-opencode-version-");

  writeScript(path.join(bin, "opencode"), 'echo "opencode v1.19.3"');
  const v1 = await checkOpencodeVersion(root, bin);
  assert.equal(v1.level, "fail");
  assert.match(v1.detail, /opencode 1\.19\.3 is older than 2\.0\.32 — run `brew install opencode`/);

  writeScript(path.join(bin, "opencode"), 'echo "opencode v2.0.31"');
  const old = await checkOpencodeVersion(root, bin);
  assert.equal(old.level, "fail");
  assert.match(old.detail, /is older than 2\.0\.32/);

  writeScript(path.join(bin, "opencode"), 'echo "opencode v2.0.32"');
  const ok = await checkOpencodeVersion(root, bin);
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, /opencode 2\.0\.32 \(>= 2\.0\.32\)/);

  writeScript(path.join(bin, "opencode"), "exit 3");
  const unreadable = await checkOpencodeVersion(root, bin);
  assert.equal(unreadable.level, "warn");
  assert.match(unreadable.detail, /could not check/);
});

test("checkOpencodeVersion stands down without an opencode seam", async () => {
  const root = readyRepo();
  writeConfig(root, { model: "local/free-model" });
  assert.deepEqual(await checkOpencodeVersion(root, fakeBins("pi")), {
    level: "ok",
    detail: "no model jobs run on opencode",
  });
});
