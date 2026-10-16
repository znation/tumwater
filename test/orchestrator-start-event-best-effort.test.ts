/** The orchestrator's own startup event is best-effort (src/events/events.ts's
 * logEventBestEffort). runOrchestrator writes it BEFORE the try/finally that owns the poll
 * loop's best-effort emit and the shutdown cleanup, so a raw logEvent throw there would stop
 * the fleet from starting over an informational event — and skip the finally that disposes the
 * notifier and removes the info file. The fault is injected by putting a directory where
 * events.jsonl belongs: every append throws EISDIR while every other state file still writes,
 * so a fleet that can run must still start and finish a once round. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadLoopState } from "../src/loop/loop-state.js";
import { makeFastRepo, onceRound } from "./fixtures/orchestrator-fixtures.js";
import { unwritableEvents } from "./fixtures/log-fixtures.js";
import { withIdlePi } from "./fakes/fake-pi.js";

test("runOrchestrator starts and finishes a once round when the events feed is unwritable", async () => {
  const repo = await makeFastRepo("orchestrator start best-effort", ["clean"]);
  unwritableEvents(repo);
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "the round exits on its own");
    assert.equal(loadLoopState(repo, "clean").runs, 1, "the enabled role still ticked");
  });
});
