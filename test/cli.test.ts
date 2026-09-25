import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { truncate } from "../src/text.js";
import { inboxDir } from "../src/paths.js";
import { cli, cliWithEnv, fakePi, makeRepo, sh, tmpdir } from "./util.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli,
// exitCode) live in util.ts alongside the rest of the test scaffolding.
//
// Split in two so node --test runs the halves in parallel processes — nearly every test here
// spawns the CLI, so each half is CPU-bound on its own. This half holds help/version, status
// and init, prompt, and run's startup preflight; cli-2.test.ts holds gui, argument
// validation, status --json, tui, doctor, report, and run's lifecycle. Keep the two roughly
// equal in measured duration when moving tests between them.

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

test("init seeds a git repo in an empty directory (BUGS.md 2026-09-08)", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a tiny markdown-to-html converter CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /initialized a new git repository on branch main/);
  assert.match(r.stdout, /created README\.md/);
  assert.equal(sh(dir, "git", "symbolic-ref", "--short", "HEAD"), "main");
});

test("commands behave identically from a subdirectory of the repo (portability 2/7)", async () => {
  const repo = makeRepo();
  assert.ok((await cli(repo, "init", "From the root.")).code === 0);
  const sub = path.join(repo, "docs", "deep");
  fs.mkdirSync(sub, { recursive: true });

  // status resolves the repo root from the subdirectory and answers exactly as from the root.
  const fromRoot = await cli(repo, "status");
  const fromSub = await cli(sub, "status");
  assert.equal(fromSub.code, 0);
  assert.equal(fromSub.code, fromRoot.code);
  assert.equal(fromSub.stdout, fromRoot.stdout, "the same fleet state, wherever it runs from");

  // init from a subdirectory of an existing repo seeds THAT repo's root, never a nested
  // document set — and a second run reports already initialized.
  const adopted = makeRepo();
  const adoptedSub = path.join(adopted, "sub");
  fs.mkdirSync(adoptedSub, { recursive: true });
  const r = await cli(adoptedSub, "init", "Adopt this repo.");
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(adopted, "README.md")), "documents land at the toplevel");
  assert.ok(!fs.existsSync(path.join(adoptedSub, "README.md")), "nothing nested in the subdirectory");
  const again = await cli(adoptedSub, "init", "Adopt this repo.");
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already initialized; nothing to do/);
});

test("init --branch names the branch a new repo is seeded on", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a thing.", "--branch", "trunk");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /initialized a new git repository on branch trunk/);
  assert.equal(sh(dir, "git", "symbolic-ref", "--short", "HEAD"), "trunk");
});

test("init --dry-run prints the file lists and exits 0 without writing; --adopt then applies", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# theirs\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme");
  const listing = fs.readdirSync(repo).sort();
  const dry = await cli(repo, "init", "--adopt", "--dry-run", "Adopt me.");
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would adopt an existing repo: the project brief goes in TUMWATER\.md/);
  assert.match(dry.stdout, /dry run — would create: .*TUMWATER\.md/);
  assert.match(dry.stdout, /would leave alone: README\.md/);
  assert.match(dry.stdout, /nothing written; re-run without --dry-run to apply/);
  assert.deepEqual(fs.readdirSync(repo).sort(), listing, "nothing written");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");

  // The real run takes the path the dry run described, and the flag never reaches the brief.
  const r = await cli(repo, "init", "--adopt", "Adopt me.");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /adopting an existing repo/);
  assert.match(r.stdout, /created .*TUMWATER\.md/);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# theirs\n");
  assert.equal(readInitialPrompt(repo), "Adopt me.");
});

test("run --branch fails at startup when the branch does not exist, listing what does", async () => {
  const repo = makeRepo();
  await cli(repo, "init", "Ready repo.");
  // fake pi on PATH so the run preflight passes and the branch validation itself is what
  // fails — in the supervisor, before any child spawns: the branch is part of the one startup
  // gate (startup-gate.ts) every generation, and the supervisor itself, runs.
  const restore = fakePi("# never reached — the unknown branch fails first\n");
  try {
    const r = await cli(repo, "run", "--branch", "ghost");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /branch ghost does not exist/);
    assert.match(r.stderr, /branches: main/);

    // A valueless --branch fails the same way, at the flag parser.
    const noValue = await cli(repo, "run", "--branch");
    assert.equal(noValue.code, 1);
    assert.match(noValue.stderr, /--branch needs a branch name/);
  } finally {
    restore();
  }
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
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));
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
