import { sleep } from "./helpers/wait.js";
import { TUMWATER_SOURCE } from "../src/events/events.js";
import { spawn } from "node:child_process";
import { readJson } from "./helpers/json-read.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESTART_EXIT_CODE } from "../src/redeploy/redeploy-policy.js";
import {
  RUN_WINDOW_START_ENV,
  type ChildExit,
  type TeamDown,
  teamDownEvent,
  MAX_RAPID_RESPAWNS,
  RESPAWN_WINDOW_MS,
  startParentDeathWatch,
  expectedSupervisorPid,
  SUPERVISED_ENV,
  SUPERVISOR_PID_ENV,
  spawnRunChild,
  spawnGuiChild,
  superviseRun,
  ONCE_FAILED_EXIT_CODE,
} from "../src/process/supervisor.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The respawn loop behind `tumwater run` (src/process/supervisor.ts), driven with a scripted child
// so
// the policy is pinned without spawning processes: respawn on the restart code, exit with any
// other code, honor a stop request, and refuse to spin on a crash-looping build.

function scripted(codes: Array<number | null>): { spawnChild: (signal: AbortSignal) => Promise<ChildExit>; spawns: number } {
  const state = { spawns: 0 };
  return {
    get spawns() {
      return state.spawns;
    },
    spawnChild: async () => {
      const code = state.spawns < codes.length ? codes[state.spawns]! : 0;
      state.spawns += 1;
      return { code, signal: code === null ? "SIGKILL" : null };
    },
  };
}

test("superviseRun respawns on the restart code and exits with the final generation's code", async () => {
  const child = scripted([RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0]);
  const generations: number[] = [];
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, onRespawn: (g) => generations.push(g) },
    new AbortController().signal,
  );
  assert.equal(code, 0);
  assert.equal(child.spawns, 3, "two restarts, then a clean exit");
  assert.deepEqual(generations, [2, 3]);
});

test("a once round's failed exit code passes through without paging", async () => {
  const child = scripted([ONCE_FAILED_EXIT_CODE]);
  let paged = 0;
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, onTeamDown: () => { paged += 1; } },
    new AbortController().signal,
  );
  assert.equal(code, ONCE_FAILED_EXIT_CODE);
  assert.equal(paged, 0);
});

test("superviseRun passes a failing child's exit straight through (no respawn)", async () => {
  const child = scripted([1]);
  assert.equal(await superviseRun({ spawnChild: child.spawnChild, stopping: () => false }, new AbortController().signal), 1);
  assert.equal(child.spawns, 1);
  // A child killed by a signal has no code: the supervisor reports failure, never respawns.
  const killed = scripted([null]);
  assert.equal(await superviseRun({ spawnChild: killed.spawnChild, stopping: () => false }, new AbortController().signal), 1);
  assert.equal(killed.spawns, 1);
});

test("superviseRun runs onDone once on every ending, and its failure never changes the exit", async () => {
  // The end-of-supervision repair hook: the production wiring restores an interrupted build
  // swap to dist/ (build-stage.recoverInterruptedSwap). It must run for a failure ending too —
  // that is exactly the mid-swap SIGKILL shape — and a hook that throws must leave the child's
  // exit code intact, since the repair is best-effort and the caller reports its own failure.
  const failed = scripted([1]);
  let done = 0;
  const code = await superviseRun(
    {
      spawnChild: failed.spawnChild,
      stopping: () => false,
      onDone: () => {
        done += 1;
        throw new Error("simulated repair failure");
      },
    },
    new AbortController().signal,
  );
  assert.equal(code, 1, "onDone's failure never changes the exit");
  assert.equal(done, 1, "the hook runs exactly once");

  // Also on a clean exit, and exactly once after respawns.
  const clean = scripted([RESTART_EXIT_CODE, 0]);
  let cleanDone = 0;
  const cleanCode = await superviseRun(
    { spawnChild: clean.spawnChild, stopping: () => false, onDone: () => { cleanDone += 1; } },
    new AbortController().signal,
  );
  assert.equal(cleanCode, 0);
  assert.equal(cleanDone, 1);
});

test("a restart request after the operator asked to stop ends the supervisor instead of respawning", async () => {
  const child = scripted([RESTART_EXIT_CODE]);
  const code = await superviseRun({ spawnChild: child.spawnChild, stopping: () => true }, new AbortController().signal);
  assert.equal(code, RESTART_EXIT_CODE, "the child's own code is what the operator sees");
  assert.equal(child.spawns, 1);
});

test("the crash-loop guard gives up after too many rapid respawns", async () => {
  const child = scripted(Array(MAX_RAPID_RESPAWNS + 5).fill(RESTART_EXIT_CODE));
  let tripped = 0;
  let now = 1_000_000;
  const code = await superviseRun(
    {
      spawnChild: child.spawnChild,
      stopping: () => false,
      onCrashLoop: () => (tripped += 1),
      now: () => (now += 1000), // every respawn one second after the last — all inside the window
    },
    new AbortController().signal,
  );
  assert.equal(code, 1);
  assert.equal(tripped, 1);
  assert.equal(child.spawns, MAX_RAPID_RESPAWNS + 1, "the guard trips on the respawn past the cap");
});

test("respawns spaced wider than the window never trip the guard", async () => {
  const child = scripted([...Array(MAX_RAPID_RESPAWNS + 3).fill(RESTART_EXIT_CODE), 0]);
  let now = 1_000_000;
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, now: () => (now += RESPAWN_WINDOW_MS + 1) },
    new AbortController().signal,
  );
  assert.equal(code, 0);
  assert.equal(child.spawns, MAX_RAPID_RESPAWNS + 4);
});

// A team that goes down without the operator asking must leave a trace (BUGS.md 2026-09-23): on
// 2026-09-22 a respawned generation exited "not initialized", the supervisor exited with it, and
// events.jsonl simply ended at the previous generation's orchestrator_stop.

test("a generation that dies unasked is reported through onTeamDown before the supervisor exits", async () => {
  const child = scripted([RESTART_EXIT_CODE, 1]);
  const downs: TeamDown[] = [];
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, onTeamDown: (d) => void downs.push(d) },
    new AbortController().signal,
  );
  assert.equal(code, 1, "the exit code is still the child's");
  assert.deepEqual(downs, [{ generation: 2, exit: { code: 1, signal: null }, crashLoop: false }]);

  // A signal death is a failure too — including the operator's own first generation.
  const killed = scripted([null]);
  const killedDowns: TeamDown[] = [];
  await superviseRun(
    { spawnChild: killed.spawnChild, stopping: () => false, onTeamDown: (d) => void killedDowns.push(d) },
    new AbortController().signal,
  );
  assert.deepEqual(killedDowns, [{ generation: 1, exit: { code: null, signal: "SIGKILL" }, crashLoop: false }]);
});

test("asked-for endings leave no team-down trace: a clean exit, or anything while stopping", async () => {
  for (const [codes, stopping] of [
    [[RESTART_EXIT_CODE, 0], false],
    [[1], true],
    [[RESTART_EXIT_CODE], true],
    [[null], true],
  ] as Array<[Array<number | null>, boolean]>) {
    const child = scripted(codes);
    let downs = 0;
    await superviseRun(
      { spawnChild: child.spawnChild, stopping: () => stopping, onTeamDown: () => void (downs += 1) },
      new AbortController().signal,
    );
    assert.equal(downs, 0, `codes ${JSON.stringify(codes)}, stopping ${stopping}`);
  }
});

test("a tripped crash-loop guard is reported as a team down too", async () => {
  const child = scripted(Array(MAX_RAPID_RESPAWNS + 5).fill(RESTART_EXIT_CODE));
  const downs: TeamDown[] = [];
  let now = 1_000_000;
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, onTeamDown: (d) => void downs.push(d), now: () => (now += 1000) },
    new AbortController().signal,
  );
  assert.equal(code, 1);
  assert.deepEqual(downs, [
    { generation: MAX_RAPID_RESPAWNS + 1, exit: { code: RESTART_EXIT_CODE, signal: null }, crashLoop: true },
  ]);
});

test("an onTeamDown that throws leaves the exit code the child's", async () => {
  const child = scripted([3]);
  const code = await superviseRun(
    {
      spawnChild: child.spawnChild,
      stopping: () => false,
      onTeamDown: async () => {
        throw new Error("ENOSPC");
      },
    },
    new AbortController().signal,
  );
  assert.equal(code, 3);
});

test("teamDownEvent carries generation, code or signal, and a reason only when one is known", () => {
  const diagnosed = teamDownEvent({ generation: 2, exit: { code: 1, signal: null }, crashLoop: false }, "not initialized");
  assert.deepEqual(diagnosed, { source: TUMWATER_SOURCE, type: "supervisor_exit", generation: 2, code: 1, reason: "not initialized" });
  const bare = teamDownEvent({ generation: 1, exit: { code: null, signal: "SIGKILL" }, crashLoop: false }, null);
  assert.deepEqual(bare, { source: TUMWATER_SOURCE, type: "supervisor_exit", generation: 1, code: null, signal: "SIGKILL" }, "no guess");
  const loop = teamDownEvent({ generation: 6, exit: { code: RESTART_EXIT_CODE, signal: null }, crashLoop: true }, null);
  assert.match(String(loop.reason), new RegExp(`restarted itself more than ${MAX_RAPID_RESPAWNS} times within 60s`));
});

// The production spawner is tested against a real child process — the only way to pin the argv/
// env contract and signal forwarding. Each test points process.argv[1] at a throwaway script in
// a temp dir, then restores it.

/** Write a child script that records what it saw (argv + SUPERVISED_ENV) to `outFile`, if any,
 * then runs `body`. Returns the script's path. */
function probeScript(dir: string, outFile: string | null, body: string): string {
  const p = path.join(dir, "child.mjs");
  fs.writeFileSync(
    p,
    'import fs from "node:fs";\n' +
      (outFile
        ? `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ argv2: process.argv[2], ${JSON.stringify(SUPERVISED_ENV)}: process.env[${JSON.stringify(SUPERVISED_ENV)}], ${JSON.stringify(SUPERVISOR_PID_ENV)}: process.env[${JSON.stringify(SUPERVISOR_PID_ENV)}], ${JSON.stringify(RUN_WINDOW_START_ENV)}: process.env[${JSON.stringify(RUN_WINDOW_START_ENV)}] }));\n`
        : "") + body,
  );
  return p;
}

/** Run `fn` with process.argv[1] swapped for `value`, restoring the original afterwards. */
function withArgv1(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const argv = process.argv as Array<string | undefined>;
  const original = argv[1];
  argv[1] = value;
  return fn().finally(() => {
    argv[1] = original;
  });
}

/** Resolves to `p`'s value, or rejects after `ms` so a hung child fails the test instead of hanging
 * it. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test("spawnRunChild runs the same script with `run`, SUPERVISED_ENV set, and reports its exit", async () => {
  const dir = tmpdir();
  try {
    for (const code of [0, 3]) {
      const outFile = path.join(dir, `evidence-${code}.json`);
      await withArgv1(probeScript(dir, outFile, `process.exit(${code});\n`), async () => {
        const exit = await within(spawnRunChild(new AbortController().signal), 15_000);
        assert.deepEqual(exit, { code, signal: null });
      });
      const seen = readJson<Record<string, unknown>>(path.join(dir, `evidence-${code}.json`));
      assert.equal(seen.argv2, "run", "the child is the same script with `run` as its command");
      assert.equal(seen[SUPERVISED_ENV], "1", "the child runs the orchestrator, not another supervisor");
      assert.equal(
        seen[SUPERVISOR_PID_ENV],
        String(process.pid),
        "the child is handed the supervisor's pid, so its watch fires even if this process dies first",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnGuiChild runs the same script with `gui`, and a silent stdio (run --tui) still lets it run", async () => {
  const dir = tmpdir();
  try {
    const outFile = path.join(dir, "evidence-gui.json");
    await withArgv1(probeScript(dir, outFile, "process.exit(0);\n"), async () => {
      const exit = await within(spawnGuiChild(new AbortController().signal), 15_000);
      assert.deepEqual(exit, { code: 0, signal: null });
    });
    assert.equal(readJson<Record<string, unknown>>(outFile).argv2, "gui", "the child is the same script with `gui` as its command");

    // `run --gui --tui` silences the dashboard child's stdio so its `tumwater gui at http://…`
    // banner cannot paint over the observer TUI's full-screen render; the child must still run
    // (a separate fs path still receives its writes) and report its exit.
    const silentOut = path.join(dir, "evidence-gui-silent.json");
    await withArgv1(
      probeScript(dir, silentOut, "process.exit(0);\n"),
      async () => {
        const e = await within(spawnGuiChild(new AbortController().signal, {}, ["ignore", "ignore", "ignore"]), 15_000);
        assert.deepEqual(e, { code: 0, signal: null });
      },
    );
    assert.equal(readJson<Record<string, unknown>>(silentOut).argv2, "gui");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnRunChild hands the child the extra env marks beside SUPERVISED_ENV", async () => {
  const dir = tmpdir();
  try {
    const outFile = path.join(dir, "evidence.json");
    await withArgv1(probeScript(dir, outFile, "process.exit(0);\n"), async () => {
      await within(spawnRunChild(new AbortController().signal, [], { [RUN_WINDOW_START_ENV]: "123" }), 15_000);
    });
    const seen = readJson<Record<string, unknown>>(outFile);
    assert.equal(seen[RUN_WINDOW_START_ENV], "123");
    assert.equal(seen[SUPERVISED_ENV], "1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnRunChild without a script path fails fast with code 1 and spawns nothing", async () => {
  const dir = tmpdir();
  try {
    await withArgv1(undefined, async () => {
      const exit = await spawnRunChild(new AbortController().signal);
      assert.deepEqual(exit, { code: 1, signal: null });
    });
    assert.equal(fs.readdirSync(dir).length, 0, "no child was spawned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnRunChild resolves with code 1 when the child cannot be spawned", async () => {
  const dir = tmpdir();
  const originalExecPath = process.execPath;
  try {
    // A spawn that never reaches a live process (here: an execPath that does not exist) emits
    // 'error' instead of 'exit'. The promise must settle — one left pending would freeze
    // `tumwater run` before its first tick, with nothing on screen to explain it.
    process.execPath = path.join(dir, "missing-node-binary");
    const exit = await within(spawnRunChild(new AbortController().signal), 15_000);
    assert.deepEqual(exit, { code: 1, signal: null }, "a failed spawn reads as failure, not success");
  } finally {
    process.execPath = originalExecPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("aborting the signal terminates a live child with SIGTERM", async () => {
  const dir = tmpdir();
  try {
    await withArgv1(probeScript(dir, null, "setTimeout(() => {}, 10_000);\n"), async () => {
      const controller = new AbortController();
      const pending = spawnRunChild(controller.signal);
      setTimeout(() => controller.abort(), 50);
      const exit = await within(pending, 15_000);
      assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The parent-death watch (the supervised generation's answer to a supervisor killed outright —
// SIGKILL cannot be trapped or forwarded). The injected-ppid test pins the policy without
// processes; the real-process test proves the shape the injection cannot: a SIGKILLed middle
// process reparents the grandchild, whose watch then fires.

/** A watch poll the test drives by hand: `fire` runs the registered check, `armed` reports
 * whether the watch still holds it. Logical time for a watch that needs no real process. */
function manualPoll(): { poll: (check: () => void) => () => void; fire: () => void; armed: () => boolean } {
  let check: (() => void) | undefined;
  return {
    poll: (fn) => {
      check = fn;
      return () => {
        check = undefined;
      };
    },
    fire: () => check?.(),
    armed: () => check !== undefined,
  };
}

test("startParentDeathWatch fires exactly once when the parent pid changes", () => {
  let ppid = 4242;
  let gone = 0;
  const watch = manualPoll();
  const stop = startParentDeathWatch(() => {
    gone += 1;
  }, { ppid: () => ppid, poll: watch.poll });
  watch.fire();
  assert.equal(gone, 0, "an unchanged parent pid never fires the watch");
  assert.equal(watch.armed(), true, "the watch is still polling");
  ppid = 1; // reparented — the supervisor died without forwarding
  watch.fire();
  assert.equal(gone, 1, "a changed parent pid fires the watch");
  assert.equal(watch.armed(), false, "the watch clears itself after firing");
  ppid = 999;
  watch.fire();
  assert.equal(gone, 1, "the watch never fires again");
  stop();
});

test("startParentDeathWatch with an expected parent fires on a parent that was gone before the watch started", () => {
  // The spawner handed its pid down, but died before the child's first read: that read is
  // already launchd's 1, and only the expectation can tell the parent is gone.
  let gone = 0;
  const reparented = manualPoll();
  const stopDead = startParentDeathWatch(() => {
    gone += 1;
  }, { ppid: () => 1, poll: reparented.poll, expectedPpid: 4242 });
  const alive = manualPoll();
  const stopAlive = startParentDeathWatch(() => {
    gone += 100;
  }, { ppid: () => 4242, poll: alive.poll, expectedPpid: 4242 });
  reparented.fire();
  alive.fire();
  assert.equal(gone, 1, "the reparented child fires; the one still under its parent does not");
  stopDead();
  stopAlive();
});

test("startParentDeathWatch releases a poll that fires its check synchronously at registration", () => {
  // A poll may run its first check before returning (an eager poll). That fires the watch while
  // its stop is still unassigned; the fired watch must still release the poll, so it never
  // leaves a timer or signal handler armed behind a verdict it already reached.
  let armed = false;
  let gone = 0;
  const stop = startParentDeathWatch(() => {
    gone += 1;
  }, {
    ppid: () => 1,
    expectedPpid: 4242,
    poll: (check) => {
      armed = true;
      check();
      return () => {
        armed = false;
      };
    },
  });
  assert.equal(gone, 1, "the eager poll's check fires the watch at registration");
  assert.equal(armed, false, "the fired watch released the poll it holds");
  stop();
  assert.equal(armed, false, "the returned stop is a no-op once fired");
});

test("expectedSupervisorPid reads a handed-down mark only for a live-for-certain pid", () => {
  assert.equal(expectedSupervisorPid({ [SUPERVISOR_PID_ENV]: "4242" }), 4242);
  assert.equal(expectedSupervisorPid({ [SUPERVISOR_PID_ENV]: "1" }), undefined, "1 is launchd/init, never a supervisor");
  assert.equal(expectedSupervisorPid({ [SUPERVISOR_PID_ENV]: "junk" }), undefined);
  assert.equal(expectedSupervisorPid({}), undefined, "an older supervisor's child falls back to its first read");
});

test("startParentDeathWatch takes a SIGKILLed supervisor's grandchild down with it", async () => {
  const dir = tmpdir();
  let supervisor: ReturnType<typeof spawn> | undefined;
  try {
    // The grandchild imports the same compiled module the production generation runs, so the
    // watch under test is the shipped code, not a reimplementation.
    const supervisorUrl = fileURLToPath(new URL("../src/process/supervisor.js", import.meta.url));
    const grandchild = path.join(dir, "grandchild.mjs");
    fs.writeFileSync(
      grandchild,
      `import { startParentDeathWatch } from ${JSON.stringify(supervisorUrl)};\n` +
        `import fs from "node:fs";\n` +
        `const [started, gone, expectedPpid] = process.argv.slice(2);\n` +
        // Every poll appends the ppid it saw, so a failure can tell "reparent never visible"
        // from "grandchild died without a verdict".
        `const seen = gone + ".seen";\n` +
        // The watch's poll is driven by SIGUSR2 from the test, fired only after the supervisor
        // is dead and the grandchild reparented: the verdict follows the signal, not a real
        // poll budget, so a loaded host cannot stretch it. The handler is registered before
        // `started` is written, so the test never signals a default-action death.
        `startParentDeathWatch(() => { fs.writeFileSync(gone, "gone"); process.exit(0); }, {\n` +
        `  expectedPpid: Number(expectedPpid),\n` +
        `  poll: (check) => {\n` +
        `    const onSignal = () => { fs.appendFileSync(seen, process.ppid + " "); check(); };\n` +
        `    process.on("SIGUSR2", onSignal);\n` +
        `    return () => process.off("SIGUSR2", onSignal);\n` +
        `  },\n` +
        `});\n` +
        // Written then renamed, so the test never sees `started` created but still empty or
        // partial, and reads a truncated pid.
        `fs.writeFileSync(started + ".tmp", String(process.pid));\n` +
        `fs.renameSync(started + ".tmp", started);\n` +
        `setInterval(() => {}, 10_000);\n` +
        // A leak guard, not part of the behavior under test: it must sit far beyond the
        // test's wait budget, so a broken run cannot leak the grandchild for long.
        `setTimeout(() => process.exit(1), 180_000);\n`,
    );
    const middle = path.join(dir, "middle.mjs");
    fs.writeFileSync(
      middle,
      `import { spawn } from "node:child_process";\n` +
        // The spawner hands its own pid down, exactly as the production supervisor does
        // through SUPERVISOR_PID_ENV.
        `spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4], String(process.pid)], { stdio: "ignore" }).unref();\n` +
        `setInterval(() => {}, 10_000);\n` +
        `setTimeout(() => process.exit(1), 180_000);\n`,
    );
    const started = path.join(dir, "started");
    const gone = path.join(dir, "gone");
    supervisor = spawn(process.execPath, [middle, grandchild, started, gone], { stdio: "ignore" });
    // The guards (180s) sit far above the wait budgets, so the only way this test can fail is
    // a child that never arms its watch at all; once armed, the handed-down pid makes the
    // watch fire on the first poll after the reparent.
    for (let i = 0; i < 300 && !fs.existsSync(started); i++) await sleep(50);
    assert.ok(fs.existsSync(started), "the grandchild armed its watch");
    const grandchildPid = Number(fs.readFileSync(started, "utf8"));
    // The shape SIGTERM cannot cover: no handler runs, nothing is forwarded — the supervisor
    // just vanishes and the grandchild reparents.
    process.kill(supervisor.pid!, "SIGKILL");
    // Advance the watch: each signal runs a poll in the grandchild, which sees its parent
    // changed and fires. A signal that lands before the reparent completes simply leaves the
    // watch armed, so retry within the bounded guard. A dropped watch never writes `gone`.
    let signals = 0;
    let brokeOnEsrch = false;
    // The bound is wall-clock, not a signal count: a starved grandchild coalesces pending
    // SIGUSR2s and may not be scheduled for many seconds, so a count spent while it was
    // starved would end the loop before it ever ran a poll.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !fs.existsSync(gone)) {
      try {
        process.kill(grandchildPid, "SIGUSR2");
        signals += 1;
      } catch {
        brokeOnEsrch = true; // the grandchild already exited
        break;
      }
      await sleep(50);
    }
    // Look once more: the grandchild writes `gone` just before exiting, so an ESRCH break
    // can race it.
    const verdict = fs.existsSync(gone);
    const seenPpids = fs.existsSync(`${gone}.seen`) ? fs.readFileSync(`${gone}.seen`, "utf8").trim() : "(none)";
    assert.ok(
      verdict,
      `the orphaned grandchild's watch fired and ran its stop path; ` +
        `${signals} SIGUSR2 sent, ${brokeOnEsrch ? "loop broke on ESRCH (grandchild exited without writing gone)" : "loop ran out of time"}, ` +
        `expected ppid ${supervisor.pid}, ppids the grandchild saw per poll: ${seenPpids}`,
    );
  } finally {
    // The long self-exit timers above are only a leak guard for a crashed run; a passing
    // or failing test tears both processes down here, so nothing outlives the test.
    try {
      if (supervisor?.pid) process.kill(supervisor.pid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const pid = Number(fs.readFileSync(path.join(dir, "started"), "utf8"));
      if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch { /* the grandchild never started or is already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
