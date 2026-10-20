import { sleep } from "./helpers/wait.js";
import test from "node:test";
import { readJson, readScheduledWakes } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cmdAbort,
  cmdPause,
  cmdReclaim,
  cmdResetCounters,
  cmdResume,
  cmdStop,
  cmdWake,
  signalOrchestrator,
} from "../src/operator/operator-commands.js";
import { pidAlive } from "../src/process/process.js";
import { defaultConfig } from "../src/config/config.js";
import { PAUSE_REASON_MAX } from "../src/team/team-state.js";
import { writeJsonAtomic, writeJsonFile } from "../src/files/json-files.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { configPath } from "../src/paths.js";
import {
  freshLoopState,
  loadLoopState,
  saveLoopState,
} from "../src/runner/runner-state.js";
import {
  abortRequestPath,
  pausedPath,
  pausedRolesPath,
  reclaimRequestPath,
  resetRequestPath,
  wakeRequestPath,
  worktreeUsePath,
} from "../src/paths.js";
import { makeRepo, sh, tmpdir, worktreeAt, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { errnoError } from "./helpers/fs-faults.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";
import { expectFailAsync, expectOkAsync as expectOk } from "./helpers/exit-capture.js";
import { spawnLiveChild, stopChild } from "./helpers/child-process.js";

/** Producer-side tests for the operator-intent protocol (src/operator/operator-intent.ts, with the
 * CLI command layer in src/operator/operator-commands.ts). Its
 * consumer half is pinned in operator-requests.test.ts; until now these five CLI commands
 * were only exercised by spawning the real binary (test/cli.test.ts), which cannot assert
 * the marker contents or the untouched scheduling fields in-process. */

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
    runs: 9,
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
  assert.equal(after.runs, 0);
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
  saveLoopState(root, { ...freshLoopState("coverage"), runs: 5 });
  const { stdout } = await expectOk(() => cmdResetCounters(root, []));
  assert.deepEqual(readJson<Record<string, unknown>>(resetRequestPath(root))["roles"], roles);
  assert.equal(loadLoopState(root, "coverage").runs, 0);
  assert.ok(stdout.startsWith("counters reset for "));
});

// --- wake ---

test("cmdWake clears the named loop's backoff and pulls nextRunAt to now, leaving counters alone", async () => {
  const root = tmpdir();
  const before = Date.now();
  saveLoopState(root, {
    ...freshLoopState("clean"),
    runs: 7,
    backoffSeconds: 3600,
    nextRunAt: Date.now() + 999_999,
  });
  const { stdout } = await expectOk(() => cmdWake(root, ["--role", "clean"]));
  assert.match(stdout, /wake requested for clean/);
  const after = loadLoopState(root, "clean");
  assert.equal(after.backoffSeconds, 0);
  assert.ok(after.nextRunAt >= before && after.nextRunAt <= Date.now(), `nextRunAt ${after.nextRunAt} not pulled to now`);
  assert.equal(after.runs, 7); // observation-window counters are not this command's job
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
  const [marker] = readScheduledWakes(root);
  assert.ok(marker, "the scheduled marker is written");
  assert.equal(marker.notBeforeMs - marker.at, 45 * 60_000, "the deadline is one clock read plus the duration");
});

// A malformed tumwater.json must not block an operator marker aimed at a built-in role:
// the team itself keeps running on its last-known-good config (the live reload), so wake,
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
  assert.equal(loadLoopState(root, "feature").runs, 0);

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
  const stderr = await expectFailAsync(() => cmdWake(root, ["--role", "docs"]));
  assert.match(stderr, /tumwater\.json is not valid JSON/);
});

// --- abort ---

test("cmdAbort without --role fails before writing any marker", async () => {
  const root = tmpdir();
  const stderr = await expectFailAsync(() => cmdAbort(root, []));
  assert.match(stderr, /abort requires --role/);
  assert.equal(fs.existsSync(abortRequestPath(root, "coverage")), false);
});

test("cmdAbort with no live harness fails instead of leaving an unconsumable marker", async () => {
  const root = tmpdir();
  const stderr = await expectFailAsync(() => cmdAbort(root, ["--role", "coverage"]));
  assert.match(stderr, /tumwater is not running/);
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
  const stderr = await expectFailAsync(() => cmdAbort(root, ["--role", "ghost"]));
  assert.match(stderr, /unknown role: ghost/);
});

// --- pause / resume ---

test("cmdPause writes the marker, reports no-harness timing, and is idempotent", async () => {
  const root = tmpdir(); // fresh repo: no .tumwater/ yet — ensureParentDir must create it
  const first = await expectOk(() => cmdPause(root));
  assert.match(first.stdout, /team paused/);
  assert.match(first.stdout, /tumwater is not running/);
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
  assert.doesNotMatch(stdout, /tumwater is not running/);
});

test("cmdResume is a no-op without a marker and lifts one when present", async () => {
  const root = tmpdir();
  const idle = await expectOk(() => cmdResume(root));
  assert.match(idle.stdout, /not paused/);
  await expectOk(() => cmdPause(root));
  assert.ok(fs.existsSync(pausedPath(root)));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /team resumed/);
  assert.equal(fs.existsSync(pausedPath(root)), false);
});

test("cmdResume with a live harness promises pickup within ~2s", async () => {
  const root = tmpdir();
  markLive(root);
  await expectOk(() => cmdPause(root));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /team resumed/);
  assert.match(stdout, /within ~2s/);
  assert.doesNotMatch(stdout, /tumwater is not running/);
});

// --- per-role pause (`pause --role <id>` / `resume --role <id>`) ---

test("cmdPause --role pauses one role, is idempotent, and leaves the team marker alone", async () => {
  const root = tmpdir();
  const first = await expectOk(() => cmdPause(root, ["--role", "clean"]));
  assert.match(first.stdout, /role clean paused/);
  assert.match(first.stdout, /current runs finish; the rest of the team is unaffected/);
  assert.ok(fs.existsSync(pausedRolesPath(root)));
  assert.ok(!fs.existsSync(pausedPath(root)), "a per-role pause never writes the team marker");
  const second = await expectOk(() => cmdPause(root, ["--role", "clean"]));
  assert.match(second.stdout, /role clean is already paused/);
  // Both roles end up in the one marker set.
  await expectOk(() => cmdPause(root, ["--role", "dedupe"]));
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["clean", "dedupe"]);
  // A custom-loop id resolves through the config-backed check like abort's does.
  const config = defaultConfig();
  config.customRoles.push({ name: "myloop", task: "keep the examples current" });
  writeJsonFile(configPath(root), config);
  const custom = await expectOk(() => cmdPause(root, ["--role", "myloop"]));
  assert.match(custom.stdout, /role myloop paused/);
});

test("cmdResume --role lifts one role and reports the was-not-paused wording when absent", async () => {
  const root = tmpdir();
  const idle = await expectOk(() => cmdResume(root, ["--role", "clean"]));
  assert.match(idle.stdout, /role clean was not paused/);
  await expectOk(() => cmdPause(root, ["--role", "clean"]));
  await expectOk(() => cmdPause(root, ["--role", "dedupe"]));
  const { stdout } = await expectOk(() => cmdResume(root, ["--role", "clean"]));
  assert.match(stdout, /role clean resumed/);
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["dedupe"], "only the named role resumes");
  await expectOk(() => cmdResume(root, ["--role", "dedupe"]));
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "the last removal deletes the marker");
});

test("cmdPause and cmdResume accept --role feature-1, the instance-1 pause key, which other commands reject", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root, ["--role", "feature-1"]));
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["feature-1"]);
  await expectOk(() => cmdResume(root, ["--role", "feature-1"]));
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "resume removes the feature-1 marker");
  const stderr = await expectFailAsync(() => cmdWake(root, ["--role", "feature-1"]));
  assert.match(stderr, /unknown role: feature-1/);
});

test("cmdResume --role while the team pause holds names the stronger gate instead of promising ticks", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root)); // team pause: the stronger gate
  await expectOk(() => cmdPause(root, ["--role", "clean"]));
  await expectOk(() => cmdPause(root, ["--role", "dedupe"]));
  const { stdout } = await expectOk(() => cmdResume(root, ["--role", "clean"]));
  assert.match(stdout, /role clean resumed/);
  assert.match(stdout, /team pause is still active/);
  // The marker really was lifted; only the wording acknowledges the team gate.
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["dedupe"]);
});

test("cmdResume (team) while roles are individually paused names the still-paused roles", async () => {
  const root = tmpdir();
  await expectOk(() => cmdPause(root)); // the team pause the resume lifts
  await expectOk(() => cmdPause(root, ["--role", "clean"]));
  await expectOk(() => cmdPause(root, ["--role", "dedupe"]));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /team resumed/);
  assert.match(stdout, /clean, dedupe are still individually paused/);
  // The per-role marker outlives the team resume.
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["clean", "dedupe"]);
  // A team resume with no per-role marker does not carry the note.
  await expectOk(() => cmdResume(root, ["--role", "clean"]));
  await expectOk(() => cmdResume(root, ["--role", "dedupe"]));
  const bare = await expectOk(() => cmdPause(root));
  assert.doesNotMatch(bare.stdout, /individually paused/);
  const quiet = await expectOk(() => cmdResume(root));
  assert.match(quiet.stdout, /team resumed/);
  assert.doesNotMatch(quiet.stdout, /individually paused/);
});

test("per-role pause and resume reject unknown role ids like abort does", async () => {
  const root = tmpdir();
  const stderr = await expectFailAsync(() => cmdPause(root, ["--role", "ghost"]));
  assert.match(stderr, /unknown role: ghost/);
  const r = await expectFailAsync(() => cmdResume(root, ["--role", "ghost"]));
  assert.match(r, /unknown role: ghost/);
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "no marker on failure");
});

// --- timed pause (`pause --for <duration>`) ---

// The pause confirmations' resume-time phrasing depends on whether the deadline crosses
// midnight, so these tests inject cmdPause's clock instead of reading the wall: a real clock
// would flip the phrasing whenever the suite runs near midnight. The fixture sits far in the
// future because the already-paused idempotence reads the marker's deadline against the real
// clock — a past deadline reads as expired and a plain re-pause would report a fresh pause.
const NOON = new Date(2100, 0, 15, 12, 0, 0).getTime();

test("cmdPause --for writes a timed team marker and names the auto-resume", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--for", "30m"], NOON));
  assert.match(stdout, /team paused for 30m — roles start no new runs/);
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
  assert.match(stdout, /team paused for 2h —/, "a fresh --for is a fresh confirmation, not 'already paused'");
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
  assert.match(stdout, /team paused/);
  assert.doesNotMatch(stdout, /already paused/);
});

test("cmdPause --role --for writes the role marker with the deadline and overwrites on a re-pause", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--role", "clean", "--for", "2h"], NOON));
  assert.match(stdout, /role clean paused for 2h — it starts no new runs/);
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

test("cmdPause and cmdResume --role take a comma list", async () => {
  const root = tmpdir();
  const first = await expectOk(() => cmdPause(root, ["--role", "clean, dedupe,clean"]));
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["clean", "dedupe"]);
  assert.match(first.stdout, /role clean paused/);
  assert.match(first.stdout, /role dedupe paused/);
  assert.equal(first.stdout.match(/role clean/g)?.length, 1);
  const again = await expectOk(() => cmdPause(root, ["--role", "clean,organize"]));
  assert.match(again.stdout, /role clean is already paused/);
  assert.match(again.stdout, /role organize paused/);
  const resumed = await expectOk(() => cmdResume(root, ["--role", "clean,dedupe"]));
  assert.match(resumed.stdout, /clean[^\n]*resumed/);
  assert.match(resumed.stdout, /dedupe[^\n]*resumed/);
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["organize"]);
  await expectOk(() => cmdPause(root, ["--role", "feature-1,clean"]));
  assert.deepEqual(readJson<Record<string, unknown>>(pausedRolesPath(root)).roles, ["organize", "feature-1", "clean"]);
});

test("a comma list with an unknown id writes no marker", async () => {
  const root = tmpdir();
  const stderr = await expectFailAsync(() => cmdPause(root, ["--role", "clean,ghost"]));
  assert.match(stderr, /unknown role: ghost/);
  assert.ok(!fs.existsSync(pausedRolesPath(root)));
  assert.match(await expectFailAsync(() => cmdPause(root, ["--role", ","])), /--role needs a role id/);
});

test("cmdPause --role list --for writes one deadline for every listed role", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--role", "clean,dedupe", "--for", "1h"], NOON));
  assert.match(stdout, /role clean paused for 1h/);
  assert.match(stdout, /role dedupe paused for 1h/);
  const marker = readJson<{ roles: string[]; until: number }>(pausedRolesPath(root));
  assert.deepEqual(marker.roles, ["clean", "dedupe"]);
  assert.equal(marker.until, NOON + 60 * 60_000);
});

// --- the operator pause's reason (`pause --reason <text>`) ---

// The reason rides the fresh pause write (or a --for overwrite) as last-write-wins: the
// confirmation quotes it verbatim, an "already paused" no-op keeps the standing note, and
// a per-role pause carries no reason — `--role` + `--reason` fails fast rather than
// silently dropping the note (the exact hole the plan called out after a prior attempt).
test("cmdPause --reason quotes the why in the confirmation and the marker", async () => {
  const root = tmpdir();
  const { stdout } = await expectOk(() => cmdPause(root, ["--reason", "deploying to prod"]));
  assert.match(stdout, /team paused — "deploying to prod" — roles start no new runs/);
  const marker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(marker.reason, "deploying to prod");
  // A --for overwrite carries its own reason beside the refreshed deadline.
  const timed = await expectOk(() => cmdPause(root, ["--for", "30m", "--reason", "deploys"], NOON));
  assert.match(timed.stdout, /team paused for 30m — "deploys" — roles start no new runs/);
  const timedMarker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(timedMarker.reason, "deploys");
  // A multi-line operator note folds to the one line every pause surface renders — the
  // confirmation line, the marker, the status header's badge — instead of breaking the
  // header mid-badge (BUGS.md 2026-09-30: the raw newline flowed through verbatim).
  await expectOk(() => cmdResume(root)); // the multiline pause must be a fresh write, not the standing no-op
  const multiline = await expectOk(() => cmdPause(root, ["--reason", "deploying\nthe new build\ttonight"]));
  assert.equal(multiline.stdout.trim().split("\n").length, 1, "the confirmation stays one line");
  assert.match(multiline.stdout, /team paused — "deploying the new build tonight" — roles start no new runs/);
  const foldedMarker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(foldedMarker.reason, "deploying the new build tonight", "the marker carries the folded line");
});

// An over-cap note reads the same on every surface: the confirmation used to quote the
// operator's full folded text while the marker stored only the first PAUSE_REASON_MAX
// characters, so the CLI claimed a reason the rest of the harness never saw. Both go through
// normalizePauseReason's one cap now, ellipsis included.
test("cmdPause --reason caps the confirmation and the marker to the same line", async () => {
  const root = tmpdir();
  const long = "x".repeat(PAUSE_REASON_MAX + 50);
  const { stdout } = await expectOk(() => cmdPause(root, ["--reason", long]));
  const marker = readJson(pausedPath(root)) as { reason?: string };
  assert.equal(marker.reason?.length, PAUSE_REASON_MAX, "the marker is capped");
  assert.ok(marker.reason?.endsWith("…"), "the cap is visible");
  assert.ok(stdout.includes(marker.reason ?? ""), "the confirmation quotes exactly the stored line");
  assert.ok(!stdout.includes(long), "the confirmation does not quote the over-cap note");
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
  const stderr = await expectFailAsync(() => cmdPause(root, ["--role", "clean", "--reason", "why"]));
  assert.match(stderr, /pause --reason states why the whole team is paused/);
  assert.match(stderr, /a per-role pause carries no reason/);
  assert.ok(!fs.existsSync(pausedRolesPath(root)), "no role pause was recorded");
  assert.ok(!fs.existsSync(pausedPath(root)), "no team pause was recorded either");
});

test("cmdPause --reason without a value fails with the gate's own wording", async () => {
  const root = tmpdir();
  const stderr = await expectFailAsync(() => cmdPause(root, ["--reason"]));
  assert.match(stderr, /pause --reason needs a reason/);
  assert.ok(!fs.existsSync(pausedPath(root)), "nothing was written");
});

// --- stop ---

// cmdStop is the one operator command that reaches a real process instead of a disk marker,
// so until now it was only exercised by spawning the whole CLI (test/cli.test.ts), which
// cannot assert that the signal arrived on the recorded pid or pin the wording in-process.

test("cmdStop fails closed with no info file, and with a torn one naming a dead pid", async () => {
  const root = tmpdir();
  const absent = await expectFailAsync(() => cmdStop(root));
  assert.match(absent, /tumwater is not running/);

  // A torn or stale info file (a pid that is not running) is the same "nothing to stop".
  writeOrchestratorMarker(root, [], { pid: 999_999_999 });
  const dead = await expectFailAsync(() => cmdStop(root));
  assert.match(dead, /tumwater is not running/);
});

test("cmdStop SIGTERMs the recorded orchestrator pid and reports the drain", async () => {
  const root = tmpdir();
  // A real sleeper plays the orchestrator: alive for the liveness check, gone after the stop.
  const live = spawnLiveChild();
  const deadline = Date.now() + 5_000;
  while (live.child.pid === undefined || !pidAlive(live.child.pid)) {
    if (Date.now() > deadline) throw new Error("the stand-in orchestrator never became visible");
    await sleep(10);
  }
  writeOrchestratorMarker(root, [], { pid: live.child.pid });
  try {
    const { stdout } = await expectOk(() => cmdStop(root));
    assert.match(stdout, /stop requested — the team finishes current work, then stops/);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      live.child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.equal(exit.signal, "SIGTERM", "the recorded pid received SIGTERM, the same path as Ctrl+C");
  } finally {
    await stopChild(live);
  }
});

test("cmdStop reports a pid that died between the check and the signal as already stopped", async (t) => {
  const root = tmpdir();
  // The race window: pidAlive's signal-0 probe (passed through) says the recorded pid is alive, but
  // the SIGTERM itself arrives at nothing (ESRCH). Stop's goal is already met, so the command must
  // exit clean with the honest wording, not a raw kill error.
  const kill = t.mock.method(process, "kill", ((_pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) return true;
    throw errnoError("ESRCH", "no such process");
  }) as typeof process.kill);
  writeOrchestratorMarker(root, []);

  const { stdout } = await expectOk(() => cmdStop(root));
  assert.match(stdout, /the orchestrator exited before the stop signal arrived — nothing is running/);
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

/** A registered worktree with a committed .gitignore and one ignored build artifact. */
function seedReclaimWorktree(root: string): string {
  const wt = worktreeAt(root, "feature");
  fs.writeFileSync(path.join(wt, ".gitignore"), "build/\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "ignore build output");
  fs.mkdirSync(path.join(wt, "build"));
  fs.writeFileSync(path.join(wt, "build", "out.bin"), "artifact\n");
  // Register it so reclaimCandidates does not exclude it as used-at-first-sight.
  writeJsonAtomic(worktreeUsePath(root), { feature: { lastUsedAt: 1 } });
  return wt;
}

test("cmdReclaim with no team cleans ignored files in-process", async () => {
  const root = makeRepo();
  const wt = seedReclaimWorktree(root);
  const { stdout } = await expectOk(() => cmdReclaim(root, []));
  assert.match(stdout, /reclaimed feature/);
  assert.equal(fs.existsSync(path.join(wt, "build")), false);
});

test("cmdReclaim --dry-run lists candidates and deletes nothing", async () => {
  const root = makeRepo();
  const wt = seedReclaimWorktree(root);
  const { stdout } = await expectOk(() => cmdReclaim(root, ["--dry-run"]));
  assert.match(stdout, /feature: idle [\d.]+h, 1 ignored path/);
  assert.equal(fs.existsSync(path.join(wt, "build")), true);
});

test("cmdReclaim with a live team drops the reclaim marker instead of cleaning", async () => {
  const root = makeRepo();
  const wt = seedReclaimWorktree(root);
  markLive(root);
  const { stdout } = await expectOk(() => cmdReclaim(root, []));
  assert.match(stdout, /reclaim requested/);
  assert.equal(fs.existsSync(reclaimRequestPath(root)), true);
  assert.equal(fs.existsSync(path.join(wt, "build")), true, "the running team does the cleaning");
});

test("cmdReclaim on a repo with no worktrees reports nothing to reclaim in both modes", async () => {
  // No .tumwater/worktrees dir at all: reclaimCandidates answers [] before it can seed or
  // inspect anything. The dry run has its own empty-list arm, distinct from the manual pass's
  // null result.
  const root = makeRepo();
  const dry = await expectOk(() => cmdReclaim(root, ["--dry-run"]));
  assert.match(dry.stdout, /nothing to reclaim — no reclaimable worktrees/);
  const manual = await expectOk(() => cmdReclaim(root, []));
  assert.equal(manual.stdout.trim(), "nothing to reclaim");
});

test("cmdReclaim --dry-run reports plural paths, pending resumes and fresh worktrees", async () => {
  const root = makeRepo();
  const pending = worktreeAt(root, "feature");
  const fresh = worktreeAt(root, "clean");
  for (const wt of [pending, fresh]) {
    fs.writeFileSync(path.join(wt, ".gitignore"), "build/\ndist/\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-m", "ignore build output");
    for (const dir of ["build", "dist"]) {
      fs.mkdirSync(path.join(wt, dir));
      fs.writeFileSync(path.join(wt, dir, "out.bin"), "artifact\n");
    }
  }
  // feature has a pending resume (so no idle pass may clean it) and was last used long ago;
  // clean was used just now, so it is not idle-expired either.
  saveLoopState(root, { ...freshLoopState("feature"), resumePending: true });
  writeJsonAtomic(worktreeUsePath(root), {
    feature: { lastUsedAt: 1 },
    clean: { lastUsedAt: Date.now() },
  });
  const { stdout } = await expectOk(() => cmdReclaim(root, ["--dry-run"]));
  assert.match(stdout, /feature: idle [\d.]+h, 2 ignored paths, resume pending, not idle-reclaimable/);
  assert.match(stdout, /clean: idle 0\.0h, 2 ignored paths, not idle-reclaimable/);
  assert.equal(fs.existsSync(path.join(pending, "build")), true, "dry run deletes nothing");
  assert.equal(fs.existsSync(path.join(fresh, "build")), true, "dry run deletes nothing");
});
