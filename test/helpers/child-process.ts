// Spawning a short-lived helper process that signals its readiness — the cross-process lock
// and read-modify-write race tests all need the same three steps: run an inline `node -e`
// script, drain its stderr so it cannot block, then poll for a condition that marks it ready
// (a `ready` file it wrote, a lock it took). `spawnReadyChild` bundles those; `stopChild`
// bundles the `finally` teardown the race tests share.

import { spawn, type ChildProcess } from "node:child_process";

interface ReadyChild {
  child: ChildProcess;
  /** Resolves once `isReady()` first holds; rejects if it never does within `maxSpins`. */
  ready: Promise<void>;
  /** Resolves when the child process has exited. */
  exited: Promise<void>;
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

/** Kills a child and waits for it to exit; safe to call after it has already exited. */
export async function stopChild(handle: ReadyChild): Promise<void> {
  handle.child.kill();
  await handle.exited;
}
