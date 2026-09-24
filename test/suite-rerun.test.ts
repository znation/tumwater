import test from "node:test";
import assert from "node:assert/strict";
import { runsFullSuite, suiteRerunWarning, type ToolCallStart } from "../src/suite-rerun.js";

// Pins the reviewer suite-rerun tripwire (BUGS.md 2026-09-23): the review gate warns when a
// reviewer told the harness's pre-check passed re-runs the full suite anyway. The flagged
// command lines below are the shapes reviewers actually ran (from the retained review sessions);
// the unflagged ones are what the prompt allows — one specific test file for a concrete reason —
// or commands that merely name the runner without running it.

const bash = (command: string): ToolCallStart => ({ toolName: "bash", args: { command } });

test("runsFullSuite flags an unfiltered suite run or `npm ci`, however the line is composed", () => {
  for (const command of [
    "npm test",
    "cd /tmp/revrun && npm test 2>&1 | tail -15",
    "npm run test 2>&1 | tail -60",
    "npm test > /tmp/testrun.txt 2>&1; echo \"exit=$?\"", // a redirect target is not a filter
    "npm test --silent", // an npm flag is not a filter
    "npm test --", // nothing passed through
    "npm t",
    "npm run-script test",
    "cd /tmp/revrun && npm ci --no-audit --no-fund 2>&1 | tail -3 && npm test 2>&1 | tail -12",
    "rm -rf /tmp/rev && git archive HEAD | tar -x -C /tmp/rev && cd /tmp/rev && npm ci --silent",
    "cd /tmp/reviewcopy && node dist/src/test-runner.js 2>&1 | tail -12",
    "TUMWATER_TRACE_FOLLOW=1 node dist/src/test-runner.js > /tmp/full-trace.log 2>&1", // env prefix
    "for i in 1 2 3; do npm run test 2>&1 | grep -E \"ℹ fail\" ; done", // loop body
    "(cd /tmp/land-check && npm test)", // subshell
    "time npm test",
    "/usr/local/bin/npm test",
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
});

test("runsFullSuite leaves filtered runs and mere mentions of the runner alone", () => {
  for (const command of [
    "npm test gui 2>&1 | tail -15", // one test file, by filter
    "rm -rf /tmp/rev-scratch && cp -R wt /tmp/rev-scratch && cd /tmp/rev-scratch && npm test pi 2>&1 | tail -15",
    "npm test -- build-check",
    "npm run test merge",
    "cd /tmp/tw-review && node dist/src/test-runner.js orchestrator-3 2>&1 | tail -6",
    "node --test dist/test/pi.test.js 2>&1 | grep -E \"✖\"", // node's own runner on one file
    "sed -n '1,80p' src/test-runner.ts", // reading the runner is not running it
    "pkill -f test-runner",
    "ps aux | grep -E \"cli\\.js|test-runner|npm test\" | grep -v grep", // quoted pattern is data
    "grep -rn 'npm test' README.md",
    "npm run test:e2e", // a different script
    "npm run build && npx tsc --noEmit",
    "npm ci --dry-run --ignore-scripts --no-audit", // installs nothing
    "npm install --prefix /tmp/twprefix ./tumwater-0.1.0.tgz", // packaging check, not a suite
    "echo npm test",
    "npm",
  ]) {
    assert.ok(!runsFullSuite(command), `not flagged: ${command}`);
  }
});

test("suiteRerunWarning names the first full-suite run and counts the rest; filtered and non-bash calls never count", () => {
  assert.equal(suiteRerunWarning([]), undefined, "no calls, no warning");
  assert.equal(
    suiteRerunWarning([
      bash("git diff main --stat"),
      bash("npm test gui 2>&1 | tail -15"),
      bash("node dist/src/test-runner.js review"),
      { toolName: "read", args: { path: "src/review.ts" } },
      // A non-bash tool whose args happen to carry a command string is not a shell run.
      { toolName: "grep", args: { command: "npm test" } },
    ]),
    undefined,
    "a stream of reads and filtered runs is exactly what the prompt allows",
  );

  const warning = suiteRerunWarning([
    bash("git log --oneline -3"),
    bash("cd /tmp/revrun && npm ci --no-audit\nnpm test 2>&1 | tail -15"),
    bash("npm test gui"),
    // pi omits toolName on some start events: a nameless call with a command is still bash.
    { toolName: "", args: { command: "cd /tmp/revrun && node dist/src/test-runner.js" } },
  ]);
  assert.equal(
    warning,
    "reviewer re-ran the suite the harness's pre-check already verified: cd /tmp/revrun && npm ci --no-audit npm test 2>&1 | tail -15 (+1 more)",
  );

  // A long command is clipped so one heredoc cannot bloat the event row.
  const long = suiteRerunWarning([bash(`npm test && echo ${"x".repeat(400)}`)]) ?? "";
  assert.ok(long.length < 250, `clipped: ${long.length} chars`);
  assert.match(long, /…$/);
});

test("suiteRerunWarning tolerates malformed args instead of throwing", () => {
  for (const args of [undefined, null, "npm test", 5, { command: 7 }, {}]) {
    assert.equal(suiteRerunWarning([{ toolName: "bash", args }]), undefined);
  }
});
