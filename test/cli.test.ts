import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./helpers/json-read.js";
import { initProject } from "../src/init/init.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { readInitialPrompt } from "../src/brief.js";
import { defaultConfig } from "../src/config/config.js";
import { assertClean, makeRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { cli } from "./helpers/cli-harness.js";
import { seedCounters } from "./fixtures/loop-fixtures.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli,
// exitCode) live in cli-harness.ts, beside the run-to-completion capture they share.
//
// Split across files so node --test runs them in parallel processes — nearly every test here
// spawns the CLI, so each file is CPU-bound on its own. This file holds help/version, status,
// and init; cli-prompt-queue.test.ts carries the prompt queue, cli-preflight.test.ts run's
// startup preflight, and
// cli-arg-strictness.test.ts the argument-strictness tests; the other child-process CLI tests
// live in their command's topic file: cli-gui.test.ts
// (gui), cli-run-live.test.ts (run's lifecycle), doctor.test.ts, report.test.ts,
// and tui.test.ts.

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

test("--help and -h answer like `help` — the flag spellings are commands themselves", async () => {
  // The <command> --help interception deliberately skips a command that IS --help/-h: those
  // fall through to the help dispatcher, where a following token is read as a topic name.
  // Bare, they print the full listing; with a token, the token's topic — so `tumwater --help
  // status` and `tumwater help status` print the same stanza, and a mistyped token gets the
  // dispatcher's no-topic error instead of silently printing the full list.
  const dir = tmpdir();
  for (const flag of ["--help", "-h"]) {
    const bare = await cli(dir, flag);
    assert.equal(bare.code, 0);
    assert.match(bare.stdout, /Usage:/);
    assert.match(bare.stdout, /tumwater init/);

    const topic = await cli(dir, flag, "status");
    assert.equal(topic.code, 0);
    assert.match(topic.stdout, /tumwater status/);

    const mistyped = await cli(dir, flag, "statis");
    assert.equal(mistyped.code, 1);
    assert.match(mistyped.stderr, /no help topic: statis — did you mean `status`\?/);
  }
});

test("a broken install's version command fails with the reason, and the floor gate stands down", async () => {
  // cli.ts reads the package.json beside the compiled CLI (version.ts's PACKAGE_JSON), so an
  // install whose root package.json is missing or malformed — a half-pruned global install,
  // a hand-copied dist/ without its root — is only reachable from a copied tree: copy
  // dist/src into a temp dir and run the copy, whose package.json lookup lands in the temp
  // root. The dispatcher's broken-install paths (the version command's failure and the
  // Node-floor gate's stand-down) have no other test: the real install always answers.
  const install = tmpdir();
  fs.cpSync(fileURLToPath(new URL("../src", import.meta.url)), path.join(install, "dist", "src"), { recursive: true });
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(install, "dist", "src", "cli.js"), ...args],
        { cwd: install, timeout: 20_000 },
        (err, stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
      );
    });
  // No package.json at all: version reports the broken install instead of a raw stack trace…
  const missing = await run("version");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /tumwater: cannot read package\.json \(the running harness's install looks broken\)/);
  // …and the Node-floor gate stands down (no engines spec to compare against), so help still
  // answers — the gate must not block every command on a value it cannot read. version.test.ts
  // covers the sibling shape, a package.json present but without a usable version field.
  const help = await run("help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  // A package.json declaring a Node floor above the running runtime blocks every command at
  // startup with the fix, before any command does work — `help` included, the one command an
  // operator reaches for when nothing else answers.
  fs.writeFileSync(path.join(install, "package.json"), '{"engines":{"node":">=999"}}\n');
  const belowFloor = await run("help");
  assert.equal(belowFloor.code, 1);
  assert.match(belowFloor.stderr, /tumwater needs Node >=999 \(found v\d+\.\d+\.\d+\) — upgrade Node, then run tumwater again/);
});

test("version prints the package version", async () => {
  const pkg = readJson(new URL("../../package.json", import.meta.url)) as { version: string };
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

test("help --help prints the help command's own topic", async () => {
  // The convention covers every command, help included: `help --help`/`help -h` must answer
  // with the help topic, not fall through to a topic lookup for the literal flag text
  // (exit 1, "no help topic: --help — did you mean `help`?").
  for (const args of [["help", "--help"], ["help", "-h"]]) {
    const r = await cli(tmpdir(), ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /tumwater help \[<command>\]/);
  }
});

test("help <command> prints that command's topic without a ready repo", async () => {
  // The dispatch itself (cli.ts's `help` case), not just the topic parser: README documents
  // `tumwater help <command>` as the way to read one command's usage, so the primary spelling
  // must answer like `--help` does — same topic text, exit 0, and no ready-repo gate (help is
  // how an operator diagnoses a repo that is not ready in the first place).
  const dir = tmpdir();
  for (const name of ["status", "report", "help"]) {
    const r = await cli(dir, "help", name);
    assert.equal(r.code, 0, `help ${name}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${name}`));
    assert.doesNotMatch(r.stderr, /not a git repository/);
  }
});

test("help takes at most one command name", async () => {
  // Two tokens are never a topic: the arity failure must come from the help dispatcher
  // itself, before any topic lookup could misread the second token as a flag of the first.
  const r = await cli(tmpdir(), "help", "status", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /help takes at most one command name/);
});

test("--help does not rescue an unknown command", async () => {
  const r = await cli(tmpdir(), "frobnicate", "--help");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("a free-form text command carrying a --help token files the text, not the help topic", async () => {
  // The <command> --help interception answers a flag-shaped help request, but the free-form
  // position commands (init, prompt, bug, plan) read their positionals as operator text — a
  // text containing a standalone --help/-h token (`tumwater bug the TUI mishandles --help
  // output`) used to be swallowed whole: the topic printed, exit 0, the text gone with no
  // trace. When such a command carries any non-flag token (real text), the interception must
  // stand down and let the command read the text; with only flags present (`tumwater bug
  // --help`, `prompt --role qa --help`) the topic still answers.
  const dir = tmpdir();
  await initProject(dir, "test fleet");
  const filed = await cli(dir, "bug", "the", "TUI", "mishandles", "--help", "output");
  assert.equal(filed.code, 0, `bug --help text: ${filed.stderr}`);
  assert.doesNotMatch(filed.stdout, /Usage:/);
  assert.match(fs.readFileSync(path.join(dir, "BUGS.md"), "utf8"), /the TUI mishandles --help output/);

  const prompted = await cli(dir, "prompt", "fix", "the", "--help", "flag");
  // prompt (and init) read flag values, so a help token beside text is ambiguous there —
  // the parser's named error answers instead of either silently queuing or printing help.
  assert.equal(prompted.code, 1);
  assert.match(prompted.stderr, /unknown argument: --help/);
  assert.doesNotMatch(prompted.stderr, /Usage:/);

  // Flag-only invocations keep the topic answer.
  for (const args of [["bug", "--help"], ["prompt", "--role", "qa", "--help"], ["init", "--help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${args[0]}`));
  }
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
  assertClean(repo);

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

// --- `status --json` through the real CLI entry point: the machine-readable fleet state --
// the same document GET /api/status serves, printed with no server. The CLI runs as a child
// process, so the deep-equal below compares its parsed stdout against statusPayload(root)
// computed in this process for the same root; both read only from disk and nothing mutates
// the temp repo between the reads.

test("status --json prints the /api/status payload; bare status keeps the table", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli status json");
  seedCounters(repo, "feature");

  let r = await cli(repo, "status", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as Record<string, unknown>;
  // Top-level fields -- the same document GET /api/status serves for this root. `pid` is
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
  // Seeded counters surface verbatim -- the JSON is state-file data, not a re-rendering.
  const feature = loops.find((l) => l.role === "feature");
  assert.ok(feature, "feature loop row present");
  assert.equal(feature!.ticks, 7);
  assert.equal(feature!.commits, 3);
  assert.equal(feature!.generated, 424242);
  assert.equal(feature!.costUsd, 1.5);

  // Deep-equal against the same root's payload in this process -- one definition of fleet
  // state as JSON (status-payload.statusPayload) feeds both surfaces, so they cannot drift.
  // Both sides go through a JSON round-trip: that is exactly what the endpoint and the flag
  // emit.
  assert.deepEqual(doc, JSON.parse(JSON.stringify(statusPayload(repo))));

  // Bare status still renders the table -- same command, human surface unchanged.
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
