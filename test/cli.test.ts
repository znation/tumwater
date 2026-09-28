import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize, queuedPrompts, submitPrompt, queuedRolePrompts, submitRolePrompt } from "../src/inbox.js";
import { truncate } from "../src/text.js";
import { inboxDir, resetRequestPath } from "../src/paths.js";
import { loadLoopState } from "../src/state.js";
import { seedCounters } from "./loop-fixtures.js";
import { makeRepo, sh, tmpdir, writeConfig } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { cli, cliWithEnv } from "./cli-harness.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli,
// exitCode) live in cli-harness.ts, beside the run-to-completion capture they share.
//
// Split across files so node --test runs them in parallel processes — nearly every test here
// spawns the CLI, so each file is CPU-bound on its own. This file holds help/version, status
// and init, prompt, run's startup preflight, and the cross-command argument-strictness test;
// the other child-process CLI tests live in their command's topic file: cli-gui.test.ts
// (gui), cli-run-live.test.ts (run's lifecycle), doctor.test.ts, report.test.ts,
// status.test.ts (status --json), and tui.test.ts.

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
  writeConfig(uncommitted, defaultConfig());
  r = await cli(uncommitted, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no commits yet/);
});

test("init creates the harness files and is idempotent", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  // The full created line, in file order, with the commit marker: the harness documents plus
  // the seeded .gitignore, and tumwater.json created but untracked (it stays out of the
  // commit pathspec), so init leaves the tree clean and says so with "(committed)".
  assert.equal(
    r.stdout.match(/created .*/)?.[0],
    "created README.md, PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md, tumwater.json, .gitignore (committed)",
  );
  assert.match(r.stdout, /next: `tumwater run` in one terminal, `tumwater tui` in another/);
  for (const f of ["README.md", "PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(fs.existsSync(path.join(repo, f)), `${f} exists`);
  }
  r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  // The no-op run says exactly one line and nothing else — no stray created/next output.
  assert.equal(r.stdout, "already initialized; nothing to do\n");
});

test("init seeds a git repo in an empty directory (BUGS.md 2026-09-08)", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a tiny markdown-to-html converter CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /initialized a new git repository on branch main/);
  assert.match(r.stdout, /created README\.md/);
  assert.match(r.stdout, /next: `tumwater run` in one terminal, `tumwater tui` in another/);
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

test("init --branch in an existing repo fails instead of silently ignoring the flag", async () => {
  const repo = makeRepo();
  const r = await cli(repo, "init", "Build a thing.", "--branch", "trunk");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--branch only seeds a new repository/);
  assert.match(r.stderr, /tumwater run --branch trunk/);
  // The refusal precedes every side effect: no harness files, branch unchanged.
  assert.ok(!fs.existsSync(path.join(repo, "README.md")));
  assert.equal(sh(repo, "git", "symbolic-ref", "--short", "HEAD"), "main");
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

test("init --dry-run in a fresh directory previews the repo seeding and writes nothing", async () => {
  // The adopt dry run above covers an existing repo; this is the other half of the preview —
  // a bare directory, where the run would `git init` — and it is the branch the operator sees
  // before init ever touches an un-versioned project.
  const dir = tmpdir();
  const dry = await cli(dir, "init", "Build a tiny widget.", "--dry-run");
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /dry run — would initialize a new git repository on branch main/);
  assert.match(dry.stdout, /dry run — would create: .*README\.md/);
  assert.match(dry.stdout, /would leave alone: nothing/);
  assert.match(dry.stdout, /nothing written; re-run without --dry-run to apply/);
  // Nothing written means nothing: no seeded git repo, no document set.
  assert.deepEqual(fs.readdirSync(dir), []);

  // The --branch flag the real run would honor is named by the preview too.
  const named = tmpdir();
  const branched = await cli(named, "init", "Build a thing.", "--branch", "trunk", "--dry-run");
  assert.equal(branched.code, 0, branched.stderr);
  assert.match(branched.stdout, /dry run — would initialize a new git repository on branch trunk/);
  assert.deepEqual(fs.readdirSync(named), []);
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

  // An empty set of queues is a clean one-liner, not an error.
  let r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing queued/);

  submitPrompt(repo, "first task");
  // Full text verbatim — including newlines: --list is the inspection command that shows
  // what a queued prompt actually says before you cancel it.
  submitPrompt(repo, "second\nwith a newline");
  r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. first task$/m);
  assert.match(r.stdout, /^2\. second\nwith a newline$/m);
});

// The empty side of --role scoping: a role with nothing queued gets its own one-liner, the
// same clean answer the unscoped empty list gives — the grouped-listing test below covers the
// populated side.
test("prompt --list --role with an empty queue names the role, not an error", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt list role empty");

  const r = await cli(repo, "prompt", "--list", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^nothing queued for qa$/m);
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
