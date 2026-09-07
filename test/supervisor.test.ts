import test from "node:test";
import assert from "node:assert/strict";
import { RESTART_EXIT_CODE } from "../src/redeploy.js";
import { type ChildExit, MAX_RAPID_RESPAWNS, RESPAWN_WINDOW_MS, superviseRun } from "../src/supervisor.js";

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
