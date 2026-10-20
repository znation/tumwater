/** pollDiskGate edges (src/gates/disk-gate.ts) that test/disk-gate.test.ts leaves open: the floor
 * itself does not hold, a null sample lifts an active hold, and the unmeasurable warning is
 * spent once per process even when measurable samples arrive between null ones. Asserts return
 * values and the warning count only — never whether a lifted hold logs a closing `disk_ok`. */

import test from "node:test";
import assert from "node:assert/strict";

import { BYTES_PER_GB, newDiskGateState, pollDiskGate } from "../src/gates/disk-gate.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { eventTypes, warningEvents } from "./fixtures/log-fixtures.js";

test("pollDiskGate: the floor itself does not hold, a null sample lifts an active hold, and the unmeasurable warning fires once per process", () => {
  const root = tmpdir("disk-gate-edges-");
  const state = newDiskGateState();
  const B = BYTES_PER_GB;

  // Exactly at the floor: the entry is strict, so nothing holds and nothing logs.
  assert.equal(pollDiskGate(root, 10 * B, 10, state), false);
  assert.deepEqual(eventTypes(root), []);

  // Below the floor holds; a null sample then lifts it.
  assert.equal(pollDiskGate(root, 9 * B, 10, state), true);
  assert.equal(pollDiskGate(root, null, 10, state), false);

  // A measurable sample, then another null: still one warning for the process.
  assert.equal(pollDiskGate(root, 40 * B, 10, state), false);
  assert.equal(pollDiskGate(root, null, 10, state), false);
  assert.equal(warningEvents(readEvents(root, 100)).length, 1);
});
