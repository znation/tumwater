/** The orchestrator's own startup event is best-effort (src/events/events.ts's
 * logEventBestEffort). runOrchestrator writes it BEFORE the try/finally that owns the poll
 * loop's best-effort emit and the shutdown cleanup, so a raw logEvent throw there would stop
 * the fleet from starting over an informational event — and skip the finally that disposes the
 * notifier and removes the info file. The fault is injected by putting a directory where
 * events.jsonl belongs: every append throws EISDIR while every other state file still writes,
 * so a fleet that can run must still start and finish a once round. */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { eventsLogPath } from "../src/paths.js";
import { loadLoopState } from "../src/loop/loop-state.js";
import { makeFastRepo, onceRound } from "./fixtures/orchestrator-fixtures.js";
import { withIdlePi } from "./fakes/fake-pi.js";

/** Put a directory where the append-only events log belongs: every logEvent under `root`
 * throws EISDIR, while every other file under the real root still writes normally. */
function unwritableEvents(root: string): void {
  const file = eventsLogPath(root);
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(file, { recursive: true });
}

test("runOrchestrator starts and finishes a once round when the events feed is unwritable", async () => {
  const repo = await makeFastRepo("orchestrator start best-effort", ["clean"]);
  unwritableEvents(repo);
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "the round exits on its own");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "the enabled role still ticked");
  });
});
