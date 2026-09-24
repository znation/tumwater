import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildCheckSkipWarning,
  clipBuildTail,
  failureHeadline,
  runBuildCheck,
  runScopedBuildCheck,
} from "../src/build-check.js";
import { detectBuildCheck, resolveFromNodeModules } from "../src/build-check-detect.js";
import { readEvents } from "../src/events.js";
import { pidAlive } from "../src/process.js";
import { buildCheckFixture, sh, tmpdir } from "./util.js";

/** True while any process in the group `pgid` exists — a signal-0 send to the whole group. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll `cond` every 10 ms for at most `ms` (performance.now, so a test that mocks Date can
 * still bound its wait). */
async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = performance.now() + ms;
  while (!cond() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

/** A pid/pgid a fixture command wrote to `file` (0 when it never did). */
function readPid(file: string): number {
  return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) : 0;
}

// Unit coverage for the deterministic build pre-check (src/build-check.ts): detection by
// walk-up to the installed root and execution/outcome classification. The gate's integration
// with this check (a healthy build reaching the reviewer) is covered in review.test.ts, where
// it belongs — that test drives reviewAheadOfMain end-to-end.

const ROLE = "improve";

test("runBuildCheck resolves the toolchain from the installed root when the worktree has no node_modules", async () => {
  const { root, wt } = buildCheckFixture();
  // Pre-fix this was `sh: buildcheck-tool: command not found` (exit 127) — a deterministic
  // rejection of every code change in any JS project (BUGS.md).
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "passed");
});

test("runBuildCheck still classifies a genuinely failing build as failed with the output tail", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --fail" } }),
  );
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  fs.writeFileSync(
    tool,
    "#!/bin/sh\n[ \"$1\" = \"--ok\" ] && echo ok || { echo type error TS9999: boom; exit 1; }\n",
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "failed");
  assert.ok((outcome.outputTail ?? []).some((l) => l.includes("TS9999")));
});

test("runBuildCheck skips (not fails closed) when the script times out", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "sleep 5" } }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 400);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "timeout");
});

// A check that dies on a signal the harness did not send (another run's pkill, an operator's
// cleanup) must not be reported as a timeout: the 2026-09-23 gate incident logged "timed out
// after 300s" for a check killed by pkill at 7.4s and sent the change to review unverified.
// npm re-raises a script child's signal death, so the group leader itself closes with the
// signal — no timeout has fired, and the classification is a distinct "killed" skip naming it.
test("a check killed by an external signal is skipped as killed, naming the signal (regression)", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "kill -9 $$" } }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "test" }, 30_000);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "killed");
  assert.equal(outcome.killedBy, "SIGKILL");
});

// A timed-out check must take its whole process tree with it. npm runs detached as its own
// process group leader; the old execFileAsync `timeout` signalled npm alone, so everything
// below it survived and reparented to PID 1 — four orphaned trees on the fleet, one alive 12
// days, one running a real orchestrator for 18 hours (BUGS.md 2026-09-21). The runner here
// backgrounds a grandchild that TRAPS SIGTERM — only the SIGKILL escalation can stop it — so
// the test pins both the group signal and the escalation armed on timeout. Mirrors
// test/pi.test.ts's "a killed run leaves no grandchild behind".
test("a timed-out build check takes its process tree with it (regression)", async () => {
  const { root, wt } = buildCheckFixture();
  const pidFile = path.join(wt, "grandchild.pid");
  fs.writeFileSync(
    path.join(wt, "runner.mjs"),
    [
      'import fs from "node:fs";',
      'import { spawn } from "node:child_process";',
      `const pidFile = ${JSON.stringify(pidFile)};`,
      `const script = "process.on('SIGTERM', () => {}); " +`,
      `  "require('fs').writeFileSync('${pidFile}', String(process.pid)); " +`,
      '  "setTimeout(() => {}, 60_000)";',
      'spawn(process.execPath, ["-e", script], { stdio: "ignore" });',
      "const deadline = Date.now() + 10_000;",
      "while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));",
      "if (!fs.existsSync(pidFile)) process.exit(3);",
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "node runner.mjs" } }),
  );
  let pid = 0;
  try {
    // 4s budget, 700ms SIGKILL grace: the grandchild traps SIGTERM, so it must be gone
    // shortly after the grace expires — and only via the escalation. The budget must cover
    // the whole startup chain (npm boot → runner boot → the grandchild's own node boot)
    // BEFORE the group SIGTERM fires: at 600ms a load-sensitive run (the suite's per-file
    // node --test workers, the orchestrator itself) let SIGTERM land mid-grandchild-startup,
    // which died by default action before trapping or writing its pid — the test then died
    // reading a pid file that never existed and falsely reddened main at 03edeba6 (BUGS.md
    // 2026-09-24). test/pi.test.ts hit and fixed this same startup race once already.
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "test" }, 4_000, 700);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "timeout");
    // The check settles only once its tree is gone, so a pid the grandchild wrote is already on
    // disk; the bounded wait just keeps a slow filesystem from failing the read.
    const pidDeadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < pidDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(pidFile), "the grandchild recorded its pid before the timeout");
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0, "the grandchild recorded its pid before the timeout");
    // The SIGKILL lands before the check settles, but launchd reaps the orphan asynchronously:
    // poll until it is gone (or the assertion below fails on the leak this test pins).
    const deadline = Date.now() + 5_000;
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(pidAlive(pid), false, "the timed-out check's grandchild is gone after the SIGKILL grace");
  } finally {
    // A failure above must not leave the SIGTERM-trapping process behind.
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone — the fix working is exactly this case.
      }
    }
  }
});

// The SIGKILL escalation is armed WHEN THE TIMEOUT FIRES, never at spawn: a timer armed at
// spawn SIGKILLed every healthy check still running at killGraceMs and misclassified it as a
// timeout — which, at a merge scope (landing/batch), is a deterministic reject of a green
// tree (the 2026-09-22 review-gate catch on this fix's first draft).
test("a healthy check that outlasts the SIGKILL grace is not mistaken for a timeout", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "sleep 2" } }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "test" }, 30_000, 500);
  assert.equal(outcome.status, "passed");
});

// BUGS.md 2026-09-21 (the 300 s timeout that did not bound the check): a timed-out check
// settles within its deadline plus the SIGKILL grace whatever its tree does, and the tree is
// gone when it settles — no teardown left running behind the caller's retry or next check.
// Pre-fix the check resolved AT the deadline with the SIGKILL still pending in the background.
// `trap '' TERM` in the group-leading shell is inherited as ignored by the backgrounded sleep,
// which also holds the check's stdout/stderr: neither the SIGTERM nor a close can end this
// run, only the SIGKILL at the grace.
test("a timed-out check whose tree ignores SIGTERM and holds its pipes settles at deadline + grace with the group gone (regression)", async () => {
  const wt = tmpdir();
  const command = "trap '' TERM; echo $$ > pgid; sleep 30 & echo $! > sleep.pid; wait";
  let pgid = 0;
  try {
    const started = performance.now();
    const outcome = await runBuildCheck(wt, { kind: "command", command, cwd: wt, timeoutMs: 1_000 }, 30_000, 800);
    const elapsed = performance.now() - started;
    pgid = readPid(path.join(wt, "pgid"));
    const sleepPid = readPid(path.join(wt, "sleep.pid"));
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "timeout");
    assert.ok(pgid > 0 && sleepPid > 0, "the fixture's tree started before the deadline");
    const ran = outcome.run!.settledAt - outcome.run!.spawnedAt;
    assert.ok(ran >= 1_700, `the tree outlived the SIGTERM, so the check waited for the SIGKILL (ran ${ran}ms)`);
    assert.ok(elapsed < 1_800 + 2_500, `bounded at deadline + grace (settled after ${Math.round(elapsed)}ms)`);
    // SIGKILLed before the check settled; launchd reaps the orphan a moment later. Pre-fix
    // the SIGKILL was still ~800 ms away here, so this window cannot hide the leak.
    await until(() => !groupAlive(pgid), 300);
    assert.equal(groupAlive(pgid), false, "nothing in the check's process group survives it");
    assert.equal(pidAlive(sleepPid), false, "the SIGTERM-ignoring pipe holder is dead");
  } finally {
    if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

// The leader's close is not the tree's death: a grandchild that ignores SIGTERM and holds none
// of the check's pipes survives the close, and settling on that close would cancel the SIGKILL
// it still needs. The run settles only once the whole group is gone.
test("a timed-out check does not settle on its leader's close while a grandchild survives", async () => {
  const wt = tmpdir();
  const command =
    "(trap '' TERM; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > sleep.pid; echo $$ > pgid; sleep 30";
  let pgid = 0;
  try {
    const outcome = await runBuildCheck(wt, { kind: "command", command, cwd: wt, timeoutMs: 1_000 }, 30_000, 800);
    pgid = readPid(path.join(wt, "pgid"));
    const sleepPid = readPid(path.join(wt, "sleep.pid"));
    assert.equal(outcome.skipReason, "timeout");
    assert.ok(pgid > 0 && sleepPid > 0, "the fixture's tree started before the deadline");
    await until(() => !pidAlive(sleepPid), 300);
    assert.equal(pidAlive(sleepPid), false, "the surviving grandchild was SIGKILLed before the check settled");
  } finally {
    if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

// The other half of the bound: a tree the SIGTERM takes down does not wait out the grace, so
// the common timeout costs the deadline and not the deadline plus ten seconds.
test("a timed-out check whose tree dies on SIGTERM settles right after the deadline, not after the grace", async () => {
  const wt = tmpdir();
  const started = performance.now();
  const outcome = await runBuildCheck(
    wt,
    { kind: "command", command: "echo $$ > pgid; sleep 30", cwd: wt, timeoutMs: 1_000 },
    30_000,
    5_000,
  );
  const elapsed = performance.now() - started;
  const pgid = readPid(path.join(wt, "pgid"));
  assert.equal(outcome.skipReason, "timeout");
  assert.ok(elapsed < 1_000 + 2_500, `settled ${Math.round(elapsed)}ms after the call, not after the 5 s grace`);
  assert.ok(pgid > 0 && !groupAlive(pgid), "the group was already gone when the check settled");
});

// The measured cause of BUGS.md 2026-09-21: the host slept through the deadline. libuv's clock
// on macOS counts sleep, so the timer fires at the first wake — minutes past the bound, often
// after seconds of real work — and the warning still said "timed out after 300s". A Date-only
// mock makes the wall clock jump the way it does across that sleep while the real timer keeps
// its schedule; the run must report when its deadline really fired, on the event and in the
// warning.
test("a deadline the host slept through is reported as when it really fired, on the event and in the warning (regression)", async (t) => {
  const { root } = buildCheckFixture();
  const wt = tmpdir();
  const marker = path.join(wt, "started");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pending = runScopedBuildCheck(root, ROLE, "gate", wt, {
    check: { command: "touch started; sleep 30", timeoutSeconds: 2 },
  });
  await until(() => fs.existsSync(marker), 10_000);
  assert.ok(fs.existsSync(marker), "the check spawned before the deadline");
  t.mock.timers.tick(412_000); // the host sleeps 412 s through the 2 s deadline
  const result = await pending;
  assert.equal(result!.outcome.skipReason, "timeout");
  assert.equal(result!.outcome.run?.deadlineLateMs, 410_000, "the deadline fired 410 s past its 2 s bound");
  const events = readEvents(root);
  const check = events.find((e) => e.type === "build_check");
  assert.equal(check?.durationMs, 412_000);
  assert.equal(check?.timeoutMs, 2_000, "the event names the bound that was armed");
  assert.equal(check?.deadlineLateMs, 410_000, "and how late it actually fired");
  assert.equal(typeof check?.spawnedAt, "number");
  assert.equal(typeof check?.settledAt, "number");
  const warning = events.find((e) => e.type === "warning");
  assert.equal(
    warning?.message,
    "build check timed out after 412s (its 2s deadline fired 410s late: the host was asleep or " +
      "the harness stalled); proceeding to model review",
  );
});

test("a landing- or batch-scope timeout is a deterministic reject, not an environmental skip", async () => {
  // BUGS.md 2026-09-18: the landing check is the last gate before main, so a suite that never
  // finished must not read as "environmental" and merge the unverified tree. The gate scope
  // stays fail-open because the model reviewer and the landing check still stand behind it.
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "sleep 5" } }),
  );

  for (const scope of ["landing", "batch"] as const) {
    const result = await runScopedBuildCheck(root, ROLE, scope, wt, undefined, 400);
    assert.equal(result!.outcome.status, "failed", `${scope}: a timeout rejects`);
    assert.match(
      result!.outcome.outputTail?.[0] ?? "",
      /timed out after 0\.4s; the tree is unverified/,
    );
  }
  const events = readEvents(root);
  assert.ok(
    events.some((e) => e.type === "build_check" && e.scope === "landing" && e.status === "failed"),
    "the rejected timeout is priced as a failed check in the feed",
  );
  assert.ok(
    events.some((e) => e.type === "warning" && /rejecting the merge/.test(String(e.message))),
    "the operator sees why the landing did not proceed",
  );

  const gate = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 400);
  assert.equal(gate!.outcome.status, "skipped");
  assert.equal(gate!.outcome.skipReason, "timeout");
});

// A gate check killed by an external signal says nothing about the tree: one retry, whose
// verdict stands (the 2026-09-23 incident — a build-fix run's `pkill` killed organize's gate
// check and the change went to review unverified). Each attempt is priced as its own event.
test("a gate check killed by an external signal is retried once, and the retry's verdict stands", async () => {
  const { root, wt } = buildCheckFixture();
  // wt needs its own node_modules or detectBuildCheck walks up to the fixture root's package.json.
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({
      name: "proj",
      version: "1.0.0",
      scripts: { test: "if [ -f killed-once ]; then exit 0; else touch killed-once; kill -9 $$; fi" },
    }),
  );
  const result = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 30_000);
  assert.equal(result!.outcome.status, "passed", "the clean retry's verdict stands");
  const events = readEvents(root).filter((e) => e.type === "build_check");
  assert.equal(events.length, 2, "each attempt is priced as its own build_check event");
  assert.equal(events[0]?.status, "skipped");
  assert.equal(events[1]?.status, "passed");
});

// A persistently killed check at a merge scope is unverified, not environmental: it rejects
// deterministically, and the reason names the signal and the real duration — never the
// timeout bound, which did not fire.
test("a merge-scope check killed by an external signal rejects, naming the signal and real duration", async () => {
  const { root, wt } = buildCheckFixture();
  // wt needs its own node_modules or detectBuildCheck walks up to the fixture root's package.json.
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "kill -9 $$" } }),
  );
  const result = await runScopedBuildCheck(root, ROLE, "batch", wt, undefined, 30_000);
  assert.equal(result!.outcome.status, "failed", "an unverified tree must not land");
  assert.match(result!.outcome.outputTail?.[0] ?? "", /was killed by SIGKILL after \d+(?:\.\d+)?s; the tree is unverified/);
  const warning = readEvents(root).find((e) => e.type === "warning");
  assert.match(String(warning?.message ?? ""), /was killed by SIGKILL after \d+(?:\.\d+)?s/);
  assert.doesNotMatch(String(warning?.message ?? ""), /timed out/);
});

test("a gate check killed on every attempt stays skipped, and the warning names the signal — not the timeout", async () => {
  // The killed-skip warning's with-info arm: the gate scope (fail-open, one retry) is the only
  // surface that can still be "skipped" after a kill — a merge scope remaps the kill to a
  // deterministic failure and a single kill that recovers on retry never warns at all, so
  // without this test the message the operator actually reads had no coverage.
  const { root, wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "kill -9 $$" } }),
  );
  const result = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 30_000);
  assert.equal(result!.outcome.status, "skipped", "the gate stays fail-open on an environmental kill");
  assert.equal(result!.outcome.skipReason, "killed");
  assert.equal(result!.outcome.killedBy, "SIGKILL");
  // Both attempts are priced as build_check events (the feed answers how long a check took).
  const checks = readEvents(root).filter((e) => e.type === "build_check");
  assert.equal(checks.length, 2, "the killed attempt and the retry each priced one event");
  const warning = readEvents(root).find((e) => e.type === "warning");
  assert.match(String(warning?.message ?? ""),
    /build check was killed by SIGKILL after \d+(?:\.\d+)?s; proceeding to model review/);
  assert.doesNotMatch(String(warning?.message ?? ""), /timed out/);
});

test("the killed skip warning without signal info names an external signal, never the timeout", () => {
  // The main-red baseline passes no killed info: its wording must still say "killed by an
  // external signal" rather than claiming the timeout bound fired (BUGS.md 2026-09-23).
  assert.equal(
    buildCheckSkipWarning("killed", "main baseline check", "proceeding with authoring unverified", 30_000),
    "main baseline check was killed by an external signal; proceeding with authoring unverified",
  );
});

test("runBuildCheck skips (not fails closed) when npm is missing from PATH", async () => {
  const { root, wt } = buildCheckFixture();

  // A spawn failure before anything ran must classify as environmental: a machine without npm
  // would otherwise fail-closed and discard every code change through the strike cap.
  const emptyBin = tmpdir("no-npm-");
  const oldPath = process.env.PATH;
  process.env.PATH = emptyBin; // no npm (execFile resolves bare commands via PATH)
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "no-npm");
  } finally {
    process.env.PATH = oldPath;
  }
});

/** A scratch bin dir holding a `git` that fails the way the 2026-09-15 incident's did:
 * the xcrun shim of an invalidated Xcode license, exit 69 with the license message. */
function brokenGitBin(): string {
  const bin = tmpdir("broken-git-");
  const git = path.join(bin, "git");
  fs.writeFileSync(git, "#!/bin/sh\necho \"xcrun: error: SDK root does not exist\" >&2\necho \"You have not agreed to the Xcode license agreements.\" >&2\nexit 69\n");
  fs.chmodSync(git, 0o755);
  return bin;
}

test("runBuildCheck skips (not fails closed) when the toolchain probe fails, and the check never runs", async () => {
  // BUGS.md 2026-09-15 in miniature: git exits 69 before any check runs. Pre-fix every such
  // run was classified `failed` — a deterministic rejection at the gate, a red baseline at the
  // main-red gate, a latched \"main is red\" at the redeploy — all of them about the toolchain,
  // none of them about the tree.
  const { root, wt } = buildCheckFixture();
  const counter = path.join(tmpdir(), "runs");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: `echo run >> ${counter}` } }),
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${brokenGitBin()}:${oldPath}`; // the broken git shadows the real one; npm stays
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "toolchain");
    assert.ok(!fs.existsSync(counter), "the check itself never ran — the probe short-circuited it");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runBuildCheck reads a toolchain error in a failed run's output as skipped, not failed", async () => {
  // The incident's suite path: git ran the probe fine, the suite ran, and the suite's own
  // git calls died on the license error — the nonzero exit is noise from the environment,
  // not a verdict about the tree. Both signatures the incident produced must classify.
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({
      name: "proj",
      version: "1.0.0",
      scripts: { build: 'echo "You have not agreed to the Xcode license agreements."; echo "xcrun: error: missing input"; exit 1' },
    }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "toolchain");
});

test("runBuildCheck proceeds when git is missing from PATH: a check that never touches git still runs", async () => {
  // The probe must tell "no git at all" (missing) from "git refuses to work" (broken): this
  // project's check has no git in it, so a git-less machine is not an environmental skip.
  const { root, wt } = buildCheckFixture();
  const bin = tmpdir("no-git-");
  for (const tool of ["node", "npm", "sh"]) {
    const found = sh(wt, "which", tool).trim();
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  const oldPath = process.env.PATH;
  process.env.PATH = bin; // node + npm + sh, no git
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "passed");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("detectBuildCheck walks up from a worktree without node_modules to the installed project root", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(detectBuildCheck(wt), { kind: "npm", rootDir: root, script: "build" });
});

// --- detectBuildCheck semantics: preference, first-qualifying-directory-wins, and failure modes.
// These are documented in src/build-check.ts but were untested; the first-qualifier rule is the
// load-bearing one — skipping past a scriptless installed project to an unrelated ancestor would
// run THAT project's build script against this worktree (or nothing of this project at all).

test("detectBuildCheck prefers test over typecheck and build when all three scripts are declared", () => {
  const base = tmpdir("buildcheck-pref-");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // All three declared: test wins — npm convention makes `npm test` the canonical verify command.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "b", typecheck: "t", test: "x" } }),
  );
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "test" });

  // Without a test script the old preference stands: typecheck over build.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "b", typecheck: "t" } }),
  );
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "typecheck" });
});

test("detectBuildCheck stops at the first qualifying directory even when it declares no check script", () => {
  const base = tmpdir("buildcheck-first-qualifies-");
  const outer = path.join(base, "outer"); // installed and HAS a build script — must never be used
  fs.mkdirSync(path.join(outer, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(outer, "package.json"),
    JSON.stringify({ name: "other", version: "1.0.0", scripts: { build: "echo other-project" } }),
  );
  const project = path.join(outer, "project"); // installed but scriptless — the first qualifier
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0" }),
  );
  const wt = path.join(project, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(wt, { recursive: true });

  assert.equal(detectBuildCheck(wt), null, "no check — the scriptless project wins over its ancestor");
});

test("detectBuildCheck tolerates a malformed or scriptless package.json without throwing", () => {
  const base = tmpdir("buildcheck-malformed-");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // Unparseable JSON at the qualifying directory: no check, and detection never throws into the gate.
  fs.writeFileSync(path.join(root, "package.json"), "{ not json ");
  assert.equal(detectBuildCheck(root), null);

  // Valid JSON that is not an object must not throw: reading `.scripts` off the null from
  // JSON.parse("null") would otherwise escape detection, which callers rely on never throwing.
  for (const raw of ["null", "true", '"proj"', "[1,2]"]) {
    fs.writeFileSync(path.join(root, "package.json"), raw);
    assert.equal(detectBuildCheck(root), null, `non-object package.json ${raw} must not throw`);
  }

  // A scripts object with neither a usable test, typecheck, nor build (empty string / non-string) is no check.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "", build: "", typecheck: null } }),
  );
  assert.equal(detectBuildCheck(root), null);

  // Whitespace-only scripts are empty in effect — `npm run test` on one is a no-op that exits 0,
  // so honoring it would report a false green. All blank → no check.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "   ", build: "\t\n" } }),
  );
  assert.equal(detectBuildCheck(root), null);

  // A blank test still lets a real build be used: the preference order is preserved, not skipped.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "  ", build: "echo ok" } }),
  );
  assert.deepEqual(detectBuildCheck(root), { kind: "npm", rootDir: root, script: "build" });
});

test("detectBuildCheck honors the maxLevels bound and terminates at the filesystem root", () => {
  // No install anywhere up a plain tmpdir chain. Walking 10 levels from here passes through /
  // (tmpdir is only a few levels deep), so this also pins the parent===dir termination: a
  // regression that kept walking past root would loop forever and hang the suite.
  const base = tmpdir("buildcheck-none-");
  const deep = path.join(base, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(detectBuildCheck(deep, undefined, 10), null);

  // The bound is inclusive: an install exactly maxLevels up is found; one level further out is not.
  const chain = tmpdir("buildcheck-bound-");
  let dir = path.join(chain, "l1", "l2", "l3");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(chain, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(chain, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "echo ok" } }),
  );
  assert.deepEqual(detectBuildCheck(dir, undefined, 3), { kind: "npm", rootDir: chain, script: "build" });
  assert.equal(detectBuildCheck(dir, undefined, 2), null);
});

// --- clipBuildTail: what of a chatty build's output survives into persisted state and the
// reviewer-injected note — blanks and npm's own banners must not count against the ten-line cap.

test("clipBuildTail keeps only the last ten meaningful lines, dropping blanks and npm banners", () => {
  const noise = Array.from({ length: 30 }, (_, i) => `error line ${i}`);
  const output = ["> proj@1.0.0 build", "> tsc --noEmit", "", ...noise.slice(0, 5), "   ", ...noise.slice(5)].join("\n");
  const tail = clipBuildTail(output);
  assert.equal(tail.length, 10, "capped at ten lines");
  assert.deepEqual(tail, noise.slice(-10), "the LAST ten meaningful lines survive");
});

test("clipBuildTail clips each surviving line to the reason cap with an ellipsis", () => {
  const long = "x".repeat(400);
  const tail = clipBuildTail(`ok\n${long}\nshort`);
  assert.equal(tail.length, 3);
  const clipped = tail[1] ?? "";
  assert.equal(clipped.length, 300, "clipped to MAX_REASON_CHARS");
  assert.ok(clipped.endsWith("…"), "marked with the ellipsis");
  assert.equal(tail[2], "short", "lines that fit are unchanged");
});

test("clipBuildTail keeps the error message when the ten-line window cuts it off above a long stack", () => {
  // Node prints an unhandled error's message ABOVE its stack and property dump (verified
  // against node 26): a deep stack pushes the message out of the last-ten window, so without
  // this it is lost and the headline becomes a frame or `errno: -2,` (BUGS.md 2026-09-19).
  const frames = Array.from({ length: 12 }, (_, i) => `at f${i} (file:///w/x.ts:${i}:1)`);
  const output = [
    "Error: ENOENT: no such file or directory, open '/nope'",
    ...frames,
    "{",
    "errno: -2,",
    "code: 'ENOENT',",
    "syscall: 'open',",
    "path: '/nope'",
    "}",
  ].join("\n");
  const tail = clipBuildTail(output);
  assert.equal(tail[0], "Error: ENOENT: no such file or directory, open '/nope'", "the naming line, not a frame");
  assert.equal(tail.length, 11, "the ten-line window plus the rescued message");
});

test("clipBuildTail never mistakes an error property for the message", () => {
  // `actual:`/`expected:`/`diff:` are real assertion-diff content, not noise to skip: with no
  // message shape in the prefix, the plain ten-line window is returned unchanged.
  const lines = [
    "actual: 1,",
    "expected: 2,",
    "operator: '==',",
    "diff: 'simple'",
    ...Array.from({ length: 8 }, (_, i) => `at f${i} (x:1:1)`),
  ];
  assert.deepEqual(clipBuildTail(lines.join("\n")), lines.slice(-10));
});

// --- failureHeadline: which line of a clipped tail becomes the one-line headline, so a red
// names what broke rather than the stack frame it broke in.

test("failureHeadline names what broke, not the frame it broke in", () => {
  // clipBuildTail keeps the LAST ten lines, so an unhandled rejection's tail opens mid-stack.
  assert.equal(
    failureHeadline([
      "at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      "at async Promise.all (index 0)",
      "AssertionError [ERR_ASSERTION]: actual: 'quiet_killed', expected: 'no_change'",
    ]),
    "AssertionError [ERR_ASSERTION]: actual: 'quiet_killed', expected: 'no_change'",
  );
  assert.equal(failureHeadline(["at a (f:1:1)", "at b (f:2:2)"]), "at a (f:1:1)", "all frames: print something");
  assert.equal(failureHeadline([]), undefined);
  assert.equal(failureHeadline(undefined), undefined);
});

test("failureHeadline names an unhandled error whose message the tail window would otherwise cut", () => {
  const frames = Array.from({ length: 12 }, (_, i) => `at f${i} (file:///w/x.ts:${i}:1)`);
  const tail = clipBuildTail(
    [
      "Error: ENOENT: no such file or directory, open '/nope'",
      ...frames,
      "errno: -2,",
      "code: 'ENOENT',",
      "syscall: 'open',",
      "path: '/nope'",
    ].join("\n"),
  );
  assert.equal(
    failureHeadline(tail),
    "Error: ENOENT: no such file or directory, open '/nope'",
    "the message, not `errno: -2,`",
  );
});

test("failureHeadline skips node:test's summary block, not the failure it frames", () => {
  // node --test's spec reporter ends a failing run with the summary THEN the detail; when both
  // fit in the ten-line window the first non-frame line was `ℹ todo 0` and two real rejections
  // surfaced as `build check failed (test): ℹ todo 0` (BUGS.md 2026-09-22). Output is real
  // spec-reporter shape (reproduced with a test that throws a plain string).
  const tail = clipBuildTail(
    [
      "ℹ pass 0",
      "ℹ fail 1",
      "ℹ cancelled 0",
      "ℹ skipped 0",
      "ℹ todo 0",
      "ℹ duration_ms 73.78325",
      "✖ failing tests:",
      "test at a.test.js:2:1",
      "✖ the interlock held: no tick ever started (0.348625ms)",
      "  'the interlock held: no tick ever started'",
    ].join("\n"),
  );
  assert.equal(
    failureHeadline(tail),
    "✖ the interlock held: no tick ever started (0.348625ms)",
    "the failure's own message, not `ℹ fail 1` or the `test at` marker",
  );
});

// --- resolveFromNodeModules: the same walk-up detectBuildCheck makes, for a dependency the
// harness must locate itself (redeploy's tsc) rather than let npm's PATH walk find.

test("resolveFromNodeModules climbs to an ancestor's install and gives up past the level cap", () => {
  const base = tmpdir("walkup-");
  fs.mkdirSync(path.join(base, "node_modules", "typescript", "bin"), { recursive: true });
  const tsc = path.join(base, "node_modules", "typescript", "bin", "tsc");
  fs.writeFileSync(tsc, "#!/usr/bin/env node\n");
  const nested = path.join(base, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(resolveFromNodeModules(base, path.join("typescript", "bin", "tsc")), tsc, "found at the start dir");
  assert.equal(resolveFromNodeModules(nested, path.join("typescript", "bin", "tsc")), tsc, "and three levels down");
  assert.equal(resolveFromNodeModules(nested, path.join("typescript", "bin", "tsc"), 2), null, "cap reached first");
  assert.equal(resolveFromNodeModules(nested, "nonesuch"), null, "nothing to find");
});


// --- A configured check.command (plans/portability.md §6/7): the walk-up cannot know how a
// Python, Rust, or Go repo verifies itself, so `check` in tumwater.json names it and the same
// detection → run → classification machinery executes it. No npm assumed anywhere.

test("detectBuildCheck returns the configured check.command first, with cwd and timeout resolved", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(detectBuildCheck(wt, { check: { command: "pytest -q" } }), {
    kind: "command",
    command: "pytest -q",
    cwd: wt,
    timeoutMs: 300_000,
  });
  assert.deepEqual(
    detectBuildCheck(wt, { check: { command: "cargo test", cwd: "crates/core", timeoutSeconds: 5 } }),
    { kind: "command", command: "cargo test", cwd: path.join(wt, "crates", "core"), timeoutMs: 5_000 },
  );
  // A blank command is no command — validation rejects one, but a degraded default config
  // could still carry it; the walk-up detection takes over instead of running nonsense.
  assert.deepEqual(detectBuildCheck(wt, { check: { command: "   " } }), {
    kind: "npm",
    rootDir: root,
    script: "build",
  });
  // No config at all: today's npm auto-detection, unchanged.
  assert.deepEqual(detectBuildCheck(wt), { kind: "npm", rootDir: root, script: "build" });
});

test("a configured command runs through a shell in its cwd, classified like an npm check", async () => {
  const { wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "sub"));
  fs.writeFileSync(path.join(wt, "sub", "marker.txt"), "x");

  // `&&` composition and a pipe prove shell semantics — split into argv this would ENOENT,
  // and without the cwd it would look in the wrong directory and fail.
  const passing = await runBuildCheck(
    wt,
    { kind: "command", command: "cat marker.txt | grep x && echo done", cwd: path.join(wt, "sub"), timeoutMs: 30_000 },
    30_000,
  );
  assert.equal(passing.status, "passed");
  assert.equal(passing.script, "cat marker.txt | grep x && echo done");

  const failing = await runBuildCheck(
    wt,
    { kind: "command", command: "echo type error TS9999: boom; exit 1", cwd: wt, timeoutMs: 30_000 },
    30_000,
  );
  assert.equal(failing.status, "failed", "a nonzero exit is a deterministic rejection");
  assert.ok((failing.outputTail ?? []).some((l) => l.includes("TS9999")), "the tail carries the failure");
});

test("a configured command times out at its own timeoutSeconds, not the caller's", async () => {
  const { wt } = buildCheckFixture();
  const outcome = await runBuildCheck(wt, { kind: "command", command: "sleep 5", cwd: wt, timeoutMs: 400 }, 30_000);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "timeout");
});

test("runScopedBuildCheck remaps a configured command's merge-scope timeout exactly as an npm one", async () => {
  const { root, wt } = buildCheckFixture();
  const config = { check: { command: "sleep 5", timeoutSeconds: 0.4 } };
  for (const scope of ["landing", "batch"] as const) {
    const result = await runScopedBuildCheck(root, ROLE, scope, wt, config, 30_000);
    assert.equal(result!.outcome.status, "failed", `${scope}: a timeout rejects`);
    assert.match(result!.outcome.outputTail?.[0] ?? "", /timed out after 0\.4s; the tree is unverified/);
  }
  const events = readEvents(root);
  const check = events.find((e) => e.type === "build_check" && e.scope === "landing");
  assert.equal((check as { script?: string } | undefined)?.script, "sleep 5", "the event names the command");
});

// --- check.gateCommand (PLANS.md Land-queue speed 3e): an opt-in cheaper check for the review
// gate's per-change pre-check only. The landing and batch scopes — the checks that decide what
// reaches main — keep running the full check, or a weaker gate would land an unverified tree.

test("runScopedBuildCheck runs check.gateCommand at the gate scope only; landing and batch keep check.command", async () => {
  const { root, wt } = buildCheckFixture();
  // The full check is red and the gate command green, so each scope's verdict names which ran.
  const config = { check: { command: "echo full; exit 1", gateCommand: "echo gate-only" } };
  const gate = await runScopedBuildCheck(root, ROLE, "gate", wt, config, 30_000);
  assert.equal(gate!.outcome.status, "passed");
  assert.deepEqual(gate!.check, { kind: "command", command: "echo gate-only", cwd: wt, timeoutMs: 300_000 });
  for (const scope of ["landing", "batch"] as const) {
    const result = await runScopedBuildCheck(root, ROLE, scope, wt, config, 30_000);
    assert.equal(result!.outcome.status, "failed", `${scope}: the full check still runs`);
    assert.equal(result!.outcome.script, "echo full; exit 1");
  }
  const scripts = readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => [e.scope, (e as { script?: string }).script]);
  assert.deepEqual(scripts, [
    ["gate", "echo gate-only"],
    ["landing", "echo full; exit 1"],
    ["batch", "echo full; exit 1"],
  ]);
});

test("check.gateCommand shares the check's cwd and timeout, and overrides the npm walk-up at the gate too", async () => {
  const { root, wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "sub"));
  fs.writeFileSync(path.join(wt, "sub", "marker.txt"), "x");
  const withCwd = await runScopedBuildCheck(
    root,
    ROLE,
    "gate",
    wt,
    { check: { command: "exit 1", gateCommand: "test -f marker.txt", cwd: "sub", timeoutSeconds: 7 } },
    30_000,
  );
  assert.equal(withCwd!.outcome.status, "passed", "the gate command ran in check.cwd");
  assert.deepEqual(withCwd!.check, {
    kind: "command",
    command: "test -f marker.txt",
    cwd: path.join(wt, "sub"),
    timeoutMs: 7_000,
  });
  // No check.command (an npm repo — validation allows the key to be absent): the gate runs the
  // gate command, the landing scope the npm walk-up exactly as before.
  const npmRepo = { check: { gateCommand: "echo gate-only" } } as { check: { command: string; gateCommand: string } };
  const gate = await runScopedBuildCheck(root, ROLE, "gate", wt, npmRepo, 30_000);
  assert.equal(gate!.outcome.script, "echo gate-only");
  const landing = await runScopedBuildCheck(root, ROLE, "landing", wt, npmRepo, 30_000);
  assert.deepEqual(landing!.check, { kind: "npm", rootDir: root, script: "build" });
});

test("an unset or blank check.gateCommand leaves the gate running check.command", async () => {
  const { root, wt } = buildCheckFixture();
  for (const gateCommand of [undefined, "", "   "]) {
    const result = await runScopedBuildCheck(
      root,
      ROLE,
      "gate",
      wt,
      { check: { command: "echo full", ...(gateCommand === undefined ? {} : { gateCommand }) } },
      30_000,
    );
    assert.equal(result!.outcome.script, "echo full", `gateCommand ${JSON.stringify(gateCommand)} is off`);
  }
});
