import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MAINTENANCE_DAILY_FLOOR,
  countMaintenanceWindow,
  maintenanceQuota,
  newMaintenanceWindowCounter,
} from "../src/gates/maintenance-quota.js";
import { eventsLogPath } from "../src/paths.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { HOUR } from "./helpers/oracles.js";

// Tests for src/gates/maintenance-quota.ts (Work ratio 1a/4): the pure allowance verdict and
// the rolling-24 h merged-count memo behind it. The window is instant-shaped, so fixtures seed
// timestamps relative to Date.now() (ago-style) rather than local days.

test("maintenanceQuota computes the allowance, used, and held verdict", () => {
  assert.deepEqual(
    maintenanceQuota({ work: 10, maint: 32, inFlight: 0, perWorkLanding: 2 }),
    { allowance: 32, used: 32, held: true },
  );
  // One below the allowance is not held; the boundary is `used >= allowance`.
  assert.deepEqual(
    maintenanceQuota({ work: 10, maint: 31, inFlight: 0, perWorkLanding: 2 }),
    { allowance: 32, used: 31, held: false },
  );
});

test("the floor keeps the allowance at 12 when no work landed", () => {
  assert.equal(
    maintenanceQuota({ work: 0, maint: 11, inFlight: 0, perWorkLanding: 2 }).allowance,
    MAINTENANCE_DAILY_FLOOR,
  );
  assert.equal(MAINTENANCE_DAILY_FLOOR, 12);
});

test("an in-flight maintenance count adds to the used figure", () => {
  assert.deepEqual(
    maintenanceQuota({ work: 5, maint: 20, inFlight: 2, perWorkLanding: 2 }),
    { allowance: 22, used: 22, held: true },
  );
});

test("countMaintenanceWindow counts merged events by tier inside the last 24 h", () => {
  const root = tmpdir();
  const now = Date.now();
  const inside = now - 2 * HOUR;
  const outside = now - 25 * HOUR;
  writeEvents(root, [
    ...Array.from({ length: 3 }, (_, i) => ({ ts: inside, loop: "feature", type: "merged", commit: `f${i}` })),
    { ts: inside, loop: "director", type: "merged", commit: "d" },
    ...Array.from({ length: 5 }, (_, i) => ({ ts: inside, loop: "clean", type: "merged", commit: `c${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ ts: inside, loop: "readme", type: "merged", commit: `r${i}` })),
    // steward and plan are neither tier, so they are ignored.
    { ts: inside, loop: "steward", type: "merged", commit: "s" },
    ...Array.from({ length: 2 }, (_, i) => ({ ts: inside, loop: "plan", type: "merged", commit: `p${i}` })),
    // older than 24 h: excluded.
    ...Array.from({ length: 4 }, (_, i) => ({ ts: outside, loop: "clean", type: "merged", commit: `oc${i}` })),
    // a non-merged event inside the window is not a landing.
    { ts: inside, loop: "clean", type: "tick_end", tokens: 1 },
    // a tier-counted merge with no timestamp contributes nothing.
    { loop: "clean", type: "merged", commit: "nots" },
  ]);
  assert.deepEqual(countMaintenanceWindow(root, newMaintenanceWindowCounter(), now), { work: 4, maint: 7 });
});

test("a second count folds only the appended bytes and sees the new merge", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - 2 * HOUR, loop: "clean", type: "merged", commit: "a" }]);
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  const before = counter.offset;
  const line = JSON.stringify({ ts: now - 1 * HOUR, loop: "feature", type: "merged", commit: "b" }) + "\n";
  fs.appendFileSync(eventsLogPath(root), line);
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 1, maint: 1 });
  assert.equal(
    counter.offset,
    before + Buffer.byteLength(line),
    "the append branch must advance the folded offset by exactly the appended bytes",
  );
});

test("a rotated log is reseeded from the live file and its archive, not folded from the old offset", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - 2 * HOUR, loop: "feature", type: "merged", commit: "a" }]);
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 1, maint: 0 });
  // Rotation renames the live log away and a fresh one grows in its place (a new inode). The
  // reseed reads the new live file together with the archive generation that holds the old
  // merge — the merge is still inside the window, so it still counts.
  fs.renameSync(eventsLogPath(root), eventsLogPath(root) + ".1");
  writeEvents(root, [
    { ts: now - 1 * HOUR, loop: "clean", type: "merged", commit: "x" },
    { ts: now, loop: "clean", type: "merged", commit: "y" },
  ]);
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 1, maint: 2 });
});

test("a missing events log counts zero and seeds an empty memo", () => {
  const root = tmpdir();
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, Date.now()), { work: 0, maint: 0 });
  assert.equal(counter.seeded, true);
});

test("an unchanged poll reuses the memo without reseeding", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - HOUR, loop: "clean", type: "merged", commit: "a" }]);
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  const offset = counter.offset;
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  assert.equal(counter.offset, offset, "an unchanged file must not move the folded offset");
});

test("appended lines that are torn, non-merged, tierless, or timestamp-less are ignored", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - 2 * HOUR, loop: "clean", type: "merged", commit: "a" }]);
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  const appended = [
    "{ torn",
    JSON.stringify({ ts: now - HOUR, loop: "clean", type: "tick_end", tokens: 1 }),
    JSON.stringify({ ts: now - HOUR, loop: "steward", type: "merged", commit: "s" }),
    JSON.stringify({ loop: "feature", type: "merged", commit: "x" }),
    JSON.stringify({ ts: now - HOUR / 2, loop: "feature", type: "merged", commit: "b" }),
  ];
  fs.appendFileSync(eventsLogPath(root), appended.join("\n") + "\n");
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 1, maint: 1 });
});

test("records that age past the rolling window are dropped from the memo", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - 23 * HOUR, loop: "clean", type: "merged", commit: "a" }]);
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  // Two hours later the same, unchanged record sits 25 h back — outside the window.
  assert.deepEqual(countMaintenanceWindow(root, counter, now + 2 * HOUR), { work: 0, maint: 0 });
  assert.equal(counter.records.length, 0);
});
