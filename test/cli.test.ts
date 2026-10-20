import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { readInitialPrompt } from "../src/brief/brief.js";
import { defaultConfig } from "../src/config/config.js";
import { assertClean, makeRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { cli, cliWithEnv } from "./helpers/cli-harness.js";
import { seedCounters } from "./fixtures/runner-fixtures.js";

// The CLI runs main() on import and reports failures via process.exit, so it is tested as a
// child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli, exitCode) live in
// cli-harness.ts, beside the run-to-completion capture they share.
//
// This file holds the command bodies driven end-to-end through the CLI child: `status`,
// `init` (including the subdirectory behavior and dry runs), and `run`'s branch validation.
// The dispatcher, help topics, and `version` live in cli-help.test.ts; the other
// child-process CLI tests live in their command's topic file: cli-prompt-queue.test.ts
// carries the prompt queue, cli-preflight.test.ts run's startup preflight, and the
// argument-strictness family (cli-arg-strictness.test.ts and cli-flag-value-errors.test.ts
// parser-wide, plus the per-command cli-prompt-/cli-questions-/cli-tui-strictness.test.ts
// files and cli-questions-list.test.ts); cli-gui.test.ts (gui),
// the cli-start-*.test.ts family (run's pre-boot guards, lifecycle, forced exit, live
// window/gui, and scoped once round), doctor.test.ts, report.test.ts, and tui.test.ts.

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
    (/created .*/.exec(r.stdout))?.[0],
    "created README.md, PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md, tumwater.json, .gitignore (committed)",
  );
  assert.match(r.stdout, /next: `tumwater start` in one terminal, `tumwater tui` in another/);
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
  assert.match(r.stdout, /next: `tumwater start` in one terminal, `tumwater tui` in another/);
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
  assert.equal(fromSub.stdout, fromRoot.stdout, "the same team state, wherever it runs from");

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

test("TUMWATER_DEBUG echoes the stack of a thrown CLI error", async () => {
  const dir = tmpdir();
  // The invalid branch name makes initProject throw past its own fail-free checks, so the
  // error reaches the top-level catch instead of the fail() gate that already reports.
  const plain = await cli(dir, "init", "Build a thing.", "--branch", "bad name");
  assert.equal(plain.code, 1);
  assert.doesNotMatch(plain.stderr, /\n    at /);
  const debug = await cliWithEnv(dir, { TUMWATER_DEBUG: "1" }, [
    "init",
    "Build a thing.",
    "--branch",
    "bad name",
  ]);
  assert.equal(debug.code, 1);
  assert.match(debug.stderr, /not a valid git branch name/);
  assert.match(debug.stderr, /\n    at /);
});

test("init --branch in an existing repo fails instead of silently ignoring the flag", async () => {
  const repo = makeRepo();
  const r = await cli(repo, "init", "Build a thing.", "--branch", "trunk");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--branch only seeds a new repository/);
  assert.match(r.stderr, /tumwater start --branch trunk/);
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
  await withPi("# never reached — the unknown branch fails first\n", async () => {
    const r = await cli(repo, "run", "--branch", "ghost");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /branch ghost does not exist/);
    assert.match(r.stderr, /branches: main/);

    // A valueless --branch fails the same way, at the flag parser.
    const noValue = await cli(repo, "run", "--branch");
    assert.equal(noValue.code, 1);
    assert.match(noValue.stderr, /--branch needs a branch name/);
  });
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

// --- `status --json` through the real CLI entry point: the machine-readable team state --
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
  // Top-level fields — the same document GET /api/status serves for this root. `pid` is
  // absent while no harness runs (undefined does not survive JSON.stringify).
  for (const field of ["running", "inbox", "inboxPrompts", "budget", "roles", "events", "plans", "bugs", "questions"]) {
    assert.ok(field in doc, `top-level ${field} present`);
  }
  assert.equal(doc.running, false, "no harness running");
  assert.ok(!("pid" in doc), "no pid while the harness is not running");

  // Per-role fields on every row.
  const roles = doc.roles as Array<Record<string, unknown>>;
  assert.ok(roles.length > 0);
  for (const l of roles) {
    for (const field of ["role", "phase", "runs", "commits", "generated", "peakCtx", "costUsd", "todayUsd", "lastResult", "lastSummary", "lastRunEndedAt"]) {
      assert.ok(field in l, `loop field ${field} present`);
    }
  }
  // Seeded counters surface verbatim — the JSON is state-file data, not a re-rendering.
  const feature = roles.find((l) => l.role === "feature");
  assert.ok(feature, "feature loop row present");
  assert.equal(feature!.runs, 7);
  assert.equal(feature!.commits, 3);
  assert.equal(feature!.generated, 424242);
  assert.equal(feature!.costUsd, 1.5);

  // Deep-equal against the same root's payload in this process — one definition of team
  // state as JSON (status-payload.statusPayload) feeds both surfaces, so they cannot drift.
  // Both sides go through a JSON round-trip: that is exactly what the endpoint and the flag
  // emit.
  assert.deepEqual(doc, JSON.parse(JSON.stringify(statusPayload(repo))));

  // Bare status still renders the table — same command, human surface unchanged.
  r = await cli(repo, "status");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\brole\b/);
  assert.match(r.stdout, /last result/);
  assert.match(r.stdout, /feature/);

  // A misspelled flag is rejected like every other unknown argument.
  r = await cli(repo, "status", "--jsonn");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --jsonn/);
});
