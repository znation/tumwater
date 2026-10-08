import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  orchestratorAlive,
  readOrchestratorInfo,
  writeOrchestratorInfo,
  type OrchestratorInfo,
} from "../src/fleet/orchestrator-info.js";
import { orchestratorStatePath } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";

/** The orchestrator info file's own tests (src/fleet/orchestrator-info.ts): the tolerant read,
 * the atomic write, and the pid-liveness check. The operator pause markers read and written
 * through fleet-state.ts have their tests in fleet-state.test.ts. */

test("readOrchestratorInfo returns null for missing, torn, and non-object files", () => {
  const root = tmpdir();
  const file = orchestratorStatePath(root);
  assert.equal(readOrchestratorInfo(root), null, "no file reads null");

  ensureParentDir(file);
  fs.writeFileSync(file, '{"pid": 1, "start'); // torn write
  assert.equal(readOrchestratorInfo(root), null, "torn JSON reads null, never throws");

  fs.writeFileSync(file, "null"); // JSON.parse succeeds but yields null
  assert.equal(readOrchestratorInfo(root), null, "a null body reads null");

  fs.writeFileSync(file, "[1, 2, 3]"); // an array is not a state object
  assert.equal(readOrchestratorInfo(root), null, "an array body reads null");
});

test("readOrchestratorInfo parses a valid info file", () => {
  const root = tmpdir();
  const file = orchestratorStatePath(root);
  ensureParentDir(file);
  const info: OrchestratorInfo = { pid: 42, startedAt: 1234, roles: ["feature", "qa"] };
  fs.writeFileSync(file, JSON.stringify(info));
  assert.deepEqual(readOrchestratorInfo(root), info);
});

test("writeOrchestratorInfo leaves the previous file intact when a write is killed mid-flight", (t) => {
  const root = tmpdir("orchestrator-info-atomic-");
  const first: OrchestratorInfo = { pid: 1, startedAt: 1, roles: ["docs"] };
  writeOrchestratorInfo(root, first);
  assert.deepEqual(readOrchestratorInfo(root), first, "the seed is on disk");

  // Model a process killed between write and close (SIGKILL, ENOSPC, EIO): the writer leaves a
  // partial prefix of the JSON, then throws. The atomic seam must surface the failure without
  // replacing the good file, so `tumwater run`'s liveness read still sees the running fleet
  // instead of booting a second one.
  const realWriteFileSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
    realWriteFileSync(file, typeof data === "string" ? data.slice(0, 10) : data.subarray(0, 10));
    throw new Error("simulated mid-write failure");
  }) as typeof fs.writeFileSync);
  try {
    assert.throws(
      () => writeOrchestratorInfo(root, { pid: 2, startedAt: 2, roles: ["qa"] }),
      /simulated mid-write failure/,
    );
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(readOrchestratorInfo(root), first, "the torn write never replaced the good file");
});

test("orchestratorAlive is false with no info and reflects pid liveness otherwise", () => {
  const root = tmpdir();
  assert.equal(orchestratorAlive(root), false, "no info file means no live orchestrator");

  const live: OrchestratorInfo = { pid: process.pid, startedAt: 1, roles: [] };
  assert.equal(orchestratorAlive(root, live), true, "our own pid is alive");
  assert.equal(orchestratorAlive(root), false, "still false when read from disk (none written)");

  // A child that has exited and been reaped is a pid that is not alive.
  const dead = spawnSync("true"); // exits immediately; spawnSync reaps before returning
  assert.equal(orchestratorAlive(root, { ...live, pid: dead.pid }), false, "an exited pid reads dead");

  // Callers that already loaded the info may persist it; the disk path then agrees with it.
  const file = orchestratorStatePath(root);
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify({ ...live, pid: dead.pid }));
  assert.equal(orchestratorAlive(root), false, "disk-loaded dead pid reads dead");
  fs.writeFileSync(file, JSON.stringify(live));
  assert.equal(orchestratorAlive(root), true, "disk-loaded live pid reads alive");
});
