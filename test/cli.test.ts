import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { truncate } from "../src/text.js";
import { makeRepo, sh, tmpdir, writeConfig } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { cli } from "./cli-harness.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli,
// exitCode) live in cli-harness.ts, beside the run-to-completion capture they share.
//
// Split across files so node --test runs them in parallel processes — nearly every test here
// spawns the CLI, so each file is CPU-bound on its own. This file holds help/version, status,
// init, and the prompt queue's enqueue/list basics; cli-prompt-queue.test.ts carries the
// queue's cancel/role cases, cli-preflight.test.ts run's startup preflight, and
// cli-arg-strictness.test.ts the argument-strictness tests; the other child-process CLI tests
// live in their command's topic file: cli-gui.test.ts
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

test("a mistyped command suggests the closest listed one", async () => {
  const r = await cli(tmpdir(), "statis");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: statis — did you mean `status`\?/);
});

test("a mistyped help topic suggests the closest command too", async () => {
  const r = await cli(tmpdir(), "help", "statu");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no help topic: statu — did you mean `status`\?/);
});

test("<command> --help prints that command's help topic", async () => {
  const dir = tmpdir();
  // Both spellings, and --help riding alongside other flags (help wins, like every CLI).
  // No ready repo is needed: the topic is answered before status's startup gate, so the
  // same invocation outside a git repo still prints usage instead of refusing.
  for (const args of [["status", "--help"], ["pause", "-h"], ["diff", "--role", "x", "--help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${args[0]}`));
  }
  const bare = await cli(tmpdir(), "status", "--help");
  assert.equal(bare.code, 0);
  assert.doesNotMatch(bare.stderr, /not a git repository/);
});

test("--help does not rescue an unknown command", async () => {
  const r = await cli(tmpdir(), "frobnicate", "--help");
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

test("init --branch with a name git rejects fails before creating anything", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a thing.", "--branch", "bad name");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a valid git branch name/);
  assert.match(r.stderr, /--branch "bad name"/);
  // Nothing half-initialized: the failure precedes both git init and the harness files,
  // so a re-run with a good name starts clean instead of tripping the existing-repo refusal.
  assert.ok(!fs.existsSync(path.join(dir, ".git")));
  assert.ok(!fs.existsSync(path.join(dir, "README.md")));
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

