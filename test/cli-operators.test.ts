// --- operator request commands: abort / pause / resume / wake / reset-counters ---
// These commands reach a running fleet only through marker files and state-file edits on
// disk (.tumwater/abort-<role>.json, the pause marker, the reset/wake request markers), so
// they are all testable with no harness running; the fleet-side consumption of each marker
// is pinned in test/orchestrator.e2e.test.ts. Split out of test/cli.test.ts, which keeps
// the remaining CLI surface (prompt, status, tui, doctor, report, run, gui).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { loadLoopState } from "../src/state.js";
import { abortRequestPath, orchestratorStatePath, pausedPath, resetRequestPath, wakeRequestPath } from "../src/paths.js";
import { cli, makeRepo, seedCounters } from "./util.js";

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
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: 2_000_000_000, startedAt: Date.now(), roles: [] }), // beyond any pid space
  );
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
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["feature"] }),
  );

  let r = await cli(repo, "abort", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /abort requested for feature/);
  assert.match(r.stdout, /within ~2s/);

  // The marker IS the request: one file per role, content just { at } — the fleet matches
  // on the name and removes it to acknowledge.
  const marker = JSON.parse(fs.readFileSync(abortRequestPath(repo, "feature"), "utf8")) as {
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
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["director"] }),
  );

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

test("pause and resume reject stray arguments without touching the marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause args");

  // Like every other no-flag command, both reject any argument instead of ignoring it.
  let r = await cli(repo, "pause", "--x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);
  r = await cli(repo, "resume", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);

  // The rejections happened before any marker work.
  assert.ok(!fs.existsSync(pausedPath(repo)), "no marker on failure");
});

test("pause and resume name the live effect when a harness is running", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli pause live");

  // Record this test process as the running orchestrator (it is alive).
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }),
  );

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

// --- logs/reset-counters/abort --role: user-defined loop targets ---

// User-defined loops are valid --role targets for logs/reset-counters/abort once tumwater.json
// and an unknown id fails naming the customs in the valid list.

test("logs, reset-counters, and abort accept user-defined loop names from tumwater.json", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom role cli test");
  const cfg = loadConfig(repo);
  cfg.customLoops.push({ name: "docs-sync", task: "keep the README examples current" });
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));

  // logs --role <custom>: valid id, no transcript yet.
  let r = await cli(repo, "logs", "--role", "docs-sync");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no transcript yet for docs-sync/);

  // An unknown id fails and lists the custom loop among the valid ones.
  r = await cli(repo, "logs", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: .+\)/);
  assert.ok(r.stderr.includes("docs-sync"), "the valid list names the custom loop");

  // reset-counters --role <custom> zeroes just that loop.
  seedCounters(repo, "docs-sync");
  r = await cli(repo, "reset-counters", "--role", "docs-sync");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for docs-sync/);
  assert.equal(loadLoopState(repo, "docs-sync").ticks, 0);

  // abort --role <custom> passes validation (no live fleet: it fails on the alive check,
  // which proves the id was accepted rather than rejected).
  r = await cli(repo, "abort", "--role", "docs-sync");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no harness is running/);
});
// --- reset-counters ---


test("reset-counters zeroes counters in every role's state file and writes the fleet marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  const r = await cli(repo, "reset-counters");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for/);
  // No orchestrator.json in this repo: the honest no-harness wording, not a ~2s pickup
  // promise no process will make (the live wording is pinned by the test below).
  assert.match(r.stdout, /takes effect on the next `tumwater run`/);
  assert.match(r.stdout, /no harness is running/);
  assert.doesNotMatch(r.stdout, /within ~2s/);

  for (const role of ["feature", "clean"]) {
    const s = loadLoopState(repo, role);
    assert.equal(s.ticks, 0, `${role} ticks`);
    assert.equal(s.commits, 0, `${role} commits`);
    assert.equal(s.generatedTokens, 0, `${role} tokens`);
    assert.equal(s.totalCostUsd, 0, `${role} cost`);
    // Scheduling and wake tracking are untouched.
    assert.ok(s.nextRunAt > Date.now(), `${role} keeps its sleep window`);
    assert.equal(s.backoffSeconds, 15, `${role} backoff preserved`);
    assert.equal(s.lastMainHead, "deadbeef", `${role} wake tracking preserved`);
    // Per-tick semantics: a fresh observation window clears the last tick's peak too,
    // or sleeping loops would keep showing their old value until they next tick.
    assert.equal(s.peakContextTokens, 0, `${role} per-tick peak ctx cleared`);
  }

  // The marker a running fleet consumes lists every role in the config.
  const marker = JSON.parse(fs.readFileSync(resetRequestPath(repo), "utf8")) as {
    at: number;
    roles: string[];
  };
  assert.ok(marker.at > 0);
  assert.deepEqual([...marker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());
});

test("reset-counters --role targets one loop; unknown or missing role fails without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters role test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  let r = await cli(repo, "reset-counters", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for feature/);
  const f = loadLoopState(repo, "feature");
  assert.equal(f.ticks, 0);
  assert.equal(f.commits, 0);
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "other roles untouched");
  const marker = JSON.parse(fs.readFileSync(resetRequestPath(repo), "utf8")) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);

  // Unknown role: clear failure, no state changes, no marker.
  fs.rmSync(resetRequestPath(repo));
  r = await cli(repo, "reset-counters", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);
  assert.equal(loadLoopState(repo, "feature").ticks, 0, "already-reset role unchanged");
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "other roles untouched on failure");
  assert.ok(!fs.existsSync(resetRequestPath(repo)), "no marker written on failure");

  // A bare --role fails cleanly too.
  r = await cli(repo, "reset-counters", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);
});

test("reset-counters and wake name the live effect when a harness is running", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli reset wake live");

  // Record this test process as the running orchestrator (it is alive).
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["feature"] }),
  );

  const reset = await cli(repo, "reset-counters");
  assert.equal(reset.code, 0);
  assert.match(reset.stdout, /a running fleet picks this up within ~2s/);
  assert.doesNotMatch(reset.stdout, /no harness is running/);

  const wake = await cli(repo, "wake");
  assert.equal(wake.code, 0);
  assert.match(wake.stdout, /a running fleet applies it within ~2s/);
  assert.doesNotMatch(wake.stdout, /no harness is running/);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

// --- wake ---

test("wake clears backoff in every role's state file and writes the fleet marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");
  const before = Date.now();

  const r = await cli(repo, "wake");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wake requested for/);

  for (const role of ["feature", "clean"]) {
    const s = loadLoopState(repo, role);
    assert.equal(s.backoffSeconds, 0, `${role} backoff cleared`);
    assert.ok(
      s.nextRunAt >= before && s.nextRunAt <= Date.now(),
      `${role} is immediately due (nextRunAt ${s.nextRunAt})`,
    );
    // Waking touches ONLY the schedule: counters and wake tracking stay as they were.
    assert.equal(s.ticks, 7, `${role} counters preserved`);
    assert.equal(s.commits, 3, `${role} commits preserved`);
    assert.equal(s.lastMainHead, "deadbeef", `${role} wake tracking preserved`);
  }

  // The marker a running fleet consumes lists every role in the config.
  const marker = JSON.parse(fs.readFileSync(wakeRequestPath(repo), "utf8")) as {
    at: number;
    roles: string[];
  };
  assert.ok(marker.at > 0);
  assert.deepEqual([...marker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());
});

test("wake --role targets one loop; unknown or missing role fails without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake role test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  let r = await cli(repo, "wake", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wake requested for feature/);
  assert.equal(loadLoopState(repo, "feature").backoffSeconds, 0);
  assert.equal(loadLoopState(repo, "clean").backoffSeconds, 15, "other roles untouched");
  const marker = JSON.parse(fs.readFileSync(wakeRequestPath(repo), "utf8")) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);

  // Unknown role: clear failure, no state changes, no marker.
  fs.rmSync(wakeRequestPath(repo));
  r = await cli(repo, "wake", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);
  assert.equal(loadLoopState(repo, "feature").backoffSeconds, 0, "already-woken role unchanged");
  assert.equal(loadLoopState(repo, "clean").backoffSeconds, 15, "other roles untouched on failure");
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker written on failure");

  // A bare --role fails cleanly too.
  r = await cli(repo, "wake", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);
});
