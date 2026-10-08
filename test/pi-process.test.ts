import { sleep } from "./wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runPi } from "../src/pi/pi.js";
import { pidAlive, signalTree } from "../src/process/process.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { runPiFixture } from "./pi-run-harness.js";
import { ownerAliveSh } from "./victim-fixture.js";

// The process-tree-hygiene regressions: a run — killed or exited normally — must take its
// tool-call children, grandchildren, and backgrounded cross-group orphans with it, and
// signalTree must tolerate the groups those exits leave behind (src/process/process.ts's sweep, as
// runPi arms it). The quiet-watchdog and stall-warning tests stay in pi.test.ts; the shared
// runPi fixture lives in pi-run-harness.ts.

// A killed tick must take its tool-call grandchildren with it. pi runs detached as its own
// process group leader and terminateChild signals the group (BUGS.md 2026-09-20); the old
// single-PID kill left a backgrounded tool-call process orphaned to launchd forever. The
// fakePi script backgrounds a spinner that does NOT exec, so it is a genuine grandchild —
// the exec-based kill tests above cannot catch this.
//
// The kill is test-driven (abort signal) instead of quiet-watchdog-driven, and the shim
// records the grandchild's pid BEFORE printing any output: the watchdog fires on wall-clock
// silence, so on a loaded machine it could kill the whole group while the shim was still
// starting up — before the grandchild had written its pid file — and the test died reading
// that missing file (the ENOENT that turned main red, 2026-09-22). Waiting for the file and
// killing only after it exists leaves no race: the test fails with a clear message if the
// shim never starts, and the abort exercises the same terminateChild group kill.
test("a killed run leaves no grandchild behind (regression)", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  // Far beyond the test's span: the quiet watchdog must not fire — this test drives the kill.
  config.quietTimeoutSeconds = 60;
  const pidFile = path.join(dir, "grandchild.pid");
  // The spinner redirects its stdio so it does not hold pi's pipes open — exactly the shape
  // of a real tool call, and what lets runPi settle while the leak lives on. It spins only
  // while this process lives: a test process killed mid-test must not leave a core burning.
  const restore = fakePi(
    [
      `sh -c 'echo $$ > ${pidFile}; while ${ownerAliveSh()}; do :; done' >/dev/null 2>&1 &`,
      `until [ -f ${pidFile} ]; do sleep 0.05; done`,
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  const controller = new AbortController();
  let pid = 0;
  const run = runPi(runPiFixture(dir, { config, signal: controller.signal }));
  try {
    // Wait until the grandchild has recorded itself — the write the old version raced.
    const recordDeadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) && Date.now() < recordDeadline) {
      await sleep(25);
    }
    assert.ok(fs.existsSync(pidFile), "the grandchild recorded its pid within 10s");
    controller.abort();
    const result = await run;
    assert.equal(result.aborted, true, "the run ends killed by the abort");
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0, "the grandchild recorded its pid");
    // The group signal is asynchronous relative to runPi's resolution: poll until the OS
    // has reaped the grandchild (or the assertion below fails on a leak that never dies).
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) await sleep(50);
    }
    assert.equal(alive, false, "the tool-call grandchild is gone after the run resolves");
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    restore();
  }
});

// A run that ENDS NORMALLY must take its backgrounded tool-call processes with it too (BUGS.md
// 2026-09-23): qa's GUI check backgrounded `cd … && node … gui --all-interfaces &`, its own
// cleanup killed the list's subshell instead of the server, pi exited 0, and the unauthenticated
// server listened on the LAN for 7.5 hours — still in the group pi led. Both shapes of the
// Repro: `(… &)` (the subshell forks and exits, orphaning at once) and `cmd && … &` (the whole
// list is the background job, so `$!` names its subshell — the qa trap). Each sleep records its
// own pid (`exec` keeps it), and the shim waits (bounded) for both pid files before exiting, so
// the test never races their writes.
test("a run that exits normally leaves no backgrounded tool-call process behind (regression)", async () => {
  const dir = tmpdir();
  const subshellPidFile = path.join(dir, "subshell.pid");
  const listPidFile = path.join(dir, "list.pid");
  const pidFiles = [subshellPidFile, listPidFile];
  // Two minutes, not an hour: far past the run's 30 s backstop, and short enough that a test
  // process killed mid-test strands them only briefly (sh cannot load the owner watch).
  const sleeper = (pidFile: string) => `sh -c 'echo $$ > ${pidFile}; exec sleep 120'`;
  // A backstop, far beyond the test's span: were an orphan ever to hold 'close' open, the run
  // fails on the tick timeout instead of hanging the file.
  const config = defaultConfig();
  config.tickTimeoutSeconds = 30;
  const restore = fakePi(
    [
      // The "tool call" runs in its own shell whose stdio is off pi's pipes, as a real tool
      // call's is — otherwise the `&&` list's subshell holds pi's stdout open while it waits
      // on its sleep, and the pre-fix run never closes instead of resolving with its orphans
      // alive. `exec` (not a `{ …; } >` group, whose saved copy of the old stdout the forked
      // list inherits) leaves no descriptor of pi's behind.
      `( exec >/dev/null 2>&1; (${sleeper(subshellPidFile)} &); true && ${sleeper(listPidFile)} & )`,
      `n=0; until [ -s ${subshellPidFile} ] && [ -s ${listPidFile} ] || [ $n -ge 200 ]; do sleep 0.05; n=$((n+1)); done`,
      `printf '%s\n' '${assistantLine("Everything checked out.")}'`,
      `exit 0`,
    ].join("\n"),
  );
  const readPid = (f: string) => {
    try {
      return Number(fs.readFileSync(f, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  const seenDead = new Set<number>();
  try {
    const result = await runPi(runPiFixture(dir, { config }));
    assert.equal(result.ok, true, "the run ends normally — no kill path is involved");
    assert.equal(result.aborted || result.timedOut || result.quietKilled, false);
    const pids = pidFiles.map(readPid);
    assert.ok(pids.every((pid) => pid > 0), "both backgrounded sleeps recorded their pids");
    // The group signal is asynchronous relative to runPi's resolution: poll until the OS has
    // reaped both sleeps (the assertion below fails on a leak that never dies).
    const deadline = Date.now() + 5000;
    while (seenDead.size < pids.length && Date.now() < deadline) {
      for (const pid of pids) if (!pidAlive(pid)) seenDead.add(pid);
      if (seenDead.size < pids.length) await sleep(50);
    }
    assert.deepEqual(
      pids.filter((pid) => !seenDead.has(pid)),
      [],
      "every backgrounded sleep is gone after a normal exit",
    );
  } finally {
    // Never leak a sleep, whichever assertion failed: SIGKILL every recorded pid not seen dead
    // (one seen dead is left alone — its pid may already be recycled).
    for (const pid of pidFiles.map(readPid)) {
      if (pid <= 0 || seenDead.has(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    restore();
  }
});

// The group sweep cannot reach what a tool call BACKGROUNDS under pi 0.87.1: the bash tool
// spawns every command detached, in its OWN process group, so terminateChild's kill(-pi.pid)
// never sees that group — and the regression test above modeled the tool call as a same-group
// background job, passing while the real agent leaked servers and test workers for hours
// (BUGS.md 2026-09-30). This test drives the real shape: the fake pi's "tool call" spawns its
// child detached — a group leader in its own right, exactly as pi's bash tool does — and the
// orphan outlives the run in a group whose leader is not pi. The fix marks the run's whole
// environment (TUMWATER_RUN, inherited by every tool call and its descendants) and sweeps
// every same-user process carrying the mark when pi exits, whatever group it sits in. The
// orphan is node on purpose: macOS's ps -E — the scan the sweep reads — hides the
// environment of platform binaries like sleep and sh, so a sleep orphan would prove nothing
// here even where the fix works.
test("the end-of-run sweep reaches a detached tool call's cross-group orphan (regression)", async () => {
  const dir = tmpdir();
  const pidFile = path.join(dir, "orphan.pid");
  const spawner = path.join(dir, "spawn-orphan.cjs");
  fs.writeFileSync(
    spawner,
    [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e',",
      "  \"require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000)\",",
      "  process.argv[2]], { detached: true, stdio: 'ignore' });",
      "c.unref();",
    ].join("\n"),
  );
  // A backstop, far beyond the test's span: a wedged run fails on the tick timeout.
  const config = defaultConfig();
  config.tickTimeoutSeconds = 30;
  const restore = fakePi(
    [
      `node ${spawner} ${pidFile}`,
      `n=0; until [ -s ${pidFile} ] || [ $n -ge 200 ]; do sleep 0.05; n=$((n+1)); done`,
      `printf '%s\n' '${assistantLine("Everything checked out.")}'`,
      `exit 0`,
    ].join("\n"),
  );
  const readPid = () => {
    try {
      return Number(fs.readFileSync(pidFile, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  let swept = false;
  try {
    const result = await runPi(runPiFixture(dir, { config }));
    assert.equal(result.ok, true, "the run ends normally — no kill path is involved");
    const pid = readPid();
    assert.ok(pid > 0, "the orphan recorded its pid");
    // The marker sweep is fire-and-forget after pi's exit (one process-table scan): poll
    // until the marked orphan is gone, or the assertion below fails on a leak.
    const deadline = Date.now() + 15_000;
    while (pidAlive(pid) && Date.now() < deadline) await sleep(50);
    swept = !pidAlive(pid);
    assert.equal(swept, true, "the detached tool call's orphan is gone after the run resolves");
  } finally {
    // Never leak the orphan, whichever assertion failed: SIGKILL it unless the sweep already
    // reaped it (its pid may then be recycled — never signal a swept pid again).
    const pid = readPid();
    if (!swept && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    restore();
  }
});

// The sweep's contract with signalTree: a group that died with its leader is the normal case
// after an exit, so signalling it reports "nothing received this" instead of throwing — which
// is what lets the post-exit sweep skip arming a SIGKILL at a pgid no process holds any more.
test("signalTree reports whether the signal reached a live group, and tolerates a gone one", async () => {
  const done = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
  await new Promise((r) => done.on("exit", r));
  assert.equal(signalTree(done, "SIGTERM"), false, "an exited leader's empty group receives nothing");

  const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    await new Promise((r) => live.on("spawn", r));
    const exited = new Promise<NodeJS.Signals | null>((r) => live.on("exit", (_code, signal) => r(signal)));
    assert.equal(signalTree(live, "SIGTERM"), true, "a live group receives the signal");
    assert.equal(await exited, "SIGTERM");
  } finally {
    live.kill("SIGKILL");
  }
});
