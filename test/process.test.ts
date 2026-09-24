import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseLsofCwds, parsePsOutput, pidAlive, systemProcessProbe } from "../src/process.js";

// The liveness probe underpins two recovery paths: lock.ts's stale-holder check (a dead
// holder's merge lock must be breakable) and state.ts's orchestrator-alive status. Its
// contract is "any error reads as not alive" — the EPERM case matters most, because a live
// foreign pid mistaken for one of ours would make tryBreakStale never break that lock, and
// every merge would time out forever (the orphaned-lock bug class in BUGS.md).

test("pidAlive reports the calling process as alive", () => {
  assert.equal(pidAlive(process.pid), true);
});

test("pidAlive follows a real child across its whole lifetime", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid;
  try {
    // The pid is assigned at spawn, but give the kernel a moment before asserting.
    assert.ok(pid !== undefined, "spawn assigned a pid");
    const deadline = Date.now() + 2_000;
    while (!pidAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(pidAlive(pid), true, "a running child reads as alive");

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL"); // Attach the listener first, then kill.
    });
    // Probe immediately after the reap: the pid is gone (ESRCH) unless recycled in the
    // microseconds between exit and this call.
    assert.equal(pidAlive(pid), false, "an exited child reads as not alive");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
});

test("pidAlive reads a live foreign process as NOT alive (EPERM)", (t) => {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === 0) {
    t.skip("running as root: signal-0 to pid 1 is permitted, so the EPERM branch is unreachable");
    return;
  }
  // PID 1 (launchd/init) is always running but owned by another user: a non-root probe gets
  // EPERM. The contract says that reads as "not alive" — a live foreign holder must not be
  // mistaken for one of ours, or the merge lock it holds could never be broken.
  assert.equal(pidAlive(1), false);
});

test("pidAlive reads an impossible pid as NOT alive without throwing", () => {
  // Far beyond any platform's pid space (Linux PID_MAX_LIMIT is 2^22; macOS wraps at ~10^5):
  // the signal-0 fails with EINVAL/ESRCH, and "any error" must read as not alive.
  assert.equal(pidAlive(2_000_000_000), false);
});

test("pidAlive reads a non-positive or fractional pid as NOT alive", () => {
  // signal 0 treats pid 0 as the caller's own process group and a negative pid as another
  // group — both probes succeed, so without the positive-integer guard a corrupt state or
  // lock file (pid 0, -1) would report a phantom holder alive. Fractional ids are likewise
  // never real pids.
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(1.5), false);
});

// The process-table reader behind doctor's orphan check (checkOrphans in src/doctor.ts, where
// the matching is pinned against a fake table). Here: the two parsers over fixed BSD/procps
// and lsof output, and one smoke of the real probe against this test process itself — no
// orphan is ever spawned.

test("parsePsOutput reads BSD and procps rows, keeps argv spaces, and skips junk", () => {
  const rows = parsePsOutput(
    [
      "    1     0     0 35-22:43:52 425:10.18 /sbin/launchd", // macOS: dd-hh:mm:ss, mm:ss.hh
      "88052     1   501 2-21:44:01   0:03.12 node dist/src/test-runner.js",
      " 4242     1  1000    01:02:03 00:00:05 node /r/.tumwater/worktrees/qa/dist/src/cli.js gui --port 41602", // procps
      "  777   776   501     00:04 0:00.00", // a zombie: no argv at all
      "not a ps row",
      "",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, uid: 0, etime: "35-22:43:52", time: "425:10.18", command: "/sbin/launchd" },
    { pid: 88052, ppid: 1, uid: 501, etime: "2-21:44:01", time: "0:03.12", command: "node dist/src/test-runner.js" },
    {
      pid: 4242,
      ppid: 1,
      uid: 1000,
      etime: "01:02:03",
      time: "00:00:05",
      command: "node /r/.tumwater/worktrees/qa/dist/src/cli.js gui --port 41602",
    },
    { pid: 777, ppid: 776, uid: 501, etime: "00:04", time: "0:00.00", command: "" },
  ]);
});

test("parseLsofCwds maps each pid to its cwd and leaves out a process lsof could not read", () => {
  const cwds = parseLsofCwds(
    ["p101", "fcwd", "n/Users/z/repo/.tumwater/worktrees/bugfix", "p102", "fcwd", "p103", "fcwd", "n/tmp/with space", ""].join("\n"),
  );
  assert.deepEqual([...cwds], [
    [101, "/Users/z/repo/.tumwater/worktrees/bugfix"],
    [103, "/tmp/with space"],
  ]);
});

test("systemProcessProbe lists this process with its parent and reads its cwd past a vanished pid", async () => {
  const rows = await systemProcessProbe.list();
  const self = rows.find((r) => r.pid === process.pid);
  assert.ok(self, "the table includes the calling process");
  assert.equal(self.ppid, process.ppid);
  assert.match(self.command, /node/);
  // A pid beyond any pid space rides along: lsof exits 1 whenever any named pid is absent, and
  // that exit must still yield the cwds it did print (on Linux the /proc read just skips it).
  const cwds = await systemProcessProbe.cwds([process.pid, 2_000_000_000]);
  assert.equal(cwds.get(process.pid), fs.realpathSync(process.cwd()));
  assert.equal(cwds.has(2_000_000_000), false);
  assert.deepEqual(await systemProcessProbe.cwds([]), new Map());
});
