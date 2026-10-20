import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { resetRequestPath, wakeRequestPath } from "../src/paths.js";
import { loadRunnerState } from "../src/runner/runner-state.js";
import { seedCounters } from "./fixtures/runner-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

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
  assert.match(r.stderr, /no help topic: extra/);

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadRunnerState(repo, "feature").runs, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--role", "clean");
  assert.equal(r.code, 0);
});

test("tick's dispatcher admits --last for tick alone, and still rejects it elsewhere", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli tick last flag");
  // The one-positional --last form reaches cmdTick through the dispatcher's gate.
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
