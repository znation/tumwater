import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { pausedRolesLockPath } from "../src/paths.js";
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

/** Spawn a child node process that spins on a start file, then pauses one role once — the way
 * two real writers (the CLI and the GUI server) each run in their own process. The barrier
 * aligns every child's read-modify-write window, which is exactly the instant the race fires.
 * Resolves with the child's exit status; the exit listener attaches at spawn time, so a child
 * that fails fast rejects this promise instead of leaving it pending forever. */
function pauseOnceProcess(root: string, role: string, startFile: string): Promise<void> {
  const module = fileURLToPath(new URL("../src/fleet-state.js", import.meta.url));
  const script = `const fs = require("node:fs");
    import(${JSON.stringify(module)}).then((m) => {
      while (!fs.existsSync(${JSON.stringify(startFile)})) {}
      return m.pauseRole(${JSON.stringify(root)}, ${JSON.stringify(role)});
    })`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script]);
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    exited.then((code) =>
      code === 0 ? resolve() : reject(new Error(`the ${role} pause process failed: ${stderr}`)),
    );
  });
}

test("simultaneous cross-process pauseRole calls all survive in the marker", async () => {
  // Regression: the marker's whole-set overwrite was written unlocked, so concurrent
  // read-modify-write writers (CLI `pause --role` vs the dashboard's per-row toggle) raced and
  // the last writer's set silently dropped every other pause recorded since its read — the
  // operator believes those loops are stopped while they keep ticking. The marker is
  // pre-seeded with a large role set so every writer's read-serialize-write window spans
  // milliseconds: with the windows that wide, eight aligned writers lose pauses on the
  // unlocked build essentially every run, while the serialized build ends with exactly the
  // seeded roles plus all eight new ones.
  const root = tmpdir();
  const seeded = Array.from({ length: 2000 }, (_, i) => `base${i}`);
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".tumwater", "state", "paused-roles.json"),
    JSON.stringify({ roles: seeded, at: 1 }),
  );
  const roles = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
  const startFile = path.join(root, "start-when-aligned");
  const children = roles.map((role) => pauseOnceProcess(root, role, startFile));
  fs.writeFileSync(startFile, "go"); // release all eight writers at once
  await Promise.all(children);
  assert.deepEqual(
    [...pausedRoles(root)].sort(),
    [...seeded, ...roles].sort(),
    "every simultaneous pause survives (order is whichever writer landed first)",
  );
});

test("a paused-roles lock held by another process is waited for, not stolen", async () => {
  const root = tmpdir();
  const lock = pausedRolesLockPath(root);
  // A live holder via the real protocol (withSyncLock in the compiled build), releasing after
  // 300ms — well inside pauseRole's 10s wait bound.
  const module = fileURLToPath(new URL("../src/lock.js", import.meta.url));
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(module)}).then(({ withSyncLock }) => {
        const fs = require("node:fs"), path = require("node:path");
        fs.mkdirSync(path.dirname(${JSON.stringify(lock)}), { recursive: true });
        return withSyncLock(${JSON.stringify(lock)}, () =>
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300));
      });`,
    ],
  );
  const holderExit = new Promise((resolve) => holder.on("exit", resolve));
  holder.stderr?.resume();
  try {
    for (let i = 0; !fs.existsSync(lock); i++) {
      if (i > 200) throw new Error("the holder child never took the lock");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(pauseRole(root, "docs"), true, "the caller waits out the live holder and proceeds");
    assert.deepEqual(pausedRoles(root), ["docs"]);
  } finally {
    await holderExit;
  }
  assert.equal(fs.existsSync(lock), false, "the lock is released after the section");
});

test("a crashed pause writer's lock is stolen, not waited on forever", () => {
  // Two crash shapes the serializer must recover from on its own, or every later pause/resume
  // times out until a human deletes the lock by hand:
  // - a crash between mkdir and the pid write leaves an empty (or missing) pid file — stolen
  //   once past the no-pid grace, here simulated by backdating the dir six seconds;
  // - a crash after the pid write leaves a dead pid — stolen at once.
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  const empty = pausedRolesLockPath(root);
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, "pid"), "");
  const sixSecondsAgo = new Date(Date.now() - 6 * 1000);
  fs.utimesSync(empty, sixSecondsAgo, sixSecondsAgo);
  assert.equal(pauseRole(root, "docs"), true, "an empty-pid orphan past the grace is stolen");
  assert.deepEqual(pausedRoles(root), ["docs"]);
  assert.equal(fs.existsSync(empty), false, "the stolen orphan leaves no remnant after release");

  const dead = pausedRolesLockPath(root);
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, "pid"), "999999999");
  assert.equal(pauseRole(root, "dry"), true, "a dead-pid lock is stolen at once");
  assert.deepEqual(pausedRoles(root), ["docs", "dry"]);
});
