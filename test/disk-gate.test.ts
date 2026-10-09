/** sampleFreeBytes / pollDiskGate (src/gates/disk-gate.ts): the disk floor's measurement, the
 * hold's hysteresis, and the edge-triggered disk_low/disk_ok events the orchestrator's poll
 * loop depends on. The gate's live wiring — role ticks, the director, vets and merges blocked
 * while held, a live diskHoldGB edit lifting it — is pinned in test/gate-polls.test.ts (the
 * sampler is injectable there); this file covers the unit surface. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BYTES_PER_GB,
  DISK_HOLD_HYSTERESIS_GB,
  diskVolumePath,
  newDiskGateState,
  pollDiskGate,
  sampleFreeBytes,
  type StatfsLike,
} from "../src/gates/disk-gate.js";
import { worktreesDir } from "../src/paths.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

function typesAt(root: string): string[] {
  return readEvents(root, 100).map((e) => e.type);
}

test("sampleFreeBytes measures the worktrees volume once it exists, else the root", () => {
  const root = tmpdir("disk-gate-sample-");
  const seen: string[] = [];
  const probe: StatfsLike = (p) => {
    seen.push(String(p));
    return { bavail: 12_000_000_000, bsize: 1 } as fs.StatsFs;
  };
  // Before the worktrees dir exists, the root's own volume is measured.
  assert.equal(sampleFreeBytes(root, probe), 12_000_000_000);
  assert.equal(seen.at(-1), root);
  // Once it exists, the worktrees dir is the measured path.
  fs.mkdirSync(worktreesDir(root), { recursive: true });
  assert.equal(sampleFreeBytes(root, probe), 12_000_000_000);
  assert.equal(seen.at(-1), worktreesDir(root));
  assert.equal(diskVolumePath(root), worktreesDir(root));
});

test("sampleFreeBytes returns null when statfs throws", () => {
  const root = tmpdir("disk-gate-throw-");
  assert.equal(
    sampleFreeBytes(root, () => {
      throw new Error("ENOSYS");
    }),
    null,
  );
});

test("pollDiskGate holds below the floor and one disk_low logs per crossing", () => {
  const root = tmpdir("disk-gate-hold-");
  const state = newDiskGateState();
  // 9 GB free against a 10 GB floor: held, one event.
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state), true);
  // Still low on the next poll: held, no second event.
  assert.equal(pollDiskGate(root, 9.5 * BYTES_PER_GB, 10, state), true);
  assert.deepEqual(typesAt(root), ["disk_low"]);
  const low = readEvents(root, 100)[0]!;
  assert.equal(low.loop, "harness");
  assert.equal(low.freeGB, 9);
  assert.equal(low.holdGB, 10);
});

test("pollDiskGate hysteresis: stays held until floor + 5, lifts with one disk_ok", () => {
  const root = tmpdir("disk-gate-hysteresis-");
  const state = newDiskGateState();
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state), true);
  // Inside the band below floor + DISK_HOLD_HYSTERESIS_GB: the hold stands.
  assert.equal(pollDiskGate(root, 14 * BYTES_PER_GB, 10, state), true);
  assert.equal(pollDiskGate(root, (10 + DISK_HOLD_HYSTERESIS_GB) * BYTES_PER_GB, 10, state), false);
  // Settled out of the hold: further high samples add no event.
  assert.equal(pollDiskGate(root, 40 * BYTES_PER_GB, 10, state), false);
  assert.deepEqual(typesAt(root), ["disk_low", "disk_ok"]);
  assert.equal(readEvents(root, 100)[1]!.freeGB, 15);
});

test("pollDiskGate: diskHoldGB 0 disables the hold at any free space", () => {
  const root = tmpdir("disk-gate-off-");
  const state = newDiskGateState();
  assert.equal(pollDiskGate(root, 1 * BYTES_PER_GB, 0, state), false);
  assert.equal(pollDiskGate(root, 0, 0, state), false);
  assert.deepEqual(typesAt(root), []);
});

test("pollDiskGate: a live edit to diskHoldGB 0 lifts an active hold on the next poll", () => {
  // The prevHeld===true branch: 0 must win over the hysteresis, or a fleet sitting inside
  // the old band would stay held after the operator disabled the hold.
  const root = tmpdir("disk-gate-off-live-");
  const state = newDiskGateState();
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state), true);
  assert.equal(pollDiskGate(root, 3 * BYTES_PER_GB, 0, state), false);
  assert.deepEqual(typesAt(root), ["disk_low", "disk_ok"]);
  assert.equal(readEvents(root, 100)[1]!.freeGB, 3);
});

test("pollDiskGate: a null sample never holds and warns once per process", () => {
  const root = tmpdir("disk-gate-null-");
  const state = newDiskGateState();
  assert.equal(pollDiskGate(root, null, 10, state), false);
  assert.equal(pollDiskGate(root, null, 10, state), false);
  assert.equal(pollDiskGate(root, null, 10, state), false);
  const events = readEvents(root, 100);
  assert.equal(events.filter((e) => e.type === "warning").length, 1);
  assert.equal(events.filter((e) => e.type === "disk_low").length, 0);
  // A measurable sample after the unmeasurable ones re-arms a fresh hold event.
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state), true);
  assert.deepEqual(
    readEvents(root, 100).map((e) => e.type),
    ["warning", "disk_low"],
  );
});

test("pollDiskGate: measured path detail is the worktrees dir when it exists", () => {
  const root = tmpdir("disk-gate-path-");
  fs.mkdirSync(worktreesDir(root), { recursive: true });
  assert.equal(diskVolumePath(root), path.join(root, ".tumwater", "worktrees"));
});

test("pollDiskGate: waitForReclaim defers entering the hold until the pass settles", () => {
  // plans/disk-floor.md part 2/4: below the floor, reclaim gets its chance first; the hold
  // enters only once no pressure pass is running.
  const root = tmpdir("disk-gate-wait-");
  const state = newDiskGateState();
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state, true), false);
  assert.deepEqual(typesAt(root), [], "no hold while reclaim still runs");
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state, false), true);
  assert.deepEqual(typesAt(root), ["disk_low"]);
  // It never lifts an active hold: reclaim starting while held changes nothing.
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state, true), true);
  assert.deepEqual(typesAt(root), ["disk_low"]);
});

test("pollDiskGate: an unwritable events feed does not throw out of the poll", () => {
  // Disk pressure is exactly when the feed can go unwritable (ENOSPC), so the disk_low report
  // must not be the thing that kills the orchestrator's catch-less poll loop — and the hold
  // must still engage. Root replaced by a regular file: .tumwater/log cannot exist under it,
  // so every logEvent under `root` throws ENOTDIR.
  const root = tmpdir("disk-gate-unwritable-");
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(root, "");
  const state = newDiskGateState();
  assert.equal(pollDiskGate(root, 9 * BYTES_PER_GB, 10, state), true);
  assert.equal(state.prevHeld, true, "the hold engages even when disk_low cannot be logged");
  // The unmeasurable-sample warning path is best-effort too, and still marks itself spent.
  const unmeasurable = newDiskGateState();
  assert.equal(pollDiskGate(root, null, 10, unmeasurable), false);
  assert.equal(
    unmeasurable.warnedUnmeasurable,
    true,
    "the once-per-process warning is marked spent",
  );
});
