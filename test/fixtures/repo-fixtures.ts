/** The git-repo and project-dir fixtures tests stand their scenarios on: the per-process
 * temp root (tmpdir), raw shell plumbing (sh), makeRepo / initializedRepo (a repo, plain or
 * run through initProject), worktreeAt (a linked role worktree), writeConfig (a seeded
 * tumwater.json), and landWork (a commit on main that counts as work for the deferral rule).
 * Split from the old util.ts grab-bag, now dissolved into the topic-named modules
 * (oracles.ts, log-fixtures.ts, loop-fixtures.ts, gui-fixtures.ts); the live-orchestrator,
 * fake-pi, and fake-command families live in their own modules (orchestrator-fixtures.ts,
 * fake-pi.ts, fake-commands.ts). The dependency runs one way: the other test modules and
 * the tests import from here; this module imports only the leaf fake-command utilities
 * (fake-commands.ts), never another fixture family.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../../src/init/init.js";
import { ensureWorktree } from "../../src/git/worktree.js";
import { ensureParentDir } from "../../src/files/files.js";
import { pathPrepend, projManifest, writeScript } from "../fakes/fake-commands.js";

/** Per-process root for every test temp dir: created on first use, torn down synchronously at
 * process exit. A full suite run (one worker process per test file) therefore abandons at most
 * one directory per file instead of one per tmpdir() call (~500 per run), which kept $TMPDIR
 * growing until mkdtemp itself dominated suite runtime. */
let runRoot: string | undefined;

function testRunRoot(): string {
  if (runRoot === undefined) {
    runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-test-run-"));
    process.once("exit", () => {
      if (runRoot === undefined) return;
      try {
        fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Best effort: one leaked root per crashed process is still bounded.
      }
    });
  }
  return runRoot;
}

export function tmpdir(prefix = "tumwater-test-"): string {
  return fs.mkdtempSync(path.join(testRunRoot(), prefix));
}

/** True when the test process runs as root (getuid() is 0) — the one spelling of that probe,
 * shared by every permission-fixture test (chmod cannot stop a root process, so those tests
 * skip or branch on the predicate instead of asserting a failure that cannot fire). */
export function runningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trimEnd();
}

/** main's current commit sha — the head every "did this landing move main" assertion captures
 * before acting and re-reads after (lander, drain, merge, baseline, review, loop tests), so the
 * pinned-ref spelling cannot drift between them and a typo'd ref fails in one place. */
export function mainSha(dir: string): string {
  return sh(dir, "git", "rev-parse", "main");
}

/** The current commit sha of `dir` (its HEAD), wherever it is a worktree or the repo itself —
 * the one home of the tests' 129 `sh(dir, "git", "rev-parse", "HEAD")` reads, so the ref
 * spelling and the `sh()` trimEnd contract cannot drift between them. (orchestrator-director's
 * shaOnSideBranch keeps its own read through a local spawnSync wrapper, `g`.) */
export function headSha(dir: string): string {
  return sh(dir, "git", "rev-parse", "HEAD");
}

/** Assert a repo or worktree dir has a clean `git status --porcelain` — the single home of the
 * tests' "no stray edits / no uncommitted work" assertion (init, cli, lander, landing, and
 * loop tests carried ~20 identical copies). An optional label is forwarded so the sites that
 * named the assertion keep their failure message. Sites asserting a *non*-clean status (a
 * conflict, an expected untracked file) assert something different and keep their own spelling. */
export function assertClean(dir: string, message?: string): void {
  const status = sh(dir, "git", "status", "--porcelain");
  if (message === undefined) assert.equal(status, "");
  else assert.equal(status, "", message);
}

/** Assert a worktree has no merge or rebase left in progress and is back on its committed
 * branch state — the landing tests' shared "settled" assertion (landing-git and landing-merge
 * each declared their own copy of this wrapper). The message names the rebase so a
 * mid-conflict leftover is not mistaken for a stray edit. */
export function assertWorktreeSettled(wt: string): void {
  assertClean(wt, "worktree clean, no rebase in progress");
}

/** A scratch bin dir whose only entry is a symlink to the real git: a restricted PATH that
 * keeps git working (repo checks, landing, the worktree helpers) while dropping every other
 * binary — pi, npm — so a test can isolate exactly one missing tool. Tests that need the dir
 * to stay findable in failures pass a distinctive `prefix`. */
/** Install a logging `git` shim at the front of PATH that appends each invocation's args
 * to `logFile` before exec'ing the real git (so behavior stays correct). Returns a restore
 * function. Lets a test assert exactly which subprocesses a code path spawned — the same
 * PATH technique fakePi uses for pi. */
export function loggingGit(logFile: string): () => void {
  const dir = tmpdir("fake-git-");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim().split("\n")[0];
  writeScript(path.join(dir, "git"), `echo "$@" >> ${logFile}\nexec "${real}" "$@"`);
  return pathPrepend(dir);
}

export function gitOnlyBinDir(prefix = "tumwater-test-bin-"): string {
  const binDir = tmpdir(prefix);
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));
  return binDir;
}

/** Write `content` to `path.join(dir, name)` and commit everything in `dir` with `message` —
 * the standard "advance a repo by one plain commit" move the git tests repeat dozens of times
 * (diverging main, seeding conflicts, laying down history). Sync, using the fixtures' sh()
 * spelling so it relies on gitInit's config-file identity like every other fixture call. */
export function seedCommit(dir: string, name: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, name), content);
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", message);
}

/** Seed a conflicting divergence for a rebase test: commit a "branch version" of `name` on
 * the worktree's branch, then a different "main version" of the same file on the repo's main,
 * so the next rebase of `wt` onto main stops mid-conflict. The one home of that seed pair,
 * which git.test.ts hand-rolled eight times (in both orders — the two commits touch different
 * branches, so the order is immaterial). The messages default to the shared "seed edit"
 * vocabulary; tests seeding a differently named file pass their plainer "edit" variants. */
export function seedConflict(
  repo: string,
  wt: string,
  name = "seed.txt",
  mainMsg = "main seed edit",
  branchMsg = "branch seed edit",
): void {
  seedCommit(wt, name, "branch version\n", branchMsg);
  seedCommit(repo, name, "main version\n", mainMsg);
}

/** `git init -b main` in `dir` with the fixtures' commit identity. The identity is appended to
 * .git/config directly — byte for byte what `git config user.name test` and `git config
 * user.email …` write — because fixture repos are made ~600 times a suite and each spawn
 * costs more than the whole append. */
export function gitInit(dir: string): void {
  sh(dir, "git", "init", "-b", "main");
  fs.appendFileSync(path.join(dir, ".git", "config"), "[user]\n\tname = test\n\temail = test@example.com\n");
}

/** Create a git repo on branch `main` with one commit — in a fresh temp dir by default, or at
 * `dir` when the test needs a particular location (e.g. nested under an installed root). */
export function makeRepo(dir = tmpdir()): string {
  fs.mkdirSync(dir, { recursive: true });
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", "seed");
  return dir;
}

/** A makeRepo'd repo that has run initProject — the standard fixture for tests that drive a
 * full tick or lander against an initialized tumwater project. Shared by the loop e2e slices,
 * which each used to carry their own identical copy. */
export async function initializedRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "A test project.");
  return repo;
}

/** An initializedRepo'd repo plus a role's worktree off main — the base the landing-git,
 * landing-merge, refusal, retire, tick-stage, and tick-verdict tests stage their scenarios on,
 * several of which used to carry their own identical initializedRoot/setup copy. The role
 * defaults to improve; pass one for tests that need a specific role's worktree. */
export async function initializedWorktree(role = "improve"): Promise<{ root: string; wt: string }> {
  const root = await initializedRepo();
  const wt = await ensureWorktree(root, role, "main");
  return { root, wt };
}

/** Stage everything and commit in a fixture dir — the tests' one way to put work on a branch
 * or main, so the sweeping `git add -A` + commit pair lives once. */
export function commitIn(dir: string, msg: string): void {
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", msg);
}

/** Give a repo a committed package.json carrying `version` — the base the release-script
 * tests stand on, since scripts/release.mjs reads the version from it. */
export function seedPackage(root: string, version: string): void {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tumwater", version }));
  commitIn(root, "package");
}

/** A makeRepo'd repo on main with a committed package.json and a bare `origin` it has already
 * pushed main to: the smallest non-diverged base the release path needs to get past guardMain
 * and reach its push/CI/tag behavior. */
export function pushedRepo(version = "0.1.0"): { root: string; origin: string } {
  const root = makeRepo();
  seedPackage(root, version);
  const origin = tmpdir("release-origin-");
  sh(origin, "git", "init", "--bare");
  sh(root, "git", "remote", "add", "origin", origin);
  sh(root, "git", "push", "origin", "main");
  return { root, origin };
}

/** Seed a fixture's tumwater.json with the given (partial) config: the project config file's
 * name and write convention live here, so a test states only the keys under test. Fixtures
 * that deliberately write torn or invalid JSON keep their own raw writeFileSync. */
/** Make a repo's main "red": commit a package.json whose test script fails (appending to
 * `counter` so tests can count how often npm actually ran), plus an untracked node_modules dir
 * at root — the installed-project signature detectBuildCheck walks up to from the worktree. */
export function makeMainRed(repo: string, counter: string): void {
  fs.mkdirSync(path.join(repo, "node_modules")); // untracked install marker (gitignored in real projects)
  fs.writeFileSync(
    path.join(repo, "package.json"),
    projManifest({ test: `echo baseline-failure-line; echo run >> ${counter}; exit 1` }),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "make main red");
}

export function writeConfig(dir: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify(value));
}

/** Overwrite `file` with the shared unparseable-JSON payload ("{ not json"): the single home
 * of the malformed-JSON fixture the parse-failure tests used to hand-roll as
 * `fs.writeFileSync(file, "{ not json")` (config, templates, state files, package.json —
 * every "bad bytes degrade gracefully" shape). Returns `file` so a fixture writer that also
 * mints the path composes inline. Only the fully unparseable payload lives here: a torn
 * (truncated but still shapeful) write is a distinct fixture per test, so those stay local.
 * The exact bytes match what the sites hand-rolled, so every JSON.parse failure and error
 * message under test is unchanged. */
export function writeMalformedJson(file: string): string {
  fs.writeFileSync(file, "{ not json");
  return file;
}

/** Write a backlog fixture file (PLANS.md, BUGS.md, or QUESTIONS.md) from its sections. The
 * single home of the skeleton every backlog fixture used to hand-roll — title heading, blank
 * line, each `## ` section heading with its body — so a test states only the entries under
 * test. A section with no body renders the canonical `_None yet._` placeholder the init
 * templates seed; a body is trimmed at its edges (the parsers trim it right back). The exact
 * bytes match the hand-rolled arrays the fixtures used before: title, blank, heading, blank,
 * body, blank, next heading — so the parsers under test see the documents they always did. */
interface BacklogSection {
  /** The section's full heading line, as the real files carry it (e.g. "## Planned"). */
  heading: string;
  /** The section's body below its heading, verbatim; omitted means "empty section". */
  body?: string;
}

export function writeBacklogFile(
  root: string,
  file: "PLANS.md" | "BUGS.md" | "QUESTIONS.md",
  sections: BacklogSection[],
): void {
  const title = file === "PLANS.md" ? "# Plans" : file === "BUGS.md" ? "# Bugs" : "# Questions";
  const out = [title, ""];
  sections.forEach((section, i) => {
    if (i > 0) out.push("");
    const body = section.body === undefined ? "_None yet._" : section.body.trim();
    out.push(section.heading, "", ...body.split("\n"));
  });
  fs.writeFileSync(path.join(root, file), out.join("\n") + "\n");
}

/** Seed one open bug into BUGS.md's `## Open` placeholder: read-modify-write the file the
 * orchestrator e2e scenarios stand on, swapping the section's `_None yet._` body for a single
 * `### An open bug` heading. The section-anchored pattern hits only that placeholder, so
 * `## Fixed` keeps its own. The single home of the copy-pasted block the four orchestrator
 * e2e files used to hand-roll (7 sites). */
export function seedOpenBug(repo: string): void {
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    fs.readFileSync(path.join(repo, "BUGS.md"), "utf8").replace("## Open\n\n_None yet._", "## Open\n\n### An open bug\n"),
  );
}

/** A makeRepo'd repo (no package.json — nothing declares a build check) plus a linked
 * worktree for `role` at the real location, checked out to pristine main: the shape the
 * no-check-declared baseline tests need. `dir` is the repo path, created if missing. */
export function worktreeAt(root: string, role: string): string {
  const wt = path.join(root, ".tumwater", "worktrees", role);
  ensureParentDir(wt);
  sh(root, "git", "worktree", "add", "-b", `tumwater/${role}`, wt, "main");
  return wt;
}

/** Land a commit on main that counts as "work" for need-based prioritization, so deferrable
 * maintenance roles wake and re-tick. Tests that pin scheduling-adjacent behavior (config
 * reloads, resets, gates) use it to keep their maintenance roles ticking — the deferral rule
 * itself is pinned in its own test in orchestrator.e2e.test.ts. */
export function landWork(repo: string): void {
  fs.writeFileSync(
    path.join(repo, `work-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
    "work\n",
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "tumwater(feature): test work landing");
}
