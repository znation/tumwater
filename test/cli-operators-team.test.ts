import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { initProject } from "../src/init/init.js";
import { loadConfig } from "../src/config/config.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { orchestratorStatePath, resetRequestPath, wakeRequestPath } from "../src/paths.js";
import { signalOrchestrator } from "../src/operator/operator-commands.js";
import { seedCounters } from "./fixtures/runner-fixtures.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { spawnLiveChild, stopChild } from "./helpers/child-process.js";

// The team-facing operator-command CLI tests (reset-counters, wake, stop, config), split
// from cli-operators.test.ts so node --test runs them in parallel processes — each test
// spawns the CLI, so the file is CPU-bound on its own. cli-operators.test.ts keeps the
// abort and pause/resume families (and lists the role and revert files split off since).

// --- logs/reset-counters/abort --role: user-defined role targets ---

// User-defined roles are valid --role targets for logs/reset-counters/abort once tumwater.json
// names them, and an unknown id fails naming the customs in the valid list.
test("logs, reset-counters, and abort accept user-defined role names from tumwater.json", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom role cli test");
  const cfg = loadConfig(repo);
  cfg.customRoles.push({ name: "docs-sync", task: "keep the README examples current" });
  writeConfig(repo, cfg);

  // logs --transcript <custom>: valid id, no transcript yet.
  let r = await cli(repo, "logs", "--transcript", "docs-sync");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no transcript yet for docs-sync/);

  // An unknown id fails and lists the custom role among the valid ones.
  r = await cli(repo, "logs", "--transcript", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: .+\)/);
  assert.ok(r.stderr.includes("docs-sync"), "the valid list names the custom role");

  // reset-counters --role <custom> zeroes just that role.
  seedCounters(repo, "docs-sync");
  r = await cli(repo, "reset-counters", "--role", "docs-sync");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for docs-sync/);
  assert.equal(loadRunnerState(repo, "docs-sync").runs, 0);

  // abort --role <custom> passes validation (no live team: it fails on the alive check,
  // which proves the id was accepted rather than rejected).
  r = await cli(repo, "abort", "--role", "docs-sync");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater is not running/);
});
// --- abort --all ---

// abort accepts --all and writes one marker per enabled runner through the shared core, printing
// one summary line naming the count.
test("abort --all runs the core with a live team and prints one summary line", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort all test");
  const live = spawnLiveChild();
  try {
    writeOrchestratorMarker(repo, [], { pid: live.child.pid });
    const r = await cli(repo, "abort", "--all");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /abort requested for \d+ roles/);
    assert.equal(r.stdout.trim().split(/\n/).length, 1, "one summary line");
  } finally {
    await stopChild(live);
    fs.rmSync(orchestratorStatePath(repo), { force: true });
  }
});

// abort --all --role <id> is refused before writing anything; the gate accepts both flags (both
// are in abort's flag set), so the command body owns the rivalry rule.
test("abort --all with --role is refused with the both-flags message", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort all args");
  const r = await cli(repo, "abort", "--all", "--role", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /abort takes either --role <id>\[,<id>\.\.\.] or --all, not both/);
});

// --all is abort's flag alone: every other marker command still refuses it as unknown.
test("pause --all and the other marker commands still refuse an unknown --all flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort all flag scope");
  for (const cmd of ["pause", "resume", "wake", "reset-counters", "reclaim"]) {
    const r = await cli(repo, cmd, "--all");
    assert.equal(r.code, 1, `${cmd} --all fails`);
    assert.match(r.stderr, /unknown argument: --all/);
  }
});

// --- reset-counters ---

test("reset-counters zeroes counters in every role's state file and writes the team marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  const r = await cli(repo, "reset-counters");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for/);
  // No orchestrator.json in this repo: the honest no-harness wording, not a ~2s pickup
  // promise no process will make (the live wording is pinned by the test below).
  assert.match(r.stdout, /takes effect on the next `tumwater start`/);
  assert.match(r.stdout, /tumwater is not running/);
  assert.doesNotMatch(r.stdout, /within ~2s/);

  for (const role of ["feature", "clean"]) {
    const s = loadRunnerState(repo, role);
    assert.equal(s.runs, 0, `${role} runs`);
    assert.equal(s.commits, 0, `${role} commits`);
    assert.equal(s.generatedTokens, 0, `${role} tokens`);
    assert.equal(s.totalCostUsd, 0, `${role} cost`);
    // Scheduling and wake tracking are untouched.
    assert.ok(s.nextRunAt > Date.now(), `${role} keeps its sleep window`);
    assert.equal(s.backoffSeconds, 15, `${role} backoff preserved`);
    assert.equal(s.lastMainHead, "deadbeef", `${role} wake tracking preserved`);
    // Per-run semantics: a fresh observation window clears the last run's peak too,
    // or sleeping roles would keep showing their old value until they next run.
    assert.equal(s.peakContextTokens, 0, `${role} per-run peak ctx cleared`);
  }

  // The marker a running team consumes lists every role in the config.
  const marker = readJson(resetRequestPath(repo)) as {
    at: number;
    roles: string[];
  };
  assert.ok(marker.at > 0);
  assert.deepEqual([...marker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());
});

test("reset-counters --role targets one role; unknown or missing role fails without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters role test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  let r = await cli(repo, "reset-counters", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for feature/);
  const f = loadRunnerState(repo, "feature");
  assert.equal(f.runs, 0);
  assert.equal(f.commits, 0);
  assert.equal(loadRunnerState(repo, "clean").runs, 7, "other roles untouched");
  const marker = readJson(resetRequestPath(repo)) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);

  // Unknown role: clear failure, no state changes, no marker.
  fs.rmSync(resetRequestPath(repo));
  r = await cli(repo, "reset-counters", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);
  assert.equal(loadRunnerState(repo, "feature").runs, 0, "already-reset role unchanged");
  assert.equal(loadRunnerState(repo, "clean").runs, 7, "other roles untouched on failure");
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
  writeOrchestratorMarker(repo, ["feature"]);

  const reset = await cli(repo, "reset-counters");
  assert.equal(reset.code, 0);
  assert.match(reset.stdout, /the running team picks this up within ~2s/);
  assert.doesNotMatch(reset.stdout, /tumwater is not running/);

  const wake = await cli(repo, "wake");
  assert.equal(wake.code, 0);
  assert.match(wake.stdout, /the running team applies it within ~2s/);
  assert.doesNotMatch(wake.stdout, /tumwater is not running/);

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

// --- wake ---

test("wake clears backoff in every role's state file and writes the team marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");
  const before = Date.now();

  const r = await cli(repo, "wake");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wake requested for/);

  for (const role of ["feature", "clean"]) {
    const s = loadRunnerState(repo, role);
    assert.equal(s.backoffSeconds, 0, `${role} backoff cleared`);
    assert.ok(
      s.nextRunAt >= before && s.nextRunAt <= Date.now(),
      `${role} is immediately due (nextRunAt ${s.nextRunAt})`,
    );
    // Waking touches ONLY the schedule: counters and wake tracking stay as they were.
    assert.equal(s.runs, 7, `${role} counters preserved`);
    assert.equal(s.commits, 3, `${role} commits preserved`);
    assert.equal(s.lastMainHead, "deadbeef", `${role} wake tracking preserved`);
  }

  // The marker a running team consumes lists every role in the config.
  const marker = readJson(wakeRequestPath(repo)) as {
    at: number;
    roles: string[];
  };
  assert.ok(marker.at > 0);
  assert.deepEqual([...marker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());
});

test("wake --role targets one role; unknown or missing role fails without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake role test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  let r = await cli(repo, "wake", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wake requested for feature/);
  assert.equal(loadRunnerState(repo, "feature").backoffSeconds, 0);
  assert.equal(loadRunnerState(repo, "clean").backoffSeconds, 15, "other roles untouched");
  const marker = readJson(wakeRequestPath(repo)) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);

  // Unknown role: clear failure, no state changes, no marker.
  fs.rmSync(wakeRequestPath(repo));
  r = await cli(repo, "wake", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);
  assert.equal(loadRunnerState(repo, "feature").backoffSeconds, 0, "already-woken role unchanged");
  assert.equal(loadRunnerState(repo, "clean").backoffSeconds, 15, "other roles untouched on failure");
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker written on failure");

  // A bare --role fails cleanly too.
  r = await cli(repo, "wake", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);
});

// --- stop: SIGTERM the recorded orchestrator pid (the same path as Ctrl+C) ---
// Unlike the marker commands above, stop reaches a real process: the pid in
// .tumwater/state/orchestrator.json. The liveness gate and failure wording match abort's.

test("stop refuses when tumwater is not running — missing or stale info file alike", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli stop no harness");

  let r = await cli(repo, "stop");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater is not running/);

  // A stale info file (dead pid) reads the same way: nothing alive to signal.
  writeOrchestratorMarker(repo, [], { pid: 2_000_000_000 });
  r = await cli(repo, "stop");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater is not running/);
});

test("stop SIGTERMs the recorded pid and prints the drain confirmation", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli stop live");

  // A real, killable child process standing in for the orchestrator: a node eval with no
  // SIGTERM handler, so the default behavior applies and it dies with signal SIGTERM —
  // letting the test assert the actual signal it dies from. Reaped in the finally: a failed
  // assertion that left it alive kept this file's process up forever (its event loop held by
  // the child), hanging the whole suite until the runner's ceiling (2026-10-01, a feature
  // run's broken dist failed `stop` here and wedged `npm run test` for 15 min).
  const live = spawnLiveChild();
  try {
    writeOrchestratorMarker(repo, [], { pid: live.child.pid });

    const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
      live.child.once("exit", (_code, signal) => resolve({ signal }));
    });
    const r = await cli(repo, "stop");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /stop requested — the team finishes current work, then stops/);

    // The child died from the SIGTERM `stop` sent, not from anything the test tore down.
    const { signal } = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("stop did not signal the recorded pid within 5s")), 5_000),
      ),
    ]);
    assert.equal(signal, "SIGTERM");
  } finally {
    await stopChild(live); // A no-op kill once `stop` has already killed it.
    fs.rmSync(orchestratorStatePath(repo), { force: true });
  }
});

test("signalOrchestrator reports ESRCH as gone and EPERM as an actionable error", async () => {
  // A pid that died between stop's liveness check and its signal: a real child spawned and
  // reaped first, so its (now-free) pid raises ESRCH deterministically — unlike the live
  // liveness-check race, this needs no timing to hit.
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
  assert.equal(signalOrchestrator(dead.pid as number), "gone");

  // The delivered case: a live child takes the SIGTERM and dies from it — reaped in the
  // finally like the stop test's stand-in above, so a failure cannot hang the file.
  const live = spawnLiveChild();
  try {
    const exited = new Promise((resolve) => live.child.once("exit", (_c, signal) => resolve(signal)));
    assert.equal(signalOrchestrator(live.child.pid as number), "signalled");
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5_000))]), "SIGTERM");
  } finally {
    await stopChild(live);
  }
});

test("stop takes only --in and --cancel and appears in the help table", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli stop args");

  const r = await cli(repo, "stop", "--anything");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --anything \(valid flags for tumwater stop: --in <duration>, --cancel\)/);

  const help = await cli(repo, "help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /tumwater stop \[--in <duration> \| --cancel\]\s+Stop a running team/);
});

// --- config: print the effective merged config as JSON ---
// A pure read of loadConfig(root) — defaults filled in and custom roles merged — so the
// oracle is a direct loadConfig call on the same repo, never a hand-built expectation.

test("config prints the effective merged config as JSON, deep-equal to loadConfig", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli config");

  // Overrides plus a custom role: the output must show the MERGED view (defaults filled
  // in, the custom role present in roles) — the same shape the orchestrator's runners see —
  // not the overrides-only tumwater.json.
  const cfg = loadConfig(repo);
  cfg.minRunIntervalSeconds = 25;
  cfg.customRoles.push({ name: "docs-sync", task: "keep the README examples current" });
  writeConfig(repo, cfg);

  const r = await cli(repo, "config");
  assert.equal(r.code, 0);
  const printed = JSON.parse(r.stdout);
  assert.deepEqual(printed, loadConfig(repo));
  // Role defaults the file never mentions are in the output (the merge is visible, not just
  // pass-through), and the custom role is merged into roles exactly as the file's own
  // roles-override entries would be.
  assert.equal(printed.minRunIntervalSeconds, 25);
  assert.deepEqual(printed.roles["docs-sync"], { enabled: true });
  assert.ok(printed.roles.feature, "built-in role defaults are printed");
});

test("config fails with validateConfig's message and prints no JSON for an invalid file", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli config invalid");

  writeConfig(repo, { minRunIntervalSeconds: -1 });
  const r = await cli(repo, "config");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid tumwater.json/);
  assert.match(r.stderr, /minRunIntervalSeconds must be a number of 0 or more/);
  assert.equal(r.stdout, "");
});

test("config get/set arg shapes, repo gating, and the help table", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli config args");

  // Anything that is not get/set/unset fails with the usage, whatever the arity.
  let r = await cli(repo, "config", "--anything");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config \[get <key> \| set <key> <value> \| unset <key>\]/);
  r = await cli(repo, "config", "show");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config/);

  // A near-miss subcommand word gets the same did-you-mean hint `completion <shell>` gets.
  r = await cli(repo, "config", "gte");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did you mean `get`\?/);
  r = await cli(repo, "config", "--anything");
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /did you mean/);

  // get and unset take exactly one arg; set exactly two.
  r = await cli(repo, "config", "get");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config get <key>/);
  r = await cli(repo, "config", "get", "model", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config get <key>/);
  r = await cli(repo, "config", "set", "model");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config set <key> <value>/);
  r = await cli(repo, "config", "set", "model", "gpt-5", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config set <key> <value>/);
  r = await cli(repo, "config", "unset");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config unset <key>/);
  r = await cli(repo, "config", "unset", "model", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config unset <key>/);

  const help = await cli(repo, "help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /tumwater config \[get <key> \| set <key> <value> \| unset <key>\]\s+Show the effective config/);

  // Outside an initialized repo the ready-repo gate fires before any config is read.
  const bare = makeRepo();
  const b = await cli(bare, "config");
  assert.equal(b.code, 1);
  assert.match(b.stderr, /not initialized/);
});

test("config get/set roundtrip: set persists, get reads the resolved value", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli config roundtrip");

  let r = await cli(repo, "config", "set", "minRunIntervalSeconds", "45");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /set minRunIntervalSeconds to 45/);
  assert.equal(loadConfig(repo).minRunIntervalSeconds, 45);

  r = await cli(repo, "config", "get", "minRunIntervalSeconds");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^45\n?$/);

  // A non-JSON value lands as the literal string.
  r = await cli(repo, "config", "set", "model", "gpt-5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /set model to "gpt-5"/);
  assert.equal(loadConfig(repo).model, "gpt-5");
  r = await cli(repo, "config", "get", "model");
  assert.match(r.stdout, /^"gpt-5"\n?$/);

  // An optional key nothing sets prints JSON null, not the bare word `undefined` — the raw
  // JSON.stringify(undefined) is not parseable output and reads like a crash (improve 2026-09-30).
  assert.equal(loadConfig(repo).provider, undefined); // The seeded config leaves it unset.
  r = await cli(repo, "config", "get", "provider");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^null\n?$/);
  r = await cli(repo, "config", "get", "fallbackModel");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^null\n?$/);
});

test("config set rejects unknown and type-invalid edits, leaving tumwater.json byte-identical", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli config rejects");
  const before = fs.readFileSync(`${repo}/tumwater.json`, "utf8");

  // An unknown key is rejected with the valid-keys list, a did-you-mean for the typo, and
  // nothing is written.
  let r = await cli(repo, "config", "set", "modle", "x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown config key "modle" \(valid top-level keys: /);
  assert.ok(r.stderr.includes("maxDailyCostUsd"), "the valid list names a real key");
  assert.match(r.stderr, /— did you mean `model`\?/);
  assert.equal(fs.readFileSync(`${repo}/tumwater.json`, "utf8"), before);

  // `get` carries the same suggestion for its unknown-key error.
  r = await cli(repo, "config", "get", "modle");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown config key "modle" \(valid top-level keys: .+\) — did you mean `model`\?/);

  // A type-invalid value fails with validateConfig's own message; no tmp remnant.
  r = await cli(repo, "config", "set", "minRunIntervalSeconds", '"45"');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /minRunIntervalSeconds must be a number of 0 or more/);
  assert.equal(fs.readFileSync(`${repo}/tumwater.json`, "utf8"), before);
  assert.deepEqual(fs.readdirSync(repo).filter((f) => f.includes("tumwater.json")), ["tumwater.json"]);
});
