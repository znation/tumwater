import path from "node:path";
import { describeCheck } from "../build/build-check-report.js";
import type { BuildCheck } from "../build/build-check-detect.js";
import type { Role } from "../roles/roles.js";
import { DECOMPOSITION_GUIDANCE, NEEDS_REPLAN_NOTE, NEEDS_REVIEW_NOTE, PLAN_SIZING } from "../roles/role-guidance.js";
import { CLAIMS_RULE, REPLY_ENDINGS } from "../verdict/reply-contract.js";
import { todayStamp } from "../budget/budget.js";
import { worktreePath } from "../paths.js";

/** Prompt construction for the role loops' pi runs (tick and director). The reply contract
 * those runs must follow — the TUMWATER_NOTHING_TO_DO sentinel, the TUMWATER_REFUSED line, the
 * SUMMARY/WHY/RISK/VERIFIED block format, the three endings, and the claims rules — lives in
 * reply-contract.ts; this module weaves it into each prompt. The follow-up prompts that pick a
 * session back up — the resume bridge, the missing-summary recovery, and the fresh-tick cut-off
 * note — live in prompt-followup.ts. The landing gate's pi runs (conflict resolution, build fix,
 * review) build their prompts in gate-prompts.ts; assembling a reply into the tick's commit
 * message lives in git/commit-message.ts.
 *
 * The prose is tuned for the fleet's models (2026-10-01): the primary GLM-5.3-Flash (an 18B-active
 * MoE behind a ~1M window) and the budget fallback's local Qwen3.8-27B (~127k window). Both follow
 * short grouped rules with concrete numbers and literal commands far better than long dense
 * paragraphs, over-read when told merely to "work economically", make unchecked claims the
 * reviewer then rejects (the primary's leading rejection cause), and need to be told how a reply
 * must end — so the rules are grouped with one rule per bullet, budgets are numeric, role tasks are
 * numbered steps, claims carry the check that proves them, the three possible endings are a
 * mutually exclusive list, and that closing contract comes last, where a model attends to it most.
 * Nothing here is model-conditional. The PRINCIPLES.md reader the principles block is fed from
 * lives in principles.ts (readPrinciples, with its injection cap). */

/** The context-budget rule every run carries. Under the old 87k window half of all ticks ended
 * at the ceiling landing nothing (308 of 733 in the autonomous fortnight; 216 of 245 no-change
 * ticks in the first week of September), almost all of it whole-file reads: the model, told only
 * to "work economically", read the codebase file by file (277 whole-file reads against 6 ranged
 * ones in the bugfix/improve/clean logs). Every token read is prefill and dilutes the model's
 * attention, so the rule states the cost in numbers and the one habit that prevents it: check
 * size, then read in ranges. One rule per bullet (2026-10-01), so a small model can follow each
 * on its own. (Reasoning length is not addressed here: a "think briefly" bullet measured no drop in
 * the fallback model's thinking — the oMLX thinking-budget cap is the lever.) The bundled
 * context-budget extension
 * (src/pi-extension/context-budget.ts) complements this rule with the live fill level. Stated
 * once so the tick rules and prompt-followup.ts's resume bridge cannot drift. Must not contain
 * the phrase "ran out of context" — the loop tests use it to tell a fresh tick from a cut-off
 * resume. */
export const CONTEXT_BUDGET_RULE = `- Your context window is finite: everything you read stays in it until the run ends, and a
  run that fills the window lands nothing. A whole-file read of a 500-line module costs ~5k tokens.
- Check size before reading (\`wc -l\`) and read files over ~300 lines in ranges: find the lines
  with \`grep -n\`, then read them with the read tool's offset/limit (or \`sed -n 'A,Bp'\`).
- Cap command output with \`head\`/\`tail\`. Never dump a file, a log, or a test run wholesale.
- Do not re-read what you already saw — re-read only a region you edited.
- Each turn re-sends everything read so far, so issue lookups that do not depend on each other
  (a \`wc -l\` over several files, the ranges a \`grep -n\` found, a typecheck and a targeted
  test) as separate tool calls in the same turn. Keep anything that depends on a prior result
  sequential — do not batch an edit with the test that checks it.
- Oversized tool results come back as head+tail around a marker that names the omitted amount
  and where the full output lives — follow the pointer (re-read with \`offset\`/\`limit\`, or open
  the full-output file path) instead of retrying the same read.`;

/** The test-runner rule every run that may run tests carries: the tick and director rules, the
 * conflict resolver, and the reviewer. Project-neutral on purpose — a fleet works on any codebase
 * (npm, cargo, pytest, a configured check.command), so the rule names no ecosystem's runner as THE
 * right one: it points at the declared check or the framework already in use, and its one example
 * is labelled as a mismatch. A run that does not know the suite's runner guesses one: in the week
 * to 2026-10-05 the fleet's agents ran `npx vitest` 19 times in tumwater, a node:test repo, and
 * vitest killed the compiled tests mid-run, so no cleanup hook ran (BUGS.md 2026-10-05: ~725 temp
 * run roots abandoned and test children orphaned by one conflict resolver's five runs). Even where
 * a guess cannot do that damage, it wastes turns on a runner that finds no tests. tumwater's own
 * root vitest.config.mjs refuses vitest in this repo; this rule is the half that reaches every
 * project. Stated once so the three prompt families cannot drift. */
export const TEST_RUNNER_RULE = `- Run tests only through the project's declared check or the test framework it already uses —
  never a runner you guessed (say, \`npx vitest\` in a suite written for node:test): a mismatched
  runner finds no tests at best, and can kill them mid-run, leaking processes and temp files.`;

/** The date line every pi prompt carries — tick and director (via sharedPreamble) and the gate's
 * conflict and review runs — naming the local calendar day as YYYY-MM-DD. No prompt
 * used to say what day it is, so a run that had to write one (a BUGS.md heading's "(found by …
 * YYYY-MM-DD)", a Fixed or Refused date, NEEDS_REVIEW_NOTE's and NEEDS_REPLAN_NOTE's
 * <YYYY-MM-DD>, a plan deadline)
 * inferred it from the newest dates in the repo, which were themselves drifting: the fleet
 * stamped entries days into the future and each wrong date seeded the next. The day is
 * todayStamp's — the same local-day computation as the daily cost budget window — and every
 * builder takes it as an optional trailing `today` that falls through to this default, so tests
 * pin an exact date and a new call site cannot forget it. */
export function dateLine(today: string = todayStamp()): string {
  return `Today's date is ${today} (local time).`;
}

/** The repo root as a loop's worktree reaches it (`../../..`, out of .tumwater/worktrees/<role>),
 * derived from worktreePath so the prompt cannot drift from the layout: the hand-written "two
 * levels up (`../../node_modules`)" it replaced pointed at .tumwater/ itself, and on 2026-09-29
 * a bugfix run that followed it (`cd ../..`, git output empty there) fell back to the primary
 * checkout's absolute path and ran the suite in the live fleet's own checkout (BUGS.md). */
export const ROOT_FROM_WORKTREE = path.relative(worktreePath("/", "role"), "/");

/** The Scope rules every run carries unless its role states its own (Role.scope): one small,
 * self-contained task, chosen fast, with a numeric size ceiling. The director always carries
 * these; a role overrides them only when its work is a different size by nature. */
export const DEFAULT_SCOPE = `- Do exactly ONE focused task, then stop. Small, complete, and correct beats big and half-done.
- Choose the task within your first ~15 tool calls, in a handful of turns. A task that would
  need more than roughly 60 tool calls, or most of the codebase in view, is too big for one
  run — take a smaller one.`;

/** The rules every loop prompt carries — tick and director alike, so the two cannot drift.
 * `check` — the project's resolved check (plans/portability.md §6/7) — names the actual
 * verification command in the Leave-the-project-working rule instead of asserting npm, and
 * only an npm check keeps the node_modules borrowing sentence: false and actively misleading
 * in a repo with no node_modules anywhere (a Python, Rust, or Go repo, or one with no check
 * at all). Undefined keeps the generic wording, exactly as prompts read before a check could
 * be configured. `scope` is the Scope section's rules: DEFAULT_SCOPE unless the tick's role
 * states its own (Role.scope). */
function commonRules(check?: BuildCheck, briefFile: string = "README.md", scope: string = DEFAULT_SCOPE): string {
  const verify = check
    ? `verify with ${describeCheck(check)} (the project's declared check) — run it after your
  change and fix what you broke.`
    : `if it has a build or test command, run it after your change and fix what you broke.`;
  const modules =
    check?.kind === "npm"
      ? `
- Your worktree has no node_modules of its own; it borrows the install at the repo root
  (\`${ROOT_FROM_WORKTREE}/node_modules\`). To inspect a dependency's types or source, read that
  directory directly instead of widening the search outward.`
      : "";
  return `
Rules for this run:

Orientation — read this much before choosing your task, and no more:
- First read the project brief (${briefFile}) in full, plus QUESTIONS.md when present.
- PLANS.md and BUGS.md grow without bound — never read them wholesale. Their actionable
  sections come first (## Planned before ## Done; ## Open before ## Fixed): the prompt's
  <backlog-index> block lists the actionable entries (PLANS.md ## Planned, BUGS.md ## Open,
  QUESTIONS.md ## Open) with each entry's 1-based line range, so read only the entries you need
  by those ranges — Planned plus recent Done entries, Open plus recent Fixed ones. Consult older
  history via git log or a targeted read only when a specific entry is needed. The steward role
  is the exception: it curates those files and must see them whole.
- Your worktree starts clean at main, and the harness checks main's build before code roles
  start: do not run the build or test suite just to establish a baseline. Run it after your
  change, or when the task itself needs its output (reproducing a failure, counting the suite).

Scope:
${scope}

Reading budget:
${CONTEXT_BUDGET_RULE}

Where you work:
- Stay inside your worktree: run commands from it — the directory you start in, where
  \`git log\` and \`git show\` work just the same — or from a scratch directory under the system
  temp.
- Never cd to the repo root (\`${ROOT_FROM_WORKTREE}\`): it is the primary checkout, which the harness
  lands main into while you work, and when this project is the harness itself its dist/ is the
  code the running fleet executes — never build, test, or edit files in that checkout.${modules}
- Never run an unbounded scan (\`find /\`, \`grep -r /\`, any recursive search rooted outside the
  repo): it runs for tens of minutes with no output until the harness kills your tick as hung.
- Never run a command that can wait forever — interactive programs (TUIs, REPLs, editors,
  anything reading stdin), servers, or watch modes. To test such a program, background it with
  a hard time limit (kill it after at most 30 minutes) and never give it a real TTY.
- Leave the project working: ${verify} One run answers every question about the check: write
  its full output to a file in a scratch dir once (\`<check> > <scratch-dir>/check.log 2>&1\`),
  then pipe that file through \`tail\` — only the failures matter. To see any other part of the
  output, grep or read the same file; re-run the check only after an edit changes the tree.
${TEST_RUNNER_RULE}

Boundaries:
- Never create, amend, or revert git commits, branches, or merges — the harness handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the initial prompt block in ${briefFile} (between the tumwater:prompt markers).
- PRINCIPLES.md holds this project's design principles; only the director and steward roles may
  edit it. Treat it as read-only — to object to a principle, record the objection in PLANS.md.

When to ask, when to refuse:
- When a fork in the road is genuinely the user's call (product direction, an irreversible
  choice, taste), do not guess: append a question to QUESTIONS.md under ## Open with context,
  the options, and your own recommendation. Then continue with the parts that don't depend on
  it, or end the run. Never block on an unanswered question; check QUESTIONS.md for answers at
  the start of each tick and act on one that unblocks your work. Do not re-ask an open question.
- If partway in you conclude the task would harm the project — it violates PRINCIPLES.md, grows
  complexity without justification, or keeps fighting back — refuse it. Revert nothing; append
  this note directly under the entry's heading in PLANS.md (a planned feature) or BUGS.md:
  **Refused <YYYY-MM-DD> by <role>: <one-line reason>**
  That note is the only change a refusing run leaves.
- When choosing work, skip entries carrying a Refused note — do not pick them and do not
  re-refuse them. The objection stands until a human or the director edits the entry, so a
  fully blocked backlog is a legitimate nothing-to-do state.

${CLAIMS_RULE}

How to end your reply — the harness parses it, so the form matters:
- Your last message is plain text: never a tool call, and never an announcement of what you would
  do next ("Let me check…") — either make the call or finish. If a tool result only repeats what
  you already have, do not call it again.
${REPLY_ENDINGS}`;
}

/** The <principles> block injected into every tick and director prompt: the project's codified
 * taste, phrased positively so loops follow it rather than merely avoid violations. The file
 * itself is read by principles.ts's readPrinciples. */
function principlesBlock(principles: string): string {
  return `Design principles this project holds — uphold them in everything you produce:\n<principles>\n${principles}\n</principles>`;
}

/** The <failure-digest> block injected into the telemetry role's prompt (plans/telemetry-role.md):
 * the harness renders the digest from its own event log at the project root and hands it over, so
 * the role spends no tool calls acquiring evidence and cannot read a stale or foreign log. */
function digestBlock(digest: string): string {
  return `Runtime failure digest of this harness's own event log — your evidence base:\n<failure-digest>\n${digest}\n</failure-digest>`;
}

/** The role's notebook as shown to it: its own earlier ticks' note, labeled as unverified.
 * Rides only when there is a non-empty note; the standing instruction to write one is always
 * present (roleNotesInstruction), so a role's FIRST tick — with no note yet — still learns the
 * tool exists and can seed the notebook. */
function roleNotesBlock(notes: string): string {
  return `Notes your role wrote in earlier ticks (yours, unverified — check against the code before
relying on them):\n<role-notes>\n${notes.trim()}\n</role-notes>`;
}

/** The standing instruction that makes the notebook seedable: every role tick is told it may
 * write one, so the first tick (when no note exists yet) can create it. The note content block
 * (roleNotesBlock) is what is omitted when there is nothing to show. */
const ROLE_NOTES_INSTRUCTION = `Before you end, if you learned something the next tick of your role should know (where
things live, what you ruled out and why, what you would look at next), call role_notes with
the full replacement note (at most 4 KB). Do not copy backlog entries into it — PLANS.md and
BUGS.md hold the work itself.`;

interface TickPromptInput {
  role: Role;
  initialPrompt: string;
  /** PRINCIPLES.md content (see readPrinciples); omitted from the prompt when empty. */
  principles?: string;
  /** Rendered failure digest (see src/failure/failure-render.ts); telemetry only, omitted when unreadable. */
  digest?: string;
  /** Rendered flow-coverage block (see tick/qa-coverage.ts); qa only, omitted when unreadable. */
  coverage?: string;
  /** Rendered stranded-plan block (see backlog-structure.ts); clean only, omitted when the
   * primary checkout's PLANS.md is missing, unreadable, or clean. */
  backlogStructure?: string;
  /** Rendered actionable backlog index (see backlog-structure.ts); every tick carries it. */
  backlogIndex?: string;
  /** The role's notebook (roleNotesPath, read by tick-prompt.ts): the note its own earlier
   * ticks wrote. A missing/empty/whitespace-only note is passed as undefined, so the
   * <role-notes> block is omitted; the write instruction is always present. The director
   * never reaches buildTickPrompt, so it never carries either. */
  notes?: string;
  extraInstructions?: string;
  /** A per-role prompt the user queued for this loop's next tick (`tumwater prompt --role <id>`,
   * PLANS.md "Per-role prompts 1/2"), rendered as a labeled block near the top of the task text.
   * The loop still owns find-something-to-do: the request steers, the role's rules and the
   * landing gate still apply unchanged. Omitted: no queued request this tick. */
  userRequest?: string;
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
  const { role, initialPrompt, principles, digest, coverage, backlogStructure, backlogIndex, notes, extraInstructions, check, briefFile, today, userRequest } = input;
  const parts = [
    `You are the "${role.id}" loop (${role.title}) of tumwater, an autonomous development harness.`,
    ...sharedPreamble(initialPrompt, today),
  ];
  if (principles) parts.push(principlesBlock(principles));
  if (userRequest)
    parts.push(
      `An explicit request from the user, aimed at this loop. Treat it as this tick's steering;
your role's rules and the landing gate still apply unchanged. If the request is out of this
role's scope, say so in your reply instead of doing it anyway.\n<user-request>\n${userRequest.trim()}\n</user-request>`,
    );
  if (coverage) parts.push(coverage);
  if (digest) parts.push(digestBlock(digest));
  if (backlogStructure) parts.push(backlogStructure);
  if (backlogIndex) parts.push(backlogIndex);
  if (notes && notes.trim() !== "") parts.push(roleNotesBlock(notes));
  parts.push(`Your task this run:\n${role.find.trim()}`);
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  parts.push(ROLE_NOTES_INSTRUCTION);
  parts.push(commonRules(check, briefFile, role.scope).trim());
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
  /** Rendered actionable backlog index (see backlog-structure.ts); the tick prompt carries it
   * too, so the director can route against the same bounded view of the backlog. */
  backlogIndex?: string,
): string {
  const parts = [
    `You are the "director" loop of tumwater, an autonomous development harness. The user steers
the project by sending it requests; one has just arrived. Other specialist loops continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    ...sharedPreamble(initialPrompt, today),
  ];
  if (principles) parts.push(principlesBlock(principles));
  if (backlogIndex) parts.push(backlogIndex);
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
- A decision about a marked plan (e.g. "split plan X", "keep plan X whole", "replan X"):
  split it into independently landable sub-plans per PLAN_SIZING, or clear the
  ${NEEDS_REVIEW_NOTE} note, or clear a ${NEEDS_REPLAN_NOTE} note and rewrite the entry — per
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
  // Before the shared rules, not after them: the closing reply contract stays the last thing
  // in the prompt, where a model attends to it most (the tick prompt's invariant too).
  parts.push(
    `Note on one boundary in the rules below, director only: user-defined-loop requests are
executed by writing .tumwater-config-request.json in your worktree (shape and worked example
above) — never by editing tumwater.json, which stays off-limits to you as to every role. The
harness validates the request and applies only its customLoops array; a request that also names
any other setting (timeouts, budgets, role enablement, review settings) has that key discarded
with a warning, so such a request is guidance to record per the routing rules, not an edit you
can make.`,
  );
  parts.push(commonRules(check, briefFile).trim());
  return parts.join("\n\n");
}
