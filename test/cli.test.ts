import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { readBriefText } from "../src/brief/brief.js";
import { defaultConfig } from "../src/config/config.js";
import { assertClean, initializedRepo, makeRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { cli, cliWithEnv } from "./helpers/cli-harness.js";
import { seedCounters } from "./fixtures/runner-fixtures.js";

// The CLI runs main() on import and reports failures via process.exit, so it is tested as a
// child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli, exitCode) live in
// cli-harness.ts, beside the run-to-completion capture they share.
//
// This file holds the command bodies driven end-to-end through the CLI child: `status`,
// `init` (including the subdirectory behavior and dry runs), and `run`'s branch validation.
// The dispatcher, help topics, and `version` live in the cli-help*.test.ts slices; the other
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

test("init re-seeding a repo that only lacks its config reports it without claiming a commit", async () => {
  // The committed=false arm of the created report: a repo that already carries every harness
  // file but has lost its tumwater.json only gains the (gitignored) config, so the commit
  // pathspec is empty and init creates the file WITHOUT the "(committed)" suffix it appends
  // when it stages and commits a new set. The config is deliberately left out of the pathspec
  // (plans/portability.md §4a/7), so a config-only re-seed has nothing to commit.
  const repo = makeRepo();
  await cli(repo, "init", "Re-seed me.");
  fs.unlinkSync(path.join(repo, "tumwater.json"));
  const r = await cli(repo, "init", "Re-seed me.");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "created tumwater.json\nnext: `tumwater start` in one terminal, `tumwater tui` in another\n");
  assert.ok(fs.existsSync(path.join(repo, "tumwater.json")), "config re-created");
  assertClean(repo);
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

// init's --json: the acknowledgement object the prose report is replaced by. The spawned CLI
// runs under the suite's hermetic git environment, so git init seeds branch main and the
// identity the commit authors with is the suite's, not the host's global config.

interface InitJson {
  command: string;
  status: string;
  dryRun: boolean;
  template: string;
  adopted: boolean;
  readmeExists: boolean;
  wasRepo: boolean;
  repoInitialized: boolean;
  branch: string | null;
  created: string[];
  leftAlone: string[];
  committed: boolean;
  bootstrap: number | null;
}

function initJsonDoc(r: { code: number; stdout: string; stderr: string }): InitJson {
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  // The whole stdout is the one JSON document: no prose line anywhere in it.
  return JSON.parse(r.stdout) as InitJson;
}

test("init --json prints the acknowledgement object instead of the prose report", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a thing.", "--json");
  const doc = initJsonDoc(r);
  assert.equal(doc.command, "init");
  assert.equal(doc.status, "initialized");
  assert.equal(doc.dryRun, false);
  assert.equal(doc.template, "blank");
  assert.equal(doc.repoInitialized, true);
  assert.equal(doc.branch, "main");
  assert.equal(doc.adopted, false);
  assert.equal(doc.readmeExists, false);
  assert.equal(doc.wasRepo, false);
  assert.equal(doc.committed, true);
  assert.equal(doc.bootstrap, 5);
  // created names the seeded set in seed order; every entry exists, the config among them
  // (created, but left out of the commit pathspec).
  assert.deepEqual(doc.created, [
    "README.md",
    "PLANS.md",
    "BUGS.md",
    "QUESTIONS.md",
    "PRINCIPLES.md",
    "tumwater.json",
    ".gitignore",
  ]);
  for (const f of doc.created) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
  }
  // The prose lines are gone: the whole stdout is the JSON document.
  assert.doesNotMatch(r.stdout, /created README/);
  assert.doesNotMatch(r.stdout, /next: `tumwater start`/);
  assert.doesNotMatch(r.stdout, /initialized a new git repository/);
  assert.equal(r.stderr, "");
  // Second run on the seeded repo: the no-op re-run's object.
  const again = await cli(dir, "init", "Build a thing.", "--json");
  const noop = initJsonDoc(again);
  assert.equal(noop.status, "already_initialized");
  assert.deepEqual(noop.created, []);
  assert.equal(noop.committed, false);
  // The no-op leaves nothing: every seeded file is read, so all land in leftAlone in seed order.
  assert.deepEqual(noop.leftAlone, [
    "README.md",
    "PLANS.md",
    "BUGS.md",
    "QUESTIONS.md",
    "PRINCIPLES.md",
    "tumwater.json",
    ".gitignore",
  ]);
});

test("init --dry-run --json previews the would-be fields and writes nothing", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a thing.", "--dry-run", "--json");
  const doc = initJsonDoc(r);
  assert.equal(doc.status, "initialized"); // the dry run carries the mode in dryRun, not status
  assert.equal(doc.dryRun, true);
  assert.equal(doc.template, "blank");
  assert.equal(doc.repoInitialized, true);
  assert.equal(doc.branch, "main");
  assert.equal(doc.wasRepo, false);
  assert.equal(doc.committed, false);
  assert.equal(doc.bootstrap, 5);
  assert.deepEqual(doc.created, [
    "README.md",
    "PLANS.md",
    "BUGS.md",
    "QUESTIONS.md",
    "PRINCIPLES.md",
    "tumwater.json",
    ".gitignore",
  ]);
  // Rehearsal only: the directory is still empty afterwards.
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("init --adopt --json reports the adoption and leaves the README untouched", async () => {
  const repo = makeRepo();
  const readme = path.join(repo, "README.md");
  fs.writeFileSync(readme, "# My project\n\nAn unrelated README.\n");
  const before = fs.readFileSync(readme, "utf8");
  const r = await cli(repo, "init", "Adopt me.", "--adopt", "--json");
  const doc = initJsonDoc(r);
  assert.equal(doc.status, "initialized");
  assert.equal(doc.adopted, true);
  assert.equal(doc.readmeExists, true);
  assert.equal(doc.wasRepo, true);
  assert.equal(doc.repoInitialized, false);
  assert.equal(doc.branch, null);
  // The brief went to TUMWATER.md (a created entry); README.md was claimed left alone.
  assert.ok(doc.created.includes("TUMWATER.md"), `created: ${doc.created}`);
  assert.ok(doc.leftAlone.includes("README.md"), `leftAlone: ${doc.leftAlone}`);
  assert.ok(!doc.created.includes("README.md"), "the README is not re-created");
  assert.equal(fs.readFileSync(readme, "utf8"), before, "README.md is byte-identical");
  assert.ok(fs.readFileSync(path.join(repo, "TUMWATER.md"), "utf8").includes("Adopt me."));
  // The repo seeded from the existing repo's commit history is not fresh: no bootstrap seed.
  assert.equal(doc.bootstrap, null);
});

test("init --json composes with --template and --branch, and validation refusals stay prose", async () => {
  const dir = tmpdir();
  const r = await cli(dir, "init", "Build a thing.", "--template", "python-cli", "--branch", "trunk", "--json");
  const doc = initJsonDoc(r);
  assert.equal(doc.template, "python-cli");
  assert.equal(doc.branch, "trunk");
  assert.equal(doc.status, "initialized");
  // The python-cli template seeds its starter directories as created entries too.
  assert.ok(doc.created.includes("src") && doc.created.includes("tests"), `created: ${doc.created}`);
  assert.equal(sh(dir, "git", "symbolic-ref", "--short", "HEAD"), "trunk");

  // An unknown template and an invalid branch still exit 1 with the existing stderr wording
  // and an empty stdout — the refusals precede initProject and its JSON output.
  const badTemplate = await cli(dir, "init", "Build a thing.", "--template", "nope", "--json");
  assert.equal(badTemplate.code, 1);
  assert.match(badTemplate.stderr, /unknown template "nope"/);
  assert.equal(badTemplate.stdout, "");
  // A fresh directory: the invalid name is caught by git's own rule before any seeding
  // (--branch on the already-seeded `dir` above would instead hit the existing-repo refusal).
  const badBranch = await cli(tmpdir(), "init", "Build a thing.", "--branch", "bad name", "--json");
  assert.equal(badBranch.code, 1);
  assert.match(badBranch.stderr, /not a valid git branch name/);
  assert.equal(badBranch.stdout, "");

  // A doubled --json is refused by name; --list-templates takes no prompt beside --json.
  const dir2 = tmpdir();
  const doubled = await cli(dir2, "init", "Build a thing.", "--json", "--json");
  assert.equal(doubled.code, 1);
  assert.match(doubled.stderr, /--json may only be given once/);
  const listWithPrompt = await cli(dir2, "init", "--list-templates", "--json", "Build a thing.");
  assert.equal(listWithPrompt.code, 1);
  assert.match(listWithPrompt.stderr, /--list-templates takes no prompt/);
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
  // The repo's own README.md is the adoption target — it is left untouched — so the banner
  // names the README (the pre-2026-11-02 keying named the repo instead, see BUGS.md).
  assert.match(dry.stdout, /would adopt the existing README\.md: the project brief goes in TUMWATER\.md/);
  assert.match(dry.stdout, /dry run — would create: .*TUMWATER\.md/);
  assert.match(dry.stdout, /would leave alone: README\.md/);
  assert.match(dry.stdout, /nothing written; re-run without --dry-run to apply/);
  assert.deepEqual(fs.readdirSync(repo).sort(), listing, "nothing written");
  assertClean(repo);

  // The real run takes the path the dry run described, and the flag never reaches the brief.
  const r = await cli(repo, "init", "--adopt", "Adopt me.");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /adopting the existing README\.md/);
  assert.match(r.stdout, /created .*TUMWATER\.md/);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# theirs\n");
  assert.equal(readBriefText(repo), "Adopt me.");
});

test("init on a non-repo with a README.md adopts the README without claiming an existing repo", async () => {
  // A README.md without the tumwater markers drives the adoption path (the brief goes to
  // TUMWATER.md and README.md is left untouched) even when the directory is not a git repo
  // yet — but init then seeds the repo itself, so the adoption banner must not claim an
  // "existing repo" in the same run that says "initialized a new git repository".
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), "# theirs\n");
  const r = await cli(dir, "init", "Build a thing.");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /initialized a new git repository on branch main/);
  assert.match(r.stdout, /the project brief goes in TUMWATER\.md and README\.md is left untouched/);
  assert.doesNotMatch(r.stdout, /existing repo/);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# theirs\n");
  assert.ok(fs.existsSync(path.join(dir, "TUMWATER.md")));
  assert.ok(fs.existsSync(path.join(dir, ".git")));
  assert.equal(readBriefText(dir), "Build a thing.");

  // The dry run of the same case makes the same pair of contradictory lines.
  const dryDir = tmpdir();
  fs.writeFileSync(path.join(dryDir, "README.md"), "# theirs\n");
  const dry = await cli(dryDir, "init", "Build a thing.", "--dry-run");
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would initialize a new git repository on branch main/);
  assert.doesNotMatch(dry.stdout, /existing repo/);
  assert.deepEqual(fs.readdirSync(dryDir), ["README.md"], "the dry run wrote nothing");
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

test("init on a README.md directory with no git repo does not claim an existing repo", async () => {
  // Regression for BUGS.md: a README.md without a git repo is adopted for its README (the brief
  // goes to TUMWATER.md), but init also seeds a fresh git repo — so the banner must not call the
  // repo "existing" while the next line says init just created it.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), "# mine\n");

  // Dry run: the preview pairs the adoption line with "would initialize a new git repository".
  const dry = await cli(dir, "init", "Build a thing.", "--dry-run");
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would initialize a new git repository on branch main/);
  assert.match(dry.stdout, /TUMWATER\.md and README\.md is left untouched/);
  assert.doesNotMatch(dry.stdout, /would adopt an existing repo/);

  // Real run: same contradiction, real tenses.
  const r = await cli(dir, "init", "Build a thing.");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /initialized a new git repository on branch main/);
  assert.match(r.stdout, /TUMWATER\.md and README\.md is left untouched/);
  assert.doesNotMatch(r.stdout, /adopting an existing repo/);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# mine\n");
  assert.equal(readBriefText(dir), "Build a thing.");
});

test("init --adopt in an empty non-git directory does not claim to adopt a README.md", async () => {
  // Regression for BUGS.md 2026-11-02: --adopt on a directory with no README.md adopts nothing
  // to preserve, yet the banner said "adopting the existing README.md" because it keyed the
  // target on repoInitialized, which init sets for every empty directory it seeds.
  const dir = tmpdir();
  const r = await cli(dir, "init", "--adopt", "Adopt an empty dir.");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /initialized a new git repository on branch main/);
  assert.match(r.stdout, /the project brief goes in TUMWATER\.md/);
  assert.doesNotMatch(r.stdout, /existing README\.md/);
  assert.ok(!fs.existsSync(path.join(dir, "README.md")), "--adopt never creates a README.md");
  assert.equal(readBriefText(dir), "Adopt an empty dir.");

  // The dry run makes the same false claim in the would tense.
  const dryDir = tmpdir();
  const dry = await cli(dryDir, "init", "--adopt", "Adopt an empty dir.", "--dry-run");
  assert.equal(dry.code, 0, dry.stderr);
  assert.doesNotMatch(dry.stdout, /existing README\.md/);
  assert.deepEqual(fs.readdirSync(dryDir), [], "the dry run wrote nothing");
});

test("init --template names the seeded template in its report and creates its starter dirs", async () => {
  // The catalog ids are pinned by init-templates.test.ts; this is the CLI printer's half — the
  // `template: <id>` line only cmdInit prints, with `--template` reaching it through parseInitArgs
  // and initProject. No earlier test drives --template through the CLI, so a regression that
  // dropped the report line (or never passed the id through) would go unseen.
  const repo = makeRepo();
  const r = await cli(repo, "init", "--template", "python-cli", "A markdown-to-html converter.");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /template: python-cli/);
  assert.match(r.stdout, /\(committed\)/);
  assert.ok(fs.statSync(path.join(repo, "src")).isDirectory(), "src starter dir seeded");
  assert.ok(fs.statSync(path.join(repo, "tests")).isDirectory(), "tests starter dir seeded");
  // The brief carries the template's preamble first, the operator's words last.
  assert.ok(readBriefText(repo).endsWith("A markdown-to-html converter."));
});

test("run --branch fails at startup when the branch does not exist, listing what does", async () => {
  const repo = makeRepo();
  await cli(repo, "init", "Ready repo.");
  // fake pi on PATH so the run preflight passes and the branch validation itself is what
  // fails — in the supervisor, before any child spawns: the branch is part of the one startup
  // gate (startup-gates.ts) every generation, and the supervisor itself, runs.
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
  assert.equal(readBriefText(repo), "Build a thing.\nWith care.");

  const bare = makeRepo();
  r = await cli(bare, "init", "--file");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file needs a path/);
});

test("init rejects unknown flags and stray positionals instead of baking them into the prompt", async () => {
  const repo = makeRepo();

  // A misspelled --file used to succeed with "--fil prompt.md" as the project's initial
  // prompt — injected into every run forever. Now it fails like any other unknown flag,
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
  assert.equal(readBriefText(bare2), "- Build A - Build B");
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
  const doc2 = JSON.parse(JSON.stringify(await statusPayload(repo)));
    assert.deepEqual(doc, doc2);

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

// `config edit` (editor form) and its arity gate, driven end-to-end through the CLI child. The
// editor form spawns $EDITOR, so it is captured at the child level (the in-process
// --file/--json shapes live in cli-config-commands.test.ts, where no child is spawned).
/** An editor stub: a node script recording the buffer it received, then running `body`. */
function editorStub(name: string, body: string): { env: NodeJS.ProcessEnv; received: string } {
  const dir = tmpdir("tumwater-stub-");
  const received = path.join(dir, `${name}.received`);
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(
    script,
    `const fs = require("fs"); const file = process.argv[2];\n` +
      `fs.writeFileSync(${JSON.stringify(received)}, fs.readFileSync(file, "utf8"));\n${body}\n`,
  );
  return { env: { EDITOR: `"${process.execPath}" "${script}"` }, received };
}

test("config edit (editor form) saves a changed buffer, prints updated, and get reads each value", async () => {
  const repo = await initializedRepo();
  writeConfig(repo, { maxConcurrent: 3 });
  const file = path.join(repo, "tumwater.json");
  const initial = fs.readFileSync(file, "utf8"); // snapshot before the stub rewrites the file
  const s = editorStub(
    "cfg-changed",
    `fs.writeFileSync(file, JSON.stringify({ maxConcurrent: 9, model: "gpt-5" }, null, 2) + "\\n");`,
  );
  const r = await cliWithEnv(repo, s.env, ["config", "edit"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /config updated in tumwater\.json/);
  // editInEditor hands the editor the current file with a trailing newline appended.
  assert.equal(fs.readFileSync(s.received, "utf8"), initial + "\n", "the editor received the current file");
  const m = await cli(repo, "config", "get", "model");
  assert.equal(m.stdout, '"gpt-5"\n');
  const c = await cli(repo, "config", "get", "maxConcurrent");
  assert.equal(c.stdout, "9\n");
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ maxConcurrent: 9, model: "gpt-5" }, null, 2) + "\n", "the file is the saved buffer");
});

test("config edit (editor form) of an unmodified buffer prints unchanged and leaves the bytes identical", async () => {
  const repo = await initializedRepo();
  writeConfig(repo, { maxConcurrent: 3 });
  const file = path.join(repo, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  const s = editorStub("cfg-same", ""); // records the buffer, leaves it untouched
  const r = await cliWithEnv(repo, s.env, ["config", "edit"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /config unchanged/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the file stays byte-identical");
});

test("config edit (editor form) of an invalid buffer exits 1 and leaves the bytes identical", async () => {
  const repo = await initializedRepo();
  writeConfig(repo, { maxConcurrent: 3 });
  const file = path.join(repo, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  const s = editorStub("cfg-bad", `fs.writeFileSync(file, JSON.stringify({ maxConcurrent: 0 }) + "\\n");`);
  const r = await cliWithEnv(repo, s.env, ["config", "edit"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /maxConcurrent/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the file stays byte-identical on an invalid buffer");
});

test("config edit with no editor exits 1 with the hint and leaves the bytes identical", async () => {
  const repo = await initializedRepo();
  writeConfig(repo, { maxConcurrent: 3 });
  const file = path.join(repo, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  const r = await cliWithEnv(repo, { VISUAL: "", EDITOR: "" }, ["config", "edit"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no editor: set \$VISUAL or \$EDITOR, or pass --file <path>/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("config edit arity: a missing --file path and a surplus token fail with the config usage, and a typo suggests edit", async () => {
  const repo = await initializedRepo();
  writeConfig(repo, { maxConcurrent: 3 });
  let r = await cli(repo, "config", "edti");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did you mean `edit`/);
  r = await cli(repo, "config", "edit", "--file");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config/);
  r = await cli(repo, "config", "edit", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater config/);
});
