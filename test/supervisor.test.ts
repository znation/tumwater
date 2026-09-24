import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RESTART_EXIT_CODE } from "../src/redeploy.js";
import {
  type ChildExit,
  type FleetDown,
  fleetDownEvent,
  MAX_RAPID_RESPAWNS,
  RESPAWN_WINDOW_MS,
  SUPERVISED_ENV,
  spawnRunChild,
  superviseRun,
} from "../src/supervisor.js";
import { tmpdir } from "./util.js";

// The respawn loop behind `tumwater run` (src/supervisor.ts), driven with a scripted child so
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

test("superviseRun passes a failing child's exit straight through (no respawn)", async () => {
  const child = scripted([1]);
  assert.equal(await superviseRun({ spawnChild: child.spawnChild, stopping: () => false }, new AbortController().signal), 1);
  assert.equal(child.spawns, 1);
  // A child killed by a signal has no code: the supervisor reports failure, never respawns.
  const killed = scripted([null]);
  assert.equal(await superviseRun({ spawnChild: killed.spawnChild, stopping: () => false }, new AbortController().signal), 1);
  assert.equal(killed.spawns, 1);
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

// A fleet that goes down without the operator asking must leave a trace (BUGS.md 2026-09-23): on
// 2026-09-22 a respawned generation exited "not initialized", the supervisor exited with it, and
// events.jsonl simply ended at the previous generation's orchestrator_stop.

test("a generation that dies unasked is reported through onFleetDown before the supervisor exits", async () => {
  const child = scripted([RESTART_EXIT_CODE, 1]);
  const downs: FleetDown[] = [];
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, onFleetDown: (d) => void downs.push(d) },
    new AbortController().signal,
  );
  assert.equal(code, 1, "the exit code is still the child's");
  assert.deepEqual(downs, [{ generation: 2, exit: { code: 1, signal: null }, crashLoop: false }]);

  // A signal death is a failure too — including the operator's own first generation.
  const killed = scripted([null]);
  const killedDowns: FleetDown[] = [];
  await superviseRun(
    { spawnChild: killed.spawnChild, stopping: () => false, onFleetDown: (d) => void killedDowns.push(d) },
    new AbortController().signal,
  );
  assert.deepEqual(killedDowns, [{ generation: 1, exit: { code: null, signal: "SIGKILL" }, crashLoop: false }]);
});

test("asked-for endings leave no fleet-down trace: a clean exit, or anything while stopping", async () => {
  for (const [codes, stopping] of [
    [[RESTART_EXIT_CODE, 0], false],
    [[1], true],
    [[RESTART_EXIT_CODE], true],
    [[null], true],
  ] as Array<[Array<number | null>, boolean]>) {
    const child = scripted(codes);
    let downs = 0;
    await superviseRun(
      { spawnChild: child.spawnChild, stopping: () => stopping, onFleetDown: () => void (downs += 1) },
      new AbortController().signal,
    );
    assert.equal(downs, 0, `codes ${JSON.stringify(codes)}, stopping ${stopping}`);
  }
});

test("a tripped crash-loop guard is reported as a fleet down too", async () => {
  const child = scripted(Array(MAX_RAPID_RESPAWNS + 5).fill(RESTART_EXIT_CODE));
  const downs: FleetDown[] = [];
  let now = 1_000_000;
  const code = await superviseRun(
    { spawnChild: child.spawnChild, stopping: () => false, onFleetDown: (d) => void downs.push(d), now: () => (now += 1000) },
    new AbortController().signal,
  );
  assert.equal(code, 1);
  assert.deepEqual(downs, [
    { generation: MAX_RAPID_RESPAWNS + 1, exit: { code: RESTART_EXIT_CODE, signal: null }, crashLoop: true },
  ]);
});

test("an onFleetDown that throws leaves the exit code the child's", async () => {
  const child = scripted([3]);
  const code = await superviseRun(
    {
      spawnChild: child.spawnChild,
      stopping: () => false,
      onFleetDown: async () => {
        throw new Error("ENOSPC");
      },
    },
    new AbortController().signal,
  );
  assert.equal(code, 3);
});

test("fleetDownEvent carries generation, code or signal, and a reason only when one is known", () => {
  const diagnosed = fleetDownEvent({ generation: 2, exit: { code: 1, signal: null }, crashLoop: false }, "not initialized");
  assert.deepEqual(diagnosed, { loop: "harness", type: "supervisor_exit", generation: 2, code: 1, reason: "not initialized" });
  const bare = fleetDownEvent({ generation: 1, exit: { code: null, signal: "SIGKILL" }, crashLoop: false }, null);
  assert.deepEqual(bare, { loop: "harness", type: "supervisor_exit", generation: 1, code: null, signal: "SIGKILL" }, "no guess");
  const loop = fleetDownEvent({ generation: 6, exit: { code: RESTART_EXIT_CODE, signal: null }, crashLoop: true }, null);
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
        ? `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ argv2: process.argv[2], ${JSON.stringify(SUPERVISED_ENV)}: process.env[${JSON.stringify(SUPERVISED_ENV)}] }));\n`
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

/** Resolves to `p`'s value, or rejects after `ms` so a hung child fails the test instead of hanging it. */
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
      const seen = JSON.parse(fs.readFileSync(path.join(dir, `evidence-${code}.json`), "utf8"));
      assert.equal(seen.argv2, "run", "the child is the same script with `run` as its command");
      assert.equal(seen[SUPERVISED_ENV], "1", "the child runs the orchestrator, not another supervisor");
    }
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
