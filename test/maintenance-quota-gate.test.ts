import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  countMaintenanceWindow,
  newMaintenanceQuotaGateState,
  newMaintenanceWindowCounter,
  pollMaintenanceQuotaGate,
} from "../src/gates/maintenance-quota.js";
import { eventsLogPath } from "../src/paths.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { HOUR } from "./helpers/oracles.js";

// Branches of src/gates/maintenance-quota.ts that test/maintenance-quota.test.ts leaves
// unpinned: which observers count as in flight, a legacy-id merge, and a vanished events log.

test("the in-flight figure skips disabled and work roles, and a legacy dry merge counts as maintenance", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - HOUR, loop: "dry", type: "merged", commit: "d" }]); // retired-name-ok: legacy event field in a fixture
  assert.deepEqual(countMaintenanceWindow(root, newMaintenanceWindowCounter(), now), { work: 0, maint: 1 });
  const observers = [
    { role: "clean", enabled: true, running: true, hasQueuedMerge: false },
    { role: "dedupe", enabled: false, running: true, hasQueuedMerge: true },
    { role: "feature", enabled: true, running: true, hasQueuedMerge: false },
  ];
  // 1 merged maintenance + the enabled clean instance; the disabled and work roles add nothing.
  assert.deepEqual(
    pollMaintenanceQuotaGate(root, newMaintenanceQuotaGateState(), observers, 2, now),
    { allowance: 12, used: 2, held: false },
  );
});

test("a vanished or replaced events log keeps the window's counted merges and does not throw", () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [{ ts: now - HOUR, loop: "clean", type: "merged", commit: "a" }]); // retired-name-ok: legacy event field in a fixture
  const counter = newMaintenanceWindowCounter();
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  fs.rmSync(eventsLogPath(root));
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
  // A directory in the log's place folds nothing and must not throw. The log is not recreated as a
  // file afterwards: a reused inode would make the result depend on the filesystem.
  fs.mkdirSync(eventsLogPath(root));
  assert.deepEqual(countMaintenanceWindow(root, counter, now), { work: 0, maint: 1 });
});
