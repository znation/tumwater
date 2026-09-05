import fs from "node:fs";
import path from "node:path";
import { DECOMPOSITION_GUIDANCE, type Role } from "./roles.js";
import { NOTHING_TO_DO, REFUSED_SENTINEL } from "./reply-contract.js";

/** Prompt construction for every kind of pi run the harness starts (tick, director, resume,
 * conflict resolution, review), declaring in prose the reply contract those runs must follow:
 * the TUMWATER_NOTHING_TO_DO sentinel, the TUMWATER_REFUSED line, and the SUMMARY/WHY/RISK/VERIFIED
 * block format. The machine-detectable half of that contract — constants and detection for parsing
 * pi's replies — lives in reply-contract.ts; assembling a reply into the tick's commit message
 * lives in commit-message.ts. */

/** Cap on the PRINCIPLES.md text injected into every prompt, so a runaway file cannot blow up
 * each tick's prefill. */
export const PRINCIPLES_MAX_CHARS = 4000;

/** The rule every loop prompt states for ending a run that made changes — the exact
 * SUMMARY/WHY/RISK/VERIFIED block format commit-message.ts parses into the commit message.
 * Stated once so the tick/director rules and the resume bridge cannot drift (sibling of the
 * NOTHING_TO_DO sentinel in reply-contract.ts). */
const SUMMARY_RULE = `- If you did make changes, end your reply with a block in exactly this form (one line each):
  SUMMARY: <imperative one-line description of the change, at most 72 characters>
  WHY: <why the change was made — one or two sentences>
  RISK: <what could break and where to look if it does>
  VERIFIED: <what you actually ran and observed (e.g. "npm test, 182 pass") — write none when nothing was run>`;

const COMMON_RULES = `
Rules for this run:
- First read README.md in full to understand the project, plus QUESTIONS.md when present.
  PLANS.md and BUGS.md grow without bound — never read them wholesale: their actionable sections
  come first by template convention (## Planned before ## Done; ## Open before ## Fixed), so read
  only the top of each file that exists — Planned plus recent Done entries, Open plus recent
  Fixed ones. Consult older history via git log or a targeted read only when a specific entry is
  needed. The steward role is the exception: it curates those files and must see them whole.
- Do exactly ONE focused task, then stop. Small, complete, and correct beats big and half-done.
- Leave the project working: if it has a build or test command, run it and fix what you broke.
- Never create, amend, or revert git commits, branches, or merges — the harness handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the initial prompt block in README.md (between the tumwater:prompt markers).
- PRINCIPLES.md holds this project's design principles; only the director and steward roles may
  edit it. Treat it as read-only — if a principle seems wrong or outdated, record your objection
  in PLANS.md rather than editing the file.
- When a fork in the road is genuinely the user's call (product direction, an irreversible
  choice, taste), do not guess: append a question to QUESTIONS.md under ## Open with context,
  the options, and your own recommendation — a senior asks with a proposal, not a shrug — then
  either continue with the parts that don't depend on it or end the tick. Never block on an
  unanswered question; check for answers at the start of each tick. Do not re-ask an open
  question.
- Never run a command that can wait or run indefinitely — interactive programs (TUIs, REPLs,
  editors, anything reading stdin), servers, or watch modes. A hung command hangs your whole
  loop. To test such a program, impose a hard time limit yourself (background it and kill it
  after a few seconds) and never allocate it a real TTY expecting input.
- If you find nothing worth doing for your role right now, make no changes and reply with the
  single line ${NOTHING_TO_DO} instead.
- If partway in you conclude the task would harm the project — it violates PRINCIPLES.md, grows
  complexity without justification, or keeps fighting back — do not force it and revert nothing
  yourself: record your objection as a note appended directly under the refused entry's heading
  in PLANS.md (for a planned feature) or BUGS.md, in exactly this shape:
  **Refused <YYYY-MM-DD> by <role>: <one-line reason>** — that recording edit is the only change
  a refusing run should leave. When choosing work, skip entries carrying a Refused note — do not
  pick them and do not re-refuse them; the objection stands until a human or the director edits
  the entry (a fully blocked backlog is a legitimate nothing-to-do state). End your reply with a
  line in exactly this form: ${REFUSED_SENTINEL}: <the same one-line reason>.
${SUMMARY_RULE}`;

/** The project's design principles (PRINCIPLES.md), capped for injection into prompts. Empty
 * string when the file is missing or unreadable — prompt building must never throw on it. */
export function readPrinciples(root: string): string {
  const file = path.join(root, "PRINCIPLES.md");
  if (!fs.existsSync(file)) return "";
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
  if (text.length > PRINCIPLES_MAX_CHARS) {
    text = `${text.slice(0, PRINCIPLES_MAX_CHARS)}\n…[PRINCIPLES.md truncated at ${PRINCIPLES_MAX_CHARS} chars]`;
  }
  return text;
}

/** The <principles> block injected into every tick and director prompt: the project's codified
 * taste, phrased positively so loops follow it rather than merely avoid violations. */
function principlesBlock(principles: string): string {
  return `Design principles this project holds — uphold them in everything you produce:\n<principles>\n${principles}\n</principles>`;
}

interface TickPromptInput {
  role: Role;
  initialPrompt: string;
  /** PRINCIPLES.md content (see readPrinciples); omitted from the prompt when empty. */
  principles?: string;
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
  const { role, initialPrompt, principles, extraInstructions } = input;
  const parts = [
    `You are the "${role.id}" loop (${role.title}) of tumwater, an autonomous development harness.`,
    ...sharedPreamble(initialPrompt),
  ];
  if (principles) parts.push(principlesBlock(principles));
  parts.push(`Your task this run:\n${role.find.trim()}`);
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  parts.push(COMMON_RULES.trim());
  return parts.join("\n\n");
}

/** The prompt for a director tick, which routes a user request into the project. */
export function buildDirectorPrompt(
  userPrompt: string,
  initialPrompt: string,
  principles?: string,
): string {
  const parts = [
    `You are the "director" loop of tumwater, an autonomous development harness. The user steers
the project by sending it requests; one has just arrived. Other specialist loops continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    ...sharedPreamble(initialPrompt),
  ];
  if (principles) parts.push(principlesBlock(principles));
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
  where future loops will see it — PRINCIPLES.md first for standing design guidance and taste;
  README.md, PLANS.md, or BUGS.md otherwise — and remove anything it supersedes.
- A question: answer it in your final reply, and record anything durable it surfaced.
- An answer to an open question (e.g. "answer Q3: choose SQLite"): move that entry from
  QUESTIONS.md's ## Open section to ## Answered verbatim with the decision recorded, and apply
  or route any follow-on work it implies.
- A decision about a refused entry (e.g. "clear the refusal on plan X", "reconsider plan Y"):
  clear its **Refused …** note from PLANS.md/BUGS.md — or revise the entry per the user's
  direction — so loops can pick it up again.
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
${SUMMARY_RULE}`;
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

/** The prompt for the adversarial pre-merge review gate: a fresh-session pi run that sees
 * only the diff and project context — never the author's session — and replies with exactly
 * one VERDICT line plus numbered reasons (see parseVerdict in src/review.ts). */
export function buildReviewPrompt(
  diff: string,
  summary?: string,
  commitBody?: string,
  principles?: string,
  highFriction?: boolean,
): string {
  const parts = [
    `You are an adversarial code reviewer for tumwater, an autonomous development harness. A
loop's change is about to be merged to main; you decide whether it may land. You have no context
from the authoring run — judge only what is in front of you, and assume nothing until you have
checked it.`,
  ];
  if (highFriction)
    parts.push(
      `This change was flagged HIGH-FRICTION by the harness: its authoring run burned far more
assistant turns or wall-clock time than this project's thresholds. Difficulty is a signal that
the work may not fit the system — apply extra scrutiny to whether the change should exist at all,
not just whether it is correct.`,
    );
  if (summary) parts.push(`The author's summary of the change:\n${summary}`);
  if (commitBody)
    parts.push(
      `The author's commit body (claimed motivation, risk, verification — check these claims against the diff):\n${commitBody}`,
    );
  if (principles) {
    parts.push(
      `Design principles this project holds — your review standard; a violation of one is a finding:\n<principles>\n${principles}\n</principles>`,
    );
  }
  parts.push(`The full diff this merge will land (everything the branch is ahead of main):\n<diff>\n${diff}\n</diff>`);
  parts.push(
    `Review adversarially: hunt for correctness bugs, violations of the project's principles,
unjustified complexity growth, and incomplete or half-done work. Read surrounding code in the
repo freely to check claims against reality — a diff that does more than it claims is a finding.

Rules for this run:
- Do not edit any file. Never run a command that changes state (no git add/commit/merge/rebase/
  reset, no writes anywhere) — your only output channel is the verdict below. Reading files and
git history is fine.
- Weigh the change against its stated purpose; do not approve work you did not actually check.
- End your reply with exactly one line in this form:
  VERDICT: approve   or   VERDICT: reject
  followed by numbered reasons (for an approval, state what you checked and why it holds).`,
  );
  return parts.join("\n\n");
}

/** The note injected into a role's next tick prompt after its previous change was rejected in
 * review. Every tick starts a fresh pi session, so this is the only cross-tick memory of what
 * was built and why it failed — it carries the full reasons, not a summary of them. */
export function buildRejectedReviewNote(reasons: string[]): string {
  const list =
    reasons.length > 0 ? reasons.map((r, i) => `${i + 1}. ${r}`).join("\n") : "(no reasons recorded)";
  return `Your previous change was rejected in review:\n${list}\nAddress the objections or take a different approach.`;
}
