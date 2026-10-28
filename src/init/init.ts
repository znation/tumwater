import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../config/config.js";
import { seedConfig } from "../config/config-example.js";
import { ensureDir, findOnPath, writeTextAtomic } from "../files/files.js";
import { GIT_MISSING_MESSAGE, commitAuthorArgs, committerIdentArgs, git, gitTry } from "../git/git-run.js";
import { hasCommits, isGitRepo } from "../git/git.js";
import {
  BRIEF_TEXT_MAX_CHARS,
  PROMPT_END,
  PROMPT_START,
  briefFile,
  briefTemplate,
  readBriefText,
  readmeTemplate,
} from "../brief/brief.js";
import { teamWorkspaceMessage } from "../gates/readiness.js";
import { CONFIG_BASENAME, STATE_DIR, configPath, owningTeamRoot } from "../paths.js";
import { projectName } from "../project-name.js";
import { tooLongMessage } from "../text/text.js";
import { PREFILL_REASON } from "../text/phrases.js";
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
  writeTextAtomic(
    file,
    existing + (existing && !existing.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n",
  );
  return true;
}

/** New-project bootstrap (plans/work-ratio.md, "New-project bootstrap"): the plan count a
 * fresh project's config is seeded with. */
const BOOTSTRAP_PLANS = 5;

/** Names `tumwater init` itself seeds at the repo root — a project holding nothing but these is
 * "fresh" for bootstrap detection. A license (any `LICENSE*` spelling) counts too, so a repo
 * with only a license and a README is still fresh. */
const SCAFFOLDING_FILES = new Set([
  ".gitignore",
  "README.md",
  "TUMWATER.md",
  "PLANS.md",
  "BUGS.md",
  "QUESTIONS.md",
  "PRINCIPLES.md",
  "tumwater.json",
]);

/** True when `rel` (a repo-relative path git listed) is one of init's own root-level files, so
 * it does not make the project established. A same-named file below the root is the project's
 * own and counts as code. */
function isScaffoldingPath(rel: string): boolean {
  if (path.posix.dirname(rel) !== ".") return false;
  const base = path.posix.basename(rel);
  return SCAFFOLDING_FILES.has(base) || /^LICENSE(?:[.-].*)?$/i.test(base);
}

/** Whether `root` has a project of its own yet: not a git repo, a repo with no commits, or a
 * repo whose tracked and untracked-non-ignored files are all init's scaffolding. Drives the
 * bootstrap seed — a project created from nothing runs plan and feature before the maintenance
 * roles (plans/work-ratio.md, part 2/2). `withCommits` is whether `root` is a repo with at least
 * one commit, which initProject has already established. One `ls-files -co` lists the tracked
 * files and the untracked non-ignored ones together (the exclude rules filter only the
 * untracked side). */
async function isFreshProject(root: string, withCommits: boolean): Promise<boolean> {
  if (!withCommits) return true;
  const listed = ((await gitTry(root, "ls-files", "--cached", "--others", "--exclude-standard")) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return listed.every(isScaffoldingPath);
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
   * existed (its checked-out branch is the team's business, not init's). */
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
  /** The plan count the config's `bootstrap.untilPlansDone` was seeded with, when init found a
   * fresh project and created tumwater.json; null otherwise. */
  bootstrap: number | null;
}

/** What `resolveInitPlan` settled about the request before any side effect, so `seedProject`
 * can act on it without re-asking anything. */
interface InitPlan {
  /** True when nothing may be written, initted or committed. */
  dryRun: boolean;
  /** The resolved template — the brief preamble, starter plans and starter dirs come from it. */
  tpl: NonNullable<ReturnType<typeof getTemplate>>;
  /** The template's preamble joined with the operator's words, capped by BRIEF_TEXT_MAX_CHARS. */
  combinedPrompt: string;
  /** The brief file that already owns the managed brief sections, null when none does. */
  brief: string | null;
  /** Whether README.md exists at `root`. */
  readmeExists: boolean;
  /** True when the brief goes to TUMWATER.md and README.md is left untouched. */
  adopted: boolean;
  /** Whether `root` was already a git repository before this run. */
  wasRepo: boolean;
  /** The branch `git init -b` will use; set only when a new repo is seeded (`!wasRepo`). */
  preferredBranch: string | undefined;
}

/** The single job this helper owns: resolve the template up front, refusing an unknown id and
 * defaulting to the blank template (INV-Q1: before any side effect). */
function resolveInitTemplate(id: string | undefined): NonNullable<ReturnType<typeof getTemplate>> {
  // Resolve the template before any side effect: an unknown id (possible for direct callers of
  // initProject — the CLI parser already validated its own path) is refused up front, and the
  // template shapes everything below.
  const template = id ? getTemplate(id) : null;
  if (id && !template) {
    throw new Error(unknownTemplateError(id));
  }
  return template ?? getTemplate("blank")!;
}

/** The single job this helper owns: join the template's preamble with the operator's words and
 * enforce the brief cap (INV-Q1: before any side effect). */
function combineInitBrief(
  tpl: NonNullable<ReturnType<typeof getTemplate>>,
  briefText: string,
): string {
  // The brief records the template's preamble ahead of the operator's words, so their words
  // remain the tail ("latest instruction wins" reads naturally). The combined text rides into
  // every run's prefill, so it obeys the same cap as a bare prompt — reject before any side
  // effect so an overflowing preamble never lands in README.md.
  const combinedPrompt = tpl.briefPreamble
    ? `${tpl.briefPreamble}\n\n${briefText.trim()}`
    : briefText.trim();
  if (combinedPrompt.length > BRIEF_TEXT_MAX_CHARS) {
    throw new Error(
      tooLongMessage(
        `the brief with the ${tpl.id} template's preamble`,
        combinedPrompt.length,
        BRIEF_TEXT_MAX_CHARS,
        PREFILL_REASON,
      ),
    );
  }
  return combinedPrompt;
}

/** The single job this helper owns: refuse when `git` is missing from PATH (INV-Q1: before any
 * side effect). */
function requireGitOnPath(): void {
  if (!findOnPath("git")) throw new Error(GIT_MISSING_MESSAGE);
}

/** The single job this helper owns: refuse when `root` sits inside a team workspace (INV-Q1:
 * before any side effect). */
function refuseTeamWorkspace(root: string): void {
  // A team workspace is not a project: seeding it would commit tumwater.json and a phantom
  // .tumwater on the role's branch. Refused before any side effect, dry run included.
  const owner = owningTeamRoot(root);
  if (owner !== undefined) throw new Error(teamWorkspaceMessage(owner));
}

/** The single job this helper owns: refuse a bare init that has no prompt to read anywhere
 * (INV-Q1: before any side effect). */
function refuseMissingBrief(root: string, prompt: string, combinedPrompt: string): void {
  // A project brief that already carries the prompt makes it optional: a fresh clone of an
  // initialized project, or a checkout that lost its now-untracked tumwater.json
  // (plans/portability.md §4a/7), re-seeds with a bare `tumwater init` — the existing brief
  // file is never rewritten, so a prompt given here must match it (refused below otherwise).
  if (!prompt && combinedPrompt.trim() === "" && readBriefText(root) === "") {
    // A bare init with no prompt is only ever refused for one of two reasons, and they have
    // different fixes: no README (nothing to read — the message below is the whole story) or a
    // README that lacks the managed markers (bare init reads them — name the file and the
    // markers, or the user cannot tell why the README path the not-initialized hint promised
    // did not fire).
    const readmeHint = fs.existsSync(path.join(root, "README.md"))
      ? ` (a bare \`tumwater init\` reads the prompt from README.md between ${PROMPT_START} and ${PROMPT_END}, but README.md carries none)`
      : "";
    throw new Error(
      `a brief is required: tumwater init <prompt | --file prompt.md>${readmeHint}`,
    );
  }
}

/** The single job this helper owns: answer whether `root` is already a git repo, refusing
 * `--branch` on one (INV-Q1: before any side effect). */
async function resolveInitWasRepo(root: string, branch: string | undefined): Promise<boolean> {
  // `--branch` seeds a NEW repository only: an existing repo's checked-out branch is the
  // team's business (`tumwater start --branch` or baseBranch chooses it at runtime), so a
  // --branch given here would otherwise be silently ignored — the exact failure mode
  // rejectUnknownArgs exists to prevent. Fail before any side effect, dry-run included.
  // Whether `root` already is a repo is asked once here; nothing below until the `git init`
  // can change it.
  const wasRepo = await isGitRepo(root);
  if (branch !== undefined && wasRepo) {
    throw new Error(
      `--branch only seeds a new repository: this directory is already a git repository and init leaves its checked-out branch alone — drop --branch, or point the team at a branch with \`tumwater start --branch ${branch}\` (or baseBranch in tumwater.json)`,
    );
  }
  return wasRepo;
}

/** The single job this helper owns: decide adoption — whether the brief goes to TUMWATER.md and
 * README.md is left untouched — refusing an unmarked TUMWATER.md (INV-Q1: before any side
 * effect). */
function resolveInitAdoption(
  root: string,
  opts: { adopt?: boolean; dryRun?: boolean; template?: string },
): { brief: string | null; readmeExists: boolean; adopted: boolean } {
  // The roles read the project's reason to exist back out of the project brief on every
  // run (readBriefText). A README.md without the managed section is the project's own
  // documentation, so it is never rewritten: the repo is adopted instead, with the brief in
  // TUMWATER.md (plans/portability.md §7/7) — the same path `--adopt` asks for explicitly.
  // A brief that is already marked (in either file) wins over both: nothing brief-shaped is
  // written, so a README.md is never created beside a TUMWATER.md that owns the brief.
  const brief = briefFile(root);
  const readmeExists = fs.existsSync(path.join(root, "README.md"));
  const adopted = brief === null && (opts.adopt === true || readmeExists);
  // A TUMWATER.md without the markers is create-if-absent's blind spot: it would be left
  // untouched and the prompt silently dropped — every role would then run blind. Fail before
  // creating anything so the user fixes it and re-runs.
  if (adopted && fs.existsSync(path.join(root, "TUMWATER.md"))) {
    throw new Error(
      `TUMWATER.md already exists without a brief between the tumwater:prompt markers, so your prompt would be lost — add it to TUMWATER.md between ${PROMPT_START} and ${PROMPT_END} (or delete TUMWATER.md so init creates one), then re-run \`tumwater init\``,
    );
  }
  return { brief, readmeExists, adopted };
}

/** The single job this helper owns: refuse a changed prompt when a brief already owns the
 * managed sections (INV-Q1: before any side effect). */
function refuseChangedBrief(
  root: string,
  brief: string | null,
  prompt: string,
  combinedPrompt: string,
): void {
  // The same loss one step later: a brief that already owns the managed sections is never
  // rewritten (init only creates what is absent), so a DIFFERENT prompt given here would be
  // silently dropped while every run keeps running the old one. Refuse it and name the file
  // that owns the brief — TUMWATER.md resolves ahead of README.md (plans/portability.md §7a/7),
  // so pointing at README.md would send the user to edit a file nobody reads. A re-run with the
  // same prompt, or a bare init, is the idempotent re-seed and passes.
  if (prompt && brief !== null && combinedPrompt !== readBriefText(root)) {
    throw new Error(
      `${brief} already carries a different brief between the tumwater:prompt markers, and init never rewrites an existing project brief, so your prompt would be lost — to change the prompt, edit it in ${brief} between ${PROMPT_START} and ${PROMPT_END}; to re-seed with the current one, re-run a bare \`tumwater init\``,
    );
  }
}

/** The single job this helper owns: resolve and validate the new-repo branch, last, only when a
 * repo will be seeded (INV-Q1: before any side effect). */
async function resolveInitPreferredBranch(
  root: string,
  branch: string | undefined,
  wasRepo: boolean,
): Promise<string | undefined> {
  // Last, resolve the new-repo branch — only when a repo will be seeded — and validate it with
  // git's own rule before any side effect, dry run included.
  let preferredBranch: string | undefined;
  if (!wasRepo) {
    // Branch precedence: the caller's explicit --branch, else git's own init.defaultBranch
    // preference, else main. `git init -b` does not consult init.defaultBranch, so the
    // preference is read here: an operator who configured `init.defaultBranch=trunk`
    // expects `git init`-compatible behavior, and the team then targets that branch.
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
    preferredBranch = preferred;
  }
  return preferredBranch;
}

/** Validate an init request and resolve everything it needs, in the existing order, with no
 * write, no `git init`, no `created`/`leftAlone` allocation and no commit — every refusal
 * an over-long brief, `--branch` on an existing repo, an invalid branch name or a team
 * workspace (INV-Q1) throws here, ahead of any side effect, dry run included. The new-repo
 * branch is validated last (only when a repo will be seeded) so the invalid-branch refusal
 * still precedes any write. The body composes the named validation jobs in their invocation
 * order (the template resolve, the brief cap, the git check, the team-workspace refusal, the
 * missing-brief refusal, the `--branch`-on-an-existing-repo refusal, the adoption resolve,
 * the changed-brief refusal and the preferred-branch resolve), so each job is found by name;
 * every refusal still throws before any side effect (INV-Q1). Returns the resolved plan for
 * `seedProject` to act on. */
async function resolveInitPlan(
  root: string,
  briefText: string,
  branch: string | undefined,
  opts: { adopt?: boolean; dryRun?: boolean; template?: string },
): Promise<InitPlan> {
  const dryRun = opts.dryRun === true;
  const tpl = resolveInitTemplate(opts.template);
  const combinedPrompt = combineInitBrief(tpl, briefText);
  requireGitOnPath();
  refuseTeamWorkspace(root);
  const prompt = briefText.trim();
  refuseMissingBrief(root, prompt, combinedPrompt);
  const wasRepo = await resolveInitWasRepo(root, branch);
  const { brief, readmeExists, adopted } = resolveInitAdoption(root, opts);
  refuseChangedBrief(root, brief, prompt, combinedPrompt);
  const preferredBranch = await resolveInitPreferredBranch(root, branch, wasRepo);
  return { dryRun, tpl, combinedPrompt, brief, readmeExists, adopted, wasRepo, preferredBranch };
}

/** The `created`/`leftAlone` bookkeeping and the `claim`/`write` writer pair, shared by every
 * seeded path so the file and empty-directory writers' bookkeeping cannot drift. */
interface SeedWriters {
  created: string[];
  leftAlone: string[];
  claim(name: string, full: string, make: () => void): void;
  write(name: string, content: string): void;
}

/** The `created`/`leftAlone` arrays and the `claim`/`write` closures above them. */
function seedWriters(root: string, dryRun: boolean): SeedWriters {
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
  // Atomic (writeTextAtomic's tmp + rename), like every other writer of a tracked file: a
  // process killed mid-write must leave no partial README/PLANS/BUGS/QUESTIONS/PRINCIPLES,
  // because claim's existsSync would then treat the torn file as complete on a re-run and
  // never repair it.
  const write = (name: string, content: string) =>
    claim(name, path.join(root, name), () => writeTextAtomic(path.join(root, name), content));
  return { created, leftAlone, claim, write };
}

/** The new-repo `git init` job: seed the preferred branch unless the run is a dry run. */
async function initSeedRepo(
  root: string,
  plan: InitPlan,
): Promise<{ repoInitialized: boolean; createdBranch: string | undefined }> {
  let repoInitialized = false;
  let createdBranch: string | undefined;
  if (!plan.wasRepo) {
    if (!plan.dryRun) await git(root, "init", "-b", plan.preferredBranch!);
    repoInitialized = true;
    createdBranch = plan.preferredBranch;
  }
  return { repoInitialized, createdBranch };
}

/** Whether `root` is a fresh project and the repo has commits — decided before any project
 * file is written (init only seeds bootstrap on a fresh project). A repo the `git init`
 * above just created (or a dry run would) has no commits, and init itself commits nothing
 * before the end, so this one answer also picks the commit message. */
async function resolveSeedFreshness(
  root: string,
  plan: InitPlan,
): Promise<{ withCommits: boolean; fresh: boolean }> {
  const withCommits = plan.wasRepo && (await hasCommits(root));
  const fresh = await isFreshProject(root, withCommits);
  return { withCommits, fresh };
}

/** Where the brief goes: the existing brief file, TUMWATER.md (adopted), or README.md. */
function seedBriefFile(root: string, plan: InitPlan, writers: SeedWriters): void {
  // README.md is the brief only when none exists yet and there is no README to adopt (a fresh
  // repo): with TUMWATER.md owning the managed sections, a created README.md would carry a
  // duplicate prompt + status block that readBriefText never reaches and the readme role
  // never maintains.
  const name = projectName(root);
  if (plan.brief !== null) writers.leftAlone.push(plan.brief);
  else if (plan.adopted) {
    if (plan.readmeExists) writers.leftAlone.push("README.md");
    writers.write("TUMWATER.md", briefTemplate(name, plan.combinedPrompt));
  } else writers.write("README.md", readmeTemplate(name, plan.combinedPrompt));
}

/** The template backlog files: PLANS/BUGS/QUESTIONS/PRINCIPLES, with starter-plans subst. */
function seedBacklogFiles(tpl: InitPlan["tpl"], writers: SeedWriters): void {
  // A template with starter plans seeds the backlog with them, rendered as `### ` entries —
  // the primary entry format every backlog reader parses — so the team's first runs land on
  // real work. blank keeps the `_None yet._` placeholder byte-identical to today.
  const plansContent =
    tpl.starterPlans.length > 0
      ? PLANS_TEMPLATE.replace(
          "_None yet._",
          tpl.starterPlans.map((p) => `### ${p}`).join("\n\n"),
        )
      : PLANS_TEMPLATE;
  writers.write("PLANS.md", plansContent);
  writers.write("BUGS.md", BUGS_TEMPLATE);
  writers.write("QUESTIONS.md", QUESTIONS_TEMPLATE);
  writers.write("PRINCIPLES.md", PRINCIPLES_TEMPLATE);
}

/** The config seed and its fresh-project bootstrap; returns the seeded bootstrap count. */
function seedConfigFile(
  root: string,
  fresh: boolean,
  dryRun: boolean,
  writers: SeedWriters,
): number | null {
  let bootstrap: number | null = null;
  if (fs.existsSync(configPath(root))) writers.leftAlone.push(CONFIG_BASENAME);
  else {
    const seed = seedConfig(root);
    if (fresh) {
      seed.bootstrap = { untilPlansDone: BOOTSTRAP_PLANS };
      bootstrap = BOOTSTRAP_PLANS;
    }
    if (!dryRun) saveConfig(root, seed);
    writers.created.push(CONFIG_BASENAME);
  }
  return bootstrap;
}

/** The .gitignore edit: gain the missing lines, or record it as left alone. */
function seedGitignore(root: string, dryRun: boolean, writers: SeedWriters): void {
  if (ensureGitignore(root, dryRun)) writers.created.push(".gitignore");
  else if (fs.existsSync(path.join(root, ".gitignore"))) writers.leftAlone.push(".gitignore");
}

/** The template's starter directories — empty ones only, before the first run. */
function seedStarterDirs(root: string, tpl: InitPlan["tpl"], writers: SeedWriters): void {
  // The template's starter directories: empty ones only, before the first run — the team's
  // own runs write any code. Existing directories are left alone, like existing files above.
  for (const dir of tpl.starterDirs) {
    writers.claim(dir, path.join(root, dir), () => ensureDir(path.join(root, dir)));
  }
}

/** What gets committed: the committable filter and the `git add` / staged-check / commit. */
async function commitSeeded(
  root: string,
  plan: InitPlan,
  withCommits: boolean,
  writers: SeedWriters,
): Promise<boolean> {
  // The config stays out of the commit pathspec: `git add -- tumwater.json` fails on a path
  // the just-written .gitignore ignores (plans/portability.md §4a/7). It still heads the
  // `created …` line the CLI prints — the file WAS created, it just must not be tracked. When
  // that leaves the pathspec empty (`git add --` with no pathspec exits 1), there is nothing
  // to commit: a repo that only gained a config reports it and stays uncommitted.
  const dirSet = new Set(plan.tpl.starterDirs);
  const committable = writers.created.filter(
    (name) => name !== CONFIG_BASENAME && !dirSet.has(name),
  );
  let committed = false;
  if (!plan.dryRun && committable.length > 0) {
    await git(root, "add", "--", ...committable);
    const staged = await gitTry(root, "diff", "--cached", "--quiet");
    if (staged === null) {
      // Non-zero exit = something is staged.
      const message = withCommits ? "tumwater: init files" : "tumwater: init";
      await git(
        root,
        ...(await committerIdentArgs(root)),
        "commit",
        ...commitAuthorArgs(),
        "-m",
        message,
        "--",
        ...committable,
      );
      committed = true;
    }
  }
  return committed;
}

/** Seed `root` from a resolved `InitPlan`: git init (a new repo only), every absent project
 * file and starter directory, the config, and the commit. Holds the `created`/`leftAlone`
 * bookkeeping locally; performs no validation and never refuses. Returns everything the
 * composed `InitResult` needs except `adopted`, `dryRun` and `template`, which `initProject`
 * reads off `plan`. */
async function seedProject(
  root: string,
  plan: InitPlan,
): Promise<
  Pick<InitResult, "created" | "leftAlone" | "committed" | "repoInitialized" | "branch" | "bootstrap">
> {
  const { dryRun, tpl } = plan;
  const { repoInitialized, createdBranch } = await initSeedRepo(root, plan);
  const { withCommits, fresh } = await resolveSeedFreshness(root, plan);
  const writers = seedWriters(root, dryRun);
  seedBriefFile(root, plan, writers);
  seedBacklogFiles(tpl, writers);
  const bootstrap = seedConfigFile(root, fresh, dryRun, writers);
  seedGitignore(root, dryRun, writers);
  seedStarterDirs(root, tpl, writers);
  const committed = await commitSeeded(root, plan, withCommits, writers);
  return {
    created: writers.created,
    leftAlone: writers.leftAlone,
    committed,
    repoInitialized,
    branch: createdBranch,
    bootstrap,
  };
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
  briefText: string,
  branch?: string,
  opts: { adopt?: boolean; dryRun?: boolean; template?: string } = {},
): Promise<InitResult> {
  const plan = await resolveInitPlan(root, briefText, branch, opts);
  const seeded = await seedProject(root, plan);
  return { ...seeded, adopted: plan.adopted, dryRun: plan.dryRun, template: plan.tpl.id };
}
