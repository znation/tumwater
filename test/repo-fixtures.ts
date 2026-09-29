/** The git-repo and project-dir fixtures tests stand their scenarios on: the per-process
 * temp root (tmpdir), raw shell plumbing (sh), makeRepo / initializedRepo (a repo, plain or
 * run through initProject), worktreeAt (a linked role worktree), writeConfig (a seeded
 * tumwater.json), and landWork (a commit on main that counts as work for the deferral rule).
 * Split from the old util.ts grab-bag, now dissolved into the topic-named modules
 * (oracles.ts, log-fixtures.ts, loop-fixtures.ts, gui-fixtures.ts); the live-orchestrator,
 * fake-pi, and fake-command families live in their own modules (orchestrator-fixtures.ts,
 * fake-pi.ts, fake-commands.ts). The dependency runs one way: the other test modules and
 * the tests import from here; this module never imports them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/init.js";
import { ensureParentDir } from "../src/files.js";

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

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trimEnd();
}

/** main's current commit sha — the head every "did this landing move main" assertion captures
 * before acting and re-reads after (lander, drain, merge, baseline, review, loop tests), so the
 * pinned-ref spelling cannot drift between them and a typo'd ref fails in one place. */
export function mainSha(dir: string): string {
  return sh(dir, "git", "rev-parse", "main");
}

/** A scratch bin dir whose only entry is a symlink to the real git: a restricted PATH that
 * keeps git working (repo checks, landing, the worktree helpers) while dropping every other
 * binary — pi, npm — so a test can isolate exactly one missing tool. Tests that need the dir
 * to stay findable in failures pass a distinctive `prefix`. */
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

/** Seed a fixture's tumwater.json with the given (partial) config: the project config file's
 * name and write convention live here, so a test states only the keys under test. Fixtures
 * that deliberately write torn or invalid JSON keep their own raw writeFileSync. */
export function writeConfig(dir: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify(value));
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
