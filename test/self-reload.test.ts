import test from "node:test";
import assert from "node:assert/strict";
import type { BuildInfo } from "../src/build/build-info.js";
import {
  captureStartupBuild,
  createReloadWatch,
  DASHBOARD_CHILD_ENV,
  reexecSelf,
  shouldReload,
  type ReloadChild,
  type ReloadSpawn,
  watchReloadSupervisor,
} from "../src/redeploy/self-reload.js";
import { readBuildInfo } from "../src/build/build-info.js";
import { RESTART_EXIT_CODE } from "../src/redeploy/redeploy-policy.js";
import { ExitError } from "./helpers/exit-capture.js";
import fs from "node:fs";
import path from "node:path";
import { commitIn, mainSha, makeRepo } from "./fixtures/repo-fixtures.js";
import { sleep, waitFor } from "./helpers/wait.js";

// The dashboards' auto-reload (src/redeploy/self-reload.ts): decide staleness from the process's own
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
 * test/helpers/exit-capture.ts); returns the code it was called with. */
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
    { stdio: "inherit", env: { ...process.env, [DASHBOARD_CHILD_ENV]: String(process.pid) } },
  ]]);
});

test("watchReloadSupervisor fires once the supervisor the mark names is gone, and never for an unsupervised dashboard", async () => {
  let ppid = 4242;
  const fired: string[] = [];
  const env = { [DASHBOARD_CHILD_ENV]: "4242" };
  const stopChild = watchReloadSupervisor(() => fired.push("child"), { env, ppid: () => ppid, intervalMs: 5 });
  // Started after its supervisor already died: the mark's pid, not the first read, decides.
  const stopLate = watchReloadSupervisor(() => fired.push("late"), { env, ppid: () => 1, intervalMs: 5 });
  // An older supervisor's "1" names no pid: the first read stands, and an unchanged parent never fires.
  const stopLegacy = watchReloadSupervisor(() => fired.push("legacy"), {
    env: { [DASHBOARD_CHILD_ENV]: "1" },
    ppid: () => 500,
    intervalMs: 5,
  });
  // Not a supervised child at all: a changed parent means nothing to a hand-launched dashboard.
  const stopPlain = watchReloadSupervisor(() => fired.push("plain"), { env: {}, ppid: () => ppid, intervalMs: 5 });
  try {
    await sleep(40);
    assert.deepEqual(fired, ["late"], "only the child whose supervisor was already gone fired");
    ppid = 1; // the supervisor was SIGKILLed and the child reparented
    await sleep(40);
    assert.deepEqual(fired.sort(), ["child", "late"], "the reparented child fires, exactly once each");
  } finally {
    stopChild();
    stopLate();
    stopLegacy();
    stopPlain();
  }
  const stopped: string[] = [];
  let parent = 4242;
  const stop = watchReloadSupervisor(() => stopped.push("x"), { env, ppid: () => parent, intervalMs: 5 });
  stop();
  parent = 1;
  await sleep(40);
  assert.deepEqual(stopped, [], "a stopped watch never fires");
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
  assert.equal(captureExit(() => fake.children[2]?.exit?.(0)), 0,
    "an operator stop finally ends the whole dashboard (intercepted, not a real exit)");
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

test("captureStartupBuild returns this process's own stamp, or null without one", () => {
  // gui/gui-server.ts and tui.tsx both call this at startup; its contract is a thin pass-through to
  // readBuildInfo, and the watch's whole gate keys off what it returns.
  const info = captureStartupBuild();
  if (info === null) return; // running outside a built tree is legitimate
  assert.equal(typeof info.sha, "string");
  assert.deepEqual(info, readBuildInfo(), "the startup stamp is exactly the on-disk stamp at boot");
});

test("createReloadWatch uses its own dist stamp when readDisk is not injected", async () => {
  // The seam default is what production runs: the watch polls this process's real dist. With a
  // startup stamp that differs from it, the watch asks the gate about the REAL on-disk stamp —
  // proving the default reader supplied it — and refuses to fire onto a stamp naming no commit.
  const asked: string[] = [];
  let fired = 0;
  const real = readBuildInfo();
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("aaaa"),
    isSelfHostedImpl: async (_root, info) => {
      asked.push(info.sha);
      return false; // not resolvable here, so the watch never fires whatever it reads
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
    if (real !== null) {
      assert.ok(asked.includes(real.sha), "the default reader fed the real dist stamp to the gate");
      assert.equal(asked.filter((s) => s === real.sha).length, 1,
        "the same default-read stamp is asked about once, like any other stamp");
    }
  } finally {
    watch.stop();
  }
});

test("createReloadWatch stays quiet while the on-disk stamp is missing", async () => {
  // Between a redeploy's swaps the stamp can briefly vanish; that is not a newer build. The
  // boot-time gate still runs once (the startup stamp exists); the polls must not ask it again
  // — and must not fire — while the disk stamp is gone.
  let disk: BuildInfo | null = stamp("a");
  let fired = 0;
  let gateCalls = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("a"),
    readDisk: () => disk,
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
    assert.equal(gateCalls, 1, "the boot gate runs once for the startup stamp");
    disk = null;
    await sleep(30);
    assert.equal(fired, 0, "a vanished stamp fires nothing");
    assert.equal(gateCalls, 1, "a vanished stamp is not asked about");
    disk = stamp("b");
    await sleep(30);
    assert.equal(fired, 1, "the watch is alive again once a stamp reappears");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch never arms its interval when stopped during the startup gate", async () => {
  // start() awaits the gate, then checks stopped; a stop that lands inside the gate must leave
  // no timer behind — the returned object is dead the moment stop() was called.
  const deferred: Array<() => void> = []; // one resolver per isSelfHosted call: [gate, polls...]
  let fired = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("a"),
    readDisk: () => stamp("b"),
    isSelfHostedImpl: () => new Promise<boolean>((resolve) => {
      deferred.push(() => resolve(true));
    }),
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    const starting = watch.start();
    assert.equal(deferred.length, 1, "the gate is the first self-hosted call");
    watch.stop();
    deferred[0]?.(); // let the gate settle onto a stopped watch
    await starting;
    await sleep(30);
    assert.equal(fired, 0, "a watch stopped inside its gate never polls, never fires");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch ignores an in-flight check that settles after stop", async () => {
  // stop() must win over a check that is already in flight: when the pending self-hosted
  // promise later resolves "yes", the stopped watch neither fires nor restarts its interval.
  const deferred: Array<() => void> = []; // one resolver per isSelfHosted call: [gate, polls...]
  let fired = 0;
  const watch = createReloadWatch({
    root: "/r",
    startupInfo: stamp("a"),
    readDisk: () => stamp("b"),
    isSelfHostedImpl: () => new Promise<boolean>((resolve) => {
      deferred.push(() => resolve(true));
    }),
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    const starting = watch.start();
    deferred[0]?.(); // the gate passes; the interval arms
    await starting;
    await sleep(10); // the first poll's check is now in flight
    assert.equal(deferred.length, 2, "the first poll asked the gate");
    watch.stop();
    deferred[1]?.(); // the in-flight check settles "yes" onto a stopped watch
    await sleep(30);
    assert.equal(fired, 0, "a check that settles after stop never fires the reload");
  } finally {
    watch.stop();
  }
});

test("createReloadWatch with the production gate fires onto a real commit and refuses a bogus one", async () => {
  // The default seam is what production runs: the real isSelfHosted (one git cat-file per new
  // stamp). A tiny fixture repo stands in for the checkout, so the gate is exercised against
  // git itself, offline: a stamp naming a real commit of the root reloads; a stamp naming no
  // commit is rejected, and a later real commit still fires.
  const repo = makeRepo();
  const seedSha = mainSha(repo);
  fs.writeFileSync(path.join(repo, "two.txt"), "two\n");
  commitIn(repo, "second");
  const secondSha = mainSha(repo);
  let disk: BuildInfo | null = { sha: seedSha, builtAt: 1, root: repo };
  let fired = 0;
  const watch = createReloadWatch({
    root: repo,
    startupInfo: { sha: seedSha, builtAt: 1, root: repo },
    readDisk: () => disk,
    intervalMs: 5,
    onTrigger: () => {
      fired++;
    },
  });
  try {
    await watch.start();
    await sleep(30);
    assert.equal(fired, 0, "the identical real commit stays quiet");
    disk = { sha: "bogus", builtAt: 1, root: repo };
    // The quiet windows can only under-test on a slow host (the bogus stamp's git call still in
    // flight when the window ends), never fail falsely — firing onto it is the bug either way.
    await sleep(100);
    assert.equal(fired, 0, "the real gate refuses a stamp naming no commit here");
    disk = { sha: secondSha, builtAt: 1, root: repo };
    // Awaited, not slept: the accept takes a real `git cat-file`, and a fixed 30 ms window
    // expired before it returned on a loaded host (9 of 24 parallel runs, 2026-10-01).
    await waitFor(() => fired === 1, "the real gate accepting a real newer commit", 10_000);
    assert.equal(fired, 1, "the real gate accepts a real newer commit exactly once");
  } finally {
    watch.stop();
  }
});

test("reexecSelf falls back to node's real spawner when none is injected", () => {
  // The default parameter is what production passes. Under the child mark the call exits the
  // restart code before spawning, so the default spawner is resolved but never launches a
  // process — the default is proven wired without starting anything.
  process.env[DASHBOARD_CHILD_ENV] = "1";
  try {
    assert.equal(captureExit(() => reexecSelf()), RESTART_EXIT_CODE);
  } finally {
    delete process.env[DASHBOARD_CHILD_ENV];
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
