import { sleep } from "./wait.js";
import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isFleetPaused,
  PAUSE_REASON_MAX,
  pauseRole,
  pausedReason,
  pausedRoles,
  pausedUntil,
  resumeRole,
  pauseFleet,
  resumeFleet,
  readOrchestratorInfo,
  orchestratorAlive,
  type OrchestratorInfo,
} from "../src/fleet/fleet-state.js";
import { orchestratorStatePath, pausedPath, pausedRolesLockPath, pausedRolesPath } from "../src/paths.js";
import { backdate } from "./backdate.js";
import { tmpdir } from "./repo-fixtures.js";
import { ensureParentDir } from "../src/files.js";

test("isFleetPaused reads false with no .tumwater dir and no marker", () => {
  const root = tmpdir();
  assert.equal(isFleetPaused(root), false, "a missing .tumwater/ reads false, not throw");
  ensureParentDir(pausedPath(root));
  assert.equal(isFleetPaused(root), false, "no marker file reads false");
});

test("pauseFleet writes the marker once and is idempotent", () => {
  const root = tmpdir();
  assert.equal(pauseFleet(root), true, "first pause changes state");
  assert.equal(isFleetPaused(root), true);
  const raw = fs.readFileSync(pausedPath(root), "utf8");
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
  assert.equal(fs.existsSync(pausedPath(root)), false);
  assert.equal(resumeFleet(root), false, "a vanished marker still resumes as no-change, not throw");
});

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

// --- Per-role pause (`tumwater pause --role <id>` / `resume --role <id>`) ---

test("pausedRoles reads [] with no .tumwater dir and tolerates garbage", () => {
  const root = tmpdir();
  assert.equal(pausedRoles(root).join(), "", "a missing .tumwater/ reads as no paused roles, not throw");
  ensureParentDir(pausedRolesPath(root));
  assert.equal(pausedRoles(root).join(), "", "no marker file reads as no paused roles");

  const file = pausedRolesPath(root);
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
  const marker = readJson(pausedRolesPath(root)) as {
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
    fs.existsSync(pausedRolesPath(root)),
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
  const module = fileURLToPath(new URL("../src/fleet/fleet-state.js", import.meta.url));
  const script = `const fs = require("node:fs");
    import(${JSON.stringify(module)}).then((m) => {
      while (!fs.existsSync(${JSON.stringify(startFile)})) {}
      return m.pauseRole(${JSON.stringify(root)}, ${JSON.stringify(role)});
    })`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script]);
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the ${role} pause process failed: ${stderr}`)),
    );
  });
}

test("a sibling pause or resume keeps the paused-roles marker's standing shared deadline", () => {
  // Regression: the fresh-add and remaining-set writes rebuilt the marker body from scratch
  // and carried no `until` unless the current call had one, so `pause --role bugfix` after
  // `pause --role qa --for 1h` silently converted qa's timed pause into a standing one (the
  // marker lost its deadline and never expired), and resuming the sibling did the same to the
  // survivor. The deadline is the marker's one shared field: only a fresh `--for` overwrites
  // it, and the last removal drops it with the marker itself.
  const root = tmpdir();
  const until = Date.now() + 3_600_000;
  assert.equal(pauseRole(root, "qa", until), true);
  assert.equal(pauseRole(root, "bugfix"), true, "a standing join changes state");
  assert.equal(
    (readJson(pausedRolesPath(root)) as { until: number }).until,
    until,
    "joining a role standing keeps the set's timed auto-resume",
  );
  assert.deepEqual(pausedRoles(root), ["qa", "bugfix"]);
  assert.equal(resumeRole(root, "bugfix"), true);
  assert.equal(
    (readJson(pausedRolesPath(root)) as { until: number }).until,
    until,
    "resuming a sibling keeps the survivor's timed auto-resume",
  );
  assert.deepEqual(pausedRoles(root), ["qa"]);
  // Last-write-wins stays: a `--for` on a later join overwrites the shared deadline.
  const sooner = Date.now() + 60_000;
  assert.equal(pauseRole(root, "dry", sooner), true);
  assert.equal((readJson(pausedRolesPath(root)) as { until: number }).until, sooner);
});

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
  ensureParentDir(pausedRolesPath(root));
  fs.writeFileSync(
    pausedRolesPath(root),
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
      await sleep(10);
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
  ensureParentDir(pausedRolesPath(root));
  const empty = pausedRolesLockPath(root);
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, "pid"), "");
  backdate(empty, 6 * 1000);
  assert.equal(pauseRole(root, "docs"), true, "an empty-pid orphan past the grace is stolen");
  assert.deepEqual(pausedRoles(root), ["docs"]);
  assert.equal(fs.existsSync(empty), false, "the stolen orphan leaves no remnant after release");

  const dead = pausedRolesLockPath(root);
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, "pid"), "999999999");
  assert.equal(pauseRole(root, "dry"), true, "a dead-pid lock is stolen at once");
  assert.deepEqual(pausedRoles(root), ["docs", "dry"]);
});

// --- timed pause (`tumwater pause [--role <id>] --for <duration>`, PLANS.md 2026-09-25) ---

test("pauseFleet with a deadline writes { at, until } and pausedUntil reads it back", () => {
  const root = tmpdir();
  const until = Date.now() + 30 * 60_000;
  assert.equal(pauseFleet(root, until), true, "a timed pause changes state like a plain one");
  const marker = readJson(pausedPath(root)) as {
    at: number;
    until: number;
  };
  assert.equal(marker.until, until, "the marker carries the ms-epoch deadline");
  assert.equal(isFleetPaused(root), true);
  assert.equal(pausedUntil(root), until, "the standing deadline is what the snapshot's pausedUntil exposes");
});

test("an expired fleet deadline reads as unpaused everywhere and a re-pause starts fresh", () => {
  const root = tmpdir();
  ensureParentDir(pausedPath(root));
  fs.writeFileSync(
    pausedPath(root),
    JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000 }),
  );
  assert.equal(isFleetPaused(root), false, "a past deadline is not a pause");
  assert.equal(pausedUntil(root), undefined, "an expired deadline is absent, never exposed");
  assert.equal(pauseFleet(root), true, "a pause after expiry reports a fresh pause, not 'already paused'");
  const marker = readJson(pausedPath(root)) as {
    at: number;
    until?: number;
  };
  assert.equal(marker.until, undefined, "an indefinite re-pause writes the plain { at } marker");
  assert.equal(isFleetPaused(root), true);
});

// The operator pause's why (`tumwater pause --reason <text>`): the marker carries the
// trimmed, capped note, a fresh write replaces it (last write wins, like `until`), a
// reasonless write clears a stale one, and the idempotent no-op never touches it.
test("pauseFleet carries the operator reason: trimmed, capped, last-write-wins, cleared by a reasonless write", () => {
  const root = tmpdir();
  assert.equal(pauseFleet(root, undefined, "  deploying to prod  "), true);
  const marker = readJson(pausedPath(root)) as { at: number; reason?: string };
  assert.equal(marker.reason, "deploying to prod", "the reason is trimmed, quoted verbatim otherwise");
  assert.equal(pausedReason(root), "deploying to prod", "the standing reason is what pausedReason exposes");

  // The cap every writer shares: a longer note is stored truncated, not rejected. Only a
  // fresh pause or a --for overwrite applies a reason — the idempotent no-op returns false
  // and never touches the standing note (the same rule as the deadline).
  const long = "x".repeat(PAUSE_REASON_MAX + 50);
  const later = Date.now() + 30 * 60_000;
  assert.equal(pauseFleet(root, later, long), true, "a --for overwrite applies its own reason");
  assert.equal(pausedReason(root)?.length, PAUSE_REASON_MAX);
  assert.equal(pauseFleet(root), false, "a plain pause over a standing one stays the no-op");
  assert.equal(pausedReason(root)?.length, PAUSE_REASON_MAX, "a no-op keeps the standing reason");

  // The one-line fold every writer shares: a multi-line operator note collapses its
  // whitespace runs to single spaces, so the marker never carries the raw newline that
  // would break the status header's one-line badge (BUGS.md 2026-09-30).
  resumeFleet(root);
  assert.equal(pauseFleet(root, undefined, "deploying\nthe new build\ttonight"), true);
  assert.equal(pausedReason(root), "deploying the new build tonight", "the reason is one line");
  resumeFleet(root);
  assert.equal(pauseFleet(root, undefined, "   \n\t  "), true, "a whitespace-only note still pauses");
  assert.equal(pausedReason(root), undefined, "a whitespace-only note stores no reason key");

  // A write without a reason clears the stale one — the note belongs to THIS pause.
  assert.equal(pauseFleet(root, later + 1), true, "a reasonless --for overwrite clears the stale reason");
  const plain = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(plain.reason, undefined, "no reason key survives a reasonless write");
  assert.equal(resumeFleet(root), true);
  assert.equal(pauseFleet(root, undefined, "first why"), true, "a fresh pause applies its own reason");
  assert.equal(pausedReason(root), "first why");
  resumeFleet(root);
  assert.equal(pauseFleet(root), true, "a fresh pause after a resume reports fresh");
  assert.equal(pausedReason(root), undefined, "a fresh reasonless pause clears the stale reason");
});

// The one-line shape is the read side's contract too: a marker left on disk by a build
// predating the write-side fold (or a hand edit) can still carry the raw newline, and every
// consumer — the status header's badge, the alerts title — reads it through standingMarker,
// so the fold and cap apply there rather than trusting whoever wrote the file. The marker
// is a hand-editable file, so the never-throws contract must hold for a wrong-shaped
// reason too: standingMarker sits on the scheduler's per-cycle isFleetPaused poll and
// status-data's once-per-poll snapshot, and a non-string reason (json-files.ts reads what
// is on disk as T unchecked) must read as no reason, not throw (BUGS.md 2026-09-30).
test("a standing marker's reason is folded, capped, and type-guarded on read, whoever wrote it", () => {
  const root = tmpdir();
  const markerPath = pausedPath(root);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  // Exactly what a pre-fold build's JSON.stringify stored: escaped newline and tab in the file.
  fs.writeFileSync(markerPath, JSON.stringify({ at: Date.now(), reason: "deploying\nthe new build\tv2" }));
  assert.equal(pausedReason(root), "deploying the new build v2", "the raw note reads as one line");
  // An over-cap note in an old marker is capped on read by the same PAUSE_REASON_MAX.
  fs.writeFileSync(markerPath, JSON.stringify({ at: Date.now(), reason: "y".repeat(PAUSE_REASON_MAX + 50) }));
  assert.equal(pausedReason(root)?.length, PAUSE_REASON_MAX, "the cap holds on read too");
  // A whitespace-only note in an old marker reads as no reason at all.
  fs.writeFileSync(markerPath, JSON.stringify({ at: Date.now(), reason: "  \n\t " }));
  assert.equal(pausedReason(root), undefined, "a whitespace-only note reads as no reason");
  // A hand-edited non-string reason must read as no reason — never a TypeError out of
  // isFleetPaused, pausedReason, or the pauseFleet no-op check that reuses this read.
  fs.writeFileSync(markerPath, JSON.stringify({ at: Date.now(), reason: 42 }));
  assert.equal(isFleetPaused(root), true, "a wrong-shaped reason leaves the pause standing");
  assert.equal(pausedReason(root), undefined, "a numeric reason reads as no reason, not a throw");
  const later = Date.now() + 60_000;
  assert.equal(pauseFleet(root, later, "next why"), true, "pauseFleet over a wrong-shaped reason still writes");
  assert.equal(pausedReason(root), "next why", "the fresh write's reason replaces the malformed one");
});

test("a fresh --for over a standing fleet pause overwrites the deadline; a plain pause no-ops", () => {
  const root = tmpdir();
  pauseFleet(root, Date.now() + 30 * 60_000);
  assert.equal(pauseFleet(root), false, "a plain pause over a timed pause stays the idempotent no-op");
  const later = Date.now() + 2 * 3_600_000;
  assert.equal(pauseFleet(root, later), true, "a --for over a standing pause overwrites the deadline");
  assert.equal(pausedUntil(root), later);
});

test("pauseRole with a deadline writes { roles, at, until } and expiry releases the set", () => {
  const root = tmpdir();
  const until = Date.now() + 2 * 3_600_000;
  assert.equal(pauseRole(root, "clean", until), true);
  const marker = readJson(pausedRolesPath(root)) as {
    roles: string[];
    until: number;
  };
  assert.deepEqual(marker.roles, ["clean"]);
  assert.equal(marker.until, until);
  assert.deepEqual(pausedRoles(root), ["clean"]);
  // Expiry releases the whole set on the read side...
  fs.writeFileSync(
    pausedRolesPath(root),
    JSON.stringify({ roles: ["clean"], at: Date.now() - 60_000, until: Date.now() - 30_000 }),
  );
  assert.deepEqual(pausedRoles(root), [], "a past deadline is not a pause");
  // ...and a fresh pause starts a fresh set: the expired members already auto-resumed.
  assert.equal(pauseRole(root, "dry"), true);
  assert.deepEqual(pausedRoles(root), ["dry"]);
  // A plain pause of the standing role stays the no-op; a fresh --for overwrites the shared
  // deadline (extend or shorten); resume lifts a timed pause early like any other.
  assert.equal(pauseRole(root, "dry"), false);
  const sooner = Date.now() + 60_000;
  assert.equal(pauseRole(root, "dry", sooner), true);
  assert.equal((readJson(pausedRolesPath(root)) as { until: number }).until, sooner);
  assert.equal(resumeRole(root, "dry"), true);
  assert.equal(fs.existsSync(pausedRolesPath(root)), false);
});
