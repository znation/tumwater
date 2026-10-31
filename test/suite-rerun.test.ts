import test from "node:test";
import assert from "node:assert/strict";
import { runsFullSuite, suiteRerunWarning, type ToolCallStart } from "../src/review/suite-rerun.js";

// Pins the reviewer suite-rerun tripwire (BUGS.md 2026-09-23): the review gate warns when a
// reviewer told tumwater's pre-check passed re-runs the full suite anyway. The flagged
// command lines below are the shapes reviewers actually ran (from the retained review sessions);
// the unflagged ones are what the prompt allows — one specific test file for a concrete reason
// —
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
    "cd /tmp/reviewcopy && node dist/test/test-runner.js 2>&1 | tail -12",
    "TUMWATER_TRACE_FOLLOW=1 node dist/test/test-runner.js > /tmp/full-trace.log 2>&1", // env prefix
    "for i in 1 2 3; do npm run test 2>&1 | grep -E \"ℹ fail\" ; done", // loop body
    "(cd /tmp/land-check && npm test)", // subshell
    "time npm test",
    "/usr/local/bin/npm test",
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
});

test("runsFullSuite flags backgrounded suite runs and keeps &-redirects out of the filter check", () => {
  // A reviewer who backgrounds the run (`npm test &`) still loads the shared host while the
  // merge slot is held — the & must split the segment like ; or &&, not vanish into it.
  for (const command of [
    "npm test &",
    "npm run test & tail -f /tmp/log",
    "node dist/test/test-runner.js &",
    "npm ci &",
    "npm test < /dev/null &", // an input redirect target is not a filter either
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }

  // &> and &>> are redirections, not backgrounding: the segment must not split at their &
  // (a split would leave the redirect target looking like a fresh command) and the target
  // must not read as a test filter.
  for (const command of ["npm test &> /tmp/out.txt", "npm test &>> /tmp/out.txt"]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
});

test("runsFullSuite leaves filtered runs and mere mentions of the runner alone", () => {
  for (const command of [
    "npm test gui 2>&1 | tail -15", // one test file, by filter
    "rm -rf /tmp/rev-scratch && cp -R wt /tmp/rev-scratch && cd /tmp/rev-scratch && npm test pi 2>&1 | tail -15",
    "npm test -- build-check",
    "npm run test merge",
    "cd /tmp/tw-review && node dist/test/test-runner.js orchestrator-3 2>&1 | tail -6",
    "node --test dist/test/pi.test.js 2>&1 | grep -E \"✖\"", // node's own runner on one file
    "sed -n '1,80p' test/test-runner.ts", // reading the runner is not running it
    "pkill -f test-runner",
    "ps aux | grep -E \"cli\\.js|test-runner|npm test\" | grep -v grep", // quoted pattern is data
    "grep -rn 'npm test' README.md",
    "npm run test:e2e", // a different script
    "npm run build && npx tsc --noEmit",
    "npm ci --dry-run --ignore-scripts --no-audit", // installs nothing
    "npm install --prefix /tmp/twprefix ./tumwater-0.1.0.tgz", // packaging check, not a suite
    "echo npm test",
    "npm",
    // a bare `npm run` with no script names no subcommand, so nothing to flag
    "npm run",
    // `node` with no runner entry point (flags only, or a bare version) runs nothing
    "node --version",
    "node",
  ]) {
    assert.ok(!runsFullSuite(command), `not flagged: ${command}`);
  }
});

test("runsFullSuite sees the subcommand behind a value-taking npm or node flag (BUGS.md 2026-09-29)", () => {
  // A value-taking option before the subcommand must not read its value as the subcommand: the
  // shapes a reviewer reaches for when running the suite in a copied tree.
  for (const command of [
    "npm --prefix /tmp/rev test", // the bug's own shape: /tmp/rev is the flag's value, not the subcommand
    "npm -C /tmp/rev test",
    "npm --cache /tmp/cache test",
    "npm --registry http://127.0.0.1:4873 test",
    "npm --prefix /tmp/rev run test",
    "npm run --prefix /tmp/rev test", // the flag can also trail the subcommand
    "npm --prefix /tmp/rev ci",
    "cd /tmp/rev && npm --prefix . test", // value that is not a path-looking word either
    "node --max-old-space-size 4096 dist/test/test-runner.js",
    "node -r ./trace.js dist/test/test-runner.js",
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
  // The value must never leak through as a filter either: `npm test --prefix /tmp/rev` runs the
  // whole suite in the copied tree even though a positional-shaped word follows the flag.
  assert.ok(runsFullSuite("npm test --prefix /tmp/rev"), "flagged: npm test --prefix /tmp/rev");

  // Value-skipping must not swallow a real positional: a flag that takes no value leaves the
  // next word where it is.
  for (const command of [
    "npm --silent test gui",
    "npm --no-audit run test merge",
    "npm --prefix /tmp/rev ci --dry-run", // still a dry run: installs nothing
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
      bash("node dist/test/test-runner.js review"),
      { toolName: "read", args: { path: "src/review/review.ts" } },
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
    { toolName: "", args: { command: "cd /tmp/revrun && node dist/test/test-runner.js" } },
  ]);
  assert.equal(
    warning,
    "reviewer re-ran the suite tumwater's pre-check already verified: cd /tmp/revrun && npm ci --no-audit npm test 2>&1 | tail -15 (+1 more)",
  );

  // A long command is clipped so one heredoc cannot bloat the event row.
  const long = suiteRerunWarning([bash(`npm test && echo ${"x".repeat(400)}`)]) ?? "";
  assert.ok(long.length < 250, `clipped: ${long.length} chars`);
  assert.match(long, /…$/);
});

test("every documented value-taking npm/node flag and prefix word is honored", () => {
  // The other value-taking npm flags a copied-tree reviewer reaches for (the ones the
  // 2026-09-29 test above exercises for --prefix/-C/cache/registry) must not read their
  // value as the subcommand, and their value must never leak through as a filter.
  for (const command of [
    "npm --workspace /tmp/rev test",
    "npm -w /tmp/rev test",
    "npm --userconfig /tmp/c test",
    "npm --globalconfig /tmp/g test",
    "npm --loglevel verbose test",
    "npm --omit dev test",
    "npm --prefix /tmp/rev test --omit dev",
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
  // The same flags after the subcommand are still skipped, so their values are not filters.
  for (const command of ["npm test --workspace /tmp/rev", "npm test --omit dev"]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
  // The remaining value-taking node flags before the runner entry point stay skipped.
  for (const command of [
    "node --stack-size 4096 dist/test/test-runner.js",
    "node --require ./trace.js dist/test/test-runner.js",
    "node --conditions node dist/test/test-runner.js",
    "node --cpu-prof-dir /tmp/p dist/test/test-runner.js",
    "node --eval \"launch()\" dist/test/test-runner.js",
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
  // Every other PREFIX_WORDS member, not just `time`/`env`/`do`, is skipped before the
  // command so the suite run that follows is still seen.
  for (const command of [
    "command npm test",
    "! npm test",
    "exec npm test",
    "nohup npm test",
    "then npm test",
    "else npm test",
    "command node dist/test/test-runner.js",
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }

  // The no-subcommand path (a bare value-taking npm flag with nowhere for a subcommand, or
  // node flags with no runner entry point) flags nothing rather than crashing or over-reading.
  for (const command of ["npm --prefix /tmp/rev", "npm --silent", "node --eval \"x\"", "node --max-old-space-size"]) {
    assert.ok(!runsFullSuite(command), `not flagged: ${command}`);
  }
});

test("an unterminated trailing value or redirect falls back to empty without misreading", () => {
  // A value-taking flag or bare redirect at the very end of a line leaves nothing for its
  // value/target, and the word scans must read that as the empty fallback, not crash. A
  // trailing bare redirect still runs the full suite (`npm test >`), and a trailing value
  // flag still runs the full suite unfiltered (`npm test --prefix`), so both are flagged;
  // a line made of only a value flag or only a prefix word is command-less and is not.
  for (const command of [
    "npm test >", // bare redirect with no target: the suite still runs
    "npm test --prefix", // value flag with no value: the suite still runs unfiltered
  ]) {
    assert.ok(runsFullSuite(command), `flagged: ${command}`);
  }
  for (const command of [
    "npm --prefix", // only a value flag, no subcommand to run
    "npm --silent", // only an npm flag, no subcommand at all
    "node --eval", // only a node flag, no runner entry point
    "env", // a sole prefix word with no command
    "command",
    "env CI=1",
  ]) {
    assert.ok(!runsFullSuite(command), `not flagged: ${command}`);
  }
});

test("suiteRerunWarning tolerates malformed args instead of throwing", () => {
  for (const args of [undefined, null, "npm test", 5, { command: 7 }, {}]) {
    assert.equal(suiteRerunWarning([{ toolName: "bash", args }]), undefined);
  }
});
