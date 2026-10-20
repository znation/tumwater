// --- operator request commands: abort / pause / resume / wake / reset-counters ---
// These commands reach a running team only through marker files and state-file edits on
// disk (.tumwater/abort-<role>.json, the pause marker, the reset/wake request markers), so
// they are all testable with no harness running; the team-side consumption of each marker
// is pinned in test/orchestrator.e2e.test.ts. Split out of test/cli.test.ts, which keeps
// the remaining CLI surface (prompt, status, tui, doctor, report, run, gui).

import test from "node:test";
import { readJson, readScheduledWakes } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { abortRequestPath, orchestratorStatePath, restartRequestPath, roleNotesPath, pausedPath, pausedRolesPath, wakeRequestPath } from "../src/paths.js";
import { commitIn, headSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { queuedRolePromptCount } from "../src/inbox/inbox.js";
import { cli, CLI } from "./helpers/cli-harness.js";
import { spawnSync } from "node:child_process";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";

// --- abort --role <id>: request to kill one loop's in-flight tick via a marker file ---
// The CLI cannot reach into the orchestrator process, so the request rides on disk: a
// per-role marker (.tumwater/abort-<role>.json) a running team consumes within one poll
// cycle. The team-side consumption is covered by test/orchestrator.e2e.test.ts; here we pin
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

test("abort refuses when tumwater is not running — missing or stale info file alike", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli abort no tumwater");

  // No orchestrator info at all: nothing would consume the marker.
  let r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater is not running/);
  assert.match(r.stderr, /tumwater start/);
  assert.ok(!fs.existsSync(abortRequestPath(repo, "feature")), "no marker written");

  // A stale info file (dead pid) must read the same way: a crash leaves the file behind,
  // and a marker dropped now would sit in .tumwater until the NEXT team start — where its
  // first poll would abort a tick that was never running when the user asked. Refuse.
  writeOrchestratorMarker(repo, [], { pid: 2_000_000_000 }); // beyond any pid space
  r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater is not running/);
  assert.ok(!fs.existsSync(abortRequestPath(repo, "feature")), "stale info writes no marker");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("abort drops a per-role marker for a live tumwater and reports it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli abort live");

  // Record this test process as the running orchestrator (it is alive).
  writeOrchestratorMarker(repo, ["feature"]);

  let r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /abort requested for feature/);
  assert.match(r.stdout, /within ~2s/);

  // The marker IS the request: one file per role, content just { at } — the team matches
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

  // The CLI itself logs no event — the team logs run_aborted when it applies the request.
  const logs = await cli(repo, "logs", "-n", "10");
  assert.equal(logs.code, 0);
  assert.ok(!logs.stdout.includes("run_aborted"), `no abort event from the CLI:\n${logs.stdout}`);

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
  assert.match(f.stdout, /abort requested for feature — the running team applies it within ~2s/);
  assert.ok(!f.stdout.includes("discarded"), `no director clause for non-director roles:\n${f.stdout}`);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

// --- restart: apply a pending self-redeploy, waiving the restart cooldown ---
// The terminal twin of the dashboard update alert's refresh button (POST /api/restart): both
// call requestRestart, so the CLI's confirmation and refusal are byte-for-byte the GUI's. The
// marker file is the same one consumeRestartRequest consumes. Like abort, restart's staleness
// gate reads the recorded published build's `stale` flag; with no team running the marker is
// written harmlessly for the next run's first poll.

test("restart drops the marker and reports the waived cooldown while the build is stale", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli restart stale");

  // Record this test process as the running orchestrator with a stale published build.
  writeOrchestratorMarker(repo, ["feature"], {
    build: { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 3 },
  });

  const r = await cli(repo, "restart");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /restart requested/);
  assert.match(r.stdout, /cooldown is waived/);
  assert.match(r.stdout, /blocked restart still blocks/);

  const marker = readJson(restartRequestPath(repo)) as { at: number };
  assert.ok(marker.at > 0, "marker carries the numeric at the team consumes");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("restart refuses with nothing written while the running build is not stale", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli restart fresh");

  writeOrchestratorMarker(repo, ["feature"], {
    build: { sha: "a".repeat(40), builtAt: 1, stale: false },
  });

  const r = await cli(repo, "restart");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no update is waiting/);
  assert.ok(!fs.existsSync(restartRequestPath(repo)), "a fresh build's restart writes no marker");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("restart with no team running writes the marker harmlessly and says so", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli restart no team");

  const r = await cli(repo, "restart");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater is not running/);
  assert.equal(fs.existsSync(restartRequestPath(repo)), true, "the marker waits for the next run's first poll");
});

test("restart rejects stray arguments and a --role before writing anything", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli restart arg validation");

  for (const args of [["extra"], ["--role", "feature"]]) {
    const r = await cli(repo, "restart", ...args);
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.match(r.stderr, /takes no arguments/);
    assert.ok(!fs.existsSync(restartRequestPath(repo)), `no marker written for ${JSON.stringify(args)}`);
  }
});

// --- pause / resume: the operator-intent team gate via a persistent marker file ---
// Unlike abort, these commands are meaningful with NO harness running (pausing before
// startup starts an already-paused team), so there is no live-harness refusal — only the
// wording changes. The marker's effect on a live team is pinned in
// test/orchestrator.e2e.test.ts; here we pin what the CLI itself does: idempotency, messaging,
// and the marker it writes/removes.

test("pause and resume are idempotent with no tumwater running", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause resume");
  const marker = pausedPath(repo);

  // No orchestrator info at all: the commands still succeed — pausing before startup is
  // meaningful (the team then starts already paused), so they say where it takes effect.
  let r = await cli(repo, "pause");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /team paused/);
  assert.match(r.stdout, /tumwater is not running/);
  assert.match(r.stdout, /next `tumwater start`/);
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
  assert.match(r.stdout, /team resumed/);
  assert.match(r.stdout, /tumwater is not running/);
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
  assert.match(r.stdout, /team paused for 90d/);
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
  assert.match(r.stdout, /team paused for 30m —/);
  // The CLI reads the real clock, so which phrasing the note takes (bare clock, or
  // date-stamped once the deadline crosses midnight) depends on when the suite runs — the
  // test pins the contract (the confirmation names the auto-resume), not the clock's position.
  assert.match(r.stdout, /resumes automatically (at \d{2}:\d{2}:\d{2}|on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2})/);
  const m = readJson(pausedPath(repo)) as { at: number; until: number };
  assert.ok(m.until > Date.now() + 29 * 60_000, "the marker carries the ms-epoch deadline");

  // Resume still lifts a timed pause early, unchanged.
  const resume = await cli(repo, "resume");
  assert.match(resume.stdout, /team resumed/);
  assert.equal(fs.existsSync(pausedPath(repo)), false);
});

test("pause and resume name the live effect when a tumwater is running", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause live");

  // Record this test process as the running orchestrator (it is alive).
  writeOrchestratorMarker(repo, ["clean"]);

  const p = await cli(repo, "pause");
  assert.equal(p.code, 0);
  assert.match(p.stdout, /team paused/);
  assert.match(p.stdout, /within ~2s/);
  assert.doesNotMatch(p.stdout, /tumwater is not running/);

  const r = await cli(repo, "resume");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /team resumed/);
  assert.match(r.stdout, /within ~2s/);
  assert.doesNotMatch(r.stdout, /tumwater is not running/);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("pause and resume accept --role to gate one role, with per-role wording and markers", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause role");
  const marker = path.join(repo, ".tumwater", "state", "paused-roles.json");

  // Pausing a role is meaningful with no harness running, like the team-wide form.
  let r = await cli(repo, "pause", "--role", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /role clean paused/);
  assert.match(r.stdout, /the rest of the team is unaffected/);
  assert.ok(fs.existsSync(marker), "the per-role marker is written");
  assert.ok(!fs.existsSync(pausedPath(repo)), "the team marker is untouched");

  // Idempotent with distinct wording, like the team-wide form.
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
// missing read, so it works with the team stopped. The queue-survival assertion here is the
// end-to-end half of the preview seam's contract (test/role-view.test.ts and
// test/tick-prompt.test.ts pin the unit halves): an inspection must never consume a queued
// prompt.

test("role prints one role's standing prompt, and a queued prompt survives inspection", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role inspection");

  let r = await cli(repo, "role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# tumwater role: feature/);
  assert.match(r.stdout, /Implement the SINGLE most valuable planned feature in PLANS\.md/); // the find text, verbatim
  assert.match(r.stdout, /## Next run's prompt/);

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

test("role --clear-notes and --notes-file write the role's notes", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role notes");
  const notes = roleNotesPath(repo, "feature");
  const file = path.join(repo, "n.md");
  fs.writeFileSync(file, "use team.ts");

  let r = await cli(repo, "role", "feature", "--notes-file", file);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: notes saved/);
  assert.equal(fs.readFileSync(notes, "utf8"), "use team.ts");
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /use team\.ts/);

  fs.writeFileSync(notes, "old");
  r = await cli(repo, "role", "--notes-file", file, "feature");
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(notes, "utf8"), "use team.ts");

  const big = path.join(repo, "big.md");
  fs.writeFileSync(big, "x".repeat(4097));
  r = await cli(repo, "role", "feature", "--notes-file", big);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /shorten it to at most 4096 bytes/);
  assert.equal(fs.readFileSync(notes, "utf8"), "use team.ts");

  r = await cli(repo, "role", "feature", "--clear-notes");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: notes cleared/);
  assert.equal(fs.readFileSync(notes, "utf8"), "");
  r = await cli(repo, "role", "feature", "--json");
  assert.equal((JSON.parse(r.stdout) as { notes: string | null }).notes, null);

  for (const [args, msg] of [
    [["feature", "--clear-notes", "--notes-file", "x"], /not both/],
    [["feature", "--clear-notes", "--json"], /--json does not apply/],
    [["director", "--clear-notes"], /director has no notes/],
    [["bogus", "--clear-notes"], /unknown role: bogus/],
  ] as const) {
    r = await cli(repo, "role", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, msg);
  }
});

test("role --clear-instructions and --instructions-file write the role's instructions", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role instructions");
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));

  // Literal storage: a file whose whole content is `123` must stay the string "123" (the
  // JSON.stringify wrapper beats setConfigKey's JSON-parse fallback, which would re-type it).
  const file = path.join(repo, "inst.md");
  fs.writeFileSync(file, "123");
  let r = await cli(repo, "role", "feature", "--instructions-file", file);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instructions saved \(3 chars\)/);
  assert.equal(config().roles.feature.instructions, "123");

  // The rendered view and --json carry the override.
  r = await cli(repo, "role", "feature", "--json");
  assert.equal(JSON.parse(r.stdout).instructions, "123");
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /## Instructions override/);

  // `--instructions-file -` reads the text from stdin.
  const stdin = spawnSync(process.execPath, [CLI, "role", "feature", "--instructions-file", "-"], {
    cwd: repo, timeout: 20_000, input: "use src/team.ts\n", encoding: "utf8",
  });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(config().roles.feature.instructions, "use src/team.ts\n");

  // Over the 4096-char cap the config validator refuses and leaves the file unchanged.
  const big = path.join(repo, "big.md");
  fs.writeFileSync(big, "x".repeat(4097));
  r = await cli(repo, "role", "feature", "--instructions-file", big);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /at most 4096/);
  assert.equal(config().roles.feature.instructions, "use src/team.ts\n");

  // An instance id targets its base role: feature-2 writes roles.feature.instructions.
  // (feature-2 is a known id only once the base role has instances configured.)
  const configured = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  const base = path.join(repo, "base.md");
  fs.writeFileSync(base, "for base");
  r = await cli(repo, "role", "feature-2", "--instructions-file", base);
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.instructions, "for base");

  // Clearing removes the key (undefined, not an empty string).
  r = await cli(repo, "role", "feature", "--clear-instructions");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instructions cleared/);
  assert.equal(config().roles.feature.instructions, undefined);
  r = await cli(repo, "role", "feature", "--json");
  assert.equal(JSON.parse(r.stdout).instructions, null);

  // Refusals.
  for (const [args, msg] of [
    [["feature", "--clear-instructions", "--instructions-file", "x"], /not both/],
    [["feature", "--clear-instructions", "--json"], /--json does not apply/],
    [["feature", "--clear-notes", "--instructions-file", "x"], /notes and instructions writes/],
    [["bogus", "--clear-instructions"], /unknown role: bogus/],
  ] as const) {
    r = await cli(repo, "role", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, msg);
  }

  // The director is allowed for instructions (its override reaches its own runs), unlike
  // the notes branch's director refusal.
  r = await cli(repo, "role", "director", "--clear-instructions");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /director: instructions cleared/);
});

test("role --quiet-hours and --clear-quiet-hours write the role's quiet hours", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role quiet hours");
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));

  // `--quiet-hours <window>` writes quietHoursPerRole.feature through the config core.
  let r = await cli(repo, "role", "feature", "--quiet-hours", "23:00-07:00");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours set to 23:00-07:00/);
  assert.equal(config().quietHoursPerRole.feature, "23:00-07:00");

  // The rendered view and --json carry the resolved window.
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- Quiet hours: 23:00-07:00/);
  r = await cli(repo, "role", "feature", "--json");
  assert.match(r.stdout, /"23:00-07:00"/);

  // An instance id targets its base role: feature-2 writes quietHoursPerRole.feature.
  const configured = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--quiet-hours", "22:00-06:00");
  assert.equal(r.code, 0);
  assert.equal(config().quietHoursPerRole.feature, "22:00-06:00");

  // A clear removes the key; `--quiet-hours ""` and a whitespace-only value clear it too
  // (empty means off, the config's own reading), and a clear writes nothing when unset.
  r = await cli(repo, "role", "feature", "--clear-quiet-hours");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours cleared/);
  assert.equal(config().quietHoursPerRole, undefined);
  const bytesAfterClear = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--clear-quiet-hours");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours cleared/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterClear, "clearing an unset key writes nothing");
  r = await cli(repo, "role", "feature", "--quiet-hours", "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours cleared/);
  assert.equal(config().quietHoursPerRole, undefined);
  r = await cli(repo, "role", "feature", "--quiet-hours", "   ");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours cleared/);
  assert.equal(config().quietHoursPerRole, undefined);

  // A malformed window fails with checkQuietHours's message naming the key, leaving the
  // file unchanged; the director and an unknown id are refused.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["nope", "23:00", "23:00-23:00"]) {
    r = await cli(repo, "role", "feature", "--quiet-hours", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /quietHoursPerRole.feature/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }
  r = await cli(repo, "role", "director", "--quiet-hours", "23:00-07:00");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director has no quiet hours/);
  r = await cli(repo, "role", "bogus", "--quiet-hours", "23:00-07:00");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // Mutually exclusive or inapplicable flags are refused and write nothing.
  r = await cli(repo, "role", "feature", "--clear-quiet-hours", "--quiet-hours", "x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-quiet-hours or --quiet-hours, not both/);
  r = await cli(repo, "role", "feature", "--quiet-hours", "x", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a quiet-hours write/);
  r = await cli(repo, "role", "feature", "--quiet-hours", "x", "--clear-notes");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes and quiet-hours writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--quiet-hours", "x", "--instructions-file", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /instructions and quiet-hours writes cannot share one invocation/);
  assert.equal(config().quietHoursPerRole, undefined, "no write from the refused invocations");
});

test("role --cap/--clear-cap and --min-run-interval/--clear-min-run-interval write the role's holds", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role cap and interval");
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));

  // `--cap <usd>` writes maxDailyCostUsdPerRole.feature through the config core.
  let r = await cli(repo, "role", "feature", "--cap", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to 5/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 5);

  // `--min-run-interval <seconds>` writes roles.feature.minRunIntervalSeconds.
  r = await cli(repo, "role", "feature", "--min-run-interval", "300");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval set to 300s/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 300);

  // An instance id targets its base role: feature-2 writes the .feature keys.
  const configured = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--cap", "5");
  assert.equal(r.code, 0);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 5);
  r = await cli(repo, "role", "feature-2", "--min-run-interval", "300");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 300);

  // `0` is a real value (it disables the cap / allows back-to-back runs), so it sets, not clears.
  r = await cli(repo, "role", "feature", "--cap", "0");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to 0/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 0);
  r = await cli(repo, "role", "feature", "--min-run-interval", "0");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval set to 0s/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 0);

  // A clear removes the key; `--cap ""` and a whitespace-only value clear it too, and a
  // clear writes nothing when unset.
  r = await cli(repo, "role", "feature", "--clear-cap");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap cleared/);
  assert.equal(config().maxDailyCostUsdPerRole, undefined);
  const bytesAfterCapClear = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--clear-cap");
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterCapClear, "clearing an unset key writes nothing");
  r = await cli(repo, "role", "feature", "--min-run-interval", "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval cleared/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, undefined);
  r = await cli(repo, "role", "feature", "--clear-min-run-interval");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval cleared/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, undefined);

  // A malformed cap fails with checkDailyBudgetUsd's message naming the key, leaving the
  // file unchanged; a malformed interval fails with validateConfig's message.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["-1", "abc"]) {
    r = await cli(repo, "role", "feature", "--cap", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /maxDailyCostUsdPerRole.feature/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }
  for (const bad of ["-1", "2147484", "abc"]) {
    r = await cli(repo, "role", "feature", "--min-run-interval", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /roles\.feature\.minRunIntervalSeconds/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }

  // The director's cap is refused (it has none) but its min-run-interval is accepted.
  r = await cli(repo, "role", "director", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director has no daily cap/);
  r = await cli(repo, "role", "director", "--clear-cap");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director has no daily cap/);
  r = await cli(repo, "role", "director", "--min-run-interval", "60");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.minRunIntervalSeconds, 60);

  // An unknown id is refused for both, writing nothing.
  r = await cli(repo, "role", "bogus", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  r = await cli(repo, "role", "bogus", "--min-run-interval", "60");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // Mutually exclusive or inapplicable flags are refused and write nothing.
  r = await cli(repo, "role", "feature", "--clear-cap", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-cap or --cap, not both/);
  r = await cli(repo, "role", "feature", "--clear-min-run-interval", "--min-run-interval", "60");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-min-run-interval or --min-run-interval, not both/);
  r = await cli(repo, "role", "feature", "--cap", "5", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a cap write/);
  r = await cli(repo, "role", "feature", "--min-run-interval", "60", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a min-run-interval write/);
  r = await cli(repo, "role", "feature", "--cap", "5", "--min-run-interval", "60");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cap and min-run-interval writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--cap", "5", "--clear-notes");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes and cap writes cannot share one invocation/);
  const afterRefusals = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  assert.equal(JSON.parse(afterRefusals).maxDailyCostUsdPerRole, undefined, "no cap write from the refused invocations");
});

test("role --instances/--clear-instances write the role's parallel-runner count", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role instances");
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));

  // `--instances <n>` writes roles.feature.instances through the config core.
  let r = await cli(repo, "role", "feature", "--instances", "3");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances set to 3/);
  assert.equal(config().roles.feature.instances, 3);

  // An instance id targets its base role: feature-2 writes the .feature key.
  r = await cli(repo, "role", "feature-2", "--instances", "3");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.instances, 3);

  // The write is visible: `tumwater role feature` and feature-2 render an Instances line.
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- Instances: 3/);
  r = await cli(repo, "role", "feature-2");
  assert.match(r.stdout, /- Instances: 3/);
  r = await cli(repo, "role", "feature-2", "--json");
  assert.match(r.stdout, /"instances": 3/);

  // A clear removes the key; `--instances ""` clears it too, and a clear writes nothing when
  // the key is already unset.
  r = await cli(repo, "role", "feature", "--clear-instances");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances cleared/);
  assert.equal(config().roles.feature.instances, undefined);
  const bytesAfterClear = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--clear-instances");
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterClear, "clearing an unset key writes nothing");
  r = await cli(repo, "role", "feature", "--instances", "2");
  assert.equal(r.code, 0);
  r = await cli(repo, "role", "feature", "--instances", "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances cleared/);
  assert.equal(config().roles.feature.instances, undefined);

  // A malformed count fails with validateConfig's message naming the key, leaving the file
  // unchanged.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["0", "9", "1.5", "abc"]) {
    r = await cli(repo, "role", "feature", "--instances", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /roles\.feature\.instances/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }
  // Only feature and bugfix may split: the director and every other role are refused.
  r = await cli(repo, "role", "steward", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only valid for feature and bugfix/);
  r = await cli(repo, "role", "director", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only valid for feature and bugfix/);
  // An unknown id is refused, writing nothing.
  r = await cli(repo, "role", "bogus", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // Mutually exclusive or inapplicable flags are refused and write nothing.
  r = await cli(repo, "role", "feature", "--clear-instances", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-instances or --instances, not both/);
  r = await cli(repo, "role", "feature", "--instances", "2", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to an instances write/);
  r = await cli(repo, "role", "feature", "--clear-instances", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to an instances write/);
  r = await cli(repo, "role", "feature", "--instances", "2", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /instances and cap writes cannot share one invocation/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "no write from the refused invocations");
});

test("role --enable and --disable write the role's enabled state", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role enable disable");
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));

  // `--disable` writes roles.feature.enabled === false and the view renders it disabled.
  let r = await cli(repo, "role", "feature", "--disable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: disabled/);
  assert.equal(config().roles.feature.enabled, false);
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- State: disabled, not paused/);
  r = await cli(repo, "role", "feature", "--json");
  assert.match(r.stdout, /"enabled": false/);

  // `--enable` restores it; a disabled role's base id still resolves and enables.
  r = await cli(repo, "role", "feature", "--enable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: enabled/);
  assert.equal(config().roles.feature.enabled, true);

  // An instance id targets its base role: feature-2 disables feature.
  const configured = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--disable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: disabled/);
  assert.equal(config().roles.feature.enabled, false);

  // The director cannot be disabled, and an unknown id is refused for both flags.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "director", "--disable");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director cannot be disabled/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged on director disable");
  r = await cli(repo, "role", "director", "--enable");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.enabled, true);
  const beforeBogus = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const flag of ["--enable", "--disable"]) {
    r = await cli(repo, "role", "bogus", flag);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: bogus/);
  }
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeBogus, "file unchanged on unknown id");

  // --enable --disable and combining either with another role write are refused, name the kinds.
  r = await cli(repo, "role", "feature", "--enable", "--disable");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /enable and disable writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--disable", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to an enable\/disable write/);
  r = await cli(repo, "role", "feature", "--disable", "--clear-notes");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes and disable writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--disable", "--clear-quiet-hours");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quiet-hours and disable writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--enable", "--instructions-file", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /instructions and enable writes cannot share one invocation/);
});

test("role --provider/--model/--thinking (and --clear-*) write the role's model triple", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role model triple");
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));

  // `--model <id>` writes roles.feature.model through the config core.
  let r = await cli(repo, "role", "feature", "--model", "anthropic/claude-sonnet-4");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: model set to anthropic\/claude-sonnet-4/);
  assert.equal(config().roles.feature.model, "anthropic/claude-sonnet-4");

  // `--provider <id>` and `--thinking <level>` write the other two fields.
  r = await cli(repo, "role", "feature", "--provider", "openai");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: provider set to openai/);
  assert.equal(config().roles.feature.provider, "openai");
  r = await cli(repo, "role", "feature", "--thinking", "high");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: thinking set to high/);
  assert.equal(config().roles.feature.thinking, "high");

  // A tier name stores the string (a tier reference, valid for roles.<id>.model).
  r = await cli(repo, "role", "feature", "--model", "strong");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.model, "strong");

  // An instance id targets its base role: feature-2 writes roles.feature.*.
  const configured = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--model", "gpt-5");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.model, "gpt-5");
  r = await cli(repo, "role", "feature-2", "--provider", "anthropic");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.provider, "anthropic");
  r = await cli(repo, "role", "feature-2", "--thinking", "low");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.thinking, "low");

  // Two model-triple writes cannot share one invocation, and write nothing.
  const beforeShare = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--model", "anthropic/x", "--provider", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /provider and model writes cannot share one invocation/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeShare, "no write from a shared invocation");

  // A clear removes each key; `--X ""` and whitespace-only values clear too, and a clear
  // writes nothing when unset.
  for (const [flag, clearFlag, field] of [
    ["--model", "--clear-model", "model"],
    ["--provider", "--clear-provider", "provider"],
    ["--thinking", "--clear-thinking", "thinking"],
  ] as const) {
    r = await cli(repo, "role", "feature", clearFlag);
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} cleared`));
    assert.equal(config().roles.feature[field], undefined, `${field} cleared`);
    const bytes = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
    r = await cli(repo, "role", "feature", clearFlag);
    assert.equal(r.code, 0, field);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytes, `${field} clear of an unset key writes nothing`);
    r = await cli(repo, "role", "feature", flag, "");
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} cleared`));
    r = await cli(repo, "role", "feature", flag, "   ");
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} cleared`));
  }

  // A malformed thinking level fails with checkModelTripleField's message naming the key and
  // naming THINKING_LEVELS, leaving the file unchanged.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--thinking", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /roles\.feature\.thinking must be one of off, minimal, low, medium, high, xhigh, max \(got "bogus"\)/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged on bogus thinking");

  // An unknown id is refused for any of the three, writing nothing.
  r = await cli(repo, "role", "bogus", "--model", "gpt-5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  r = await cli(repo, "role", "bogus", "--provider", "openai");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  r = await cli(repo, "role", "bogus", "--thinking", "high");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // --json is refused with any of the three writes.
  r = await cli(repo, "role", "feature", "--model", "gpt-5", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a model write/);
  r = await cli(repo, "role", "feature", "--provider", "openai", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a provider write/);
  r = await cli(repo, "role", "feature", "--thinking", "high", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a thinking write/);

  // --clear-X alongside --X is refused.
  r = await cli(repo, "role", "feature", "--clear-model", "--model", "gpt-5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-model or --model, not both/);
  r = await cli(repo, "role", "feature", "--clear-provider", "--provider", "openai");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-provider or --provider, not both/);
  r = await cli(repo, "role", "feature", "--clear-thinking", "--thinking", "high");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-thinking or --thinking, not both/);
  // A model-triple write combined with another role write is refused, naming both kinds.
  r = await cli(repo, "role", "feature", "--model", "gpt-5", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cap and model writes cannot share one invocation/);
  // All the refusals above left the file unchanged (it still holds the cleared state).
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged after all refusals");

  // The director's model-triple writes are accepted (configForRole resolves roles.director.*).
  r = await cli(repo, "role", "director", "--model", "claude-opus-4");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.model, "claude-opus-4");
  r = await cli(repo, "role", "director", "--provider", "anthropic");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.provider, "anthropic");
  r = await cli(repo, "role", "director", "--thinking", "medium");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.thinking, "medium");
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
// team's poll consumes it no earlier than the deadline (the consume gate is pinned in
// test/operator-requests.test.ts). Here we pin the CLI half: the flag gate, the cap, and the
// marker the three wake forms drop.

test("wake keeps the plain --role vocabulary and rejects --in everywhere else", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake args");

  // A malformed --in names the flag and the shape it wants, before any marker work.
  let r = await cli(repo, "wake", "--in", "xyz");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--in needs a duration like 45s, 90m, 1h30m, or 2d/);
  r = await cli(repo, "wake", "--in");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wake --in needs a value/);

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
  const [scheduled] = readScheduledWakes(repo);
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
  assert.match(r.stdout, /tumwater is not running/);
});

test("wake --cancel drops scheduled wakes without writing a marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake cancel");
  await cli(repo, "wake", "--role", "qa", "--in", "45m");
  let r = await cli(repo, "wake", "--cancel");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cancelled 1 scheduled wake$/m);
  assert.deepEqual(readScheduledWakes(repo), []);
  r = await cli(repo, "wake", "--cancel");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no scheduled wake pending/);
  r = await cli(repo, "wake", "--cancel", "--role", "qa");
  assert.match(r.stdout, /no scheduled wake pending for qa/);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "cancel is not a wake");

  await cli(repo, "wake", "--role", "qa", "--in", "45m");
  r = await cli(repo, "wake", "--cancel", "--in", "5m");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wake --cancel and --in cannot be combined/);
  assert.equal(readScheduledWakes(repo).length, 1);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)));

  r = await cli(repo, "pause", "--cancel");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --cancel/);
});

test("wake --list shows pending scheduled wakes read-only", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake list");
  let r = await cli(repo, "wake", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no scheduled wake pending/);
  r = await cli(repo, "wake", "--list", "--json");
  assert.equal(r.stdout.trim(), "[]");
  await cli(repo, "wake", "--role", "qa", "--in", "45m");
  await cli(repo, "wake", "--role", "feature", "--in", "2h");
  r = await cli(repo, "wake", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. in 4[45]m — qa$/m);
  assert.match(r.stdout, /^2\. in 2h — feature$/m);
  r = await cli(repo, "wake", "--list", "--role", "qa");
  assert.match(r.stdout, /^1\. in 4[45]m — qa$/m);
  assert.doesNotMatch(r.stdout, /feature/);
  r = await cli(repo, "wake", "--list", "--json");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 2);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["atMs", "roles"]);
  assert.equal(readScheduledWakes(repo).length, 2);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)));
  for (const extra of [["--cancel"], ["--in", "5m"]]) {
    r = await cli(repo, "wake", "--list", ...extra);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /wake --list cannot be combined with --in or --cancel/);
  }
  r = await cli(repo, "wake", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wake --json requires --list/);
  r = await cli(repo, "reset-counters", "--list");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --list/);
});

test("wake --in is capped at 90d like pause --for", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake cap");
  const r = await cli(repo, "wake", "--in", "91d");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wake --in is capped at 90d \(got 91d\)/);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker on a refused --in");
});

// --- revert: undo one merged change on main ---
// The CLI renderer for src/operator/revert.ts (its fail-closed unit surface lives in
// test/operator-revert.test.ts). Here we pin the arity gate, the exit code and printed head on
// success, and that the usage errors write no commit.

test("revert succeeds on main, prints the new head, and revers to a clean tree", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert success");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "work\n");
  commitIn(repo, "work to undo");
  const before = headSha(repo);

  const r = await cli(repo, "revert", before);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /main is now [0-9a-f]{8}/);
  assert.match(r.stdout, /may redo the work/);
  assert.notEqual(headSha(repo), before, "the revert committed the inverse");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "tree is clean after the revert");
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), `tumwater(operator): Revert ${before.slice(0, 8)}`);
});

test("revert rejects a flag-shaped token as a flag, before a lookup or a write", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert flag");
  const before = headSha(repo);

  const r = await cli(repo, "revert", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revert takes only --dry-run \(got --json\)/);
  assert.equal(headSha(repo), before, "no commit was written");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "the tree is clean");
});

test("revert --dry-run previews without writing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert dry run");
  fs.writeFileSync(path.join(repo, "to-undo.txt"), "one\n");
  commitIn(repo, "work to undo");
  const clean = headSha(repo);
  let r = await cli(repo, "revert", clean, "--dry-run");
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^would revert ${clean.slice(0, 8)}`));
  assert.match(r.stdout, /\n {2}to-undo\.txt\n/);
  assert.match(r.stdout, /applies cleanly/);
  assert.equal(headSha(repo), clean);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");

  fs.writeFileSync(path.join(repo, "to-undo.txt"), "two\n");
  commitIn(repo, "edit it again");
  const tip = headSha(repo);
  r = await cli(repo, "revert", "--dry-run", clean);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /would conflict/);
  assert.equal(headSha(repo), tip);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

test("revert with zero or multiple positionals fails with usage and writes no commit", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli revert arity");
  const before = headSha(repo);

  let r = await cli(repo, "revert");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revert needs a commit \(e.g. run tumwater revert 1a2b3c4\)/);

  r = await cli(repo, "revert", before, "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revert needs a commit \(e.g. run tumwater revert 1a2b3c4\)/);

  assert.equal(headSha(repo), before, "neither usage error moved HEAD");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "no commit was written");
});
