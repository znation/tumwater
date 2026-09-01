import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { pidAlive } from "../src/process.js";

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
