import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isFleetPaused,
  pauseRole,
  pausedRoles,
  resumeRole,
  pauseFleet,
  resumeFleet,
  readOrchestratorInfo,
  orchestratorAlive,
  type OrchestratorInfo,
} from "../src/fleet-state.js";
import { tmpdir } from "./util.js";

test("isFleetPaused reads false with no .tumwater dir and no marker", () => {
  const root = tmpdir();
  assert.equal(isFleetPaused(root), false, "a missing .tumwater/ reads false, not throw");
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  assert.equal(isFleetPaused(root), false, "no marker file reads false");
});

test("pauseFleet writes the marker once and is idempotent", () => {
  const root = tmpdir();
  assert.equal(pauseFleet(root), true, "first pause changes state");
  assert.equal(isFleetPaused(root), true);
  const raw = fs.readFileSync(path.join(root, ".tumwater", "paused.json"), "utf8");
  const marker = JSON.parse(raw) as { at: number };
  assert.equal(typeof marker.at, "number", "the marker carries { at: timestamp }");
  assert.ok(Number.isFinite(marker.at) && marker.at > 0);
  assert.equal(pauseFleet(root), false, "second pause is a no-op (already paused)");
  assert.equal(isFleetPaused(root), true);
});

test("resumeFleet lifts an existing marker and reports no change when absent", () => {
  const root = tmpdir();
  assert.equal(resumeFleet(root), false, "resume without a pause is a no-op");
  assert.equal(pauseFleet(root), true);
  assert.equal(resumeFleet(root), true, "resume over a marker changes state");
  assert.equal(isFleetPaused(root), false);
  assert.equal(fs.existsSync(path.join(root, ".tumwater", "paused.json")), false);
  assert.equal(resumeFleet(root), false, "a vanished marker still resumes as no-change, not throw");
});

test("readOrchestratorInfo returns null for missing, torn, and non-object files", () => {
  const root = tmpdir();
  const file = path.join(root, ".tumwater", "state", "orchestrator.json");
  assert.equal(readOrchestratorInfo(root), null, "no file reads null");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"pid": 1, "start'); // torn write
  assert.equal(readOrchestratorInfo(root), null, "torn JSON reads null, never throws");

  fs.writeFileSync(file, "null"); // JSON.parse succeeds but yields null
  assert.equal(readOrchestratorInfo(root), null, "a null body reads null");

  fs.writeFileSync(file, "[1, 2, 3]"); // an array is not a state object
  assert.equal(readOrchestratorInfo(root), null, "an array body reads null");
});

test("readOrchestratorInfo parses a valid info file", () => {
  const root = tmpdir();
  const file = path.join(root, ".tumwater", "state", "orchestrator.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info: OrchestratorInfo = { pid: 42, startedAt: 1234, roles: ["feature", "qa"] };
  fs.writeFileSync(file, JSON.stringify(info));
  assert.deepEqual(readOrchestratorInfo(root), info);
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
  const file = path.join(root, ".tumwater", "state", "orchestrator.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...live, pid: dead.pid }));
  assert.equal(orchestratorAlive(root), false, "disk-loaded dead pid reads dead");
  fs.writeFileSync(file, JSON.stringify(live));
  assert.equal(orchestratorAlive(root), true, "disk-loaded live pid reads alive");
});

// --- Per-role pause (`tumwater pause --role <id>` / `resume --role <id>`) ---

test("pausedRoles reads [] with no .tumwater dir and tolerates garbage", () => {
  const root = tmpdir();
  assert.equal(pausedRoles(root).join(), "", "a missing .tumwater/ reads as no paused roles, not throw");
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  assert.equal(pausedRoles(root).join(), "", "no marker file reads as no paused roles");

  const file = path.join(root, ".tumwater", "state", "paused-roles.json");
  fs.writeFileSync(file, "{not json"); // torn write
  assert.equal(pausedRoles(root).join(), "", "torn JSON reads as no paused roles, never throws");
  fs.writeFileSync(file, "null"); // not an object
  assert.equal(pausedRoles(root).join(), "", "a null body reads as no paused roles");
  fs.writeFileSync(file, JSON.stringify({ roles: "docs", at: 1 })); // roles is not an array
  assert.equal(pausedRoles(root).join(), "", "a non-array roles field reads as no paused roles");
  fs.writeFileSync(file, JSON.stringify({ roles: ["docs", 3, null, "dry"], at: 1 }));
  assert.deepEqual(pausedRoles(root), ["docs", "dry"], "non-string entries are dropped, not thrown on");
});

test("pauseRole and resumeRole maintain the marker set idempotently", () => {
  const root = tmpdir();
  assert.equal(resumeRole(root, "docs"), false, "resume without a pause is a no-op");
  assert.equal(pauseRole(root, "docs"), true, "first pause changes state");
  const marker = JSON.parse(fs.readFileSync(path.join(root, ".tumwater", "state", "paused-roles.json"), "utf8")) as {
    roles: string[];
    at: number;
  };
  assert.deepEqual(marker.roles, ["docs"], "the marker carries the role set");
  assert.ok(Number.isFinite(marker.at) && marker.at > 0, "the marker carries the pause timestamp");
  assert.equal(pauseRole(root, "docs"), false, "a second pause of the same role is a no-op");
  assert.equal(pauseRole(root, "dry"), true, "a second role joins the set");
  assert.deepEqual(pausedRoles(root), ["docs", "dry"]);

  assert.equal(resumeRole(root, "dry"), true, "resume of a paused role changes state");
  assert.deepEqual(pausedRoles(root), ["docs"], "only the resumed role leaves the set");
  assert.equal(resumeRole(root, "dry"), false, "a second resume is a no-op");
  assert.equal(resumeRole(root, "docs"), true);
  assert.equal(
    fs.existsSync(path.join(root, ".tumwater", "state", "paused-roles.json")),
    false,
    "the last removal deletes the marker outright",
  );
  // Custom-loop ids are stored verbatim — the marker must survive config edits.
  assert.equal(pauseRole(root, "my-custom-loop"), true);
  assert.deepEqual(pausedRoles(root), ["my-custom-loop"]);
});
