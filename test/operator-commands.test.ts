import { sleep } from "./wait.js";
import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  cmdAbort,
  cmdPause,
  cmdResetCounters,
  cmdResume,
  cmdStop,
  cmdWake,
  signalOrchestrator,
} from "../src/operator-commands.js";
import { pidAlive } from "../src/process.js";
import { defaultConfig } from "../src/config.js";
import { writeJsonFile } from "../src/json-files.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { configPath } from "../src/paths.js";
import {
  freshLoopState,
  loadLoopState,
  saveLoopState,
} from "../src/loop-state.js";
import {
  abortRequestPath,
  pausedPath,
  pausedRolesPath,
  resetRequestPath,
  wakeRequestPath,
} from "../src/paths.js";
import { tmpdir, writeMalformedJson } from "./repo-fixtures.js";
import { errnoError } from "./fs-faults.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { ensureParentDir } from "../src/files.js";
import { attemptAsync } from "./exit-capture.js";
import { exitWithOwnerEnv } from "./victim-fixture.js";

/** Producer-side tests for the operator-intent protocol (src/operator-intent.ts, with the
 * CLI command layer in src/operator-commands.ts). Its
 * consumer half is pinned in operator-requests.test.ts; until now these five CLI commands
 * were only exercised by spawning the real binary (test/cli.test.ts), which cannot assert
 * the marker contents or the untouched scheduling fields in-process. */

async function expectOk<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const o = await attemptAsync(fn);
  if (o.exited) assert.fail(`expected success, but process.exit(${o.code}) with:\n${o.stderr}`);
  return o;
}

async function expectFail(fn: () => Promise<unknown>): Promise<{ code: number; stderr: string }> {
  const o = await attemptAsync(fn);
  if (!o.exited) assert.fail(`expected process.exit, but the call returned ${JSON.stringify(o.value)}`);
  return o;
}

/** Mark a harness live for orchestratorAlive: its info file names a pid that is provably alive
 * (this test process). */
function markLive(root: string): void {
  writeOrchestratorMarker(root, []);
}

// --- reset-counters ---

test("cmdResetCounters with --role zeroes that loop's counters and preserves its schedule", async () => {
  const root = tmpdir();
  saveLoopState(root, {
    ...freshLoopState("coverage"),
    ticks: 9,
    commits: 4,
    generatedTokens: 1200,
    peakContextTokens: 900,
    totalCostUsd: 3.5,
    nextRunAt: 12_345,
    backoffSeconds: 60,
    lastMainHead: "abc",
  });
  const { stdout } = await expectOk(() => cmdResetCounters(root, ["--role", "coverage"]));
  assert.match(stdout, /counters reset for coverage/);
  const after = loadLoopState(root, "coverage");
  assert.equal(after.ticks, 0);
  assert.equal(after.commits, 0);
  assert.equal(after.generatedTokens, 0);
  assert.equal(after.peakContextTokens, 0);
  assert.equal(after.totalCostUsd, 0);
  // Scheduling and wake tracking are deliberately untouched.
  assert.equal(after.nextRunAt, 12_345);
  assert.equal(after.backoffSeconds, 60);
  assert.equal(after.lastMainHead, "abc");
  const marker = readJson<Record<string, unknown>>(resetRequestPath(root));
  assert.deepEqual(marker["roles"], ["coverage"]);
  assert.equal(typeof marker["at"], "number");
});

test("cmdResetCounters without --role targets every role in the config", async () => {
  const root = tmpdir();
  const roles = Object.keys(defaultConfig().roles);
  saveLoopState(root, { ...freshLoopState("coverage"), ticks: 5 });
  const { stdout } = await expectOk(() => cmdResetCounters(root, []));
  assert.deepEqual(readJson<Record<string, unknown>>(resetRequestPath(root))["roles"], roles);
  assert.equal(loadLoopState(root, "coverage").ticks, 0);
  assert.ok(stdout.startsWith("counters reset for "));
});

// --- wake ---

test("cmdWake clears the named loop's backoff and pulls nextRunAt to now, leaving counters alone", async () => {
  const root = tmpdir();
  const before = Date.now();
  saveLoopState(root, {
    ...freshLoopState("clean"),
    ticks: 7,
    backoffSeconds: 3600,
    nextRunAt: Date.now() + 999_999,
  });
  const { stdout } = await expectOk(() => cmdWake(root, ["--role", "clean"]));
  assert.match(stdout, /wake requested for clean/);
  const after = loadLoopState(root, "clean");
  assert.equal(after.backoffSeconds, 0);
  assert.ok(after.nextRunAt >= before && after.nextRunAt <= Date.now(), `nextRunAt ${after.nextRunAt} not pulled to now`);
  assert.equal(after.ticks, 7); // observation-window counters are not this command's job
  assert.deepEqual(readJson<Record<string, unknown>>(wakeRequestPath(root))["roles"], ["clean"]);
});

// The "wakes in" phrase once came from the deadline minus a second clock read: cmdWake read
// the clock for the deadline, requestWake read it again on entry, and a millisecond tick
// between the two printed "wakes in 2699999ms" for `--in 45m`. A clock that advances on every
// read makes that tick certain instead of a rare flake.
test("cmdWake --in echoes the operator's duration even when the clock ticks between reads", async (t) => {
  const root = tmpdir();
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock++);
  const { stdout } = await expectOk(() => cmdWake(root, ["--role", "clean", "--in", "45m"]));
  assert.match(stdout, /wake scheduled for clean — wakes in 45m — /);
  const marker = readJson<{ at: number; notBeforeMs: number }>(wakeRequestPath(root));
  assert.equal(marker.notBeforeMs - marker.at, 45 * 60_000, "the deadline is one clock read plus the duration");
});

// A malformed tumwater.json must not block an operator marker aimed at a built-in role:
// the fleet itself keeps running on its last-known-good config (the live reload), so wake,
// reset-counters, and abort --role <builtin> resolve the id from the static catalog instead
// of requiring the file to parse — the same resilience `logs --role` has.
test("marker commands with --role <builtin> work while tumwater.json is malformed", async () => {
  const root = tmpdir();
  writeMalformedJson(configPath(root));
  saveLoopState(root, { ...freshLoopState("feature"), backoffSeconds: 120 });

  const wake = await expectOk(() => cmdWake(root, ["--role", "feature"]));
  assert.match(wake.stdout, /wake requested for feature/);
  assert.equal(loadLoopState(root, "feature").backoffSeconds, 0);

  const reset = await expectOk(() => cmdResetCounters(root, ["--role", "feature"]));
  assert.match(reset.stdout, /counters reset for feature/);
  assert.equal(loadLoopState(root, "feature").ticks, 0);

  markLive(root);
  const abort = await expectOk(() => cmdAbort(root, ["--role", "feature"]));
  assert.match(abort.stdout, /abort requested for feature/);
});

// The escape hatch is only for built-ins: a custom-loop id (or any unknown id) still needs
// the config to know the valid id set, so the malformed file is reported honestly instead
// of the command silently claiming a role that may not exist.
test("marker commands with a custom/unknown --role still report the broken config", async () => {
  const root = tmpdir();
  writeMalformedJson(configPath(root));
  const { code, stderr } = await expectFail(() => cmdWake(root, ["--role", "docs"]));
  assert.equal(code, 1);
  assert.match(stderr, /tumwater\.json is not valid JSON/);
});

// --- abort ---

test("cmdAbort without --role fails before writing any marker", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdAbort(root, []));
  assert.equal(code, 1);
  assert.match(stderr, /abort requires --role/);
  assert.equal(fs.existsSync(abortRequestPath(root, "coverage")), false);
});

test("cmdAbort with no live harness fails instead of leaving an unconsumable marker", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdAbort(root, ["--role", "coverage"]));
  assert.equal(code, 1);
  assert.match(stderr, /no harness is running/);
  assert.equal(fs.existsSync(abortRequestPath(root, "coverage")), false);
});

test("cmdAbort with a live harness writes the per-role marker", async () => {
  const root = tmpdir();
  markLive(root);
  const { stdout } = await expectOk(() => cmdAbort(root, ["--role", "coverage"]));
  assert.match(stdout, /abort requested for coverage/);
  const marker = readJson<Record<string, unknown>>(abortRequestPath(root, "coverage"));
  assert.equal(typeof marker["at"], "number");
});

test("cmdAbort for the director warns that its in-flight prompt is discarded", async () => {
  const root = tmpdir();
  markLive(root);
  const { stdout } = await expectOk(() => cmdAbort(root, ["--role", DIRECTOR_ROLE]));
  assert.match(stdout, /in-flight prompt will be discarded/);
});

test("cmdAbort rejects an unknown role id", async () => {
  const root = tmpdir();
  markLive(root);
  const { code, stderr } = await expectFail(() => cmdAbort(root, ["--role", "ghost"]));
  assert.equal(code, 1);
  assert.match(stderr, /unknown role: ghost/);
});

// --- pause / resume ---

test("cmdPause writes the marker, reports no-harness timing, and is idempotent", async () => {
  const root = tmpdir(); // fresh repo: no .tumwater/ yet — ensureParentDir must create it
  const first = await expectOk(() => cmdPause(root));
  assert.match(first.stdout, /fleet paused/);
  assert.match(first.stdout, /no harness is running/);
  assert.ok(fs.existsSync(pausedPath(root)));
  const second = await expectOk(() => cmdPause(root));
  assert.match(second.stdout, /already paused/);
});

test("cmdPause writes the unchanged { at } marker through the shared state writer", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root));
  const marker = readJson(pausedPath(root)) as { at: number };
  assert.deepEqual(Object.keys(marker), ["at"], "the marker format the CLI has always written");
  assert.equal(typeof marker.at, "number");
});

test("cmdPause with a live harness promises pickup within ~2s", async () => {
  const root = tmpdir();
  markLive(root);
  const { stdout } = await expectOk(() => cmdPause(root));
  assert.match(stdout, /within ~2s/);
  assert.doesNotMatch(stdout, /no harness is running/);
});

test("cmdResume is a no-op without a marker and lifts one when present", async () => {
  const root = tmpdir();
  const idle = await expectOk(() => cmdResume(root));
  assert.match(idle.stdout, /not paused/);
  await expectOk(() => cmdPause(root));
  assert.ok(fs.existsSync(pausedPath(root)));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /fleet resumed/);
  assert.equal(fs.existsSync(pausedPath(root)), false);
});

test("cmdResume with a live harness promises pickup within ~2s", async () => {
  const root = tmpdir();
  markLive(root);
  await expectOk(() => cmdPause(root));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /fleet resumed/);
  assert.match(stdout, /within ~2s/);
  assert.doesNotMatch(stdout, /no harness is running/);
});

// --- per-role pause (`pause --role <id>` / `resume --role <id>`) ---

test("cmdPause --role pauses one role, is idempotent, and leaves the fleet marker alone", async () => {
  const root = tmpdir();
  const first = await expectOk(() => cmdPause(root, ["--role", "clean"]));
  assert.match(first.stdout, /role clean paused/);
  assert.match(first.stdout, /in-flight ticks finish; the rest of the fleet is unaffected/);
  assert.ok(fs.existsSync(pausedRolesPath(root)));
  assert.ok(!fs.existsSync(pausedPath(root)), "a per-role pause never writes the fleet marker");
  const second = await expectOk(() => cmdPause(root, ["--role", "clean"]));
  assert.match(second.stdout, /role clean is already paused/);
  // Both roles land in the one marker set.
  await expectOk(() => cmdPause(root, ["--role", "dry"]));
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["clean", "dry"]);
  // A custom-loop id resolves through the config-backed check like abort's does.
  const config = defaultConfig();
  config.customLoops.push({ name: "myloop", task: "keep the examples current" });
  writeJsonFile(configPath(root), config);
  const custom = await expectOk(() => cmdPause(root, ["--role", "myloop"]));
  assert.match(custom.stdout, /role myloop paused/);
});

test("cmdResume --role lifts one role and reports the was-not-paused wording when absent", async () => {
  const root = tmpdir();
  const idle = await expectOk(() => cmdResume(root, ["--role", "clean"]));
  assert.match(idle.stdout, /role clean was not paused/);
  await expectOk(() => cmdPause(root, ["--role", "clean"]));
  await expectOk(() => cmdPause(root, ["--role", "dry"]));
  const { stdout } = await expectOk(() => cmdResume(root, ["--role", "clean"]));
  assert.match(stdout, /role clean resumed/);
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["dry"], "only the named role resumes");
  await expectOk(() => cmdResume(root, ["--role", "dry"]));
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "the last removal deletes the marker");
});

test("cmdResume --role while the fleet pause holds names the stronger gate instead of promising ticks", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root)); // fleet pause: the stronger gate
  await expectOk(() => cmdPause(root, ["--role", "clean"]));
  await expectOk(() => cmdPause(root, ["--role", "dry"]));
  const { stdout } = await expectOk(() => cmdResume(root, ["--role", "clean"]));
  assert.match(stdout, /role clean resumed/);
  assert.match(stdout, /fleet pause is still active/);
  // The marker really was lifted; only the wording acknowledges the fleet gate.
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["dry"]);
});

test("cmdResume (fleet) while roles are individually paused names the still-paused roles", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root)); // the fleet pause the resume lifts
  await expectOk(() => cmdPause(root, ["--role", "clean"]));
  await expectOk(() => cmdPause(root, ["--role", "dry"]));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /fleet resumed/);
  assert.match(stdout, /clean, dry are still individually paused/);
  // The per-role marker outlives the fleet resume.
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["clean", "dry"]);
  // A fleet resume with no per-role marker does not carry the note.
  await expectOk(() => cmdResume(root, ["--role", "clean"]));
  await expectOk(() => cmdResume(root, ["--role", "dry"]));
  const bare = await expectOk(() => cmdPause(root));
  assert.doesNotMatch(bare.stdout, /individually paused/);
  const quiet = await expectOk(() => cmdResume(root));
  assert.match(quiet.stdout, /fleet resumed/);
  assert.doesNotMatch(quiet.stdout, /individually paused/);
});

test("per-role pause and resume reject unknown role ids like abort does", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdPause(root, ["--role", "ghost"]));
  assert.equal(code, 1);
  assert.match(stderr, /unknown role: ghost/);
  const r = await expectFail(() => cmdResume(root, ["--role", "ghost"]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: ghost/);
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "no marker on failure");
});

// --- timed pause (`pause --for <duration>`) ---

// The pause confirmations' resume-time phrasing depends on whether the deadline crosses
// midnight, so these tests inject cmdPause's clock instead of reading the wall: a real clock
// would flip the phrasing whenever the suite runs near midnight. The fixture sits far in the
// future because the already-paused idempotence reads the marker's deadline against the real
// clock — a past deadline reads as expired and a plain re-pause would report a fresh pause.
const NOON = new Date(2100, 0, 15, 12, 0, 0).getTime();

test("cmdPause --for writes a timed fleet marker and names the auto-resume", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--for", "30m"], NOON));
  assert.match(stdout, /fleet paused for 30m — role loops stop starting new ticks/);
  assert.match(stdout, /resumes automatically at 12:30:00/);
  const marker = readJson(pausedPath(root)) as { at: number; until: number };
  assert.equal(marker.until, NOON + 30 * 60_000);
});

test("cmdPause --for over a standing pause overwrites the deadline and reports it", async () => {
  const root = tmpdir();
  // A late-evening clock: the first pause's deadline stays on today's calendar, the 2h one
  // crosses midnight — the confirmation must date-stamp it (this test runs the real cmdPause
  // with cmdPause's own clock, so it exercises the cross-midnight wording end to end).
  const evening = new Date(2100, 0, 15, 23, 20, 0).getTime();
  await expectOk(() => cmdPause(root, ["--for", "30m"], evening));
  const { stdout } = await expectOk(() => cmdPause(root, ["--for", "2h"], evening));
  assert.match(stdout, /fleet paused for 2h —/, "a fresh --for is a fresh confirmation, not 'already paused'");
  assert.match(stdout, /resumes automatically on 2100-01-16 at 01:20:00/);
  const marker = readJson(pausedPath(root)) as { until: number };
  assert.equal(marker.until, evening + 2 * 60 * 60_000);
  // A plain pause over a timed pause stays today's idempotent no-op.
  const again = await expectOk(() => cmdPause(root));
  assert.equal(again.stdout.trim(), "already paused");
});

test("cmdPause after an expired deadline reports a fresh pause", async () => {
  const root = tmpdir();
  ensureParentDir(pausedPath(root));
  fs.writeFileSync(pausedPath(root), JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000 }));
  const { stdout } = await expectOk(() => cmdPause(root));
  assert.match(stdout, /fleet paused/);
  assert.doesNotMatch(stdout, /already paused/);
});

test("cmdPause --role --for writes the role marker with the deadline and overwrites on a re-pause", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--role", "clean", "--for", "2h"], NOON));
  assert.match(stdout, /role clean paused for 2h — it stops starting new ticks/);
  assert.match(stdout, /resumes automatically at 14:00:00/);
  const readUntil = () => (readJson(pausedRolesPath(root)) as { roles: string[]; until: number }).until;
  const first = readUntil();
  assert.equal(first, NOON + 2 * 60 * 60_000);
  // A plain pause of the standing role stays the no-op; a fresh --for overwrites the deadline.
  const idle = await expectOk(() => cmdPause(root, ["--role", "clean"]));
  assert.equal(idle.stdout.trim(), "role clean is already paused");
  const second = await expectOk(() => cmdPause(root, ["--role", "clean", "--for", "1h"], NOON));
  assert.match(second.stdout, /role clean paused for 1h —/);
  assert.match(second.stdout, /resumes automatically at 13:00:00/);
  assert.equal(readUntil(), NOON + 60 * 60_000);
});

// --- the operator pause's reason (`pause --reason <text>`) ---

// The reason rides the fresh pause write (or a --for overwrite) as last-write-wins: the
// confirmation quotes it verbatim, an "already paused" no-op keeps the standing note, and
// a per-role pause carries no reason — `--role` + `--reason` fails fast rather than
// silently dropping the note (the exact hole the plan called out after a prior attempt).
test("cmdPause --reason quotes the why in the confirmation and the marker", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--reason", "deploying to prod"]));
  assert.match(stdout, /fleet paused — "deploying to prod" — role loops stop starting new ticks/);
  const marker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(marker.reason, "deploying to prod");
  // A --for overwrite carries its own reason beside the refreshed deadline.
  const timed = await expectOk(() => cmdPause(root, ["--for", "30m", "--reason", "deploys"], NOON));
  assert.match(timed.stdout, /fleet paused for 30m — "deploys" — role loops stop starting new ticks/);
  const timedMarker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(timedMarker.reason, "deploys");
  // A multi-line operator note folds to the one line every pause surface renders — the
  // confirmation line, the marker, the status header's badge — instead of breaking the
  // header mid-badge (BUGS.md 2026-09-30: the raw newline flowed through verbatim).
  await expectOk(() => cmdResume(root)); // the multiline pause must be a fresh write, not the standing no-op
  const multiline = await expectOk(() => cmdPause(root, ["--reason", "deploying\nthe new build\ttonight"]));
  assert.equal(multiline.stdout.trim().split("\n").length, 1, "the confirmation stays one line");
  assert.match(multiline.stdout, /fleet paused — "deploying the new build tonight" — role loops/);
  const foldedMarker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(foldedMarker.reason, "deploying the new build tonight", "the marker carries the folded line");
});

test("cmdPause --reason on a standing pause stays the no-op and keeps the standing reason", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root, ["--reason", "first why"]));
  const again = await expectOk(() => cmdPause(root, ["--reason", "second why"]));
  assert.equal(again.stdout.trim(), "already paused");
  const marker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(marker.reason, "first why", "only a fresh pause or a --for overwrite applies a reason");
});

test("cmdPause --role --reason fails fast and writes no role marker", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdPause(root, ["--role", "clean", "--reason", "why"]));
  assert.equal(code, 1);
  assert.match(stderr, /pause --reason states why the whole fleet is paused/);
  assert.match(stderr, /a per-role pause carries no reason/);
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "no role pause was recorded");
  assert.ok(!fs.existsSync(pausedPath(root)), "no fleet pause was recorded either");
});

test("cmdPause --reason without a value fails with the gate's own wording", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdPause(root, ["--reason"]));
  assert.equal(code, 1);
  assert.match(stderr, /pause --reason needs a reason/);
  assert.ok(!fs.existsSync(pausedPath(root)), "nothing was written");
});

// --- stop ---

// cmdStop is the one operator command that reaches a real process instead of a disk marker,
// so until now it was only exercised by spawning the whole CLI (test/cli.test.ts), which
// cannot assert that the signal landed on the recorded pid or pin the wording in-process.

test("cmdStop fails closed with no info file, and with a torn one naming a dead pid", async () => {
  const root = tmpdir();
  const absent = await expectFail(() => cmdStop(root));
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /no harness is running/);

  // A torn or stale info file (a pid that is not running) is the same "nothing to stop".
  writeOrchestratorMarker(root, [], { pid: 999_999_999 });
  const dead = await expectFail(() => cmdStop(root));
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /no harness is running/);
});

test("cmdStop SIGTERMs the recorded orchestrator pid and reports the drain", async () => {
  const root = tmpdir();
  // A real sleeper plays the orchestrator: alive for the liveness check, gone after the stop.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: exitWithOwnerEnv() });
  const deadline = Date.now() + 5_000;
  while (child.pid === undefined || !pidAlive(child.pid)) {
    if (Date.now() > deadline) throw new Error("the stand-in orchestrator never became visible");
    await sleep(10);
  }
  writeOrchestratorMarker(root, [], { pid: child.pid });
  try {
    const { stdout } = await expectOk(() => cmdStop(root));
    assert.match(stdout, /stop requested — the fleet drains its in-flight ticks and exits/);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.equal(exit.signal, "SIGTERM", "the recorded pid received SIGTERM, the same path as Ctrl+C");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
});

test("cmdStop reports a pid that died between the check and the signal as already stopped", async (t) => {
  const root = tmpdir();
  // The race window: pidAlive's signal-0 probe (passed through) says the recorded pid is
  // alive, but the SIGTERM itself lands on nothing (ESRCH). Stop's goal is already met, so
  // the command must exit clean with the honest wording, not a raw kill error.
  const kill = t.mock.method(process, "kill", ((_pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) return true;
    throw errnoError("ESRCH", "no such process");
  }) as typeof process.kill);
  writeOrchestratorMarker(root, []);

  const { stdout } = await expectOk(() => cmdStop(root));
  assert.match(stdout, /the orchestrator exited before the stop signal landed — nothing is running/);
  assert.deepEqual(
    kill.mock.calls.map((c) => c.arguments),
    [
      [process.pid, 0],
      [process.pid, "SIGTERM"],
    ],
    "the liveness probe ran signal-0 and the stop signal ran SIGTERM on the recorded pid",
  );
});

test("signalOrchestrator names the pid and the remedy when delivery fails for another reason", (t) => {
  const kill = t.mock.method(process, "kill", (() => {
    throw errnoError("EPERM", "operation not permitted");
  }) as typeof process.kill);
  assert.throws(() => signalOrchestrator(4242), /pid 4242.*kill 4242/s, "the message names the pid twice: once as the subject, once as the remedy");
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments), [[4242, "SIGTERM"]]);
});

test("signalOrchestrator rethrows a delivery error that is neither ESRCH nor EPERM", (t) => {
  // An unexpected errno must reach the caller untouched — the ESRCH and EPERM mappings are
  // the only two the command interprets; anything else is a bug or an environment the
  // operator needs to see raw, not a message the harness invents around it.
  const original = errnoError("EINVAL", "invalid argument");
  t.mock.method(process, "kill", (() => {
    throw original;
  }) as typeof process.kill);
  assert.throws(
    () => signalOrchestrator(4242),
    (err: unknown) => err === original,
    "the original error object is rethrown, not wrapped or swallowed",
  );
});

test("signalOrchestrator reads a vanished pid as gone, never throwing", () => {
  // A pid beyond any pid space (Linux caps pids at 2^22, macOS at 99999): the signal finds
  // nothing and the ESRCH mapping answers "gone" — the caller reports the goal as met.
  assert.equal(signalOrchestrator(999_999_999), "gone");
});
