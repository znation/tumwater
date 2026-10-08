// The owner watch for every process a test starts and cannot otherwise tie to its own life: a
// process that loads this module exits once its owner — the test process whose in-process
// cleanup (a finally, a t.after hook, a kill() helper) was meant to reap it — no longer
// exists. That cleanup dies with the test process when something outside kills it mid-test:
// on 2026-10-04 a conflict resolver ran `npx vitest run`, which imports the node:test files
// into workers (node:test runs a file's tests on import) and tears each down mid-test, and
// the children of the tests in flight were left at PPID 1 for good. Loaded as a NODE_OPTIONS
// preload (victim-fixture.ts's exitWithOwnerEnv), so it reaches a child's whole node subtree:
// a `run` supervisor's generation, a dashboard's re-exec'd child, npm and what npm starts.
// Scripts with no NODE_OPTIONS of their own (a fake build's runner) import exitWithOwner.

/** The variable naming the owning test process's pid for the preload half below. */
export const OWNER_PID_ENV = "TUMWATER_TEST_OWNER_PID";

/** Exit this process once `owner` is gone, polling `kill(owner, 0)`: ESRCH means gone, while
 * EPERM is a live process this user may not signal (a reused pid at worst), never a reason to
 * exit. Liveness rather than a parent-pid comparison, because the owner is often an ancestor
 * further up, not the parent. The timer is unref'd, so it never holds a process open past its
 * own work. */
export function exitWithOwner(owner: number, intervalMs = 250): void {
  const timer = setInterval(() => {
    try {
      process.kill(owner, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") process.exit(1);
    }
  }, intervalMs);
  timer.unref();
}

const owner = Number(process.env[OWNER_PID_ENV]);
if (Number.isInteger(owner) && owner > 0) exitWithOwner(owner);
