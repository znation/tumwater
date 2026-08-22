import fs from "node:fs";
import path from "node:path";
import { defaultConfig, saveConfig } from "./config.js";
import { COMMIT_IDENT, git, gitTry, hasCommits, isGitRepo } from "./git.js";
import { PROMPT_END, PROMPT_START, STATUS_END, STATUS_START } from "./prompt.js";
import { STATE_DIR, configPath } from "./paths.js";

export function readmeTemplate(projectName: string, initialPrompt: string): string {
  return `# ${projectName}

## Initial prompt

${PROMPT_START}
${initialPrompt.trim()}
${PROMPT_END}

## Status

${STATUS_START}
_No status yet. The readme loop keeps this section up to date._
${STATUS_END}
`;
}

export const PLANS_TEMPLATE = `# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

_None yet._

## Done

_None yet._
`;

export const BUGS_TEMPLATE = `# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

_None yet._

## Fixed

_None yet._
`;

/** Add the tumwater state dir to .gitignore if it isn't ignored yet. */
function ensureGitignore(root: string): boolean {
  const file = path.join(root, ".gitignore");
  const entry = `${STATE_DIR}/`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.split("\n").some((l) => l.trim() === entry || l.trim() === STATE_DIR)) return false;
  fs.writeFileSync(file, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + entry + "\n");
  return true;
}

export interface InitResult {
  created: string[];
  committed: boolean;
}

/** Initialize a repo for tumwater: README (with prompt + status), PLANS, BUGS,
 * tumwater.json, .gitignore — then commit whatever was created. */
export async function initProject(root: string, initialPrompt: string): Promise<InitResult> {
  if (!(await isGitRepo(root))) {
    throw new Error(`${root} is not a git repository (run \`git init\` first)`);
  }
  if (!initialPrompt.trim()) {
    throw new Error("an initial prompt is required: tumwater init <prompt | --file prompt.md>");
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
  if (!fs.existsSync(configPath(root))) {
    saveConfig(root, defaultConfig());
    created.push("tumwater.json");
  }
  if (ensureGitignore(root)) created.push(".gitignore");

  let committed = false;
  if (created.length > 0) {
    await git(root, "add", "--", ...created);
    const staged = await gitTry(root, "diff", "--cached", "--quiet");
    if (staged === null) {
      // Non-zero exit = something is staged.
      const message = (await hasCommits(root)) ? "tumwater: init harness files" : "tumwater: init";
      await git(root, ...COMMIT_IDENT, "commit", "-m", message, "--", ...created);
      committed = true;
    }
  }
  return { created, committed };
}
