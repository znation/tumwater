import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { truncate } from "../src/text.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { abortRequestPath, inboxDir, orchestratorStatePath, pausedPath, piLogPath, resetRequestPath } from "../src/paths.js";
import { SUPERVISED_ENV } from "../src/supervisor.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process: the built dist/src/cli.js with cwd set to a temp repo.
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with an explicit env override (merged over process.env). The timeout
 * bounds tests that would otherwise hang if a command regresses to not exiting. */
function cliWithEnv(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<CliResult> {
  const merged = { ...process.env, ...env };
  // Hermeticity: the supervised marker leaks from any tumwater orchestrator into pi's (and
  // this test process') environment; without stripping it, `run` skips its supervisor half.
  delete merged[SUPERVISED_ENV];
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: merged, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  return cliWithEnv(cwd, {}, args);
}

test("help and no command print usage", async () => {
  const dir = tmpdir();
  for (const args of [[], ["help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /tumwater init/);
    assert.match(r.stdout, /tumwater prompt/);
  }
});

test("version prints the package version", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const r = await cli(tmpdir(), "version");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("unknown command fails with a hint", async () => {
  const r = await cli(tmpdir(), "frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("status refuses repos that are not ready", async () => {
  // Not a git repo.
  let r = await cli(tmpdir(), "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);

  // A git repo without tumwater.json.
  const bare = makeRepo();
  r = await cli(bare, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not initialized/);

  // tumwater.json present but no commits yet.
  const uncommitted = tmpdir();
  sh(uncommitted, "git", "init", "-b", "main");
  fs.writeFileSync(path.join(uncommitted, "tumwater.json"), JSON.stringify(defaultConfig()));
  r = await cli(uncommitted, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no commits yet/);
});

test("init creates the harness files and is idempotent", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /created README\.md/);
  for (const f of ["README.md", "PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(fs.existsSync(path.join(repo, f)), `${f} exists`);
  }
  r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already initialized; nothing to do/);
});

test("init --file reads the prompt from a file and rejects a missing path", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "prompt.md"), "Build a thing.\nWith care.\n");
  let r = await cli(repo, "init", "--file", "prompt.md");
  assert.equal(r.code, 0);
  assert.equal(readInitialPrompt(repo), "Build a thing.\nWith care.");

  const bare = makeRepo();
  r = await cli(bare, "init", "--file");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file needs a path/);
});

test("init rejects unknown flags and stray positionals instead of baking them into the prompt", async () => {
  const repo = makeRepo();

  // A misspelled --file used to succeed with "--fil prompt.md" as the project's initial
  // prompt — injected into every tick forever. Now it fails like any other unknown flag,
  // and nothing is created.
  let r = await cli(repo, "init", "--fil", "prompt.md");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --fil/);
  assert.match(r.stderr, /--file <path>/);
  assert.ok(!fs.existsSync(path.join(repo, "tumwater.json")), "nothing created on failure");

  // A doubled --file used to silently use the first file.
  fs.writeFileSync(path.join(repo, "a.md"), "From a.");
  fs.writeFileSync(path.join(repo, "b.md"), "From b.");
  r = await cli(repo, "init", "--file", "a.md", "--file", "b.md");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file may only be given once/);

  // Stray prompt text alongside --file used to be silently ignored.
  r = await cli(repo, "init", "--file", "a.md", "extra words");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unexpected argument "extra words"/);

  // An unreadable --file path names the file's role instead of a bare ENOENT.
  r = await cli(repo, "init", "--file", "missing.md");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read prompt file "missing\.md"/);

  // Free-form positionals — including single-dash bullets — still work.
  const bare2 = makeRepo();
  r = await cli(bare2, "init", "- Build A", "- Build B");
  assert.equal(r.code, 0);
  assert.equal(readInitialPrompt(bare2), "- Build A - Build B");
});

test("prompt queues for the director and logs an event; empty text fails", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt test");

  let r = await cli(repo, "prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prompt text required/);

  r = await cli(repo, "prompt", "add dark mode");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the director loop/);
  assert.equal(inboxSize(repo), 1);
  assert.equal(dequeuePrompt(repo), "add dark mode");

  // The queueing is visible in `logs`.
  r = await cli(repo, "logs", "-n", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /user prompt queued: add dark mode/);
});

// --- prompt --list / --cancel: inspecting and removing queued prompts from the CLI ---

test("prompt --list shows queued prompts numbered in execution order", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list");

  // An empty queue is a clean one-liner, not an error.
  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing queued for the director/);

  submitPrompt(repo, "first task");
  // Full text verbatim — including newlines: --list is the inspection command that shows
  // what a queued prompt actually says before you cancel it.
  submitPrompt(repo, "second\nwith a newline");
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. first task$/m);
  assert.match(r.stdout, /^2\. second\nwith a newline$/m);
});

test("prompt --cancel removes the Nth queued prompt and reports its text", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt cancel");

  submitPrompt(repo, "alpha");
  const long = `fix the ${"x".repeat(100)} bug`;
  submitPrompt(repo, long);
  submitPrompt(repo, "gamma");

  let r = await cli(repo, "prompt", "--cancel", "2");
  assert.equal(r.code, 0);
  // Over-long text is reported through truncate (80 chars + ellipsis), like every other
  // one-line label — never a raw multi-hundred-character line.
  assert.ok(
    r.stdout.includes(`cancelled: ${truncate(long, 80)}`),
    `expected the truncated report in:\n${r.stdout}`,
  );

  // The removal renumbers the queue and is visible in --list and logs.
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. alpha$/m);
  assert.match(r.stdout, /^2\. gamma$/m);
  assert.ok(!r.stdout.includes("fix the"), "the cancelled prompt is gone from the list:\n" + r.stdout);

  r = await cli(repo, "logs", "-n", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /user prompt cancelled: /);
});

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
  assert.match(r.stdout, /the director already took it/);

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

test("logs -n validates its value instead of misbehaving", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs validation");

  // Unvalidated, these made readEvents' slice(-limit) dump the whole log (NaN/0)
  // or drop leading lines (negative).
  for (const bad of ["abc", "0", "-5", "2.5"]) {
    const r = await cli(repo, "logs", "-n", bad);
    assert.equal(r.code, 1, `-n ${bad} should fail`);
    assert.match(r.stderr, /-n needs a positive integer/);
  }

  // A bare -n used to silently fall back to the default of 50.
  const noValue = await cli(repo, "logs", "-n");
  assert.equal(noValue.code, 1);
  assert.match(noValue.stderr, /-n needs a value/);

  // A valid -n still works.
  const ok = await cli(repo, "logs", "-n", "3");
  assert.equal(ok.code, 0);
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

test("gui --port validates its range instead of listening on an unexpected port", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui validation");

  // Port 0 would listen on an ephemeral port while printing http://127.0.0.1:0.
  for (const bad of ["0", "-1", "99999", "abc"]) {
    const r = await cli(repo, "gui", "--port", bad);
    assert.equal(r.code, 1, `--port ${bad} should fail`);
    assert.match(r.stderr, /--port must be an integer between 1 and 65535/);
  }

  const noValue = await cli(repo, "gui", "--port");
  assert.equal(noValue.code, 1);
  assert.match(noValue.stderr, /--port needs a value/);

  // --all-interfaces is part of gui's vocabulary: with it present, a bad port still fails
  // on the port (not as an unknown argument).
  const withAll = await cli(repo, "gui", "--all-interfaces", "--port", "abc");
  assert.equal(withAll.code, 1);
  assert.match(withAll.stderr, /--port must be an integer/);
});

test("gui reports a friendly error when the port is already in use", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui busy port");

  // Occupy an ephemeral port so the CLI hits EADDRINUSE deterministically; without the
  // catch it printed Node's raw "listen EADDRINUSE: address already in use …" with no hint.
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const addr = blocker.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const r = await cli(repo, "gui", "--port", String(addr.port));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
    assert.match(r.stderr, /tumwater gui --port <n>/);
  } finally {
    blocker.close();
  }
});

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

  // Commands with no flags reject any argument at all.
  r = await cli(repo, "run", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--role", "clean");
  assert.equal(r.code, 0);
});

// --- status --json: machine-readable fleet state — the same document GET /api/status
// serves, printed with no server. The CLI runs as a child process, so the deep-equal below
// compares its parsed stdout against statusPayload(root) computed in this process for the
// same root; both read only from disk and nothing mutates the temp repo between the reads.

test("status --json prints the /api/status payload; bare status keeps the table", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli status json");
  seedCounters(repo, "feature");

  let r = await cli(repo, "status", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as Record<string, unknown>;
  // Top-level fields — the same document GET /api/status serves for this root. `pid` is
  // absent while no harness runs (undefined does not survive JSON.stringify).
  for (const field of ["running", "inbox", "inboxPrompts", "budget", "loops", "events", "plans", "bugs", "questions"]) {
    assert.ok(field in doc, `top-level ${field} present`);
  }
  assert.equal(doc.running, false, "no harness running");
  assert.ok(!("pid" in doc), "no pid while the harness is not running");

  // Per-loop fields on every row.
  const loops = doc.loops as Array<Record<string, unknown>>;
  assert.ok(loops.length > 0);
  for (const l of loops) {
    for (const field of ["role", "phase", "ticks", "commits", "generated", "peakCtx", "costUsd", "todayUsd", "lastResult", "lastSummary", "lastTickEndedAt"]) {
      assert.ok(field in l, `loop field ${field} present`);
    }
  }
  // Seeded counters surface verbatim — the JSON is state-file data, not a re-rendering.
  const feature = loops.find((l) => l.role === "feature");
  assert.ok(feature, "feature loop row present");
  assert.equal(feature!.ticks, 7);
  assert.equal(feature!.commits, 3);
  assert.equal(feature!.generated, 424242);
  assert.equal(feature!.costUsd, 1.5);

  // Deep-equal against the same root's payload in this process — one definition of fleet
  // state as JSON (status-payload.statusPayload) feeds both surfaces, so they cannot drift.
  // Both sides
  // go through a JSON round-trip: that is exactly what the endpoint and the flag emit.
  assert.deepEqual(doc, JSON.parse(JSON.stringify(statusPayload(repo))));

  // Bare status still renders the table — same command, human surface unchanged.
  r = await cli(repo, "status");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /loop/);
  assert.match(r.stdout, /last result/);
  assert.match(r.stdout, /feature/);

  // A misspelled flag is rejected like every other unknown argument.
  r = await cli(repo, "status", "--jsonn");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --jsonn/);
});

// --- tui: main()'s tui case (arg rejection → readiness gate → runTui) had no end-to-end
// test — every other command is driven through the CLI, but only runTui itself was tested
// in-process. A spawned child has no TTY, so the happy path ends in a clean error and the
// whole wiring is observable without a terminal.

test("tui gates on repo readiness, rejects extra args, and fails cleanly without a terminal", async () => {
  // Not a git repo: the readiness gate fires before any TUI work — a regression that dropped
  // requireReadyRepo here would crash deep in snapshot() instead of naming the fix.
  let r = await cli(tmpdir(), "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);

  const repo = makeRepo();
  await initProject(repo, "cli tui test");

  // A ready repo: runTui's TTY requirement surfaces as a clean CLI error (exit 1) and the
  // command exits rather than hanging — which also bounds this test if that ever regresses.
  r = await cli(repo, "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs an interactive terminal/);

  // Like every other no-flag command, tui rejects stray arguments instead of ignoring them.
  r = await cli(repo, "tui", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);
});

// --- abort --role <id>: request to kill one loop's in-flight tick via a marker file ---
// The CLI cannot reach into the orchestrator process, so the request rides on disk: a
// per-role marker (.tumwater/abort-<role>.json) a running fleet consumes within one poll
// cycle. The fleet-side consumption is covered by test/orchestrator.test.ts; here we pin
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
// test/orchestrator.test.ts; here we pin what the CLI itself does: idempotency, messaging,
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

// --- logs --role (per-role pi transcript) ---

test("logs --role validates the role id and reports a missing transcript", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli test");

  let r = await cli(repo, "logs", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);

  r = await cli(repo, "logs", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // A valid id whose loop never ran: friendly message, exit 0.
  r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no transcript yet for clean/);
});
// --- reset-counters ---

/** Seed a role's state file with non-zero counters plus scheduling fields. */
function seedCounters(repo: string, role: string): void {
  const s = freshLoopState(role);
  s.ticks = 7;
  s.commits = 3;
  s.generatedTokens = 424242;
  s.totalCostUsd = 1.5;
  s.peakContextTokens = 65536; // last tick's peak — cleared by the reset
  s.nextRunAt = Date.now() + 60_000;
  s.backoffSeconds = 15;
  s.lastMainHead = "deadbeef";
  saveLoopState(repo, s);
}

test("reset-counters zeroes counters in every role's state file and writes the fleet marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  const r = await cli(repo, "reset-counters");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for/);
  assert.match(r.stdout, /running fleet picks this up within ~2s/);

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

test("logs --role prints the rendered pi transcript and -n limits entries", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli render test");
  const TS1 = 1787222691956;
  const TS2 = TS1 + 3_600_000;
  const file = piLogPath(repo, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "x" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tick prompt one (must not appear)" }], timestamp: TS1 } }),
      JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: "streaming noise" } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "look at the files first" },
            { type: "text", text: "Reading PLANS.md." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/PLANS.md" } },
          ],
          stopReason: "stop",
        },
      }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tick prompt two (must not appear)" }], timestamp: TS2 } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second run done" }], stopReason: "stop" } }),
    ].join("\n") + "\n",
  );

  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  let r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0);
  // Both runs render in order: separator stamped from the user message, then the turn.
  assert.ok(r.stdout.includes(`── run @ ${stamp(TS1)} ──`), r.stdout);
  assert.ok(r.stdout.includes("· look at the files first"), r.stdout);
  assert.ok(r.stdout.includes("  Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("→ read PLANS.md"), r.stdout);
  assert.ok(r.stdout.includes(`── run @ ${stamp(TS2)} ──`), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
  // User prompts and streaming deltas never leak into the transcript.
  assert.ok(!r.stdout.includes("must not appear"));
  assert.ok(!r.stdout.includes("streaming noise"));

  // -n limits to the last N entries: only the second run's turn remains.
  r = await cli(repo, "logs", "--role", "clean", "-n", "1");
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
});

// --- doctor: pre-flight check through the real CLI entry point ---
// runDoctor/renderDoctor and each individual check are pinned in-process in
// test/doctor.test.ts; what is missing here is main()'s wiring — that doctor runs WITHOUT a
// readiness gate (it must report why the environment isn't ready, not refuse like status),
// renders the full report to stdout, rejects unknown arguments, and honors the exit-code
// contract that makes it scriptable: 0 when no check fails, 1 otherwise. Warnings never fail.

test("doctor runs outside a git repo — reports every problem instead of gating", async () => {
  // A bare directory with a PATH holding only git (no pi): every check's outcome is
  // deterministic, and the command must not refuse to run like status does. Without the
  // missing-gate regression this would print "not a git repository" to stderr and exit 1
  // without ever showing the other checks.
  const binDir = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));

  const r = await cliWithEnv(tmpdir(), { PATH: binDir }, ["doctor"]);
  assert.equal(r.code, 1, `expected exit 1 with failing checks:\n${r.stdout}\n${r.stderr}`);
  // The full report is printed — one line per check in fixed order, not the first error.
  assert.match(r.stdout, /tumwater doctor — harness not running/);
  assert.match(r.stdout, /ok\s+git binary/);
  assert.match(r.stdout, /fail\s+repo\s+not a git repository/);
  assert.match(r.stdout, /fail\s+init\s+not initialized/);
  assert.match(r.stdout, /fail\s+pi binary\s+pi not found on PATH/);
  assert.match(r.stdout, /ok\s+state dir/);
  assert.match(r.stdout, /ok\s+merge lock/);
  assert.match(r.stdout, /ok\s+build check/);
  // The verdict counts the fails (repo + init + pi) and nothing else.
  assert.match(r.stdout, /3 problems/);
});

test("doctor exits 0 on a ready repo; a stale merge lock warns without failing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor test");

  // A stale merge lock (dead pid) is a warning: it self-heals on the next merge, so it must
  // not flip the exit code — scripts key off 0/1 for real problems only.
  const lockDir = path.join(repo, ".tumwater", "merge.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "pid"), String(2_000_000_000)); // beyond any pid space

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "doctor");
    assert.equal(r.code, 0, `expected exit 0 on a ready repo:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /tumwater doctor — harness not running/);
    for (const line of [
      /ok\s+git binary/,
      /ok\s+repo\s+on branch main/,
      /ok\s+init/,
      /ok\s+pi binary/,
      /ok\s+state dir/,
      /warn\s+merge lock\s+stale — will be broken on next merge/,
      /ok\s+build check/,
    ]) {
      assert.match(r.stdout, line);
    }
    assert.match(r.stdout, /ready to run/);
  } finally {
    restore();
  }
});

test("doctor rejects unknown arguments", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor args");

  // Like every other no-flag command, doctor takes no arguments at all.
  const r = await cli(repo, "doctor", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);
});

// --- long-running commands (run, logs -f): spawned with a live handle so the test can
// observe startup output, exercise the follow behavior, and always reap the child. ---

interface SpawnedCli {
  out: () => string;
  /** Resolves once `pred` matches the captured stdout; fails the test with the output on timeout. */
  waitFor(pred: (out: string) => boolean, what: string, ms?: number): Promise<void>;
  kill(): void;
}

function spawnCli(cwd: string, args: string[]): { child: ChildProcess } & SpawnedCli {
  const env = { ...process.env };
  delete env[SUPERVISED_ENV]; // same hermeticity as cliWithEnv: `run` must take the supervisor path
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
  let buffer = "";
  child.stdout?.on("data", (d) => (buffer += d));
  return {
    child,
    out: () => buffer,
    waitFor(pred, what, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (pred(buffer)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > ms) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for ${what}; output so far:\n${buffer}`));
          }
        }, 100);
      });
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    },
  };
}

/** Wait for the child's exit code; null on timeout so a hung command fails the test instead of hanging it. */
function exitCode(child: ChildProcess, ms = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.once("close", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

// --- run: startup guards, banner, and graceful shutdown ---

test("run refuses a detached primary checkout", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run detached");
  sh(repo, "git", "checkout", "--detach");

  // pi must be on PATH to get past the earlier check; without the branch guard the
  // orchestrator would start with a null main branch.
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /primary checkout is detached/);
  } finally {
    restore();
  }
});

test("run refuses to start while another orchestrator is alive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run guard");

  // Record a live pid (this test process) as the running orchestrator; two fleets in one
  // repo would double-tick every loop and race on the merge lock.
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: [] }),
  );

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /an orchestrator is already running/);
  } finally {
    fs.rmSync(orchestratorStatePath(repo), { force: true });
    restore();
  }
});

test("run starts the fleet, prints its banner, and stops cleanly on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run lifecycle");

  // One enabled role keeps the startup burst small; a no-op pi ends every tick as
  // no_change so nothing is committed while we observe the harness itself.
  const cfg = defaultConfig();
  for (const [id, role] of Object.entries(cfg.roles)) if (id !== "clean") role.enabled = false;
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));

  const restore = fakePi("exit 0");
  const s = spawnCli(repo, ["run"]);
  try {
    await s.waitFor(
      (out) => out.includes("tumwater running on branch main") && out.includes("orchestrator started (pid"),
      "the run banner and orchestrator event",
    );
    assert.match(s.out(), /loops: clean/);

    // The top-level process is the supervisor (src/supervisor.ts), not the orchestrator:
    // the event stream names the orchestrator's own pid, which must be a different process.
    const m = s.out().match(/orchestrator started \(pid (\d+)/);
    assert.ok(m, `expected an "orchestrator started (pid …)" event:\n${s.out()}`);
    assert.notEqual(Number(m[1]), s.child.pid, "the orchestrator must run as the supervisor's child");

    // SIGTERM reaches only the supervisor from a plain kill; it forwards it to the child,
    // which takes the graceful stop path (announce, abort in-flight ticks), and the
    // supervisor exits with the child's code.
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — waiting for in-flight ticks/);

    // Graceful shutdown removed the info file: a stale marker would make every later
    // `tumwater run` refuse to start.
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  } finally {
    s.kill();
    restore();
  }
});

// --- logs -f: the follow half of both log commands is only reachable with a live child ---

test("logs -f prints the current window and follows newly appended events", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs follow");

  // Seed one real event through the same path the TUI/GUI/CLI use.
  submitPrompt(repo, "first prompt");

  const s = spawnCli(repo, ["logs", "-f"]);
  try {
    await s.waitFor((out) => out.includes("user prompt queued: first prompt"), "the seeded event");

    // A new event appended while following must appear without a restart (500ms poll).
    submitPrompt(repo, "second prompt");
    await s.waitFor((out) => out.includes("user prompt queued: second prompt"), "the live event");
  } finally {
    s.kill();
  }
});

test("logs --role -f prints each turn exactly once across the initial window and follow", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli transcript follow");

  // One completed run on disk; a second is appended while following.
  const file = piLogPath(repo, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [JSON.stringify({ type: "session", version: 3, id: "x" }), assistantLine("first turn text")].join("\n") + "\n",
  );

  const s = spawnCli(repo, ["logs", "--role", "clean", "-f"]);
  try {
    await s.waitFor((out) => out.includes("first turn text"), "the initial window");

    fs.appendFileSync(file, assistantLine("second turn text") + "\n");
    await s.waitFor((out) => out.includes("second turn text"), "the live turn");

    // The follow renderer starts fresh at the window's end: a regression that re-fed the
    // initial lines would print the first turn twice.
    const out = s.out();
    assert.equal(out.split("first turn text").length - 1, 1, `first turn printed once:\n${out}`);
    assert.equal(out.split("second turn text").length - 1, 1, `second turn printed once:\n${out}`);
  } finally {
    s.kill();
  }
});

// --- gui: non-EADDRINUSE listen errors pass through the top-level handler ---

test("gui passes a permission error through with the raw message", async () => {
  // Privileged ports need root; as an unprivileged user this deterministically yields
  // EACCES, which the CLI must not swallow into the port-in-use hint. Skipped under root,
  // where port 80 would bind and serve forever.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const repo = makeRepo();
  await initProject(repo, "cli gui eacces");

  const r = await cli(repo, "gui", "--port", "80");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EACCES/);
});

test("gui --all-interfaces prints the reachable LAN URLs and serves until killed", async () => {
  // The success path of `tumwater gui` (banner, LAN URL lines, exposure warning) is only
  // reachable with a live child: startGui resolves once listening, then the CLI prints and
  // blocks. README documents that --all-interfaces "prints the LAN URLs it is reachable at";
  // lanAddresses' filter semantics are pinned in test/gui.test.ts (this e2e covers the
  // printing wiring against whatever interfaces this machine actually has).
  const repo = makeRepo();
  await initProject(repo, "cli gui all interfaces");

  // Claim a free port: bind an ephemeral listener, take its number, release it.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  // The URLs the CLI should print: every non-loopback IPv4 address of this machine —
  // computed here (the same filter lanAddresses applies) so the test checks the printed
  // lines against reality instead of a hardcoded IP. Empty on machines without one.
  const expected = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === "IPv4" && !a.internal))
    .map((a) => a.address);

  const s = spawnCli(repo, ["gui", "--port", String(port), "--all-interfaces"]);
  try {
    // Wait for the LAST of the three synchronous startup writes (banner → URL lines →
    // warning), so every line is present before asserting.
    await s.waitFor(
      (out) => out.includes(`tumwater gui at http://127.0.0.1:${port}`) && out.includes("listening on ALL interfaces"),
      "the gui banner and exposure warning",
    );

    // The no-auth exposure warning is printed whenever --all-interfaces is used.
    assert.match(s.out(), /listening on ALL interfaces — no auth; anyone reaching it can prompt the director/);

    // Every non-loopback IPv4 address gets exactly one URL line, and nothing else does:
    // a regression that also printed loopback or IPv6 would add extra lines (the count
    // check catches it), and dropping an interface would miss its line.
    for (const addr of expected) {
      assert.ok(s.out().includes(`also at http://${addr}:${port}`), `missing URL for ${addr}:\n${s.out()}`);
    }
    const alsoLines = s.out().split("\n").filter((l) => l.includes("also at http://"));
    assert.equal(alsoLines.length, expected.length, `exactly one line per LAN address:\n${s.out()}`);

    // The server is actually up and serving the dashboard (binding every interface
    // includes loopback).
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /<title>tumwater<\/title>/);
  } finally {
    s.kill();
  }
});
