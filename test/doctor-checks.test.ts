import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkAgentBinary,
  checkBacklogHeadings,
  checkBrief,
  checkBuild,
  checkBuildCheck,
  checkFallbackModel,
  checkFixClaims,
  checkGitBinary,
  checkInit,
  checkMergeLock,
  checkNodeVersion,
  checkRepo,
  checkStateDir,
  checkStrandedPlans,
} from "../src/doctor-checks.js";
import { GIT_MISSING_MESSAGE } from "../src/git.js";
import { initProject } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { allRoleIds } from "../src/roles.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import { makeRepo, runningAsRoot, sh, tmpdir, writeConfig, writeMalformedJson } from "./repo-fixtures.js";
import { vanishOnReadFile } from "./fs-faults.js";
import { fakeBins, readyRepo } from "./doctor-fixtures.js";

// Unit coverage for the pre-flight environment checks (src/doctor-checks.ts): every check's
// ok/fail/warn branches. The binary checks take an explicit PATH so the missing branch is
// exercised by passing "" — no PATH mutation, no spawning. Report composition, rendering, and
// the CLI wiring (`tumwater doctor` exit codes through main()) are pinned in
// test/doctor.test.ts; the orphan check's own unit coverage lives in test/doctor-orphans.test.ts
// (it pins src/doctor-orphans.ts), and the fixtures the three files share live in
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
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lockDir, elevenMinutesAgo, elevenMinutesAgo);
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
  // The foreign stamp is the harness install's own build — it must not read as this project's
  // dist/, which a non-harness project does not even have.
  assert.match(foreign.detail, /^harness build [0-9a-f]{8} /);
  assert.doesNotMatch(foreign.detail, /dist\//);

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

// checkFixClaims — the standalone false-fix detector: the newest Fixed records of BUGS.md are
// re-verified against the tree with src/fix-claim.ts's parsing (the document shapes below
// follow test/fix-claim.test.ts). A record warns only when every symbol its Fix paragraph
// names is absent; the gate-strength rule (any missing symbol) belongs to md-only landings.

/** A fixture tree whose code defines `liveSymbol`, plus a BUGS.md whose Fixed section holds
 * one entry per given Fix paragraph, newest first (the template convention). */
function fixClaimsRepo(fixes: string[]): string {
  const root = tmpdir("doctor-fix-claims-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export function liveSymbol() {}\n");
  const entries = fixes.map(
    (fix, i) => `### Entry ${i}: details (found by qa 2026-09-20, fixed 2026-09-21)\n\n**Symptom:** it broke.\n\n**Fix:** ${fix}\n`,
  );
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    `# Bugs\n\n## Open\n\n### Still broken (found by qa 2026-09-22)\n\n**Fix:** \`openOnlyPhantom\` someday.\n\n## Fixed\n\n${entries.join("\n")}`,
  );
  return root;
}

test("checkFixClaims reads ok for a record whose symbols exist — one live symbol is enough", () => {
  const r = checkFixClaims(fixClaimsRepo(["`liveSymbol()` now does it.", "`liveSymbol` and `renamedSinceThen` both changed."]));
  assert.equal(r.level, "ok", r.detail);
  assert.match(r.detail, /newest 2 Fixed record/);
});

test("checkFixClaims warns naming the heading and missing symbols of a record whose symbols are all absent", () => {
  const root = fixClaimsRepo([
    "`liveSymbol` is real.",
    "`runScriptGroup` now signals via `signalTree` in `src/build-check.ts`, bounded by `killAfter`.",
    "`anotherPhantom` landed.",
  ]);
  const r = checkFixClaims(root);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /"Entry 1: details \(found by qa 2026-09-20, fixed 2026-09-21\)" as Fixed/);
  // Up to three names, falseFixReason's shape — the fourth is elided.
  assert.ok(r.detail.includes("runScriptGroup, signalTree, src/build-check.ts…"), r.detail);
  assert.ok(!r.detail.includes("killAfter"), r.detail);
  // A second suspect is still named, so fixing the first does not hide it.
  assert.match(r.detail, /and 1 more record\(s\): "Entry 2:/);
  assert.match(r.detail, /land the fix or keep the bug Open \/ refresh a stale record/);
  // Open entries are never verified — an Open bug has no fix to back.
  assert.ok(!r.detail.includes("openOnlyPhantom"), r.detail);
});

test("checkFixClaims verifies only the newest 10 Fixed records", () => {
  const live = Array.from({ length: 10 }, () => "`liveSymbol` fixed it.");
  const old = checkFixClaims(fixClaimsRepo([...live, "`longRenamedSymbol` fixed it."]));
  assert.equal(old.level, "ok", "a stale 11th record is outside the window");
  assert.match(old.detail, /newest 10 Fixed record/);
  const recent = checkFixClaims(fixClaimsRepo(["`longRenamedSymbol` fixed it.", ...live]));
  assert.equal(recent.level, "warn", "the same record as the newest is inside it");
  assert.match(recent.detail, /longRenamedSymbol/);
});

test("checkFixClaims reads ok with no BUGS.md and for a record naming no symbols", () => {
  assert.deepEqual(checkFixClaims(tmpdir("doctor-fix-claims-")), {
    level: "ok",
    detail: "no BUGS.md — nothing to verify",
  });
  // Pure-documentation fixes are legitimate: spans with whitespace are not symbols either.
  const r = checkFixClaims(fixClaimsRepo(["documented the behavior; `npm test` covers it."]));
  assert.equal(r.level, "ok", r.detail);
});

test("checkFixClaims warns instead of throwing when BUGS.md vanishes between the stat and the read", () => {
  // existsSync passes, then the file is gone when readFileSync lands — the rotation/race
  // tail the catch exists for (fs-faults.ts's vanishOnReadFile is that race, made
  // deterministic). Without the catch the check throws and takes the whole doctor run down.
  const root = fixClaimsRepo(["`liveSymbol` fixed it."]);
  const bugsPath = path.join(root, "BUGS.md");
  const undo = vanishOnReadFile(bugsPath);
  try {
    const r = checkFixClaims(root);
    assert.equal(r.level, "warn");
    assert.match(r.detail, /cannot read BUGS\.md — ENOENT/);
    assert.ok(!fs.existsSync(bugsPath), "the fault consumed the file");
  } finally {
    undo();
  }
});

// checkStrandedPlans — the stranded-plan detector surfaced for the operator (plans part 3/4):
// plan headings filed under the wrong PLANS.md section warn, naming the heading and section.

test("checkStrandedPlans warns naming a stranded heading and stays silent on a clean file", () => {
  const dir = tmpdir("doctor-stranded-");
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Timed pause support (planned 2026-09-25)\n`,
  );
  const warn = checkStrandedPlans(dir);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /stranded under ## Done: "Timed pause support \(planned 2026-09-25\)"/);
  assert.match(warn.detail, /move it under ## Planned/);

  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Landed (planned 2026-09-10, done 2026-09-11)\n`,
  );
  assert.deepEqual(checkStrandedPlans(dir), {
    level: "ok",
    detail: "no plan headings filed under the wrong PLANS.md section",
  });

  // No PLANS.md at all is a fine state too — nothing to verify.
  assert.deepEqual(checkStrandedPlans(tmpdir("doctor-stranded-none-")), {
    level: "ok",
    detail: "no PLANS.md — nothing to verify",
  });
});

test("checkStrandedPlans warns instead of throwing when PLANS.md cannot be read", () => {
  // A directory where the file belongs: existsSync passes, readFileSync lands EISDIR — the
  // class of filesystem damage a stray tool leaves behind. Without the catch the check
  // throws and takes the whole doctor run down; the contract is a warn, never a fail
  // (checkFixClaims's vanish-on-read twin above pins the same policy for BUGS.md).
  const dir = tmpdir("doctor-stranded-unreadable-");
  fs.mkdirSync(path.join(dir, "PLANS.md"));
  const r = checkStrandedPlans(dir);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /^cannot read PLANS\.md — /);
});

// checkBacklogHeadings — the duplicate-heading half of the backlog-structure check surfaced
// for the operator (plans part 2/4): a `## ` heading already duplicated on main warns, naming
// the file and heading, so existing damage is visible. The wording must not overstate the
// gate: rule (a) fires only when a landing ADDS another copy (count exceeds the merge-base's),
// so a pre-existing duplicate is not blocked away by just any next edit.

test("checkBacklogHeadings warns on a duplicated heading and stays silent on a clean set", () => {
  const dir = tmpdir("doctor-headings-");
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "## Done\n\n### A\n\n## Done\n\n### B\n\n## Planned\n\n_None yet._\n",
  );
  const warn = checkBacklogHeadings(dir);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /PLANS\.md "## Done"/);
  assert.match(warn.detail, /appears more than once/);
  // The claim about the gate stays accurate: only an adding landing is blocked, so the
  // message tells the operator to remove the duplicate deliberately.
  assert.match(warn.detail, /blocks only a landing that adds another copy/);
  assert.doesNotMatch(warn.detail, /blocks the next edit/);

  // Clean across all three backlog files: ok, one line.
  fs.writeFileSync(path.join(dir, "PLANS.md"), "## Planned\n\n_None yet._\n\n## Done\n\n### A\n");
  fs.writeFileSync(path.join(dir, "BUGS.md"), "## Open\n\n## Fixed\n\n## Verified\n");
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"), "## Open\n");
  assert.deepEqual(checkBacklogHeadings(dir), {
    level: "ok",
    detail: "no duplicated ## section headings in the backlog files",
  });

  // Absent files contribute nothing; a fenced duplicate is quoted content, not structure.
  fs.rmSync(path.join(dir, "BUGS.md"));
  fs.rmSync(path.join(dir, "QUESTIONS.md"));
  fs.writeFileSync(path.join(dir, "PLANS.md"), "## Planned\n\n```md\n## Done\n## Done\n```\n");
  assert.equal(checkBacklogHeadings(dir).level, "ok");
});

test("checkBacklogHeadings names an unreadable backlog file and still scans the readable ones", () => {
  // A directory where the file belongs: existsSync passes, readFileSync throws EISDIR. The
  // unreadable file is reported, not swallowed — its duplicate headings (if any) are now
  // invisible to every reader — and the scan continues, so one damaged file cannot mask
  // the damage in the readable ones.
  const dir = tmpdir("doctor-headings-unreadable-");
  fs.mkdirSync(path.join(dir, "PLANS.md"));
  fs.writeFileSync(path.join(dir, "BUGS.md"), "## Open\n\n## Open\n\n## Fixed\n");
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"), "## Open\n");
  const r = checkBacklogHeadings(dir);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /PLANS\.md \(unreadable\)/);
  assert.match(r.detail, /BUGS\.md "## Open"/);
});
