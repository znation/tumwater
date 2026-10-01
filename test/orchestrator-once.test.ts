/** Unit-tier coverage for the once round's exit contract (src/orchestrator.ts's once-mode
 * return). The gating `npm test` never runs the e2e tier, so the shape `run --once`'s summary
 * reads — the restart flag, the per-role settle-reasons map, and the per-role ticks-run map —
 * was pinned only by orchestrator-once.e2e.test.ts. This file pins the idle-fleet round
 * itself in the declared check: it must exit on its own (a once round that hangs is the bug
 * `--once` exists to avoid), never report a restart, and count exactly one tick per role. */

import test from "node:test";
import assert from "node:assert/strict";
import { loadLoopState } from "../src/loop-state.js";
import { makeFastRepo, onceRound } from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";

test("once: an idle fleet exits on its own, ticks each role exactly once, and returns the once-mode shape", async () => {
  const repo = await makeFastRepo("once exit contract test", ["clean", "dry"]);
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "a once round never reports a restart");
    assert.ok(exit.settled instanceof Map, "once mode returns the settle-reasons map, not the bare daemon shape");
    assert.ok(exit.ticksRun instanceof Map, "once mode returns the per-role ticks-run map");
    assert.equal(exit.ticksRun?.get("clean"), 1, "clean ticked once in the round");
    assert.equal(exit.ticksRun?.get("dry"), 1, "dry ticked once in the round");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "clean's persisted state agrees with the round's count");
    assert.equal(loadLoopState(repo, "dry").ticks, 1, "dry's persisted state agrees with the round's count");
  } finally {
    restore();
  }
});
