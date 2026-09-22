import fs from "node:fs";
import path from "node:path";
import { saveConfig, seedConfig } from "./config.js";
import { findOnPath } from "./files.js";
import { GIT_MISSING_MESSAGE, COMMIT_IDENT, git, gitTry, hasCommits, isGitRepo } from "./git.js";
import {
  INITIAL_PROMPT_MAX_CHARS,
  PROMPT_END,
  PROMPT_START,
  readInitialPrompt,
  readmeTemplate,
} from "./readme.js";
import { CONFIG_BASENAME, STATE_DIR, configPath } from "./paths.js";

const PLANS_TEMPLATE = `# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

_None yet._

## Done

_None yet._
`;

const BUGS_TEMPLATE = `# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed, with the
required \`**Validation gap:** <tag> — <one sentence>\` line recording what made the bug hard to
confirm (tag one of: none, no-repro, no-fake, real-run-needed, no-observability, slow-check,
unclear-invariant).

## Open

_None yet._

## Fixed

_None yet._
`;

const QUESTIONS_TEMPLATE = `# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

_None yet._

## Answered

_None yet._
`;

const PRINCIPLES_TEMPLATE = `# Principles

Design principles this project holds — the codified answer to "what would a senior engineer on
this team always do." Every loop's prompt carries these; uphold them in everything you produce.
Only the director and steward roles may edit this file. Phrase new principles positively: state
what to do, not what to avoid.

- Prefer the standard library over a new dependency.
- Keep every module under ~500 lines; split when it grows past that.
- Every behavior change ships with a test.
- Small, complete, and correct beats big and half-done: one focused change per tick.
`;

/** Add both tumwater entries to .gitignore independently — the state dir and the config file —
 * so a .gitignore that already carries one still gains the other (plans/portability.md §4a/7;
 * the old single-entry early return left a pre-existing `.tumwater/` line hiding the config).
 * Returns true when the file changed. */
function ensureGitignore(root: string): boolean {
  const file = path.join(root, ".gitignore");
  const wanted = [`${STATE_DIR}/`, CONFIG_BASENAME];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.split("\n").map((l) => l.trim());
  const missing = wanted.filter((e) => !lines.some((l) => l === e || l === e.replace(/\/$/, "")));
  if (missing.length === 0) return false;
  fs.writeFileSync(
    file,
    existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n",
  );
  return true;
}

interface InitResult {
  created: string[];
  committed: boolean;
  /** True when the cwd was not a git repository and init created one. */
  repoInitialized: boolean;
  /** The branch a newly created repo was seeded on; undefined when the repo already
   * existed (its checked-out branch is the fleet's business, not init's). */
  branch?: string;
}

/** Initialize a repo for tumwater: README (with prompt + status), PLANS, BUGS, QUESTIONS,
 * PRINCIPLES, tumwater.json, .gitignore — then commit whatever was created. When the cwd is
 * not a git repository yet, one is seeded first (`git init -b main`), matching the README's
 * "seeds a git repo" promise for brand-new projects. */
export async function initProject(
  root: string,
  initialPrompt: string,
  branch?: string,
): Promise<InitResult> {
  // Fail fast on a missing binary before the probe below can misread it as "not a git
  // repository" — the same preflight every other command gets in cli.ts.
  if (!findOnPath("git")) throw new Error(GIT_MISSING_MESSAGE);
  // Validate everything that is pure validation before any side effect, so a bad prompt or
  // README never leaves a half-seeded repo behind.
  const prompt = initialPrompt.trim();
  if (!prompt) {
    throw new Error("an initial prompt is required: tumwater init <prompt | --file prompt.md>");
  }
  // The prompt rides into every tick's and director's prefill (readInitialPrompt), so an
  // unbounded one is a standing per-tick cost — the same reason customLoops.task and
  // roles.<id>.instructions are capped. Reject before any side effect so a too-long prompt
  // never lands in README.md and is never committed.
  if (prompt.length > INITIAL_PROMPT_MAX_CHARS) {
    throw new Error(
      `the initial prompt is ${prompt.length} chars — shorten it to at most ${INITIAL_PROMPT_MAX_CHARS}: it rides into every tick's prefill`,
    );
  }
  // The loops read the project's reason to exist back out of README.md on every tick
  // (readInitialPrompt). If a README already exists without the managed section, it would be
  // left untouched and the prompt silently dropped — every loop would then run blind. Fail
  // before creating anything so the user fixes the README and re-runs.
  if (fs.existsSync(path.join(root, "README.md")) && readInitialPrompt(root) === "") {
    throw new Error(
      `README.md already exists without an initial prompt between the tumwater:prompt markers, so your prompt would be lost — add it to README.md between ${PROMPT_START} and ${PROMPT_END} (or delete README.md so init creates one), then re-run \`tumwater init\``,
    );
  }

  let repoInitialized = false;
  let createdBranch: string | undefined;
  if (!(await isGitRepo(root))) {
    // Branch precedence: the caller's explicit --branch, else git's own init.defaultBranch
    // preference, else main. `git init -b` does not consult init.defaultBranch, so the
    // preference is read here: an operator who configured `init.defaultBranch=trunk`
    // expects `git init`-compatible behavior, and the fleet then targets that branch.
    const preferred =
      branch ?? ((await gitTry(root, "config", "--get", "init.defaultBranch")) || "main");
    await git(root, "init", "-b", preferred);
    repoInitialized = true;
    createdBranch = preferred;
  }

  const created: string[] = [];
  const write = (name: string, content: string) => {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, content);
    created.push(name);
  };

  write("README.md", readmeTemplate(path.basename(path.resolve(root)), initialPrompt));
  write("PLANS.md", PLANS_TEMPLATE);
  write("BUGS.md", BUGS_TEMPLATE);
  write("QUESTIONS.md", QUESTIONS_TEMPLATE);
  write("PRINCIPLES.md", PRINCIPLES_TEMPLATE);
  if (!fs.existsSync(configPath(root))) {
    saveConfig(root, seedConfig(root));
    created.push(CONFIG_BASENAME);
  }
  if (ensureGitignore(root)) created.push(".gitignore");

  // The config stays out of the commit pathspec: `git add -- tumwater.json` fails on a path
  // the just-written .gitignore ignores (plans/portability.md §4a/7). It still heads the
  // `created …` line the CLI prints — the file WAS created, it just must not be tracked. When
  // that leaves the pathspec empty (`git add --` with no pathspec exits 1), there is nothing
  // to commit: a repo that only gained a config reports it and stays uncommitted.
  const committable = created.filter((name) => name !== CONFIG_BASENAME);
  let committed = false;
  if (committable.length > 0) {
    await git(root, "add", "--", ...committable);
    const staged = await gitTry(root, "diff", "--cached", "--quiet");
    if (staged === null) {
      // Non-zero exit = something is staged.
      const message = (await hasCommits(root)) ? "tumwater: init harness files" : "tumwater: init";
      await git(root, ...COMMIT_IDENT, "commit", "-m", message, "--", ...committable);
      committed = true;
    }
  }
  return { created, committed, repoInitialized, branch: createdBranch };
}
