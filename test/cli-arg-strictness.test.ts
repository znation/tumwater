import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { resetRequestPath, wakeRequestPath } from "../src/paths.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { seedCounters } from "./fixtures/runner-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { readScheduledWakes } from "./helpers/json-read.js";

// Parser-wide unknown-argument tests: every command must reject a flag or stray positional it
// does not know instead of silently ignoring it. These walk several commands because the
// regression class is parser-wide, not command-local. The sibling flag-value gate (a value
// malformed or missing) lives in cli-flag-value-errors.test.ts, and each command's own
// flag/positional boundary cases live in its surface file (cli-prompt-strictness.test.ts,
// cli-questions-strictness.test.ts, cli-questions-list.test.ts, cli-tui-strictness.test.ts).
// Spawned via the CLI so node --test can run them in parallel processes.
test("commands reject unknown arguments instead of silently ignoring them", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli strict args");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  // A misspelled --role used to be ignored: reset-counters would zero EVERY role instead of
  // the one named. Now it fails and leaves every counter (and no team marker) untouched.
  let r = await cli(repo, "reset-counters", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  assert.match(r.stderr, /--role <id>/);
  assert.equal(loadRunnerState(repo, "feature").runs, 7, "no reset happened");
  assert.equal(loadRunnerState(repo, "clean").runs, 7, "no reset happened");
  assert.ok(!fs.existsSync(resetRequestPath(repo)), "no marker written");

  // A misspelled --port used to be ignored: gui would serve on the default port.
  r = await cli(repo, "gui", "--portt", "8080");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --portt/);

  // A doubled short flag used to be ignored: logs would run one-shot instead of following.
  r = await cli(repo, "logs", "-ff");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: -ff/);

  // `--reason` is pause's flag alone: wake must fail fast instead of silently ignoring it
  // (the same hole a prior pause --reason attempt left open on the per-role branch).
  r = await cli(repo, "wake", "--reason", "fixed");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --reason/);
  assert.match(r.stderr, /valid flags for tumwater wake: --role <id>/);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker written");

  // `run` takes exactly one flag (--branch); anything else is rejected and names it.
  r = await cli(repo, "run", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --verbose/);
  assert.match(r.stderr, /valid flags for tumwater start: --branch <name>/);

  // …including version and help, which used to accept anything silently: `version --json`
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
  assert.match(r.stderr, /no help topic: "extra"/);

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadRunnerState(repo, "feature").runs, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--transcript", "clean");
  assert.equal(r.code, 0);
});

test("wake --cancel keeps its optional position across the argument gate", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli wake cancel optional value");
  await cli(repo, "wake", "--role", "qa", "--in", "45m");

  // `--cancel <n>` claims the following token as the position: a one-wake queue has no
  // position 2, so the miss wording proves the "2" was read (not treated as a stray arg).
  let r = await cli(repo, "wake", "--cancel", "2");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no scheduled wake at position 2 \(1 scheduled wake pending\)/);

  // Bare `--cancel` stays the role-wide cancel.
  r = await cli(repo, "wake", "--cancel");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^cancelled 1 scheduled wake$/m);

  // `--cancel --role qa` must NOT swallow --role as the cancel's value: it cancels qa's share.
  await cli(repo, "wake", "--role", "qa", "--in", "45m");
  r = await cli(repo, "wake", "--cancel", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^cancelled 1 scheduled wake for qa$/m);

  // `--cancel=2` is refused with the separate-token wording, writing nothing.
  await cli(repo, "wake", "--role", "qa", "--in", "45m");
  r = await cli(repo, "wake", "--cancel=2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel=2 is not accepted — give the value as a separate token: `--cancel <n>`/);
  assert.equal(readScheduledWakes(repo).length, 1, "the equals-form refusal removes nothing");
});

test("tick's dispatcher admits --last for tick alone, and still rejects it elsewhere", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli tick last flag");
  // The one-positional --last form reaches cmdRunDetail through the dispatcher's gate.
  const ok = await cli(repo, "tick", "bugfix", "--last");
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^no completed run for bugfix in the scanned window/);
  // The same flag is not part of another command's vocabulary — the unknown-argument gate.
  const other = await cli(repo, "logs", "--last");
  assert.equal(other.code, 1);
  assert.match(other.stderr, /unknown argument: --last/);
});

test("start and its hidden alias run reject unknown flags under the start name", async () => {
  const repo = makeRepo();
  await initProject(repo, "start alias");
  for (const command of ["start", "run"]) {
    const r = await cli(repo, command, "--bogus");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /valid flags for tumwater start:/);
  }
});
