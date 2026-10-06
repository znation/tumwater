import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runBuildCheck } from "../src/build/build-check.js";
import { errCode } from "../src/errno.js";
import { pidAlive } from "../src/process/process.js";
import { buildCheckFixture } from "./loop-fixtures.js";
import { projManifest } from "./fake-commands.js";
import { tmpdir } from "./repo-fixtures.js";
import { sleep, waitFor } from "./wait.js";
import { ownerAliveSh } from "./victim-fixture.js";

// The build check's process-tree teardown hygiene, split out of build-check.test.ts beside its
// local helpers (groupAlive, checkClock, readPid): what a timed-out check owes its process tree
// (the group signal, the SIGKILL escalation), what settles the run (the group's death, never the
// leader's close alone), and how deadline + grace bound the settle. The check's outcome
// classification, summary counts, and configured-command boundary stay in build-check.test.ts;
// the walk-up detection lives in build-check-detect.test.ts.

/** True while any process in the group `pgid` exists — a signal-0 send to the whole group. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

/** Put a check's deadline, SIGKILL grace and group poll (runScriptGroup in src/process/process-group.ts)
 * on logical time for the rest of `t`: Date, setTimeout and setInterval become node:test mock
 * timers, while the check's processes, pipes and exits stay real. The returned `advance(ms)`
 * fires what falls due in 50 ms steps (the group poll's period), so each timer reads its own
 * Date.now() — a single tick(ms) would stamp every callback with the span's end. A deadline
 * on logical time fires when the test says, never mid-startup: on the wall clock a budget had
 * to outlast npm, node and shell boot under load, and every such margin became a flake. */
function checkClock(t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  return (ms) => {
    for (let left = ms; left > 0; left -= 50) t.mock.timers.tick(Math.min(50, left));
  };
}

/** A pid/pgid a fixture command wrote to `file` (0 when it never did). */
function readPid(file: string): number {
  return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) : 0;
}

// A timed-out check must take its whole process tree with it. npm runs detached as its own
// process group leader; the old execFileAsync `timeout` signalled npm alone, so everything
// below it survived and reparented to PID 1 — four orphaned trees on the fleet, one alive 12
// days, one running a real orchestrator for 18 hours (BUGS.md 2026-09-21). The runner here
// backgrounds a grandchild that TRAPS SIGTERM — only the SIGKILL escalation can stop it — so
// the test pins both the group signal and the escalation armed on timeout. Mirrors
// test/pi.test.ts's "a killed run leaves no grandchild behind".
test("a timed-out build check takes its process tree with it (regression)", async (t) => {
  const { root, wt } = buildCheckFixture();
  const pidFile = path.join(wt, "grandchild.pid");
  fs.writeFileSync(
    path.join(wt, "runner.mjs"),
    [
      'import fs from "node:fs";',
      'import { spawn } from "node:child_process";',
      // npm starts the runner with the check's environment, not an owned one: it idles until
      // the check kills it, so it watches this process itself.
      `import { exitWithOwner } from ${JSON.stringify(new URL("./exit-with-owner.js", import.meta.url).href)};`,
      `exitWithOwner(${process.pid});`,
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
    projManifest({ test: "node runner.mjs" }),
  );
  let pid = 0;
  try {
    // 4s budget, 700ms SIGKILL grace: the grandchild traps SIGTERM, so it must be gone once the
    // grace expires — and only via the escalation. Both run on logical time (checkClock), and
    // the deadline fires only once the grandchild has trapped SIGTERM and written its pid. On
    // the wall clock the budget had to cover the whole startup chain (npm boot → runner boot →
    // the grandchild's own node boot) BEFORE the group SIGTERM fired: at 600ms a load-sensitive
    // run let SIGTERM land mid-grandchild-startup, which died by default action before trapping
    // or writing its pid — the test then died reading a pid file that never existed and falsely
    // reddened main at 03edeba6 (BUGS.md 2026-09-24), and 4s stayed a load flake after it.
    const advance = checkClock(t);
    const check = runBuildCheck(wt, { kind: "npm", rootDir: root, script: "test" }, 4_000, 700);
    await waitFor(() => readPid(pidFile) > 0, "the grandchild's pid file", 30_000);
    pid = readPid(pidFile);
    assert.ok(pid > 0, "the grandchild recorded its pid before the timeout");
    advance(4_000 + 700); // the deadline's group SIGTERM, then the grace's SIGKILL
    const outcome = await check;
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "timeout");
    // The SIGKILL lands before the check settles, but launchd reaps the orphan asynchronously:
    // poll until it is gone (or the assertion below fails on the leak this test pins).
    await waitFor(() => !pidAlive(pid), "the timed-out check's grandchild to be reaped", 5_000);
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
test("a healthy check that outlasts the SIGKILL grace is not mistaken for a timeout", async (t) => {
  const { root, wt } = buildCheckFixture();
  const started = path.join(wt, "started");
  const go = path.join(wt, "go");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: `touch '${started}'; while [ ! -f '${go}' ] && ${ownerAliveSh()}; do sleep 0.02; done` }),
  );
  // On logical time (checkClock): the run lasts four graces, far short of its 30 s deadline,
  // and finishes on its own once the test says go.
  const advance = checkClock(t);
  const check = runBuildCheck(wt, { kind: "npm", rootDir: root, script: "test" }, 30_000, 500);
  await waitFor(() => fs.existsSync(started), "the check's started marker", 30_000);
  advance(2_000);
  fs.writeFileSync(go, "");
  const outcome = await check;
  assert.equal(outcome.status, "passed");
});

// BUGS.md 2026-09-21 (the 300 s timeout that did not bound the check): a timed-out check
// settles within its deadline plus the SIGKILL grace whatever its tree does, and the tree is
// gone when it settles — no teardown left running behind the caller's retry or next check.
// Pre-fix the check resolved AT the deadline with the SIGKILL still pending in the background.
// `trap '' TERM` in the group-leading shell is inherited as ignored by the backgrounded sleep,
// which also holds the check's stdout/stderr: neither the SIGTERM nor a close can end this
// run, only the SIGKILL at the grace.
test("a timed-out check whose tree ignores SIGTERM and holds its pipes settles at deadline + grace with the group gone (regression)", async (t) => {
  const wt = tmpdir();
  const command = "trap '' TERM; echo $$ > pgid; sleep 30 & echo $! > sleep.pid; wait";
  let pgid = 0;
  try {
    // On logical time (checkClock), with the deadline fired only once the tree is up — the trap
    // set and the pipe-holding sleep started — so the run's length is exactly what the check's
    // timers made it.
    const advance = checkClock(t);
    const check = runBuildCheck(wt, { kind: "command", command, cwd: wt, timeoutMs: 1_000 }, 30_000, 800);
    await waitFor(() => readPid(path.join(wt, "sleep.pid")) > 0, "the pipe holder's pid file", 30_000);
    advance(1_000 + 800); // the deadline's SIGTERM (ignored), then the grace's SIGKILL
    const outcome = await check;
    pgid = readPid(path.join(wt, "pgid"));
    const sleepPid = readPid(path.join(wt, "sleep.pid"));
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "timeout");
    assert.ok(pgid > 0 && sleepPid > 0, "the fixture's tree started before the deadline");
    const ran = outcome.run!.settledAt - outcome.run!.spawnedAt;
    assert.ok(ran >= 1_700, `the tree outlived the SIGTERM, so the check waited for the SIGKILL (ran ${ran}ms)`);
    assert.ok(ran <= 1_800 + 250, `bounded at deadline + grace (settled ${ran}ms after the spawn)`);
    // SIGKILLed before the check settled; launchd reaps the orphan a moment later. Pre-fix
    // the SIGKILL was still ~800 ms away here, so this window cannot hide the leak.
    await waitFor(() => !groupAlive(pgid), "the check's process group to die", 300);
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
    await waitFor(() => !pidAlive(sleepPid), "the surviving grandchild to be reaped", 300);
    assert.equal(pidAlive(sleepPid), false, "the surviving grandchild was SIGKILLed before the check settled");
  } finally {
    if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

// The other half of the bound: a tree the SIGTERM takes down does not wait out the grace, so
// the common timeout costs the deadline and not the deadline plus ten seconds.
test("a timed-out check whose tree dies on SIGTERM settles right after the deadline, not after the grace", async (t) => {
  const wt = tmpdir();
  // On logical time (checkClock): the wall clock moves only the tree's real death, never the
  // check's timers, so a loaded host cannot push the settle toward the grace. Pre-fix-shaped
  // behaviour (settling only at the SIGKILL) never settles on the clock budget below.
  const advance = checkClock(t);
  let settled = false;
  const check = runBuildCheck(
    wt,
    { kind: "command", command: "echo $$ > pgid; sleep 30", cwd: wt, timeoutMs: 1_000 },
    30_000,
    5_000,
  ).finally(() => (settled = true));
  await waitFor(() => readPid(path.join(wt, "pgid")) > 0, "the check's pgid file", 30_000);
  const pgid = readPid(path.join(wt, "pgid"));
  advance(1_000); // the deadline's SIGTERM
  // The group's death is real time; wait it out with the check's clock frozen, then step the
  // clock (the group poll) until the run settles — well inside the 5 s grace.
  await waitFor(() => !groupAlive(pgid), "the SIGTERMed group to die", 30_000);
  for (let stepped = 0; !settled && stepped < 2_500; stepped += 50) {
    advance(50);
    await sleep(20);
  }
  assert.ok(settled, "the check settled within 2.5 s of logical time after the deadline, not at the 5 s grace");
  const outcome = await check;
  assert.equal(outcome.skipReason, "timeout");
  const ran = outcome.run!.settledAt - outcome.run!.spawnedAt;
  assert.ok(ran <= 1_000 + 2_500, `settled ${ran}ms after the spawn, not after the 5 s grace`);
});
