import fs from "node:fs";
import path from "node:path";
import { DECOMPOSITION_GUIDANCE, PLAN_SIZING, type Role } from "./roles.js";
import { NOTHING_TO_DO, REFUSED_SENTINEL } from "./reply-contract.js";

/** Prompt construction for every kind of pi run the harness starts (tick, director, resume,
 * conflict resolution, review), declaring in prose the reply contract those runs must follow:
 * the TUMWATER_NOTHING_TO_DO sentinel, the TUMWATER_REFUSED line, and the SUMMARY/WHY/RISK/VERIFIED
 * block format. The machine-detectable half of that contract — constants and detection for parsing
 * pi's replies — lives in reply-contract.ts; assembling a reply into the tick's commit message
 * lives in commit-message.ts.
 *
 * The prose is tuned for the fleet's actual model: a ~27B local model (Qwen-class, thinking on)
 * behind a ~258k-token window at ~8 tok/s decode and ~100 tok/s prefill under load. Such a model
 * follows short grouped rules with concrete numbers and literal commands far better than long
 * dense paragraphs, over-reads when told merely to "work economically", and needs to be told how
 * a reply must end — so the rules are grouped, budgets are numeric, and the closing contract comes
 * last, where a model attends to it most. */

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

/** The context-budget rule every run carries. Under the old 87k window half of all ticks ended
 * at the ceiling landing nothing (308 of 733 in the autonomous fortnight; 216 of 245 no-change
 * ticks in the first week of September), almost all of it whole-file reads: the model, told only
 * to "work economically", read the codebase file by file (277 whole-file reads against 6 ranged
 * ones in the bugfix/improve/clean logs). The 258k window absorbs that pattern instead of cutting
 * it off, but every token read is prefill at ~100 tok/s and dilutes the model's attention, so the
 * rule now states the cost in numbers and the one habit that prevents it: check size, then read in
 * ranges. Stated once so the tick rules, the resume bridge, and the cut-off note cannot drift.
 * Must not contain the phrase "ran out of context" — the loop tests use it to tell a fresh tick
 * from a cut-off resume. */
const CONTEXT_BUDGET_RULE = `- Your context window is finite and everything you read stays in it until the run ends: a
  whole-file read of a 500-line module costs ~5k tokens, and a run that fills the window ends
  without landing anything. Work economically: check size before reading (\`wc -l\`) and read
  files over ~300 lines in ranges (\`sed -n 'A,Bp'\`, or the read tool's offset/limit) around the
  lines \`grep -n\` found; cap command output with \`head\`/\`tail\`; never dump a file, a log, or a
  test run wholesale; do not re-read what you already saw — re-read only a region you edited.
  Prefer a task you can finish comfortably within the window over a sweeping one.`;

const COMMON_RULES = `
Rules for this run:

Orientation — read this much before choosing your task, and no more:
- First read README.md in full to understand the project, plus QUESTIONS.md when present.
  PLANS.md and BUGS.md grow without bound — never read them wholesale: their actionable sections
  come first by template convention (## Planned before ## Done; ## Open before ## Fixed), so read
  only the top of each file that exists — Planned plus recent Done entries, Open plus recent
  Fixed ones (\`grep -n '^##' FILE\` maps the headings with line numbers; \`sed -n 'A,Bp'\` reads
  one entry). Consult older history via git log or a targeted read only when a specific entry is
  needed. The steward role is the exception: it curates those files and must see them whole.
- Your worktree starts clean at main, and the harness checks main's build before code roles
  start: do not run the build or test suite just to establish a baseline. Run it after your
  change — or when your task itself needs its output (reproducing a failure, counting the suite).

Scope:
- Do exactly ONE focused task, then stop. Small, complete, and correct beats big and half-done.
  Choose the task within your first ~15 tool calls. A task that would need more than roughly 60
  tool calls, or most of the codebase in view, is too big for one run — take a smaller one.
${CONTEXT_BUDGET_RULE}
- Leave the project working: if it has a build or test command, run it after your change and fix
  what you broke. Pipe its output through \`tail\` — only the failures matter.

Boundaries:
- Never create, amend, or revert git commits, branches, or merges — the harness handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the initial prompt block in README.md (between the tumwater:prompt markers).
- PRINCIPLES.md holds this project's design principles; only the director and steward roles may
  edit it. Treat it as read-only — if a principle seems wrong or outdated, record your objection
  in PLANS.md rather than editing the file.
- Never run a command that can wait or run indefinitely — interactive programs (TUIs, REPLs,
  editors, anything reading stdin), servers, or watch modes. A hung command hangs your whole
  loop. To test such a program, impose a hard time limit yourself (background it and kill it
  after at most 30 minutes) and never allocate it a real TTY expecting input.

When to ask, when to refuse:
- When a fork in the road is genuinely the user's call (product direction, an irreversible
  choice, taste), do not guess: append a question to QUESTIONS.md under ## Open with context,
  the options, and your own recommendation — a senior asks with a proposal, not a shrug — then
  either continue with the parts that don't depend on it or end the tick. Never block on an
  unanswered question; check for answers at the start of each tick. Do not re-ask an open
  question.
- If partway in you conclude the task would harm the project — it violates PRINCIPLES.md, grows
  complexity without justification, or keeps fighting back — do not force it and revert nothing
  yourself: record your objection as a note appended directly under the refused entry's heading
  in PLANS.md (for a planned feature) or BUGS.md, in exactly this shape:
  **Refused <YYYY-MM-DD> by <role>: <one-line reason>** — that recording edit is the only change
  a refusing run should leave. When choosing work, skip entries carrying a Refused note — do not
  pick them and do not re-refuse them; the objection stands until a human or the director edits
  the entry (a fully blocked backlog is a legitimate nothing-to-do state). End your reply with a
  line in exactly this form: ${REFUSED_SENTINEL}: <the same one-line reason>.

How to end your reply — the harness parses it, so the form matters:
- Your last message is plain text: never a tool call, and never an announcement of what you would
  do next ("Let me check…") — either make the call or finish. If a tool result only repeats what
  you already have, do not call it again.
- If you find nothing worth doing for your role right now, make no changes and reply with the
  single line ${NOTHING_TO_DO} instead.
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
  it now. ${PLAN_SIZING}
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
- Investigate only as much as routing precisely needs — grep and ranged reads to name the right
  files, functions, and suspected cause — never a survey of the codebase, and never the
  implementation itself.
- ${DECOMPOSITION_GUIDANCE}`,
  );
  parts.push(COMMON_RULES.trim());
  return parts.join("\n\n");
}

/** Why a tick is being resumed: a harness restart interrupted it, or it ran out of context (the
 * harness resumes the compacted session — see LoopState.cutOffStreak). */
type ResumeCause = "restart" | "cut-off";

/** The follow-up prompt for resuming an interrupted tick. It is sent into the SAME pi session as
 * the interrupted run — which already carries the full original prompt, all rules, and the work
 * so far — so it only needs to bridge the gap. The bridge names the real cause: a run cut off at
 * the context ceiling needs to finish with the smallest change and read almost nothing more, not
 * to verify a half-finished tool call. The cut-off bridge carries a numeric re-reading budget
 * because the observed post-compaction behavior was the opposite of "read almost nothing": the
 * model re-read the whole tree and repeated identical reads of one file nine times. */
export function buildResumePrompt(roleId: string, cause: ResumeCause = "restart"): string {
  const opening =
    cause === "cut-off"
      ? `Your previous run as the "${roleId}" loop ran out of context before it could finish, so the
harness compacted the session and is continuing it now. Your worktree is exactly as you left it;
what you did so far is summarized above. Do NOT re-read the codebase: trust the summary and
re-check only what you must, in ranges — at most ~10 tool calls of re-reading, and never the same
file twice. Finish the SAME task with the smallest change that completes it. If it cannot be
finished within a fraction of the window, scope it down to what is already complete and coherent,
leave the project working, and stop.`
      : `The harness was restarted while you (the "${roleId}" loop) were mid-run. Your worktree
is exactly as you left it, and this session carries everything you did so far. A tool call that
was executing when the restart hit may not have finished — verify its effect before relying on it.

Continue the SAME task you were working on and finish it. If the work so far turns out to be
unusable, redo it — but stay on this task rather than picking a new one.`;
  return `${opening} All the original rules
still apply, in particular:
- Do exactly ONE focused task, then stop.
${CONTEXT_BUDGET_RULE}
- Never create, amend, or revert git commits — the harness handles all git operations.
- Your last message is plain text — never a tool call or an announcement of a next step.
- If you end up making no changes, reply with the single line ${NOTHING_TO_DO}.
${SUMMARY_RULE}`;
}

/** The one-turn follow-up sent into a tick's OWN session (--continue) when the run changed files
 * but its reply carried no SUMMARY line — 73 of the first 670 commits landed as "<role> tick N"
 * because of that, most of them the largest diffs in the repo. The session still holds everything
 * the run did, so one short reply recovers the subject and body the commit deserves; the caller
 * bounds the run tightly and falls back to a diff-derived subject if this too yields nothing. */
export function buildSummaryRequestPrompt(): string {
  return `Your run changed files in the worktree, but your final reply
did not include the required closing block, so the harness cannot describe the commit it is about
to make. Reply now with ONLY that block — no tool calls, no other text, one line each:
  SUMMARY: <imperative one-line description of the change, at most 72 characters>
  WHY: <why the change was made — one or two sentences>
  RISK: <what could break and where to look if it does>
  VERIFIED: <what you actually ran and observed — write none when nothing was run>`;
}

/** The note injected into a role's next FRESH tick prompt after its previous run(s) were cut
 * off at the context ceiling without landing anything (the loop gave up resuming — see
 * state.ts's CUT_OFF_RESUME_LIMIT — or a cut-off director prompt is re-running). The only
 * cross-tick memory that the last attempt was too big for the window. */
export function buildCutOffNote(streak: number): string {
  const runs = streak === 1 ? "run" : `${streak} runs`;
  return `Your previous ${runs} as this loop ran out of context before landing anything. Pick a
smaller, more targeted task this time and budget your reading: grep first, read in ranges, cap
command output. If the smallest useful task still needs most of the codebase in view, reply
${NOTHING_TO_DO} instead of starting it.`;
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
- Read only the conflicted files and what they directly reference (\`grep -n '<<<<<<<' FILE\`
  finds each marker; read around it in ranges) — not the codebase at large.
- Never touch the .tumwater directory or tumwater.json.
- When every marker is resolved and the project is consistent, just stop.`;
}

/** The prompt for the adversarial pre-merge review gate: a fresh-session pi run that sees
 * only the diff and project context — never the author's session — and replies with exactly
 * one VERDICT line plus numbered reasons (see parseVerdict in src/review.ts). `verifiedByHarness`
 * names the project's own check the gate's deterministic pre-check already ran green on this
 * exact tree (e.g. "`npm run test` passed"), so the reviewer spends its run on what a green suite
 * cannot show instead of re-running it. The text must contain the literal "VERDICT:" exactly
 * twice — the two advertised forms — because a prompt test derives the accepted forms from it. */
export function buildReviewPrompt(
  diff: string,
  summary?: string,
  commitBody?: string,
  principles?: string,
  highFriction?: boolean,
  verifiedByHarness?: string,
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
  if (verifiedByHarness)
    parts.push(
      `The harness already ran the project's own check on this exact tree and it passed:
${verifiedByHarness}. Do not spend your run re-running it — spend it on what a green check cannot
show: wrong behavior the tests never exercise, claims the diff does not back, work left half-done.`,
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
repo to check claims against reality — a diff that does more than it claims is a finding — but
read only what the diff touches: the changed functions, their callers, and the tests that cover
them, in ranges (\`grep -n\`, \`sed -n\`), not the repository at large.

Check, in this order:
1. Does the diff do exactly what the summary and WHY claim — no more, no less? An unclaimed
   change is a finding.
2. Are the VERIFIED claims consistent with the diff (commands, files, test counts)? A claim you
   can disprove is a rejection.
3. Do new or changed tests exercise the new behavior — would they fail without the change?
4. For a planned feature or recorded bug, does the change deliver what its PLANS.md/BUGS.md
   entry promises (files touched, acceptance criteria), and is the entry updated to match? An
   entry records intent at recording time; when the change responds to a newer user instruction
   on the same topic, judge it against that newer purpose — contradicting an older recorded fix
   direction is not itself a defect. Reject only if the change is incoherent or incomplete for
   its stated purpose, or leaves the existing entry stale and contradictory (updating the entry
   in place is the author's duty).
5. Does anything violate a principle above, or grow complexity the WHY does not justify?
Reject only for concrete, verifiable defects you can name; when the change is correct, complete
for its stated purpose, and within the principles, taste alone is not a rejection.

Rules for this run:
- Do not edit any file in the worktree. Never run a command that changes state (no git
  add/commit/merge/rebase/reset, no writes in the worktree) — your only output channel is the
  verdict below. Reading files and git history is fine; a scratch copy under the system temp
  directory is fine when you need to run something.
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
