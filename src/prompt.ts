import fs from "node:fs";
import path from "node:path";
import type { Role } from "./roles.js";

/** Sentinel a loop's pi run outputs when it found nothing worth doing. */
export const NOTHING_TO_DO = "AUTOMATON_NOTHING_TO_DO";

export const PROMPT_START = "<!-- automaton:prompt:start -->";
export const PROMPT_END = "<!-- automaton:prompt:end -->";
export const STATUS_START = "<!-- automaton:status:start -->";
export const STATUS_END = "<!-- automaton:status:end -->";

/** The project's initial prompt, extracted from README.md's managed section. */
export function readInitialPrompt(root: string): string {
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) return "";
  const text = fs.readFileSync(readme, "utf8");
  const start = text.indexOf(PROMPT_START);
  const end = text.indexOf(PROMPT_END);
  if (start < 0 || end < 0 || end < start) return "";
  return text.slice(start + PROMPT_START.length, end).trim();
}

const COMMON_RULES = `
Rules for this run:
- First read README.md, PLANS.md, and BUGS.md (those that exist) to understand the project.
- Do exactly ONE focused task, then stop. Small, complete, and correct beats big and half-done.
- Leave the project working: if it has a build or test command, run it and fix what you broke.
- Never create, amend, or revert git commits, branches, or merges — the harness handles all git
  operations. Reading git history is fine.
- Never touch the .automaton directory or automaton.json.
- Never edit the initial prompt block in README.md (between the automaton:prompt markers).
- If you find nothing worth doing for your role right now, make no changes and reply with the
  single line ${NOTHING_TO_DO} instead.
- If you did make changes, end your reply with a line in exactly this form:
  SUMMARY: <imperative one-line description of the change, at most 72 characters>`;

export interface TickPromptInput {
  role: Role;
  initialPrompt: string;
  extraInstructions?: string;
}

/** The full prompt for one role-loop tick. */
export function buildTickPrompt(input: TickPromptInput): string {
  const { role, initialPrompt, extraInstructions } = input;
  const parts = [
    `You are the "${role.id}" loop (${role.title}) of automaton, an autonomous development harness.`,
    `You work in a dedicated git worktree of this project; your changes will be committed and merged to main by the harness after you finish.`,
  ];
  if (initialPrompt) {
    parts.push(`The project's initial prompt — its reason to exist — is:\n<project-prompt>\n${initialPrompt}\n</project-prompt>`);
  }
  parts.push(`Your task this run:\n${role.find.trim()}`);
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  parts.push(COMMON_RULES.trim());
  return parts.join("\n\n");
}

/** The prompt for a director tick, which routes a user request into the project. */
export function buildDirectorPrompt(userPrompt: string, initialPrompt: string): string {
  const parts = [
    `You are the "director" loop of automaton, an autonomous development harness. The user steers
the project by sending it requests; one has just arrived. Other specialist loops continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    `You work in a dedicated git worktree of this project; your changes will be committed and merged to main by the harness after you finish.`,
  ];
  if (initialPrompt) {
    parts.push(`The project's initial prompt — its reason to exist — is:\n<project-prompt>\n${initialPrompt}\n</project-prompt>`);
  }
  parts.push(`The user's request:\n<user-request>\n${userPrompt.trim()}\n</user-request>`);
  parts.push(
    `Interpret the request as a project-level command and route it — do NOT implement substantial
work yourself:
- A feature request or substantial change: write a concrete plan for it in PLANS.md (goal,
  approach, files touched, acceptance criteria) so the feature loop implements it. Do not build
  it now.
- A bug report: record it in BUGS.md (symptom, how to reproduce, suspected cause — investigate
  briefly to sharpen the report) so the bugfix loop fixes it. Do not fix it now.
- Guidance, a decision, or a constraint (e.g. "prefer X", "drop feature Y"): record it durably
  where future loops will see it — README.md, PLANS.md, or BUGS.md as appropriate — and remove
  anything it supersedes.
- A question: answer it in your final reply, and record anything durable it surfaced.
- Only a trivially small direct edit (fix a typo, tweak a doc line, adjust a config value the
  user explicitly stated) may be done immediately instead of routed.`,
  );
  parts.push(COMMON_RULES.trim());
  return parts.join("\n\n");
}

/** The prompt for resolving merge conflicts left in a loop's worktree. */
export function buildConflictPrompt(roleId: string, files: string[]): string {
  return `You are the "${roleId}" loop of automaton, an autonomous development harness. A git merge
of main into your work branch stopped on conflicts; the conflict markers are sitting in the
worktree now. Resolve them.

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

Resolve every conflict marker (<<<<<<<, =======, >>>>>>>) by combining the intent of BOTH sides:
"ours" is this branch's change, "theirs" is the latest main. Do not simply pick one side unless
the two changes are genuinely alternatives. Keep the project building and its tests passing.

Rules for this run:
- Edit files only. Never run any git command that changes state (no add, commit, merge, reset,
  checkout) — the harness concludes the merge for you. Reading git state is fine.
- Never touch the .automaton directory or automaton.json.
- When every marker is resolved and the project is consistent, just stop.`;
}

/** Pull the SUMMARY: line out of a pi final reply; null when absent. */
export function extractSummary(finalText: string): string | null {
  const match = finalText.match(/^\s*SUMMARY:\s*(.+)\s*$/m);
  if (!match?.[1]) return null;
  return match[1].trim().slice(0, 100);
}

/** True when the reply declares there was nothing to do. */
export function isNothingToDo(finalText: string): boolean {
  return finalText.includes(NOTHING_TO_DO);
}
