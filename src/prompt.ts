import path from "node:path";
import { readTextOrNull } from "./files.js";
import { describeCheck } from "./build-check.js";
import type { BuildCheck } from "./build-check-detect.js";
import { DECOMPOSITION_GUIDANCE, NEEDS_REVIEW_NOTE, PLAN_SIZING, type Role } from "./roles.js";
import { NOTHING_TO_DO, REFUSED_SENTINEL } from "./reply-contract.js";
import { todayStamp } from "./budget.js";

/** Prompt construction for the role loops' pi runs (tick, director, resume, summary recovery),
 * declaring in prose the reply contract those runs must follow:
 * the TUMWATER_NOTHING_TO_DO sentinel, the TUMWATER_REFUSED line, and the SUMMARY/WHY/RISK/VERIFIED
 * block format. The landing gate's pi runs (conflict resolution, build fix, review) build their
 * prompts in gate-prompts.ts; the machine-detectable half of the contract — constants and detection
 * for parsing pi's replies — lives in reply-contract.ts; assembling a reply into the tick's commit
 * message lives in commit-message.ts.
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

/** The four-line SUMMARY/WHY/RISK/VERIFIED block itself — the machine-parsed half of the
 * closing contract, shared verbatim by SUMMARY_RULE (tick/director prompts) and
 * buildSummaryRequestPrompt (the follow-up that recovers a missing block), so the two cannot
 * drift (sibling of the NOTHING_TO_DO sentinel in reply-contract.ts). */
const SUMMARY_BLOCK = `  SUMMARY: <imperative one-line description of the change, at most 72 characters>
  WHY: <why the change was made — one or two sentences>
  RISK: <what could break and where to look if it does>
  VERIFIED: <what you actually ran and observed (e.g. "npm test, 182 pass") — write none when nothing was run>`;

/** The rule every loop prompt states for ending a run that made changes — the exact
 * SUMMARY/WHY/RISK/VERIFIED block format commit-message.ts parses into the commit message.
 * Stated once so the tick/director rules and the resume bridge cannot drift. */
const SUMMARY_RULE = `- If you did make changes, end your reply with a block in exactly this form (one line each):
${SUMMARY_BLOCK}`;

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
  Prefer a task you can finish comfortably within the window over a sweeping one. Each turn
  re-sends everything read so far, so when the next few reads or commands do not depend on each
  other's output (a \`wc -l\` over several files, a \`grep -n\` plus the \`sed -n\` ranges it points
  at once known, a typecheck and a targeted test), issue them as separate tool calls in the same
  turn; keep edits and anything that depends on a prior result sequential — do not batch an edit
  with the test that checks it. Oversized tool results come back as head+tail around a marker
  that names the omitted amount and where the full output lives — follow the pointer (re-read
  with \`offset\`/\`limit\`, or open the full-output file path) instead of retrying the same read.`;

/** The date line every pi prompt carries — tick and director (via sharedPreamble) and the gate's
 * conflict and review runs — naming the local calendar day as YYYY-MM-DD. No prompt
 * used to say what day it is, so a run that had to write one (a BUGS.md heading's "(found by …
 * YYYY-MM-DD)", a Fixed or Refused date, NEEDS_REVIEW_NOTE's <YYYY-MM-DD>, a plan deadline)
 * inferred it from the newest dates in the repo, which were themselves drifting: the fleet
 * stamped entries days into the future and each wrong date seeded the next. The day is
 * todayStamp's — the same local-day computation as the daily cost budget window — and every
 * builder takes it as an optional trailing `today` that falls through to this default, so tests
 * pin an exact date and a new call site cannot forget it. */
export function dateLine(today: string = todayStamp()): string {
  return `Today's date is ${today} (local time).`;
}

/** The rules every loop prompt carries — tick and director alike, so the two cannot drift.
 * `check` — the project's resolved check (plans/portability.md §6/7) — names the actual
 * verification command in the Leave-the-project-working rule instead of asserting npm, and
 * only an npm check keeps the node_modules borrowing sentence: false and actively misleading
 * in a repo with no node_modules anywhere (a Python, Rust, or Go repo, or one with no check
 * at all). Undefined keeps the generic wording, exactly as prompts read before a check could
 * be configured. */
function commonRules(check?: BuildCheck, briefFile: string = "README.md"): string {
  const verify = check
    ? `verify with ${describeCheck(check)} (the project's declared check) — run it after your
  change and fix what you broke.`
    : `if it has a build or test command, run it after your change and fix what you broke.`;
  const modules =
    check?.kind === "npm"
      ? ` Your worktree has no node_modules of its own; it borrows the install at the repo
  root, two levels up (\`../../node_modules\`). To inspect a dependency's types or source,
  read that directory directly instead of widening the search outward.`
      : "";
  return `
Rules for this run:

Orientation — read this much before choosing your task, and no more:
- First read the project brief (${briefFile}) in full to understand the project, plus
  QUESTIONS.md when present.
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
  Choose the task within your first ~15 tool calls, in a handful of turns. A task that would
  need more than roughly 60 tool calls, or most of the codebase in view, is too big for one
  run — take a smaller one.
- Stay inside your worktree: never run an unbounded scan or write above it (\`find /\`,
  \`grep -r /\`, any recursive search rooted outside the repo) — an unmatched full-disk scan runs
  for tens of minutes with no output and blocks your whole tick until the harness kills it as
  hung.${modules}
${CONTEXT_BUDGET_RULE}
- Leave the project working: ${verify} Pipe its output through \`tail\` — only the failures matter.

Boundaries:
- Never create, amend, or revert git commits, branches, or merges — the harness handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the initial prompt block in ${briefFile} (between the tumwater:prompt markers).
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
  line in exactly this form:
  ${REFUSED_SENTINEL}: <the same one-line reason> — and emit that line ONLY when refusing: it
  is not a reply-contract field, and an ordinary reply that reports completed work must never
  name the sentinel (not even as "${REFUSED_SENTINEL}: none"), or the harness treats the whole
  tick as a refusal.

How to end your reply — the harness parses it, so the form matters:
- Your last message is plain text: never a tool call, and never an announcement of what you would
  do next ("Let me check…") — either make the call or finish. If a tool result only repeats what
  you already have, do not call it again.
- If you find nothing worth doing for your role right now, make no changes and reply with the
  single line ${NOTHING_TO_DO} instead.
${SUMMARY_RULE}`;
}

/** The project's design principles (PRINCIPLES.md), capped for injection into prompts. Empty
 * string when the file is missing or unreadable — prompt building must never throw on it. */
export function readPrinciples(root: string): string {
  const file = path.join(root, "PRINCIPLES.md");
  let text = readTextOrNull(file)?.trim() ?? "";
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

/** The <failure-digest> block injected into the telemetry role's prompt (plans/telemetry-role.md):
 * the harness renders the digest from its own event log at the project root and hands it over, so
 * the role spends no tool calls acquiring evidence and cannot read a stale or foreign log. */
function digestBlock(digest: string): string {
  return `Runtime failure digest of this harness's own event log — your evidence base:\n<failure-digest>\n${digest}\n</failure-digest>`;
}

interface TickPromptInput {
  role: Role;
  initialPrompt: string;
  /** PRINCIPLES.md content (see readPrinciples); omitted from the prompt when empty. */
  principles?: string;
  /** Rendered failure digest (see failure-report.ts); telemetry only, omitted when unreadable. */
  digest?: string;
  /** Rendered flow-coverage block (see qa-coverage.ts); qa only, omitted when unreadable. */
  coverage?: string;
  extraInstructions?: string;
  /** The project's resolved check (detectBuildCheck against the live config), when one is
   * configured or detected (plans/portability.md §6/7) — names the verify command in the
   * rules instead of asserting npm. Omitted: no check — generic wording, no npm assertion. */
  check?: BuildCheck;
  /** The file the project brief (the managed initial prompt + status) is read from —
   * TUMWATER.md when it owns the sections, else README.md (plans/portability.md §7a/7).
   * Omitted: the README.md compatibility default, exactly as prompts read before the brief
   * became resolvable. */
  briefFile?: string;
  /** Today's local date as YYYY-MM-DD (see dateLine). Omitted: todayStamp() — tests pin it. */
  today?: string;
}

/** Shared opening of every loop prompt: where the run happens, what day it is, and why the
 * project exists. Defined once so the tick and director prompts cannot drift — and so the one
 * sentence telling every role to date its records from dateLine, not from the repo, reaches
 * each of them without editing any role text. */
function sharedPreamble(initialPrompt: string, today?: string): string[] {
  const parts = [
    `You work in a dedicated git worktree of this project; your changes will be committed and merged to main by the harness after you finish.`,
    `${dateLine(today)} Stamp it on anything you record now — a new BUGS.md or PLANS.md heading's
"(found by … YYYY-MM-DD)", a Fixed or Done date, a Refused or Needs-review note — and count plan
deadlines from it; never infer the date from the repo.`,
  ];
  if (initialPrompt) {
    parts.push(`The project's initial prompt — its reason to exist — is:\n<project-prompt>\n${initialPrompt}\n</project-prompt>`);
  }
  return parts;
}

/** The full prompt for one role-loop tick. */
export function buildTickPrompt(input: TickPromptInput): string {
  const { role, initialPrompt, principles, digest, coverage, extraInstructions, check, briefFile, today } = input;
  const parts = [
    `You are the "${role.id}" loop (${role.title}) of tumwater, an autonomous development harness.`,
    ...sharedPreamble(initialPrompt, today),
  ];
  if (principles) parts.push(principlesBlock(principles));
  if (coverage) parts.push(coverage);
  if (digest) parts.push(digestBlock(digest));
  parts.push(`Your task this run:\n${role.find.trim()}`);
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  parts.push(commonRules(check, briefFile).trim());
  return parts.join("\n\n");
}

/** The prompt for a director tick, which routes a user request into the project. */
export function buildDirectorPrompt(
  userPrompt: string,
  initialPrompt: string,
  principles?: string,
  /** The project's resolved check (plans/portability.md §6/7) — same threading as the tick
   * prompt, since commonRules is shared by both builders. */
  check?: BuildCheck,
  /** The resolved brief file's name (plans/portability.md §7a/7) — same threading again. */
  briefFile?: string,
  /** Today's local date (see dateLine). Omitted: todayStamp() — tests pin it. */
  today?: string,
): string {
  const parts = [
    `You are the "director" loop of tumwater, an autonomous development harness. The user steers
the project by sending it requests; one has just arrived. Other specialist loops continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    ...sharedPreamble(initialPrompt, today),
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
- A decision about a marked plan (e.g. "split plan X", "keep plan X whole"): split it into
  independently landable sub-plans per PLAN_SIZING, or clear the ${NEEDS_REVIEW_NOTE} note, per
  the user's direction.
- A request to manage user-defined loops ("add a loop named X that does Y", "remove X",
  "move X before Y"): write the FULL replacement customLoops array to
  .tumwater-config-request.json at your worktree root — the shape is
  { "customLoops": [ { "name": "…", "task": "…" } ] }. Add appends an entry with a name in
  [a-z0-9_-] no built-in role uses and a task written as the loop's standing per-tick
  instruction (one clear paragraph); remove deletes the entry; move reorders entries (array
  order is display/scheduling order). The array REPLACES the current one — include every loop
  that should exist, not only the changed entries. Worked example — to add a loop named docs
  that keeps the examples current and drop one named scrape, write the file containing exactly
  the surviving entries:
  { "customLoops": [ { "name": "docs", "task": "Keep the examples/ directory current with the latest API changes." } ] }.
  Write the file and stop: the harness validates it, applies it to the live config, and deletes
  it; the loops start on their own and the request file is never committed.
- Only a trivially small direct edit (fix a typo, tweak a doc line, adjust a config value the
  user explicitly stated) may be done immediately instead of routed.
- Investigate only as much as routing precisely needs — grep and ranged reads to name the right
  files, functions, and suspected cause — never a survey of the codebase, and never the
  implementation itself.
- ${DECOMPOSITION_GUIDANCE}`,
  );
  parts.push(commonRules(check, briefFile).trim());
  parts.push(
    `Note on one boundary above, director only: user-defined-loop requests are executed by
writing .tumwater-config-request.json in your worktree (shape and worked example above) — never
by editing tumwater.json, which stays off-limits to you as to every role. The harness validates
the request and applies only its customLoops array; a request that also names any other setting
(timeouts, budgets, role enablement, review settings) has that key discarded with a warning, so
such a request is guidance to record per the routing rules, not an edit you can make.`,
  );
  return parts.join("\n\n");
}

/** Why a tick is being resumed: a harness restart interrupted it, or it ran out of context (the
 * harness resumes the compacted session — see LoopState.cutOffStreak). */
type ResumeCause = "restart" | "cut-off" | "hung-tool";

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
      : cause === "hung-tool"
        ? `The harness killed your previous run as the "${roleId}" loop because it made no progress long enough to trip its hang watchdog — almost always one tool call that hung (a command waiting on input, or a scan far wider than intended). That tool call is dead: do not re-run it unchanged. Your worktree is exactly as you left it, and this session carries everything you did so far — verify the effect of anything the killed call was supposed to produce before relying on it, and bound any long-running command (a time limit, a scoped path).

Continue the SAME task you were working on and finish it. If the work so far turns out to be
unusable, redo it — but stay on this task rather than picking a new one.`
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
${SUMMARY_BLOCK}`;
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

