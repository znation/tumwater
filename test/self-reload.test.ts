import test from "node:test";
import assert from "node:assert/strict";
import type { BuildInfo } from "../src/build-info.js";
import {
  createReloadWatch,
  DASHBOARD_CHILD_ENV,
  reexecSelf,
  shouldReload,
  type ReloadChild,
  type ReloadSpawn,
} from "../src/ui/self-reload.js";
import { RESTART_EXIT_CODE } from "../src/redeploy-policy.js";
import { ExitError } from "./exit-capture.js";
import { sleep } from "./wait.js";

// The dashboards' auto-reload (src/ui/self-reload.ts): decide staleness from the process's own
// startup stamp versus the on-disk stamp, then re-exec the same command once. All seams are
// injected so these tests launch no process, run no git, and touch no dist.

const stamp = (sha: string): BuildInfo => ({ sha, builtAt: 1, root: "/r" });

test("shouldReload is true only when both stamps exist and name different commits", () => {
  const a = stamp("a");
  const b = stamp("b");
  assert.equal(shouldReload(a, b), true, "a newer disk build reloads");
  assert.equal(shouldReload(a, a), false, "the same build never reloads");
  assert.equal(shouldReload(a, null), false, "a missing disk stamp is not staleness");
  assert.equal(shouldReload(null, b), false, "a stampless startup never reloads");
  assert.equal(shouldReload(null, null), false);
});

interface FakeListeners {
  exit?: (code: number | null) => void;
  error?: (err: Error) => void;
}

/** A spawner that records each call and hands back a fresh child per call, its listeners
 * captured separately, so a test can drive the exit/error events of any generation without
 * launching anything. */
function fakeSpawn(): {
  calls: Array<[string, string[], { stdio: string; env: Record<string, string | undefined> }]>;
  spawnImpl: ReloadSpawn;
  children: FakeListeners[];
} {
  const calls: Array<[string, string[], { stdio: string; env: Record<string, string | undefined> }]> = [];
  const children: FakeListeners[] = [];
  const spawnImpl: ReloadSpawn = (command, args, options) => {
    calls.push([command, args, options]);
    const listeners: FakeListeners = {};
    children.push(listeners);
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "exit") listeners.exit = listener as (code: number | null) => void;
        else listeners.error = listener as (err: Error) => void;
      },
    } as ReloadChild;
  };
  return { calls, spawnImpl, children };
}

/** Run fn with process.exit intercepted (the shared ExitError sentinel from
 * test/exit-capture.ts); returns the code it was called with. */
function captureExit(fn: () => void): number {
  const realExit = process.exit;
  let code = -1;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(c ?? 0);
  }) as typeof process.exit;
  try {
    fn();
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
  } finally {
    process.exit = realExit;
  }
  return code;
}

test("reexecSelf spawns this exact command with inherited stdio and the child mark", () => {
  const { calls, spawnImpl } = fakeSpawn();
  captureExit(() => reexecSelf(spawnImpl));
  assert.deepEqual(calls, [[
    process.execPath,
    process.argv.slice(1),
    { stdio: "inherit", env: { ...process.env, [DASHBOARD_CHILD_ENV]: "1" } },
  ]]);
});

test("reexecSelf exits with the child's code; a null code or spawn error becomes 1", () => {
  const first = fakeSpawn();
  assert.equal(captureExit(() => {
    reexecSelf(first.spawnImpl);
    first.children[0]?.exit?.(7);
  }), 7, "the child's exit code is propagated");

  const second = fakeSpawn();
  assert.equal(captureExit(() => {
    reexecSelf(second.spawnImpl);
    second.children[0]?.exit?.(null);
  }), 1, "a signal death exits 1");

  const third = fakeSpawn();
  assert.equal(captureExit(() => {
    reexecSelf(third.spawnImpl);
    third.children[0]?.error?.(new Error("boom"));
  }), 1, "a failed spawn exits 1");
});

test("reexecSelf respawns a sibling on the child's restart code — depth stays at two across reloads", () => {
  // BUGS.md 2026-09-30: the old shape spawned one child and exited with its code, so each
  // reload wrapped another idle wrapper onto the process chain. The supervisor shape: the
  // child asks for a fresh generation with RESTART_EXIT_CODE and this process respawns it —
  // however many redeploys land, there is never a grandchild.
  const fake = fakeSpawn();
  captureExit(() => reexecSelf(fake.spawnImpl));
  assert.equal(fake.calls.length, 1);
  fake.children[0]?.exit?.(RESTART_EXIT_CODE); // first reload: respawn, do NOT exit
  assert.equal(fake.calls.length, 2, "a restart code respawns a sibling instead of exiting");
  fake.children[1]?.exit?.(RESTART_EXIT_CODE); // second reload: still no nesting, still no exit
  assert.equal(fake.calls.length, 3, "every reload respawns; the supervisor never accumulates");
  fake.children[2]?.exit?.(0); // an operator stop finally ends the whole dashboard
});

test("a supervised child (the mark set) exits the restart code instead of spawning", () => {
  const fake = fakeSpawn();
  process.env[DASHBOARD_CHILD_ENV] = "1";
  try {
    assert.equal(captureExit(() => reexecSelf(fake.spawnImpl)), RESTART_EXIT_CODE);
    assert.equal(fake.calls.length, 0, "the child asks its supervisor; it never spawns a grandchild");
  } finally {
    delete process.env[DASHBOARD_CHILD_ENV];
  }
});

test("createReloadWatch fires exactly once when a newer disk build appears", async () => {
  let disk: BuildInfo | null = stamp("a");
  let fired = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("a"),
    readDisk: () => disk,
    isSelfHostedImpl: async () => true,
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start();
    await sleep(20);
    assert.equal(fired, 0, "identical stamps stay quiet");
    disk = stamp("b");
    await sleep(30);
    assert.equal(fired, 1, "a differing stamp fires once");
    await sleep(30);
    assert.equal(fired, 1, "one-shot even while the disk keeps differing");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch never polls for a build compiled from another root", async () => {
  // A tumwater installed elsewhere and pointed at this project: its stamp names the install's
  // own root, so no disk change here is ever this process's redeploy.
  let fired = 0;
  let gateCalls = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: { sha: "a", builtAt: 1, root: "/installed/tumwater" },
    readDisk: () => stamp("b"),
    isSelfHostedImpl: async () => {
      gateCalls++;
      return false;
    },
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start();
    await sleep(30);
    assert.equal(fired, 0);
    assert.equal(gateCalls, 1, "only the startup gate asked: no interval ever ran");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch never reloads onto a stamp naming no commit here, and asks git once per stamp", async () => {
  // BUGS.md 2026-09-29: a test wrote a fake "eeee…" stamp into a live checkout's dist, the
  // dashboard re-exec'd onto it, and the new process — whose startup stamp resolved to no
  // commit — never watched again. A bogus stamp must not be reloaded onto at all.
  let disk: BuildInfo | null = stamp("a");
  let fired = 0;
  const asked: string[] = [];
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("a"),
    readDisk: () => disk,
    isSelfHostedImpl: async (_root, info) => {
      asked.push(info.sha);
      return info.sha !== "bogus";
    },
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start();
    disk = stamp("bogus");
    await sleep(40);
    assert.equal(fired, 0, "a stamp naming no commit of this repo is not a build to reload onto");
    assert.deepEqual(asked, ["a", "bogus"], "the bogus stamp is asked about once, not on every poll");
    disk = stamp("b");
    await sleep(30);
    assert.equal(fired, 1, "the next real build still reloads");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch recovers from an unresolvable startup stamp compiled in this root", async () => {
  // The other half of the same incident: a process already started on a bogus stamp of this
  // checkout keeps watching, so the next real build — not an operator restart — brings it back.
  let disk: BuildInfo | null = stamp("eeee");
  let fired = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("eeee"),
    readDisk: () => disk,
    isSelfHostedImpl: async (_root, info) => info.sha !== "eeee" && info.sha !== "ffff",
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start();
    await sleep(20);
    assert.equal(fired, 0, "an unchanged stamp stays quiet");
    disk = stamp("ffff");
    await sleep(30);
    assert.equal(fired, 0, "another bogus stamp is still no build to reload onto");
    disk = stamp("b");
    await sleep(30);
    assert.equal(fired, 1, "a real build of this checkout ends the stuck state");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch survives a failed self-hosted check: it un-latches and fires on the same stamp", async () => {
  // A transient check failure (git wedged, say) must not wedge the watch: the in-flight guard
  // clears on the rejection, and the SAME differing stamp is retried on the next poll rather
  // than being consumed or rejected — only a definitive "not self-hosted" verdict sets that.
  let fail = false;
  let fired = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("a"),
    readDisk: () => stamp("b"),
    isSelfHostedImpl: async () => {
      if (fail) throw new Error("git unavailable");
      return true;
    },
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start(); // the boot-time gate runs before the disk can differ; it succeeds here
    fail = true;
    await sleep(20);
    assert.equal(fired, 0, "checks that cannot run never fire the reload");
    fail = false;
    await sleep(20);
    assert.equal(fired, 1, "recovery fires on the same stamp the failed checks kept seeing");
    await sleep(20);
    assert.equal(fired, 1, "still one-shot after a rejected check");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch never fires with a stampless startup and skips the async gate", async () => {
  let fired = 0;
  let gateCalls = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: null,
    readDisk: () => stamp("b"),
    isSelfHostedImpl: async () => {
      gateCalls++;
      return true;
    },
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start();
    await sleep(30);
    assert.equal(fired, 0);
    assert.equal(gateCalls, 0, "the null check precedes the non-null isSelfHosted call");
  } finally {
    watch.stop();
  }
});
