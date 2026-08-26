import { DECOMPOSITION_GUIDANCE, type Role } from "./roles.js";

/** Sentinel a loop's pi run outputs when it found nothing worth doing. */
export const NOTHING_TO_DO = "TUMWATER_NOTHING_TO_DO";

const COMMON_RULES = `
Rules for this run:
- First read README.md, PLANS.md, and BUGS.md (those that exist) to understand the project.
- Do exactly ONE focused task, then stop. Small, complete, and correct beats big and half-done.
- Leave the project working: if it has a build or test command, run it and fix what you broke.
- Never create, amend, or revert git commits, branches, or merges — the harness handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the initial prompt block in README.md (between the tumwater:prompt markers).
- Never run a command that can wait or run indefinitely — interactive programs (TUIs, REPLs,
  editors, anything reading stdin), servers, or watch modes. A hung command hangs your whole
  loop. To test such a program, impose a hard time limit yourself (background it and kill it
  after a few seconds) and never allocate it a real TTY expecting input.
- If you find nothing worth doing for your role right now, make no changes and reply with the
  single line ${NOTHING_TO_DO} instead.
- If you did make changes, end your reply with a line in exactly this form:
  SUMMARY: <imperative one-line description of the change, at most 72 characters>`;

export interface TickPromptInput {
  role: Role;
  initialPrompt: string;
  extraInstructions?: string;
}

/** Shared opening of every loop prompt: where the run happens and why the project exists.
 * Defined once so the tick and director prompts cannot drift. */
function sharedPreamble(initialPrompt: string): string[] {
  const parts = [
    `You work in a dedicated git worktree of this project; your changes will be committed and merged to main by the harness after you finish.`,
  ];
  if (initialPrompt) {
    parts.push(`The project's initial prompt — its reason to exist — is:\n<project-prompt>\n${initialPrompt}\n</project-prompt>`);
  }
  return parts;
}

/** The full prompt for one role-loop tick. */
export function buildTickPrompt(input: TickPromptInput): string {
  const { role, initialPrompt, extraInstructions } = input;
  const parts = [
    `You are the "${role.id}" loop (${role.title}) of tumwater, an autonomous development harness.`,
    ...sharedPreamble(initialPrompt),
    `Your task this run:\n${role.find.trim()}`,
  ];
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  parts.push(COMMON_RULES.trim());
  return parts.join("\n\n");
}

/** The prompt for a director tick, which routes a user request into the project. */
export function buildDirectorPrompt(userPrompt: string, initialPrompt: string): string {
  const parts = [
    `You are the "director" loop of tumwater, an autonomous development harness. The user steers
the project by sending it requests; one has just arrived. Other specialist loops continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    ...sharedPreamble(initialPrompt),
    `The user's request:\n<user-request>\n${userPrompt.trim()}\n</user-request>`,
  ];
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
  user explicitly stated) may be done immediately instead of routed.
- ${DECOMPOSITION_GUIDANCE}`,
  );
  parts.push(COMMON_RULES.trim());
  return parts.join("\n\n");
}

/** The follow-up prompt for resuming a tick that a harness shutdown interrupted. It is sent
 * into the SAME pi session as the interrupted run — which already carries the full original
 * prompt, all rules, and the work so far — so it only needs to bridge the gap. */
export function buildResumePrompt(roleId: string): string {
  return `The harness was restarted while you (the "${roleId}" loop) were mid-run. Your worktree
is exactly as you left it, and this session carries everything you did so far. A tool call that
was executing when the restart hit may not have finished — verify its effect before relying on it.

Continue the SAME task you were working on and finish it. If the work so far turns out to be
unusable, redo it — but stay on this task rather than picking a new one. All the original rules
still apply, in particular:
- Do exactly ONE focused task, then stop.
- Never create, amend, or revert git commits — the harness handles all git operations.
- If you end up making no changes, reply with the single line ${NOTHING_TO_DO}.
- If you did make changes, end your reply with a line in exactly this form:
  SUMMARY: <imperative one-line description of the change, at most 72 characters>`;
}

/** The prompt for resolving merge conflicts left in a loop's worktree. */
export function buildConflictPrompt(roleId: string, files: string[]): string {
  return `You are the "${roleId}" loop of tumwater, an autonomous development harness. A rebase of
your work branch onto main stopped on conflicts; the conflict markers are sitting in the
worktree now. Resolve them.

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

Resolve every conflict marker (<<<<<<<, =======, >>>>>>>) by combining the intent of BOTH sides:
"ours" is this branch's change, "theirs" is the latest main. Do not simply pick one side unless
the two changes are genuinely alternatives. Keep the project building and its tests passing.

Rules for this run:
- Edit files only. Never run any git command that changes state (no add, commit, merge, rebase,
  reset, checkout) — the harness concludes the rebase for you. Reading git state is fine.
- Never touch the .tumwater directory or tumwater.json.
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
