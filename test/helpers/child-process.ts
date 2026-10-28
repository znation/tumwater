// Spawning a helper process under a test's control. The cross-process lock and
// read-modify-write race tests all need the same three steps: run an inline `node -e` script,
// drain its stderr so it cannot block, then poll for a condition that marks it ready (a
// `ready` file it wrote, a lock it took). `spawnReadyChild` bundles those. Tests that only
// need a process to be *alive* — a stand-in orchestrator — spawn one with `spawnLiveChild`
// instead. `stopChild` bundles the SIGKILL-and-wait teardown both share.
//
// A child's readiness poll must yield between spins (`await`, `Atomics.wait`, or a timer): a
// synchronous `while (!fs.existsSync(...)) {}` holds the event loop, the owner preload
// (test/helpers/exit-with-owner.ts) can never fire, and the child outlives the test. The rule
// is enforced deterministically by test/test-child-spin-guard.test.ts over `test/**/*.ts`; keep
// any new poll here and in child sources text below yielding (see `spawnLockHolder`'s
// `Atomics.wait` and the `sleep`-based readiness handshake).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { exitWithOwnerEnv } from "../fixtures/victim-fixture.js";
import { sleep } from "./wait.js";

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
  const child = spawn(process.execPath, ["-e", source], { env: exitWithOwnerEnv() });
  child.stderr?.resume();
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const ready = (async () => {
    for (let i = 0; !isReady(); i++) {
      if (i > maxSpins) throw new Error(missingMessage);
      await sleep(SPIN_MS);
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

/** Runs a node script synchronously with `args` and returns its exit status and output, the
 * output defaulting to "" when the stream is absent. `env` (when given) is layered over the
 * test process's environment. */
export function runNodeScript(
  script: string,
  args: string[],
  env?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Spawns a child that takes `lock` (`withStateLock` or `withSyncLock`), runs `before` under it
 * (e.g. snapshot a file), writes the `ready` file, then waits up to 1.5 s for `until` — a JS
 * expression, false when it throws — and runs `after` (where the `until()` function is still in
 * scope) before releasing. `outside` runs before the lock is requested. All three are source
 * text for the child. The race tests use it to hold a lock while the parent's writer contends. */
export function spawnLockHolder(opts: {
  lock: string;
  ready: string;
  withLock: "withStateLock" | "withSyncLock";
  outside?: string;
  before?: string;
  until: string;
  after: string;
  /** The error when the child never reports ready; names the primary-worktree lock by default. */
  missingMessage?: string;
}): ReadyChild {
  const lockModule = fileURLToPath(new URL("../../src/concurrency/lock.js", import.meta.url));
  return spawnReadyChild(
    `const fs = require("node:fs");
     ${opts.outside ?? ""}
     import(${JSON.stringify(lockModule)}).then(({ ${opts.withLock} }) => ${opts.withLock}(${JSON.stringify(opts.lock)}, () => {
       ${opts.before ?? ""}
       fs.writeFileSync(${JSON.stringify(opts.ready)}, "1");
       const until = () => { try { return (${opts.until}); } catch { return false; } };
       const deadline = Date.now() + 1500;
       while (Date.now() < deadline && !until()) {
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
       }
       ${opts.after}
     }));`,
    () => fs.existsSync(opts.ready),
    opts.missingMessage ?? "the holder child never took the primary-worktree lock",
  );
}
