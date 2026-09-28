import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize, queuedPrompts, submitPrompt, queuedRolePrompts, submitRolePrompt } from "../src/inbox.js";
import { inboxDir, resetRequestPath } from "../src/paths.js";
import { loadLoopState } from "../src/state.js";
import { seedCounters } from "./loop-fixtures.js";
import { makeRepo, tmpdir, writeConfig } from "./repo-fixtures.js";
import { cli, cliWithEnv } from "./cli-harness.js";

// The second half of the CLI's child-process tests, split from cli.test.ts so node --test
// runs them in parallel processes (each test spawns the CLI, so the file is CPU-bound on
// its own). This file holds the prompt queue's cancel/role/flag-strictness cases, run's
// startup preflight, and the cross-command argument-strictness test; cli.test.ts keeps
// help/version, status, and init.
test("prompt --cancel fails on out-of-range or non-numeric positions without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel validation");

  submitPrompt(repo, "alpha");

  // Out of range: the error names the position and the queue size.
  let r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt at position 2 \(1 queued\)/);

  // Non-numeric or non-positive values are rejected by the parser before any file is touched.
  for (const bad of ["0", "abc", "1.5"]) {
    r = await cli(repo, "prompt", "--cancel", bad);
    assert.equal(r.code, 1, `--cancel ${bad} should fail`);
    assert.match(r.stderr, /--cancel needs a positive integer/);
  }

  // A missing value is its own error.
  r = await cli(repo, "prompt", "--cancel");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel needs a position number/);

  assert.equal(inboxSize(repo), 1, "nothing touched on failure");
});

// The read-only list mode follows parseRoleScope's broken-config policy (the same one
// logs --role applies): a transiently broken tumwater.json must not take the inspection
// command down, while the state-changing modes keep the loud config error when an id is
// named — and never read the config at all when the target is the director queue.
test("prompt --list survives a broken tumwater.json; named-role writes still fail loudly", async () => {
  const repo = makeRepo();
  await initProject(repo, "broken config prompt list");
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ not json");
  submitPrompt(repo, "survives");

  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^1\. survives$/m);

  // The fallback relaxes the config READ, not the id validation: an unknown id is refused.
  r = await cli(repo, "prompt", "--list", "--role", "qa");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /nothing queued for qa/);
  r = await cli(repo, "prompt", "--list", "--role", "nope");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role/);

  // Writing to a named loop's queue is owed the config error, not a built-ins-only guess.
  r = await cli(repo, "prompt", "--role", "qa", "ship it");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(inboxSize(repo), 1, "the broken config let nothing be written");

  // No --role: the director queue needs no config read, so steering still works.
  r = await cli(repo, "prompt", "steer the director");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /queued for the director loop/);
  r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cancelled: steer the director/);
});

test("prompt --cancel reports a concurrently dequeued prompt as gone and exits clean", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel race");

  // A dangling symlink is the deterministic stand-in for the race: readdir lists it (so the
  // position exists) but readFileSync hits ENOENT — exactly what a queued file looks like when
  // the director dequeues it between listing and removal. Its name sorts after real prompts,
  // so it occupies position 2.
  submitPrompt(repo, "alpha");
  const raced = path.join(inboxDir(repo), `9999999999999-000001-${process.pid}.md`);
  fs.symlinkSync(path.join(repo, "no-such-prompt.md"), raced);

  // A concurrent dequeue is a normal race, not an error: exit 0 with the explanation.
  const r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0, `expected clean exit for a gone prompt:\n${r.stderr}`);
  assert.match(r.stdout, /prompt 2 is no longer queued/);
  assert.match(r.stdout, /director already took it/);

  // Nothing was removed or logged: the prompt ran (or will), it was not cancelled.
  assert.ok(fs.lstatSync(raced).isSymbolicLink(), "the vanished file was left untouched");
  const logs = await cli(repo, "logs", "-n", "10");
  assert.equal(logs.code, 0);
  assert.ok(!logs.stdout.includes("prompt cancelled"), `no cancel event logged:\n${logs.stdout}`);

  // The sibling prompt is still queued and --list skips the vanished file instead of showing
  // a phantom position.
  const list = await cli(repo, "prompt", "--list");
  assert.equal(list.code, 0);
  assert.match(list.stdout, /^1\. alpha$/m);
  assert.ok(!list.stdout.includes("2."), `no phantom second prompt:\n${list.stdout}`);
});

test("prompt --list and --cancel reject duplicates, combinations, and stray positionals", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt flag validation");

  // Duplicates keep their existing behavior (first wins) only for other commands; here the
  // modes are exclusive, so a second occurrence is always an error.
  let r = await cli(repo, "prompt", "--list", "--list");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--list may only be given once/);

  r = await cli(repo, "prompt", "--cancel", "1", "--cancel", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel may only be given once/);

  // The two modes are mutually exclusive.
  r = await cli(repo, "prompt", "--list", "--cancel", "1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--list and --cancel are mutually exclusive/);

  // Neither mode takes prompt text: a stray positional would otherwise be silently ignored.
  r = await cli(repo, "prompt", "--list", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unexpected argument "extra" — with --list there is no prompt text/);

  r = await cli(repo, "prompt", "--cancel", "1", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unexpected argument "extra" — with --cancel there is no prompt text/);

  // The failures are parse-time: nothing reaches the inbox.
  assert.equal(inboxSize(repo), 0, "nothing enqueued on failure");
});

test("prompt rejects unknown double-dash flags instead of baking them into content", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt unknown flag");

  // Before parsePromptArgs existed, `tumwater prompt --foo text` enqueued "--foo text" as the
  // prompt — the same class of hole init's parseInitArgs closed. The flag must fail and leave
  // the queue untouched.
  const r = await cli(repo, "prompt", "--foo", "text");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --foo/);
  assert.match(r.stderr, /--list, --cancel <n>/);
  assert.equal(inboxSize(repo), 0, "the flag was not baked into queued content");
});

test("prompt keeps single-dash positionals as prompt content", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt single dash");

  // Only double-dash tokens are flags; a leading single dash is free-form content, like the
  // bullets init accepts.
  const r = await cli(repo, "prompt", "-x");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the director loop/);
  assert.equal(dequeuePrompt(repo), "-x");
});

test("run fails fast with a clear message when pi is missing from PATH", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run validation");

  // A PATH that has git (so the repo checks pass) but no pi: without the startup check,
  // the orchestrator would start and every tick of every loop would die with
  // "failed to spawn pi: spawn pi ENOENT".
  const binDir = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));

  const r = await cliWithEnv(repo, { PATH: binDir }, ["run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pi not found on PATH/);
});

// plans/portability.md §5/7 criteria 2 and 4: the env override works without editing any
// file, and a failure names the resolved value, its source, and the install hint — a wrong
// agentBin must not read as "pi is not installed".
test("run fails fast naming the resolved agentBin and its source when it is not an executable", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run agentBin fail");
  const binDir = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));

  // TUMWATER_PI_BIN overrides for one invocation — including overriding the default into a
  // failure whose text names the variable, not the ambient PATH.
  const r = await cliWithEnv(repo, { PATH: binDir, TUMWATER_PI_BIN: "/no/such/pi-override" }, ["run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\/no\/such\/pi-override/);
  assert.match(r.stderr, /TUMWATER_PI_BIN/);
  assert.match(r.stderr, /install it/);
  assert.doesNotMatch(r.stderr, /pi not found on PATH/);

  // A configured agentBin fails with the same shape, naming tumwater.json's key.
  const cfg = defaultConfig();
  cfg.agentBin = "/also/missing/pi";
  writeConfig(repo, cfg);
  const r2 = await cliWithEnv(repo, { PATH: binDir }, ["run"]);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /\/also\/missing\/pi/);
  assert.match(r2.stderr, /agentBin in tumwater\.json/);
});

test("status and init fail fast with a clear message when git is missing from PATH", async () => {
  // Without git on PATH, every repo probe used to report "not a git repository (run `git
  // init` first)" — pointing at the wrong fix for a machine that has no git installed.
  const binDir = tmpdir(); // empty: no git (the CLI child runs via an absolute node path)

  let r = await cliWithEnv(tmpdir(), { PATH: binDir }, ["status"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git not found on PATH/);
  assert.ok(!r.stderr.includes("not a git repository"), "no misleading repo error");

  // init has its own gate (it does not go through requireReadyRepo).
  r = await cliWithEnv(makeRepo(), { PATH: binDir }, ["init", "Build a thing."]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git not found on PATH/);
});

/** A fresh ephemeral port for live-server spawns: grab one from the OS, hand it back, and
 * use it before anything else claims it. */

// --- prompt --role: per-role queues from the CLI (PLANS.md "Per-role prompts 1/2") ---

test("prompt --role queues for one loop only, wakes it, and validates the role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli per-role prompt");

  // Queued for qa only: qa's queue holds it verbatim, the director's inbox is untouched, and
  // the targeted loop is woken so a sleeping fleet sees the prompt within one poll.
  let r = await cli(repo, "prompt", "--role", "qa", "check", "the", "flow");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the qa loop/);
  assert.match(r.stdout, /wake requested for qa/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["check the flow"]);
  assert.equal(inboxSize(repo), 0);
  assert.deepEqual(queuedRolePrompts(repo, "director"), []);

  // An unknown role fails naming the valid ids — the same message every other --role
  // consumer prints — and queues nothing anywhere.
  r = await cli(repo, "prompt", "--role", "nope", "hi");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: nope \(valid ids: .*\bqa\b/);
  assert.deepEqual(queuedRolePrompts(repo, "nope"), []);

  // `--role director` is the historical queue: same behavior as the flagless form.
  r = await cli(repo, "prompt", "--role", "director", "route this");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the director loop/);
  assert.equal(dequeuePrompt(repo), "route this");
});

test("prompt --list groups queues by loop and --cancel removes from the named loop's queue", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli per-role list");

  submitPrompt(repo, "director task");
  submitRolePrompt(repo, "qa", "qa task one");
  submitRolePrompt(repo, "qa", "qa task two");
  submitRolePrompt(repo, "readme", "docs task");

  // Grouped: the director first (the shared historical queue), then each role with queued
  // prompts, each section numbered from 1.
  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /director:\n1\. director task/);
  assert.match(r.stdout, /qa:\n1\. qa task one\n2\. qa task two/);
  assert.match(r.stdout, /readme:\n1\. docs task/);

  // Scoped by --role: only that loop's queue, numbered from 1.
  r = await cli(repo, "prompt", "--list", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /qa:\n1\. qa task one\n2\. qa task two/);
  assert.ok(!r.stdout.includes("director task"));

  // Cancel is scoped too: qa's position 1 is qa's first prompt, and only qa's queue shrinks.
  r = await cli(repo, "prompt", "--cancel", "1", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cancelled: qa task one/);
  assert.deepEqual(queuedRolePrompts(repo, "qa"), ["qa task two"]);
  assert.deepEqual(queuedRolePrompts(repo, "readme"), ["docs task"]);
  assert.deepEqual(queuedPrompts(repo), ["director task"]);
});

// --- argument strictness, cross-command: every command must reject unknown arguments ---
// (the per-command validation lives in each command's tests; this one walks several commands
// because the regression class is parser-wide, not command-local).

test("commands reject unknown arguments instead of silently ignoring them", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli strict args");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  // A misspelled --role used to be ignored: reset-counters would zero EVERY loop instead of
  // the one named. Now it fails and leaves every counter (and no fleet marker) untouched.
  let r = await cli(repo, "reset-counters", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  assert.match(r.stderr, /--role <id>/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "no reset happened");
  assert.ok(!fs.existsSync(resetRequestPath(repo)), "no marker written");

  // A misspelled --port used to be ignored: gui would serve on the default port.
  r = await cli(repo, "gui", "--portt", "8080");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --portt/);

  // A doubled short flag used to be ignored: logs would run one-shot instead of following.
  r = await cli(repo, "logs", "-ff");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: -ff/);

  // `run` takes exactly one flag (--branch); anything else is rejected and names it.
  r = await cli(repo, "run", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --verbose/);
  assert.match(r.stderr, /valid flags for tumwater run: --branch <name>/);

  // ...including version and help, which used to accept anything silently: `version --json`
  // printed a version as if it had answered the query, and `help extra` printed usage.
  r = await cli(repo, "version", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);

  // `help <command>` now prints that command's usage stanza; only a NON-command token is
  // still an error — pointed back at the full list instead of pretending it was answered.
  r = await cli(repo, "help", "gui");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater gui/);

  r = await cli(repo, "help", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no help topic: extra/);

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--role", "clean");
  assert.equal(r.code, 0);
});
