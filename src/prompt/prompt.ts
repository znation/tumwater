// vocabulary: plain
import path from "node:path";
import { describeCheck } from "../build/build-check-report.js";
import type { BuildCheck } from "../build/build-check-detect.js";
import type { Role } from "../roles/roles.js";
import { DECOMPOSITION_GUIDANCE, NEEDS_REPLAN_NOTE, NEEDS_REVIEW_NOTE, PLAN_SIZING } from "../roles/role-guidance.js";
import { CLAIMS_RULE, CLAIMS_RULE_COMPACT, REPLY_ENDINGS } from "../verdict/reply-contract.js";
import { todayStamp } from "../budget/budget.js";
import { daysBetween } from "../text/datetime.js";
import { plural } from "../text/phrases.js";
import { worktreePath } from "../paths.js";
import { PI_DIALECT, dialectFor, type PromptDialect } from "./dialect.js";

/** Prompt construction for the role loops' pi runs (tick and director). The reply contract those
 * runs must follow — the TUMWATER_NOTHING_TO_DO sentinel, the TUMWATER_REFUSED line, the
 * SUMMARY/WHY/RISK/VERIFIED block format, the three endings, and the claims rules — lives in
 * reply-contract.ts; this module weaves it into each prompt. The follow-up prompts that pick a
 * session back up — the resume bridge, the missing-summary recovery, and the fresh-tick cut-off
 * note — live in prompt-followup.ts. The merge gate's pi runs (conflict resolution, build fix,
 * review) build their prompts in gate-prompts.ts; assembling a reply into the tick's commit message
 * lives in git/commit-message.ts.
 *
 * The prose is tuned for the team's models (2026-10-01): the primary GLM-5.3-Flash (an 18B-active
 * MoE behind a ~1M window) and the budget fallback's local Qwen3.8-27B (~127k window). Both follow
 * short grouped rules with concrete numbers and literal commands far better than long dense
 * paragraphs, over-read when told merely to "work economically", make unchecked claims the reviewer
 * then rejects (the primary's leading rejection cause), and need to be told how a reply must end
 * — so the rules are grouped with one rule per bullet, budgets are numeric, role tasks are
 * numbered steps, claims carry the check that proves them, the three possible endings are a
 * mutually exclusive list, and that closing contract comes last, where a model attends to it most.
 * The one model-conditional part is the compact variant (`CompactPrompt`) a run on a model
 * that declares a window of at most 128k gets: the same rules in fewer words, and an assigned
 * run without the material its assignment makes redundant. Every larger or unknown window gets
 * the full prompt, unchanged. The PRINCIPLES.md reader the principles block is fed from lives in
 * principles.ts (readPrinciples, with its injection cap). */

/** The compact variant of a run's prompt, for a model that declares a window of at most 128k
 * (context-window.ts compactPromptWindow): its first request is re-sent on every turn and is a
 * real share of the window, so the rules keep their directives without the reasons, the
 * principles block keeps only its bullets, and an `assigned` run — one tumwater handed a single
 * backlog entry — drops the backlog index and reads its entry first instead of the whole brief.
 * The caller also leaves the brief block out (tick-prompt.ts): the brief file holds the same
 * text. Absent: the full prompt. */
export interface CompactPrompt {
  assigned: boolean;
}

/** The context-budget rule every run carries. Under the old 87k window half of all ticks ended
 * at the ceiling merging nothing (308 of 733 in the autonomous fortnight; 216 of 245 no-change
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
export function contextBudgetRule(dialect: PromptDialect = PI_DIALECT): string {
  return `- Your context window is finite: everything you read stays in it until the run ends, and a
  run that fills the window lands nothing. A whole-file read of a 500-line module costs ~5k tokens.
- Check size before reading (\`wc -l\`) and read files over ~300 lines in ranges: find the lines
  with \`grep -n\`, then read them with ${dialect.readRange}.
- Cap command output with \`head\`/\`tail\`. Never dump a file, a log, or a test run wholesale.
- Do not re-read what you already saw — re-read only a region you edited.
- Each turn re-sends everything read so far, so issue lookups that do not depend on each other
  (a \`wc -l\` over several files, the ranges a \`grep -n\` found, a typecheck and a targeted
  test) as separate tool calls in the same turn. Keep anything that depends on a prior result
  sequential — do not batch an edit with the test that checks it.
- ${dialect.oversizedOutput}`;
}

/** The pi-dialect reading-budget rule, byte-identical to the rule before the dialect split, for
 * the callers and tests that want the default text. */
export const CONTEXT_BUDGET_RULE = contextBudgetRule(PI_DIALECT);

/** contextBudgetRule for the compact prompt: the same habits, with the range-read threshold at
 * ~150 lines, which is what a 64k window's read cap holds (bounded-output.ts outputLimits). */
export function compactContextBudgetRule(dialect: PromptDialect = PI_DIALECT): string {
  return `- Your context window is small: everything you read stays in it until the run ends, and a run
  that fills it merges nothing. A whole read of a 500-line file costs ~5k tokens.
- Check size first (\`wc -l\`) and read files over ~150 lines in ranges: find the lines with
  \`grep -n\`, then read them with ${dialect.readRange}.
- Cap command output with \`head\`/\`tail\`; never dump a file, a log, or a test run. Do not
  re-read what you already saw.
- Issue lookups that do not depend on each other as separate tool calls in the same turn; keep
  dependent steps sequential.
- ${dialect.oversizedOutput}`;
}

/** The test-runner rule every run that may run tests carries: the tick and director rules, the
 * conflict resolver, and the reviewer. Project-neutral on purpose — a team works on any codebase
 * (npm, cargo, pytest, a configured check.command), so the rule names no ecosystem's runner as THE
 * right one: it points at the declared check or the framework already in use, and its one example
 * is labeled as a mismatch. A run that does not know the suite's runner guesses one: in the week
 * to 2026-10-05 the team's agents ran `npx vitest` 19 times in tumwater, a node:test repo, and
 * vitest killed the compiled tests mid-run, so no cleanup hook ran (BUGS.md 2026-10-05: ~725 temp
 * run roots abandoned and test children orphaned by one conflict resolver's five runs). Even where
 * a guess cannot do that damage, it wastes turns on a runner that finds no tests. tumwater's own
 * root vitest.config.mjs refuses vitest in this repo; this rule is the half that reaches every
 * project. Stated once so the three prompt families cannot drift. */
export const TEST_RUNNER_RULE = `- Run tests only through the project's declared check or the test framework it already uses —
  never a runner you guessed (say, \`npx vitest\` in a suite written for node:test): a mismatched
  runner finds no tests at best, and can kill them mid-run, leaking processes and temp files.`;

/** Render a dialect's `backendRules` as one bullet each, or nothing when the dialect has none
 * (pi and claude) — so a backend's extra shell/reasoning guidance rides the reading-budget
 * section right after the oversized-output rule and is present in both the full and compact
 * prompts. */
function backendRuleLines(rules: readonly string[] | undefined): string {
  if (!rules || rules.length === 0) return "";
  return "\n" + rules.map((rule) => `- ${rule}`).join("\n");
}

/** The date line every pi prompt carries — tick and director (via sharedPreamble) and the gate's
 * conflict and review runs — naming the local calendar day as YYYY-MM-DD. No prompt
 * used to say what day it is, so a run that had to write one (a BUGS.md heading's "(found by …
 * YYYY-MM-DD)", a Fixed or Refused date, NEEDS_REVIEW_NOTE's and NEEDS_REPLAN_NOTE's
 * <YYYY-MM-DD>, a plan deadline)
 * inferred it from the newest dates in the repo, which were themselves drifting: the team
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
 * checkout's absolute path and ran the suite in the live team's own checkout (BUGS.md). */
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
 * states its own (Role.scope). A rule added here goes in compactRules too, and its directive in
 * test/compact-prompt.test.ts's DIRECTIVES list, which checks that both forms state it. */
function commonRules(
  check?: BuildCheck,
  briefFile = "README.md",
  scope: string = DEFAULT_SCOPE,
  dialect: PromptDialect = PI_DIALECT,
  compact?: CompactPrompt,
): string {
  if (compact) return compactRules(check, briefFile, scope, dialect, compact.assigned);
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
  QUESTIONS.md ## Open) and the newest few ## Done and ## Fixed entries, each with its 1-based
  line range, so read only the entries you need
  by those ranges — Planned plus recent Done entries, Open plus recent Fixed ones. Consult older
  history via git log or a targeted read only when a specific entry is needed. The steward role
  is the exception: it curates those files and must see them whole.
- Your worktree starts clean at main, and tumwater checks main's build before code roles
  start: do not run the build or test suite just to establish a baseline. Run it after your
  change, or when the task itself needs its output (reproducing a failure, counting the suite).

Scope:
${scope}

Reading budget:
${contextBudgetRule(dialect)}${backendRuleLines(dialect.backendRules)}

Where you work:
- Stay inside your worktree: run commands from it — the directory you start in, where
  \`git log\` and \`git show\` work just the same — or from a scratch directory under the system
  temp.
- Other agents run concurrently on this machine: put scratch files under \`$TMPDIR\` (made with
  \`mktemp\`), never at a fixed \`/tmp\` path such as \`/tmp/check.log\`, so no other run overwrites
  or reads yours.
- Never cd to the repo root (\`${ROOT_FROM_WORKTREE}\`): it is the primary checkout, which tumwater
  merges main into while you work, and when this project is tumwater itself its dist/ is the
  code the running team executes — never build, test, or edit files in that checkout.${modules}
- Never run an unbounded scan (\`find /\`, \`grep -r /\`, any recursive search rooted outside the
  repo): it runs for tens of minutes with no output until tumwater kills your run as hung.
- Never run a command that can wait forever — interactive programs (TUIs, REPLs, editors,
  anything reading stdin), servers, or watch modes. To test such a program, background it with
  a hard time limit (kill it after at most 30 minutes) and never give it a real TTY.
- Leave the project working: ${verify} One run answers every question about the check: write
  its full output to a file in a scratch dir once (\`<check> > <scratch-dir>/check.log 2>&1\`),
  then pipe that file through \`tail\` — only the failures matter. To see any other part of the
  output, grep or read the same file; re-run the check only after an edit changes the tree.
${TEST_RUNNER_RULE}

Boundaries:
- Never create, amend, or revert git commits, branches, or merges — tumwater handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the brief block in ${briefFile} (between the tumwater:prompt markers).
- PRINCIPLES.md holds this project's design principles; only the director and steward roles may
  edit it. Treat it as read-only — to object to a principle, record the objection in PLANS.md.
- docs/invariants.md states each subsystem's guarantees, pinned to the test that enforces them.
  Read the matching section before you reconstruct what the code you are changing is supposed
  to guarantee; when a merge adds or changes a guarantee, update the register in the same
  commit.

When to ask, when to refuse:
- When a fork in the road is genuinely the user's call (product direction, an irreversible
  choice, taste), do not guess: append a question to QUESTIONS.md under ## Open with context,
  the options, and your own recommendation. Then continue with the parts that don't depend on
  it, or end the run. Never block on an unanswered question; check QUESTIONS.md for answers at
  the start of each run and act on one that unblocks your work. Do not re-ask an open question.
- If partway in you conclude the task would harm the project — it violates PRINCIPLES.md, grows
  complexity without justification, or keeps fighting back — refuse it. Revert nothing; append
  this note directly under the entry's heading in PLANS.md (a planned feature) or BUGS.md:
  **Refused <YYYY-MM-DD> by <role>: <one-line reason>**
  That note is the only change a refusing run leaves.
- When choosing work, skip entries carrying a Refused note — do not pick them and do not
  re-refuse them. The objection stands until a human or the director edits the entry, so a
  fully blocked backlog is a legitimate nothing-to-do state.

${CLAIMS_RULE}

How to end your reply — tumwater parses it, so the form matters:
- Your last message is plain text: never a tool call, and never an announcement of what you would
  do next ("Let me check…") — either make the call or finish. If a tool result only repeats what
  you already have, do not call it again.
${REPLY_ENDINGS}`;
}

/** commonRules for the compact prompt (CompactPrompt): every directive of the full rules, in
 * fewer words. Orientation differs for an assigned run, which reads its entry first and the
 * brief only when the entry needs it — reading the brief in full cost a median ~2.5k tokens of
 * every run before its first edit (2026-10-17 audit). Scope, Boundaries' first three bullets,
 * TEST_RUNNER_RULE and the reply contract are the full prompt's own text. Keep it in step with
 * commonRules: test/compact-prompt.test.ts checks every directive both must state. */
function compactRules(check: BuildCheck | undefined, briefFile: string, scope: string, dialect: PromptDialect, assigned: boolean): string {
  const verify = check
    ? `verify with ${describeCheck(check)} (the project's declared check) — run it after your
  change and fix what you broke.`
    : `if it has a build or test command, run it after your change and fix what you broke.`;
  const modules =
    check?.kind === "npm"
      ? `
- Your worktree has no node_modules; it borrows \`${ROOT_FROM_WORKTREE}/node_modules\`. Read a
  dependency's types or source there.`
      : "";
  const orientation = assigned
    ? `Orientation — read this much before you start, and no more:
- Read your assigned entry (at the end of this prompt) by its line range first. It replaces your
  task's choosing steps, so this prompt carries no backlog index. Read the project brief
  (${briefFile}) or QUESTIONS.md only when the entry needs them.
- PLANS.md and BUGS.md grow without bound — never read them wholesale. Read another entry only
  by a range this prompt gives, or find it with \`grep -n\` first.`
    : `Orientation — read this much before choosing your task, and no more:
- First read the project brief (${briefFile}) in full, plus QUESTIONS.md when present.
- PLANS.md and BUGS.md grow without bound — never read them wholesale. The <backlog-index> block
  gives each actionable entry and the newest closed ones with its 1-based line range: read only
  the entries you need, by range. The steward role is the exception: it curates those files and
  must see them whole.`;
  return `
Rules for this run:

${orientation}
- Your worktree starts clean at main and tumwater checks main's build first: do not run the
  build or test suite for a baseline. Run it after your change, or when the task needs its output.

Scope:
${scope}

Reading budget:
${compactContextBudgetRule(dialect)}${backendRuleLines(dialect.backendRules)}

Where you work:
- Run commands from your worktree (where you start; \`git log\` and \`git show\` work there) or a
  scratch directory. Put scratch files under \`$TMPDIR\` (made with \`mktemp\`), never at a fixed
  \`/tmp\` path: other agents run concurrently on this machine.
- Never cd to the repo root (\`${ROOT_FROM_WORKTREE}\`): it is the primary checkout tumwater merges
  into — never build, test, or edit files there.${modules}
- Never run an unbounded scan (\`find /\`, \`grep -r /\`, any recursive search rooted outside the
  repo) or a command that can wait forever (TUIs, REPLs, editors, anything reading stdin,
  servers, watch modes). To test such a program, background it with a hard time limit (at most
  30 minutes) and never give it a real TTY.
- Leave the project working: ${verify} Write the check's full output to a scratch file once
  (\`<check> > <scratch-dir>/check.log 2>&1\`) and \`tail\` it; grep that file for anything else, and
  re-run the check only after an edit changes the tree.
${TEST_RUNNER_RULE}

Boundaries:
- Never create, amend, or revert git commits, branches, or merges — tumwater handles all git
  operations. Reading git history is fine.
- Never touch the .tumwater directory or tumwater.json.
- Never edit the brief block in ${briefFile} (between the tumwater:prompt markers).
- PRINCIPLES.md is read-only to every role but the director and steward; record an objection to
  a principle in PLANS.md.
- docs/invariants.md pins each subsystem's guarantees to tests: read the matching section before
  changing that code, and update it in the same commit when a merge changes a guarantee.

When to ask, when to refuse:
- A fork that is genuinely the user's call (product direction, an irreversible choice, taste):
  do not guess. Append a question to QUESTIONS.md under ## Open with context, the options, and
  your recommendation, then continue with what does not depend on it, or end the run. Never
  block on a question, act on an answer that unblocks your work, and do not re-ask an open one.
- A task that would harm the project (it violates PRINCIPLES.md, grows complexity without
  justification, or keeps fighting back): refuse it. Revert nothing; append this note directly
  under the entry's heading in PLANS.md (a planned feature) or BUGS.md:
  **Refused <YYYY-MM-DD> by <role>: <one-line reason>**
  That note is the only change a refusing run leaves.
- Skip entries carrying a Refused note: never pick or re-refuse them. A fully blocked backlog is
  a legitimate nothing-to-do state.

${CLAIMS_RULE_COMPACT}

How to end your reply — tumwater parses it, so the form matters:
- Your last message is plain text: never a tool call, and never an announcement of what you would
  do next ("Let me check…") — either make the call or finish. If a tool result only repeats what
  you already have, do not call it again.
${REPLY_ENDINGS}`;
}

/** The principles block's compact form: PRINCIPLES.md from its first list item on, dropping the
 * file's own introduction (which restates the block's heading). A file with no list item is
 * kept whole. */
export function principleBullets(principles: string): string {
  const lines = principles.split("\n");
  const first = lines.findIndex((line) => /^[-*] /.test(line));
  return first <= 0 ? principles : lines.slice(first).join("\n");
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
  return `Runtime failure digest of tumwater's own event log — your evidence base:\n<failure-digest>\n${digest}\n</failure-digest>`;
}

/** The age clause opening the notes heading: `last saved today; `, `last saved <day>, N days
 * ago; `, or `last saved <day>; ` for a day after today (clock skew). Empty without both days. */
function savedClause(savedDay?: string, today?: string): string {
  if (!savedDay || !today) return "";
  const age = daysBetween(savedDay, today);
  if (age < 0) return `last saved ${savedDay}; `;
  if (age === 0) return "last saved today; ";
  return `last saved ${savedDay}, ${plural(age, "day")} ago; `;
}

/** The role's notebook as shown to it: its own earlier ticks' note, labeled as unverified.
 * Rides only when there is a non-empty note; the standing instruction to write one is always
 * present (roleNotesInstruction), so a role's FIRST tick — with no note yet — still learns the
 * tool exists and can seed the notebook. */
function roleNotesBlock(notes: string, savedDay?: string, today?: string): string {
  return `Notes your role wrote in earlier runs (${savedClause(savedDay, today)}yours, unverified — check against the code before
relying on them):\n<role-notes>\n${notes.trim()}\n</role-notes>`;
}

/** The standing instruction that makes the notebook seedable: every role tick is told it may
 * write one, so the first tick (when no note exists yet) can create it. The note content block
 * (roleNotesBlock) is what is omitted when there is nothing to show. */
export function roleNotesInstruction(dialect: PromptDialect = PI_DIALECT): string {
  // A backend whose dialect carries no notes tool (`notesTool: ""`) has no tool to call,
  // so no instruction is rendered at all rather than one naming a tool the model lacks.
  if (dialect.notesTool === "") return "";
  return `Before you end, if you learned something the next run of your role should know (where
things live, what you ruled out and why, what you would look at next), call ${dialect.notesTool} with
the full replacement note (at most 4 KB). Do not copy backlog entries into it — PLANS.md and
BUGS.md hold the work itself.`;
}

interface TickPromptInput {
  role: Role;
  initialPrompt: string;
  /** PRINCIPLES.md content (see readPrinciples); omitted from the prompt when empty. */
  principles?: string;
  /** Rendered failure digest (see src/failure/failure-render.ts); telemetry only, omitted when
   * unreadable. */
  digest?: string;
  /** Rendered flow-coverage block (see tick/qa-coverage.ts); qa only, omitted when unreadable. */
  coverage?: string;
  /** Rendered stranded-plan block (see backlog-structure.ts); clean only, omitted when the
   * primary checkout's PLANS.md is missing, unreadable, or clean. */
  backlogStructure?: string;
  /** Rendered closed-section overflow block (see records-overflow.ts); steward only, omitted when
   * both closed sections are within the policy or unreadable. */
  recordsOverflow?: string;
  /** Rendered actionable backlog index (see backlog-structure.ts); every tick carries it. */
  backlogIndex?: string;
  /** The role's notebook (roleNotesPath, read by tick-prompt.ts): the note its own earlier
   * ticks wrote. A missing/empty/whitespace-only note is passed as undefined, so the
   * <role-notes> block is omitted; the write instruction is always present. The director
   * never reaches buildTickPrompt, so it never carries either. */
  notes?: string;
  /** The note file's mtime as a local YYYY-MM-DD (read by tick-prompt.ts). Omitted: the notes
   * heading carries no age. */
  notesSavedDay?: string;
  extraInstructions?: string;
  /** The plan charter's stop target, rendered right after the charter's task text. The catalog
   * text is config-free, so the concrete eligible-plan count (`planBacklogTarget`) is supplied
   * here by the caller that holds the config; a role payload's `nextPrompt` therefore shows the
   * resolved number, never a placeholder. Omitted: every role but plan. */
  planTargetNote?: string;
  /** The bugfix run's flake tally, rendered by tick-prompt.ts; omitted for every other role and
   * when no flake was excused in the window. */
  flakyChecks?: string;
  /** A per-role prompt the user queued for this loop's next tick (`tumwater prompt --role <id>`),
   * rendered as a labeled block near the top of the task text.
   * The loop still owns find-something-to-do: the request steers, the role's rules and the
   * merge gate still apply unchanged. Omitted: no queued request this tick. */
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
  /** The agent backend this role resolves to (`configForRole(config, role).agent`), selecting
   * the prompt dialect (./dialect.ts). Omitted: pi's dialect. */
  agent?: string;
  /** The compact variant for a small-window model (CompactPrompt). Omitted: the full prompt. The
   * caller drops the brief and backlog index of an assigned run itself, since it supplies them. */
  compact?: CompactPrompt;
}

/** The retired names a model still meets in code, git history and logs, mapped to today's terms
 * (plans/terminology.md "Glossary"). The one place these words may appear in a prompt. */
const OLDER_NAMES_MAP = "loop = role, tick = run, fleet = team, landing/landed = merge/merged, vetted = approved, notebook = notes, initial prompt = brief"; // vocabulary-ok: maps retired names

/** The sentence every assembled prompt carries once: the older names and where all of them are
 * listed. Interpolated into the shared preamble and the reviewer and resolver openers. */
export const OLDER_NAMES_SENTENCE = `Older tumwater names still appear in code, git history and logs: ${OLDER_NAMES_MAP}; docs/glossary.md in tumwater's repository lists them all.`;

/** Shared opening of every loop prompt: where the run happens, what day it is, and why the
 * project exists. Defined once so the tick and director prompts cannot drift — and so the one
 * sentence telling every role to date its records from dateLine, not from the repo, reaches
 * each of them without editing any role text. */
function sharedPreamble(initialPrompt: string, today?: string): string[] {
  const parts = [
    `You work in a dedicated git worktree of this project; your changes will be committed and merged to main by tumwater after you finish.`,
    `${dateLine(today)} Stamp it on anything you record now — a new BUGS.md heading ends
"(found by the <role> role YYYY-MM-DD)", a closing date reads "— fixed YYYY-MM-DD by the <role> role",
a new PLANS.md heading reads "(planned YYYY-MM-DD by the <role> role …)", and a Refused or
Needs-review note carries the date too — and count plan deadlines from it; never infer the date
from the repo.`,
    OLDER_NAMES_SENTENCE,
  ];
  if (initialPrompt) {
    parts.push(`The project's brief — its reason to exist — is:\n<project-prompt>\n${initialPrompt}\n</project-prompt>`);
  }
  return parts;
}

/** The full prompt for one role run. */
export function buildTickPrompt(input: TickPromptInput): string {
  const { role, initialPrompt, principles, digest, coverage, backlogStructure, recordsOverflow, backlogIndex, notes, notesSavedDay, extraInstructions, planTargetNote, flakyChecks, check, briefFile, today, userRequest, agent, compact } = input;
  const dialect = dialectFor(agent);
  const day = today ?? todayStamp();
  const parts = [
    `You are the "${role.id}" role (${role.title}) on this project's tumwater team — tumwater runs a team of AI roles that develop the project.`,
    ...sharedPreamble(initialPrompt, day),
  ];
  if (principles) parts.push(principlesBlock(compact ? principleBullets(principles) : principles));
  if (userRequest)
    parts.push(
      `An explicit request from the user, aimed at this role. Treat it as this run's steering;
your role's rules and the merge gate still apply unchanged. If the request is out of this
role's scope, say so in your reply instead of doing it anyway.\n<user-request>\n${userRequest.trim()}\n</user-request>`,
    );
  if (coverage) parts.push(coverage);
  if (digest) parts.push(digestBlock(digest));
  if (backlogStructure) parts.push(backlogStructure);
  if (recordsOverflow) parts.push(recordsOverflow);
  if (backlogIndex) parts.push(backlogIndex);
  if (notes && notes.trim() !== "") parts.push(roleNotesBlock(notes, notesSavedDay, day));
  parts.push(`Your task this run:\n${role.find.trim()}`);
  if (planTargetNote) parts.push(planTargetNote.trim());
  if (flakyChecks) parts.push(flakyChecks.trim());
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  const notesInstruction = roleNotesInstruction(dialect);
  if (notesInstruction !== "") parts.push(notesInstruction);
  parts.push(commonRules(check, briefFile, role.scope, dialect, compact).trim());
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
  /** The agent backend the director resolves to, selecting the prompt dialect (./dialect.ts).
   * Omitted: pi's dialect. */
  agent?: string,
  /** The compact variant for a small-window model; a director run is never assigned an entry.
   * Omitted: the full prompt. */
  compact?: boolean,
  /** The director's `roles.director.instructions` override — its run prompt is otherwise the
   * user's request. Omitted: no `Additional standing instructions` block, exactly as today. */
  extraInstructions?: string,
): string {
  const variant: CompactPrompt | undefined = compact ? { assigned: false } : undefined;
  const parts = [
    `You are the "director" role on this project's tumwater team — tumwater runs a team of AI roles that develop the project. The user steers
the project by sending it requests; one has just arrived. Other specialist roles continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    ...sharedPreamble(initialPrompt, today),
  ];
  if (principles) parts.push(principlesBlock(variant ? principleBullets(principles) : principles));
  if (backlogIndex) parts.push(backlogIndex);
  parts.push(`The user's request:\n<user-request>\n${userPrompt.trim()}\n</user-request>`);
  parts.push(
    `Interpret the request as a project-level command and route it — do NOT implement substantial
work yourself:
- A feature request or substantial change: write a concrete plan for it in PLANS.md (goal,
  approach, files touched, acceptance criteria) so the feature role implements it. Do not build
  it now. ${PLAN_SIZING}
- A bug report: record it in BUGS.md (symptom, how to reproduce, suspected cause — investigate
  briefly to sharpen the report) so the bugfix role fixes it. Do not fix it now.
- Guidance, a decision, or a constraint (e.g. "prefer X", "drop feature Y"): record it durably
  where future roles will see it — PRINCIPLES.md first for standing design guidance and taste;
  README.md, PLANS.md, or BUGS.md otherwise — and remove anything it supersedes.
- A question: answer it in your final reply, and record anything durable it surfaced.
- An answer to an open question (e.g. "answer Q3: choose SQLite"): move that entry from
  QUESTIONS.md's ## Open section to ## Answered verbatim with the decision recorded, and apply
  or route any follow-on work it implies.
- A decision about a refused entry (e.g. "clear the refusal on plan X", "reconsider plan Y"):
  clear its **Refused …** note from PLANS.md/BUGS.md — or revise the entry per the user's
  direction — so roles can pick it up again.
- A decision about a marked plan (e.g. "split plan X", "keep plan X whole", "replan X"):
  split it into independently landable sub-plans per PLAN_SIZING, or clear the
  ${NEEDS_REVIEW_NOTE} note, or clear a ${NEEDS_REPLAN_NOTE} note and rewrite the entry — per
  the user's direction.
- A request to manage custom roles ("add a role named X that does Y", "remove X",
  "move X before Y"): write the FULL replacement customRoles array to
  .tumwater-config-request.json at your worktree root — the shape is
  { "customRoles": [ { "name": "…", "task": "…" } ] }. Add appends an entry with a name in
  [a-z0-9_-] no built-in role uses and a task written as the role's standing per-run
  instruction (one clear paragraph); remove deletes the entry; move reorders entries (array
  order is display/scheduling order). The array REPLACES the current one — include every role
  that should exist, not only the changed entries. Worked example — to add a role named docs
  that keeps the examples current and drop one named scrape, write the file containing exactly
  the surviving entries:
  { "customRoles": [ { "name": "docs", "task": "Keep the examples/ directory current with the latest API changes." } ] }.
  Write the file and stop: tumwater validates it, applies it to the live config, and deletes
  it; the roles start on their own and the request file is never committed.
- Only a trivially small direct edit (fix a typo, tweak a doc line, adjust a config value the
  user explicitly stated) may be done immediately instead of routed.
- Investigate only as much as routing precisely needs — grep and ranged reads to name the right
  files, functions, and suspected cause — never a survey of the codebase, and never the
  implementation itself.
- ${DECOMPOSITION_GUIDANCE}`,
  );
  if (extraInstructions) parts.push(`Additional standing instructions from the user:\n${extraInstructions.trim()}`);
  // Before the shared rules, not after them: the closing reply contract stays the last thing
  // in the prompt, where a model attends to it most (the tick prompt's invariant too).
  parts.push(
    `Note on one boundary in the rules below, director only: user-defined-role requests are
executed by writing .tumwater-config-request.json in your worktree (shape and worked example
above) — never by editing tumwater.json, which stays off-limits to you as to every role. Tumwater
validates the request and applies only its customRoles array; a request that also names
any other setting (timeouts, budgets, role enablement, review settings) has that key discarded
with a warning, so such a request is guidance to record per the routing rules, not an edit you
can make.`,
  );
  parts.push(commonRules(check, briefFile, undefined, dialectFor(agent), variant).trim());
  return parts.join("\n\n");
}
