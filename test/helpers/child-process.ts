// Spawning a helper process under a test's control. The cross-process lock and
// read-modify-write race tests all need the same three steps: run an inline `node -e` script,
// drain its stderr so it cannot block, then poll for a condition that marks it ready (a
// `ready` file it wrote, a lock it took). `spawnReadyChild` bundles those. Tests that only
// need a process to be *alive* — a stand-in orchestrator — spawn one with `spawnLiveChild`
// instead. `stopChild` bundles the SIGKILL-and-wait teardown both share.

import { spawn, type ChildProcess } from "node:child_process";
import { exitWithOwnerEnv } from "../victim-fixture.js";

/** The part of a spawned child the teardown needs — a superset of what `spawnReadyChild`
 * returns, so `stopChild` accepts either kind of handle. */
interface ChildHandle {
  child: ChildProcess;
  /** Resolves when the child process has exited. */
  exited: Promise<void>;
}

interface ReadyChild extends ChildHandle {
  /** Resolves once `isReady()` first holds; rejects if it never does within `maxSpins`. */
  ready: Promise<void>;
}

const SPIN_MS = 10;

/** Spawns `node -e <source>` and gives a handle whose `ready` resolves once `isReady()` holds. */
export function spawnReadyChild(
  source: string,
  isReady: () => boolean,
  missingMessage: string,
  maxSpins = 500,
): ReadyChild {
  const child = spawn(process.execPath, ["-e", source]);
  child.stderr?.resume();
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const ready = (async () => {
    for (let i = 0; !isReady(); i++) {
      if (i > maxSpins) throw new Error(missingMessage);
      await new Promise((r) => setTimeout(r, SPIN_MS));
    }
  })();
  return { child, ready, exited };
}

/** Spawns a real node process that idles until killed — a stand-in for a live orchestrator (or
 * any process a test only needs "alive"). STDIO is ignored and it runs under the owner watch
 * (exitWithOwnerEnv), so it cannot outlive the test process; tear it down with `stopChild`.
 * (`lock.test.ts`'s `sleeperPid` is deliberately not this: it wants only an ephemeral pid and
 * lets the 500 ms sleeper expire on its own rather than holding a child to kill.) */
export function spawnLiveChild(script = "setInterval(() => {}, 1000)"): ChildHandle {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: exitWithOwnerEnv() });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, exited };
}

/** Kills a child and waits for it to exit; safe to call after it has already exited. */
export async function stopChild(handle: ChildHandle): Promise<void> {
  handle.child.kill();
  await handle.exited;
}
