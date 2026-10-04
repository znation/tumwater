// --- operator request commands: abort / pause / resume / wake / reset-counters ---
// These commands reach a running fleet only through marker files and state-file edits on
// disk (.tumwater/abort-<role>.json, the pause marker, the reset/wake request markers), so
// they are all testable with no harness running; the fleet-side consumption of each marker
// is pinned in test/orchestrator.e2e.test.ts. Split out of test/cli.test.ts, which keeps
// the remaining CLI surface (prompt, status, tui, doctor, report, run, gui).

import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { abortRequestPath, orchestratorStatePath, pausedPath, pausedRolesPath, wakeRequestPath } from "../src/paths.js";
import { makeRepo } from "./repo-fixtures.js";
import { queuedRolePromptCount } from "../src/inbox.js";
import { cli } from "./cli-harness.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";

// --- abort --role <id>: request to kill one loop's in-flight tick via a marker file ---
// The CLI cannot reach into the orchestrator process, so the request rides on disk: a
// per-role marker (.tumwater/abort-<role>.json) a running fleet consumes within one poll
// cycle. The fleet-side consumption is covered by test/orchestrator.e2e.test.ts; here we pin
// what the CLI itself does — validation, the live-harness gate, and the marker it drops.

test("abort validates its arguments before touching anything", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli abort validation");

  // No flag at all: the command cannot know which loop to kill.
  let r = await cli(repo, "abort");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /abort requires --role <id>/);

  // A bare --role has no id to validate against.
  r = await cli(repo, "abort", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);

  // Unknown role: the parser fails before any marker could be written — a typo'd role must
  // not drop a marker no runner will ever match.
  r = await cli(repo, "abort", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // Unknown flags and stray positionals are rejected like every other command.
  r = await cli(repo, "abort", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);

  r = await cli(repo, "abort", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);

  // None of the failures left a marker behind.
  for (const role of ["feature", "clean"]) {
    assert.ok(!fs.existsSync(abortRequestPath(repo, role)), `no ${role} marker on failure`);
  }
});

test("abort refuses when no harness is running — missing or stale info file alike", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli abort no harness");

  // No orchestrator info at all: nothing would consume the marker.
  let r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no harness is running/);
  assert.match(r.stderr, /tumwater run/);
  assert.ok(!fs.existsSync(abortRequestPath(repo, "feature")), "no marker written");

  // A stale info file (dead pid) must read the same way: a crash leaves the file behind,
  // and a marker dropped now would sit in .tumwater until the NEXT fleet start — where its
  // first poll would abort a tick that was never running when the user asked. Refuse.
  writeOrchestratorMarker(repo, [], { pid: 2_000_000_000 }); // beyond any pid space
  r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no harness is running/);
  assert.ok(!fs.existsSync(abortRequestPath(repo, "feature")), "stale info writes no marker");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("abort drops a per-role marker for a live harness and reports it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli abort live");

  // Record this test process as the running orchestrator (it is alive).
  writeOrchestratorMarker(repo, ["feature"]);

  let r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /abort requested for feature/);
  assert.match(r.stdout, /within ~2s/);

  // The marker IS the request: one file per role, content just { at } — the fleet matches
  // on the name and removes it to acknowledge.
  const marker = readJson(abortRequestPath(repo, "feature")) as {
    at: number;
  };
  assert.ok(marker.at > 0);

  // Other roles' markers are untouched by an abort of one role.
  fs.writeFileSync(abortRequestPath(repo, "clean"), JSON.stringify({ at: 1 }));
  r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(abortRequestPath(repo, "clean")), "other role's marker untouched");

  // The CLI itself logs no event — the fleet logs tick_aborted when it applies the request.
  const logs = await cli(repo, "logs", "-n", "10");
  assert.equal(logs.code, 0);
  assert.ok(!logs.stdout.includes("tick_aborted"), `no abort event from the CLI:\n${logs.stdout}`);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("abort's confirmation names the discarded prompt only for the director", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli abort director clause");

  // Record this test process as the running orchestrator (it is alive).
  writeOrchestratorMarker(repo, ["director"]);

  // The director's in-flight prompt was dequeued from the inbox file at tick start and an
  // abort discards it without re-queueing — the confirmation must say so (item (b)).
  const d = await cli(repo, "abort", "--role", "director");
  assert.equal(d.code, 0);
  assert.match(d.stdout, /abort requested for director/);
  assert.match(d.stdout, /within ~2s/);
  assert.match(d.stdout, /in-flight prompt will be discarded/);
  assert.match(d.stdout, /re-submit with `tumwater prompt`/);

  // Non-director roles carry no such clause: their ticks have no dequeued prompt to lose,
  // and the base confirmation stays byte-identical.
  const f = await cli(repo, "abort", "--role", "feature");
  assert.equal(f.code, 0);
  assert.match(f.stdout, /abort requested for feature — a running fleet applies it within ~2s/);
  assert.ok(!f.stdout.includes("discarded"), `no director clause for non-director roles:\n${f.stdout}`);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

// --- pause / resume: the operator-intent fleet gate via a persistent marker file ---
// Unlike abort, these commands are meaningful with NO harness running (pausing before
// startup starts an already-paused fleet), so there is no live-harness refusal — only the
// wording changes. The marker's effect on a live fleet is pinned in
// test/orchestrator.e2e.test.ts; here we pin what the CLI itself does: idempotency, messaging,
// and the marker it writes/removes.

test("pause and resume are idempotent with no harness running", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause resume");
  const marker = pausedPath(repo);

  // No orchestrator info at all: the commands still succeed — pausing before startup is
  // meaningful (the fleet then starts already paused), so they say where it takes effect.
  let r = await cli(repo, "pause");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /fleet paused/);
  assert.match(r.stdout, /no harness is running/);
  assert.match(r.stdout, /next `tumwater run`/);
  const first = fs.readFileSync(marker, "utf8");
  const m = JSON.parse(first) as { at: number };
  assert.ok(m.at > 0, "the marker carries the pause timestamp");

  // Second pause: already paused, and the existing marker is left byte-for-byte untouched.
  r = await cli(repo, "pause");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "already paused");
  assert.equal(fs.readFileSync(marker, "utf8"), first, "no rewrite on repeat pause");

  // Resume removes the marker and confirms; a second resume reports not paused.
  r = await cli(repo, "resume");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /fleet resumed/);
  assert.match(r.stdout, /no harness is running/);
  assert.ok(!fs.existsSync(marker), "the marker is removed");

  r = await cli(repo, "resume");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "not paused");
});

test("pause --for is capped at 90d and accepts the boundary value", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause for cap");
  const marker = pausedPath(repo);

  // An over-cap --for is refused with the standing-pause alternative named, and no marker is
  // written: the refusal must not leave a deadline the operator has to learn about from
  // `tumwater status` instead of the command that created it.
  let r = await cli(repo, "pause", "--for", "91d");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pause --for is capped at 90d \(got 91d\)/);
  assert.match(r.stderr, /bare `tumwater pause`/);
  assert.ok(!fs.existsSync(marker), "no marker on a refused --for");

  // The same refusal on the per-role form (one check guards both pause shapes).
  r = await cli(repo, "pause", "--role", "qa", "--for", "100000000d");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /capped at 90d \(got 100000000d\)/);
  assert.ok(!fs.existsSync(pausedRolesPath(repo)), "no role marker on a refused --for");

  // The boundary value passes and writes the timed marker's { at, until } shape.
  r = await cli(repo, "pause", "--for", "90d");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /fleet paused for 90d/);
  const m = readJson(marker) as { at: number; until: number };
  assert.ok(m.until > Date.now() + 89 * 24 * 60 * 60 * 1000, "the deadline is 90 days out");
});

test("pause and resume reject stray arguments without touching the marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause args");

  // Both reject any argument they do not understand instead of ignoring it; since --role
  // became valid, the rejection names the flag list rather than a no-arguments rule. Pause
  // additionally accepts --for (the timed pause) and --reason (the operator pause's why),
  // so its list is longer — and the other marker commands keep rejecting both, so a stray
  // deadline or note fails fast instead of being silently ignored.
  let r = await cli(repo, "pause", "--x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --x \(valid flags for tumwater pause: --role <id>, --for <duration>, --reason <text>\)/);
  r = await cli(repo, "resume", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra \(valid flags for tumwater resume: --role <id>\)/);
  r = await cli(repo, "resume", "--for", "5m");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --for/);

  // The rejections happened before any marker work.
  assert.ok(!fs.existsSync(pausedPath(repo)), "no marker on failure");
});

test("pause --for writes a timed marker and resume lifts it early", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause timed");

  const r = await cli(repo, "pause", "--for", "30m");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /fleet paused for 30m —/);
  // The CLI reads the real clock, so which phrasing the note takes (bare clock, or
  // date-stamped once the deadline crosses midnight) depends on when the suite runs — the
  // test pins the contract (the confirmation names the auto-resume), not the clock's position.
  assert.match(r.stdout, /resumes automatically (at \d{2}:\d{2}:\d{2}|on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2})/);
  const m = readJson(pausedPath(repo)) as { at: number; until: number };
  assert.ok(m.until > Date.now() + 29 * 60_000, "the marker carries the ms-epoch deadline");

  // Resume still lifts a timed pause early, unchanged.
  const resume = await cli(repo, "resume");
  assert.match(resume.stdout, /fleet resumed/);
  assert.equal(fs.existsSync(pausedPath(repo)), false);
});

test("pause and resume name the live effect when a harness is running", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause live");

  // Record this test process as the running orchestrator (it is alive).
  writeOrchestratorMarker(repo, ["clean"]);

  const p = await cli(repo, "pause");
  assert.equal(p.code, 0);
  assert.match(p.stdout, /fleet paused/);
  assert.match(p.stdout, /within ~2s/);
  assert.doesNotMatch(p.stdout, /no harness is running/);

  const r = await cli(repo, "resume");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /fleet resumed/);
  assert.match(r.stdout, /within ~2s/);
  assert.doesNotMatch(r.stdout, /no harness is running/);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("pause and resume accept --role to gate one loop, with per-role wording and markers", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause role");
  const marker = path.join(repo, ".tumwater", "state", "paused-roles.json");

  // Pausing a role is meaningful with no harness running, like the fleet-wide form.
  let r = await cli(repo, "pause", "--role", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /role clean paused/);
  assert.match(r.stdout, /the rest of the fleet is unaffected/);
  assert.ok(fs.existsSync(marker), "the per-role marker is written");
  assert.ok(!fs.existsSync(pausedPath(repo)), "the fleet marker is untouched");

  // Idempotent with distinct wording, like the fleet-wide form.
  r = await cli(repo, "pause", "--role", "clean");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "role clean is already paused");

  // Resume lifts just the named role; a second resume reports it was not paused.
  r = await cli(repo, "resume", "--role", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /role clean resumed/);
  r = await cli(repo, "resume", "--role", "clean");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "role clean was not paused");
  assert.ok(!fs.existsSync(marker), "the last removal deletes the marker");

  // An unknown id fails with the shared unknown-role wording, before any marker work.
  r = await cli(repo, "pause", "--role", "ghost");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: ghost/);
  assert.ok(!fs.existsSync(marker));
});


// --- role <id>: one loop's standing prompt and resolved settings (read-only) ---
// Like backlog, the command gates on nothing: its collector degrades to empty answers on a
// missing read, so it works with the fleet stopped. The queue-survival assertion here is the
// end-to-end half of the preview seam's contract (test/role-view.test.ts and
// test/tick-prompt.test.ts pin the unit halves): an inspection must never consume a queued
// prompt.

test("role prints one loop's standing prompt, and a queued prompt survives inspection", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role inspection");

  let r = await cli(repo, "role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# tumwater role: feature/);
  assert.match(r.stdout, /Implement the SINGLE most valuable planned feature in PLANS\.md/); // the find text, verbatim
  assert.match(r.stdout, /## Next tick prompt/);

  // A queued per-role prompt appears inside the previewed next prompt AND survives — two
  // inspections in a row both show it, and the queue file count is unchanged.
  r = await cli(repo, "prompt", "--role", "feature", "check the scheduler first");
  assert.equal(r.code, 0);
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /check the scheduler first/);
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /check the scheduler first/);
  assert.equal(queuedRolePromptCount(repo, "feature"), 1);

  // --json prints the collector's own payload as one JSON document, not a re-parse of the
  // render — the same shape the Markdown branch consumed.
  r = await cli(repo, "role", "feature", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { id: string; nextPrompt: string; title: string };
  assert.equal(payload.id, "feature");
  assert.equal(payload.title, "feature implementer");
  assert.match(payload.nextPrompt, /check the scheduler first/);
});

test("role validates its arguments like every other command", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role validation");

  // No id at all.
  let r = await cli(repo, "role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater role needs a role id/);

  // Unknown role: the shared unknownRoleMessage wording, exit 1.
  r = await cli(repo, "role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // Unknown flags and stray positionals are rejected like every other command.
  r = await cli(repo, "role", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  r = await cli(repo, "role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);

  // Both spellings at once is a mistake, not a silent pick of one.
  r = await cli(repo, "role", "feature", "--role", "qa");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give the role id once/);

  // The --role spelling every other role-targeting command shares works too.
  r = await cli(repo, "role", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# tumwater role: qa/);
});

// --- wake [--in <duration>]: the immediate and scheduled wake request ---
// Like pause --for, the scheduled wake rides the wake marker: the CLI writes it now and the
// fleet's poll consumes it no earlier than the deadline (the consume gate is pinned in
// test/operator-requests.test.ts). Here we pin the CLI half: the flag gate, the cap, and the
// marker the three wake forms drop.

test("wake keeps the plain --role vocabulary and rejects --in everywhere else", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake args");

  // A malformed --in names the flag and the shape it wants, before any marker work.
  let r = await cli(repo, "wake", "--in", "xyz");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--in needs a duration like 45s, 90m, 2h, or 1d/);
  r = await cli(repo, "wake", "--in");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--in needs a value/);

  // The flag belongs to wake alone: pause/reset-counters reject it instead of ignoring it.
  r = await cli(repo, "pause", "--in", "5m");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --in \(valid flags for tumwater pause: --role <id>, --for <duration>, --reason <text>\)/);
  r = await cli(repo, "reset-counters", "--in", "5m");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --in/);

  // The rejections happened before any marker work.
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker on a refused --in");
});

test("wake --in schedules the marker; without --in the immediate shape is unchanged", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake scheduled");

  // The scheduled form: the marker carries the ms-epoch deadline and the confirmation names
  // both the deferral and where the state change actually happens (the deadline-crossing
  // poll, not the submit).
  let r = await cli(repo, "wake", "--role", "qa", "--in", "45m");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wake scheduled for qa — wakes in 45m — /);
  const scheduled = readJson(wakeRequestPath(repo)) as { at: number; roles: string[]; notBeforeMs: number };
  assert.ok(scheduled, "the scheduled marker is written");
  assert.ok(scheduled.notBeforeMs > Date.now() + 44 * 60_000, "the deadline is 45 minutes out");
  assert.deepEqual(scheduled.roles, ["qa"]);

  // Without --in, today's behavior is byte-for-byte the old contract: immediate consume, no
  // notBeforeMs field, "wake requested" wording.
  r = await cli(repo, "wake");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wake requested for /);
  const immediate = readJson(wakeRequestPath(repo)) as { at: number; roles: string[]; notBeforeMs?: number };
  assert.ok(immediate, "the immediate marker is written");
  assert.equal(immediate.notBeforeMs, undefined);
  assert.match(r.stdout, /no harness is running/);
});

test("wake --in is capped at 90d like pause --for", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake cap");
  const r = await cli(repo, "wake", "--in", "91d");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wake --in is capped at 90d \(got 91d\)/);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker on a refused --in");
});
