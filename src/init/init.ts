import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../config/config.js";
import { seedConfig } from "../config/config-example.js";
import { findOnPath } from "../files/files.js";
import { COMMIT_IDENT, GIT_MISSING_MESSAGE, git, gitTry } from "../git/git-run.js";
import { hasCommits, isGitRepo } from "../git/git.js";
import {
  INITIAL_PROMPT_MAX_CHARS,
  PROMPT_END,
  PROMPT_START,
  briefFile,
  briefTemplate,
  readInitialPrompt,
  readmeTemplate,
} from "../readme.js";
import { CONFIG_BASENAME, STATE_DIR, configPath } from "../paths.js";
import { projectName } from "../project-name.js";
import {
  getTemplate,
  BUGS_TEMPLATE,
  PLANS_TEMPLATE,
  PRINCIPLES_TEMPLATE,
  QUESTIONS_TEMPLATE,
  unknownTemplateError,
} from "./init-templates.js";

export { PLANS_TEMPLATE, BUGS_TEMPLATE } from "./init-templates.js";

/** Add both tumwater entries to .gitignore independently — the state dir and the config file —
 * so a .gitignore that already carries one still gains the other (plans/portability.md §4a/7;
 * the old single-entry early return left a pre-existing `.tumwater/` line hiding the config).
 * Returns true when the file changed — or, with `dryRun`, would change (nothing is written). */
function ensureGitignore(root: string, dryRun = false): boolean {
  const file = path.join(root, ".gitignore");
  const wanted = [`${STATE_DIR}/`, CONFIG_BASENAME];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.split("\n").map((l) => l.trim());
  const missing = wanted.filter((e) => !lines.some((l) => l === e || l === e.replace(/\/$/, "")));
  if (missing.length === 0) return false;
  if (dryRun) return true;
  fs.writeFileSync(
    file,
    existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n",
  );
  return true;
}

interface InitResult {
  /** Files init created — or, on a dry run, would create. */
  created: string[];
  /** Files init looked for and found already present, so left byte-identical. */
  leftAlone: string[];
  committed: boolean;
  /** True when the cwd was not a git repository and init created one (on a dry run: would). */
  repoInitialized: boolean;
  /** The branch a newly created repo was seeded on; undefined when the repo already
   * existed (its checked-out branch is the fleet's business, not init's). */
  branch?: string;
  /** True when the brief went to TUMWATER.md and README.md was left untouched
   * (plans/portability.md §7/7) — asked for with `--adopt`, or automatic for a README.md
   * without the tumwater markers. */
  adopted: boolean;
  /** True when nothing was written: `created` is what a real run would create. */
  dryRun: boolean;
  /** The template id the brief and backlog were seeded from — "blank" unless --template named
   * a catalog template (the default, which reproduces the pre-templates output exactly). */
  template: string;
}

/** Initialize a repo for tumwater: README (with prompt + status) when no project brief exists
 * yet, PLANS, BUGS, QUESTIONS, PRINCIPLES, tumwater.json, .gitignore — then commit whatever was
 * created. When the cwd is not a git repository yet, one is seeded first (`git init -b main`),
 * matching the README's "seeds a git repo" promise for brand-new projects. An existing repo
 * whose README.md carries no tumwater markers (or any repo without a brief, with `adopt`) is
 * adopted instead: the brief goes in TUMWATER.md and README.md is never touched. `--branch` seeds a
new repository only and is refused on an existing one, where its value would otherwise be silently
ignored. `dryRun` runs
 * the same validation and computes the same lists, but writes, inits and commits nothing. */
export async function initProject(
  root: string,
  initialPrompt: string,
  branch?: string,
  opts: { adopt?: boolean; dryRun?: boolean; template?: string } = {},
): Promise<InitResult> {
  const dryRun = opts.dryRun === true;
  // Resolve the template before any side effect: an unknown id (possible for direct callers of
  // initProject — the CLI parser already validated its own path) is refused up front, and the
  // template shapes everything below.
  const template = opts.template ? getTemplate(opts.template) : null;
  if (opts.template && !template) {
    throw new Error(unknownTemplateError(opts.template));
  }
  const tpl = template ?? getTemplate("blank")!;
  // The brief records the template's preamble ahead of the operator's words, so their words
  // remain the tail ("latest instruction wins" reads naturally). The combined text rides into
  // every tick's prefill, so it obeys the same cap as a bare prompt — reject before any side
  // effect so an overflowing preamble never lands in README.md.
  const combinedPrompt = tpl.briefPreamble
    ? `${tpl.briefPreamble}\n\n${initialPrompt.trim()}`
    : initialPrompt.trim();
  if (combinedPrompt.length > INITIAL_PROMPT_MAX_CHARS) {
    throw new Error(
      `the initial prompt with the ${tpl.id} template's preamble is ${combinedPrompt.length} chars — shorten it to at most ${INITIAL_PROMPT_MAX_CHARS}: it rides into every tick's prefill`,
    );
  }
  if (!findOnPath("git")) throw new Error(GIT_MISSING_MESSAGE);
  // Validate everything that is pure validation before any side effect, so a bad prompt or
  // README never leaves a half-seeded repo behind.
  const prompt = initialPrompt.trim();
  // A project brief that already carries the prompt makes it optional: a fresh clone of an
  // initialized project, or a checkout that lost its now-untracked tumwater.json
  // (plans/portability.md §4a/7), re-seeds with a bare `tumwater init` — the existing brief
  // file is never rewritten, so a prompt given here must match it (refused below otherwise).
  if (!prompt && combinedPrompt.trim() === "" && readInitialPrompt(root) === "") {
    // A bare init with no prompt is only ever refused for one of two reasons, and they have
    // different fixes: no README (nothing to read — the message below is the whole story) or a
    // README that lacks the managed markers (bare init reads them — name the file and the
    // markers, or the user cannot tell why the README path the not-initialized hint promised
    // did not fire).
    const readmeHint = fs.existsSync(path.join(root, "README.md"))
      ? ` (a bare \`tumwater init\` reads the prompt from README.md between ${PROMPT_START} and ${PROMPT_END}, but README.md carries none)`
      : "";
    throw new Error(
      `an initial prompt is required: tumwater init <prompt | --file prompt.md>${readmeHint}`,
    );
  }
  // `--branch` seeds a NEW repository only: an existing repo's checked-out branch is the
  // fleet's business (`tumwater run --branch` or baseBranch chooses it at runtime), so a
  // --branch given here would otherwise be silently ignored — the exact failure mode
  // rejectUnknownArgs exists to prevent. Fail before any side effect, dry-run included.
  if (branch !== undefined && (await isGitRepo(root))) {
    throw new Error(
      `--branch only seeds a new repository: this directory is already a git repository and init leaves its checked-out branch alone — drop --branch, or point the fleet at a branch with \`tumwater run --branch ${branch}\` (or baseBranch in tumwater.json)`,
    );
  }
  // The loops read the project's reason to exist back out of the project brief on every
  // tick (readInitialPrompt). A README.md without the managed section is the project's own
  // documentation, so it is never rewritten: the repo is adopted instead, with the brief in
  // TUMWATER.md (plans/portability.md §7/7) — the same path `--adopt` asks for explicitly.
  // A brief that is already marked (in either file) wins over both: nothing brief-shaped is
  // written, so a README.md is never created beside a TUMWATER.md that owns the brief.
  const brief = briefFile(root);
  const readmeExists = fs.existsSync(path.join(root, "README.md"));
  const adopted = brief === null && (opts.adopt === true || readmeExists);
  // A TUMWATER.md without the markers is create-if-absent's blind spot: it would be left
  // untouched and the prompt silently dropped — every loop would then run blind. Fail before
  // creating anything so the user fixes it and re-runs.
  if (adopted && fs.existsSync(path.join(root, "TUMWATER.md"))) {
    throw new Error(
      `TUMWATER.md already exists without an initial prompt between the tumwater:prompt markers, so your prompt would be lost — add it to TUMWATER.md between ${PROMPT_START} and ${PROMPT_END} (or delete TUMWATER.md so init creates one), then re-run \`tumwater init\``,
    );
  }
  // The same loss one step later: a brief that already owns the managed sections is never
  // rewritten (init only creates what is absent), so a DIFFERENT prompt given here would be
  // silently dropped while every tick keeps running the old one. Refuse it and name the file
  // that owns the brief — TUMWATER.md resolves ahead of README.md (plans/portability.md §7a/7),
  // so pointing at README.md would send the user to edit a file nobody reads. A re-run with the
  // same prompt, or a bare init, is the idempotent re-seed and passes.
  if (prompt && brief !== null && combinedPrompt !== readInitialPrompt(root)) {
    throw new Error(
      `${brief} already carries a different initial prompt between the tumwater:prompt markers, and init never rewrites an existing project brief, so your prompt would be lost — to change the prompt, edit it in ${brief} between ${PROMPT_START} and ${PROMPT_END}; to re-seed with the current one, re-run a bare \`tumwater init\``,
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
    // A branch name git rejects (a space, a leading dash, "@{…}" history syntax, …) would
    // abort `git init -b` AFTER it has created .git — a half-initialized directory whose
    // re-run then trips the existing-repo refusal above, because .git exists. Validate the
    // name with git's own rule first and refuse before anything is written; the check runs
    // in --dry-run too, so the rehearsal rehearses the failure instead of reporting a
    // branch the real run would die on.
    if ((await gitTry(root, "check-ref-format", "--branch", preferred)) === null) {
      const namedBy =
        branch !== undefined
          ? `--branch ${JSON.stringify(preferred)}`
          : `git config init.defaultBranch ${JSON.stringify(preferred)}`;
      throw new Error(
        `${namedBy} is not a valid git branch name — pick a name like main, trunk, or release/2.0 (git's rules: no spaces, colons, or ~^?*[ characters; no leading/trailing slash or double slash; not a dotted or .lock-suffixed component)`,
      );
    }
    if (!dryRun) await git(root, "init", "-b", preferred);
    repoInitialized = true;
    createdBranch = preferred;
  }

  const created: string[] = [];
  const leftAlone: string[] = [];
  /** Record a template path this run either created (via `make`, under a real run only) or
   * found already present and left alone — the exists → leftAlone / create → created /
   * dryRun → no-op discipline every seeded path below follows, shared by the file and empty-
   * directory writers so their bookkeeping cannot drift. (The brief, adopted-README, config,
   * and .gitignore cases keep their bespoke pushes: each has its own existence rule.) */
  const claim = (name: string, full: string, make: () => void) => {
    if (fs.existsSync(full)) {
      leftAlone.push(name);
      return;
    }
    if (!dryRun) make();
    created.push(name);
  };
  const write = (name: string, content: string) =>
    claim(name, path.join(root, name), () => fs.writeFileSync(path.join(root, name), content));

  // README.md is the brief only when none exists yet and there is no README to adopt (a fresh
  // repo): with TUMWATER.md owning the managed sections, a created README.md would carry a
  // duplicate prompt + status block that readInitialPrompt never reaches and the readme role
  // never maintains.
  const name = projectName(root);
  if (brief !== null) leftAlone.push(brief);
  else if (adopted) {
    if (readmeExists) leftAlone.push("README.md");
    write("TUMWATER.md", briefTemplate(name, combinedPrompt));
  } else write("README.md", readmeTemplate(name, combinedPrompt));
  // A template with starter plans seeds the backlog with them, rendered as `### ` entries —
  // the primary entry format every backlog reader parses — so the fleet's first ticks land on
  // real work. blank keeps the `_None yet._` placeholder byte-identical to today.
  const plansContent =
    tpl.starterPlans.length > 0
      ? PLANS_TEMPLATE.replace(
          "_None yet._",
          tpl.starterPlans.map((p) => `### ${p}`).join("\n\n"),
        )
      : PLANS_TEMPLATE;
  write("PLANS.md", plansContent);
  write("BUGS.md", BUGS_TEMPLATE);
  write("QUESTIONS.md", QUESTIONS_TEMPLATE);
  write("PRINCIPLES.md", PRINCIPLES_TEMPLATE);
  if (fs.existsSync(configPath(root))) leftAlone.push(CONFIG_BASENAME);
  else {
    if (!dryRun) saveConfig(root, seedConfig(root));
    created.push(CONFIG_BASENAME);
  }
  if (ensureGitignore(root, dryRun)) created.push(".gitignore");
  else if (fs.existsSync(path.join(root, ".gitignore"))) leftAlone.push(".gitignore");
  // The template's starter directories: empty ones only, before the first tick — the fleet's
  // own ticks write any code. Existing directories are left alone, like existing files above.
  for (const dir of tpl.starterDirs) {
    claim(dir, path.join(root, dir), () => fs.mkdirSync(path.join(root, dir), { recursive: true }));
  }

  // The config stays out of the commit pathspec: `git add -- tumwater.json` fails on a path
  // the just-written .gitignore ignores (plans/portability.md §4a/7). It still heads the
  // `created …` line the CLI prints — the file WAS created, it just must not be tracked. When
  // that leaves the pathspec empty (`git add --` with no pathspec exits 1), there is nothing
  // to commit: a repo that only gained a config reports it and stays uncommitted.
  const dirSet = new Set(tpl.starterDirs);
  const committable = created.filter((name) => name !== CONFIG_BASENAME && !dirSet.has(name));
  let committed = false;
  if (!dryRun && committable.length > 0) {
    await git(root, "add", "--", ...committable);
    const staged = await gitTry(root, "diff", "--cached", "--quiet");
    if (staged === null) {
      // Non-zero exit = something is staged.
      const message = (await hasCommits(root)) ? "tumwater: init harness files" : "tumwater: init";
      await git(root, ...COMMIT_IDENT, "commit", "-m", message, "--", ...committable);
      committed = true;
    }
  }
  return { created, leftAlone, committed, repoInitialized, branch: createdBranch, adopted, dryRun, template: tpl.id };
}
