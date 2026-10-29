import path from "node:path";
import { describeCheck } from "../build/build-check-report.js";
import type { BuildCheck } from "../build/build-check-detect.js";
import type { Role } from "../roles/roles.js";
import { DECOMPOSITION_GUIDANCE, NEEDS_REVIEW_NOTE, PLAN_QUEUE_GUIDANCE, PLAN_SIZING } from "../roles/role-guidance.js";
import { CLAIMS_RULE, REPLY_ENDINGS } from "../verdict/reply-contract.js";
import { todayStamp } from "../budget/budget.js";
import { daysBetween } from "../text/datetime.js";
import { plural } from "../text/phrases.js";
import { worktreePath } from "../paths.js";
import { PI_DIALECT, dialectFor, type PromptDialect } from "./dialect.js";

/** Prompt construction for the roles' pi runs (run and director). The reply contract those
 * runs must follow — the TUMWATER_NOTHING_TO_DO sentinel, the TUMWATER_REFUSED line, the
 * SUMMARY/WHY/RISK/VERIFIED block format, the three endings, and the claims rules — lives in
 * reply-contract.ts; this module weaves it into each prompt. The follow-up prompts that pick a
 * session back up — the resume bridge, the missing-summary recovery, and the fresh-run cut-off
 * note — live in prompt-followup.ts. The merge gate's pi runs (conflict resolution, build fix,
 * review) build their prompts in gate-prompts.ts; assembling a reply into the run's commit message
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
 * The prompt is compact: its first request is re-sent on every turn, so the rules keep their
 * directives without the reasons, the principles block keeps only its bullets, the brief file is
 * read rather than inlined, and an assigned run goes without the material its assignment makes
 * redundant. It was written for models with a window of at most 128k (2026-10-17) and became
 * every model's prompt on 2026-10-18 to cut the tokens each turn re-sends; the longer full
 * variant was deleted after a day of the team's runs on it (2026-10-19). The PRINCIPLES.md reader
 * the principles block is fed from lives in principles.ts (readPrinciples, with its injection
 * cap). */

/** The context-budget rule every run carries. Under the old 87k window half of all runs ended
 * at the ceiling merging nothing (308 of 733 in the autonomous fortnight; 216 of 245 no-change
 * runs in the first week of September), almost all of it whole-file reads: the model, told only
 * to "work economically", read the codebase file by file (277 whole-file reads against 6 ranged
 * ones in the bugfix/improve/clean logs). Every token read is prefill and dilutes the model's
 * attention, so the rule states the cost in numbers and the one habit that prevents it: check
 * size, then read in ranges. The range-read threshold is ~150 lines, what a 64k window's read cap
 * holds (bounded-output.ts outputLimits), and the first bullet names the cost rather than the
 * window's size, since every model gets it. One rule per bullet (2026-10-01), so a small model can
 * follow each on its own. (Reasoning length is not addressed here: a "think briefly" bullet
 * measured no drop in the fallback model's thinking — the oMLX thinking-budget cap is the lever.)
 * The bundled context-budget extension (src/pi-extension/context-budget.ts) complements this rule
 * with the live fill level. Stated once so the run rules and prompt-followup.ts's resume bridge
 * cannot drift. Must not contain the phrase "ran out of context" — the loop tests use it to tell
 * a fresh run from a cut-off resume. */
export function contextBudgetRule(dialect: PromptDialect = PI_DIALECT): string {
  return `- Everything you read stays in your context until the run ends and is re-sent on every turn;
  a run that fills the window merges nothing. A whole read of a 500-line file costs ~5k tokens.
- Check size first (\`wc -l\`) and read files over ~150 lines in ranges: find the lines with
  \`grep -n\`, then read them with ${dialect.readRange}.
- Cap command output with \`head\`/\`tail\`; never dump a file, a log, or a test run. Do not
  re-read what you already saw.
- Issue lookups that do not depend on each other as separate tool calls in the same turn; keep
  dependent steps sequential.
- ${dialect.oversizedOutput}`;
}

/** The process-kill rule every run that may run commands carries, word for word: the run and
 * director rules (full and compact, each adding its own reason), the conflict resolver, and the
 * reviewer. The team's runs and tumwater's own checks share one host, so a kill by pattern
 * reaches them all. On 2026-10-18 a feature run's `pkill -f "dist/test/test-runner.js"; pkill -f
 * "npm run test"` killed two sibling review runs, and a plan run's `pkill -f "npm run test"`
 * killed the coverage run and four lab pi runs (BUGS.md 2026-10-18). Moving pi's prompt from argv
 * to stdin keeps prompt text out of pi's command line; check runs and test runners still match. */
export const KILL_BY_PID_RULE = `Never kill processes by name or pattern (\`pkill\`, \`killall\`,
  \`pgrep … | xargs kill\`): stop only a process you started, by its PID (\`kill $!\` right after
  backgrounding it).`;

/** The test-runner rule every run that may run tests carries: the run and director rules, the
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

/** The synthetic-load rule every run that may run commands carries, word for word: the run and
 * director rules (full and compact). The bounding sentence is the point — a loader that ends with
 * the command cannot leak. 2026-10-28: seven leaked \`while :; do :; done\` loops from bugfix runs
 * reproducing a load flake stood at PPID 1 loading the shared host (BUGS.md): macOS \`ps -E\`
 * hides the environment of platform binaries like bash, so the end-of-run marker sweep cannot
 * attribute them to a run to reap them. The only reliable prevention is never starting unbounded
 * load in the first place — a leaked platform-binary loader cannot be reaped on macOS by any
 * sweep that exists. */
export const SYNTHETIC_LOAD_RULE = `The host is shared by every run, review, and check on the team,
  and already under load; never add synthetic CPU load (a \`while :; do :; done\` spinner, a
  CPU-spinning node process) to reproduce a load flake unless it ends with the command that starts
  it — a \`timeout\`, or backgrounded and killed with \`kill $!\` before that tool call returns. A
  loader that outlives its command is an orphan no sweep can reliably reap, and loads the host
  every sibling run and check runs on until a \`tumwater doctor\` sweep or a human stops it.`;

/** Render a dialect's `backendRules` as one bullet each, or nothing when the dialect has none
 * (pi and claude) — so a backend's extra shell/reasoning guidance rides the reading-budget
 * section right after the oversized-output rule. */
function backendRuleLines(rules: readonly string[] | undefined): string {
  if (!rules || rules.length === 0) return "";
  return "\n" + rules.map((rule) => `- ${rule}`).join("\n");
}

/** The date line every pi prompt carries — run and director (via sharedPreamble) and the gate's
 * conflict and review runs — naming the local calendar day as YYYY-MM-DD. No prompt
 * used to say what day it is, so a run that had to write one (a BUGS.md heading's "(found by …
 * YYYY-MM-DD)", a Fixed or Refused date, NEEDS_REVIEW_NOTE's
 * <YYYY-MM-DD>, a plan deadline)
 * inferred it from the newest dates in the repo, which were themselves drifting: the team
 * stamped entries days into the future and each wrong date seeded the next. The day is
 * todayStamp's — the same local-day computation as the daily cost budget window — and every
 * builder takes it as an optional trailing `today` that falls through to this default, so tests
 * pin an exact date and a new call site cannot forget it. */
export function dateLine(today: string = todayStamp()): string {
  return `Today's date is ${today} (local time).`;
}

/** The repo root as a role's worktree reaches it (`../../..`, out of .tumwater/worktrees/<role>),
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

/** The rules every role prompt carries — run and director alike, so the two cannot drift.
 * `check` — the project's resolved check (plans/portability.md §6/7) — names the actual
 * verification command in the Leave-the-project-working rule instead of asserting npm, and
 * only an npm check keeps the node_modules borrowing sentence: false and actively misleading
 * in a repo with no node_modules anywhere (a Python, Rust, or Go repo, or one with no check
 * at all). Undefined keeps the generic wording, exactly as prompts read before a check could
 * be configured. `scope` is the Scope section's rules: DEFAULT_SCOPE unless the run's role
 * states its own (Role.scope). Orientation differs for an `assigned` run, which reads its entry
 * first and the brief only when the entry needs it — reading the brief in full cost a median
 * ~2.5k tokens of every run before its first edit (2026-10-17 audit). */
function commonRules(
  check?: BuildCheck,
  briefFile = "README.md",
  scope: string = DEFAULT_SCOPE,
  dialect: PromptDialect = PI_DIALECT,
  assigned = false,
  gateCommand?: string,
): string {
  const verify = check && gateCommand
    ? `verify the change with a compile or the one or two test files that cover it — run them
  after your change and fix what you broke. Tumwater runs the full gate (\`${gateCommand}\`)
  itself before the change merges; do not run it.`
    : check
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
- Never read PLANS.md, BUGS.md or their archives (PLANS-DONE.md, BUGS-FIXED.md) whole. Read
  another entry only by a range this prompt gives, or find it with \`grep -n\` first.`
    : `Orientation — read this much before choosing your task, and no more:
- First read the project brief (${briefFile}) in full, plus QUESTIONS.md when present.
- PLANS.md and BUGS.md hold open work: the <backlog-index> block gives each actionable entry
  with its 1-based line range, so read only the entries you need, by range. Finished entries live
  in PLANS-DONE.md and BUGS-FIXED.md, newest first (the index lists the newest few). Never read
  those archives whole: grep them, or read one entry by its range, only when a finished entry
  matters to your task.`;
  return `
Rules for this run:

${orientation}
- Your worktree starts clean at main and tumwater checks main's build first: do not run the
  build or test suite for a baseline. Run it after your change, or when the task needs its output.

Scope:
${scope}

Reading budget:
${contextBudgetRule(dialect)}${backendRuleLines(dialect.backendRules)}

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
- ${KILL_BY_PID_RULE} A pattern also kills other agents' runs and checks.
- ${SYNTHETIC_LOAD_RULE}
- Leave the project working: ${verify} Write the check's full output to a scratch file once
  (\`${gateCommand ? "<gate>" : "<check>"} > <scratch-dir>/check.log 2>&1\`) and \`tail\` it; grep that file for anything else, and
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
  The one-line reason must name what in this entry makes it harmful; another entry's hold, or
  your own notes, is never a reason — skip that entry instead. That note is the only change a
  refusing run leaves.
- Skip entries carrying a Refused note: never pick or re-refuse them. A fully blocked backlog is
  a legitimate nothing-to-do state.

${CLAIMS_RULE}

How to end your reply — tumwater parses it, so the form matters:
- Your last message is plain text: never a tool call, and never an announcement of what you would
  do next ("Let me check…") — either make the call or finish. If a tool result only repeats what
  you already have, do not call it again.
${REPLY_ENDINGS}`;
}

/** What the principles block carries of PRINCIPLES.md: the file from its first list item on,
 * dropping its own introduction (which restates the block's heading). A file with no list item
 * is kept whole. */
export function principleBullets(principles: string): string {
  const lines = principles.split("\n");
  const first = lines.findIndex((line) => /^[-*] /.test(line));
  return first <= 0 ? principles : lines.slice(first).join("\n");
}

/** The <principles> block injected into every run and director prompt: the project's codified
 * taste, phrased positively so roles follow it rather than merely avoid violations — its bullets
 * only (principleBullets). The file itself is read by principles.ts's readPrinciples. */
function principlesBlock(principles: string): string {
  return `Design principles this project holds — uphold them in everything you produce:\n<principles>\n${principleBullets(principles)}\n</principles>`;
}

/** The <failure-digest> block injected into the selfcheck role's prompt (plans/telemetry-role.md):
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

/** The role's notes as shown to it: its own earlier runs' note, labeled as unverified.
 * Rides only when there is a non-empty note; the standing instruction to write one is always
 * present (roleNotesInstruction), so a role's FIRST run — with no note yet — still learns the
 * command exists and can seed the notes. */
function roleNotesBlock(notes: string, hasBacklogIndex: boolean, savedDay?: string, today?: string): string {
  const liveSource = hasBacklogIndex
    ? `the <backlog-index> block above is the live
source of what is currently true of each entry and series, so check it (and the entry itself) before acting on a
note's say-so.`
    : `the backlog is the live
source of what is currently true of each entry and series, so check the entry itself (and, when this run carries
one, its line in the backlog) before acting on a note's say-so.`;
  return `Notes your role wrote in earlier runs (${savedClause(savedDay, today)}yours, unverified — check against the code before
relying on them). A claim they make about an entry's backlog state — refused, blocked, abandoned,
done, behind another entry — is a snapshot of the past, not the present: ${liveSource}
A note that tells you to skip or never re-author an entry is always overridden by the backlog.
<role-notes>\n${notes.trim()}\n</role-notes>`;
}

/** The standing instruction that makes the notes seedable: every role run is told it may
 * write one, so the first run (when no note exists yet) can create it. The note content block
 * (roleNotesBlock) is what is omitted when there is nothing to show. Every backend speaks the
 * same shell command (plans/notes-command.md §3), and the director never reaches
 * buildRunPrompt, so it never carries one. */
export function roleNotesInstruction(): string {
  return `Before you end, if you learned something the next run of your role should know (where
things live, what you ruled out and why, what you would look at next), save the full replacement
note (at most 4 KB) by running:

tumwater-notes write <<'TUMWATER_NOTES'
<the note>
TUMWATER_NOTES

Do not copy backlog entries into it — PLANS.md and BUGS.md hold the work itself.`;
}

interface RunPromptInput {
  role: Role;
  /** PRINCIPLES.md content (see readPrinciples); omitted from the prompt when empty. */
  principles?: string;
  /** Rendered failure digest (see src/failure/failure-render.ts); selfcheck only, omitted when
   * unreadable. */
  digest?: string;
  /** Rendered flow-coverage block (see run/qa-coverage.ts); qa only, omitted when unreadable. */
  coverage?: string;
  /** Rendered CI-parity block (see run/ci-parity.ts); ci only, omitted when there is no
   * record yet or the ledger is unreadable. */
  ciParity?: string;
  /** Rendered previously-filed block (see run/feedback-filings.ts); feedback only, omitted when
   * the ledger is empty or unreadable. */
  filings?: string;
  /** Rendered stranded-plan block (see backlog-structure.ts); clean only, omitted when the
   * primary checkout's PLANS.md is missing, unreadable, or clean. */
  backlogStructure?: string;
  /** Rendered actionable backlog index (see backlog-index.ts); every run carries it. */
  backlogIndex?: string;
  /** The role's notes (roleNotesPath, read by run-prompt.ts): the note its own earlier
   * runs wrote. A missing/empty/whitespace-only note is passed as undefined, so the
   * <role-notes> block is omitted; the write instruction is always present. The director
   * never reaches buildRunPrompt, so it never carries either. */
  notes?: string;
  /** The note file's mtime as a local YYYY-MM-DD (read by run-prompt.ts). Omitted: the notes
   * heading carries no age. */
  notesSavedDay?: string;
  /** The live backlog state of each entry and series the notes name (notes-backlog.ts), rendered
   * right after the notes block so the backlog cannot keep a hold the notes believe in and the
   * notes cannot keep a hold the backlog has lifted. Omitted: the notes name nothing live. */
  notesBacklog?: string;
  extraInstructions?: string;
  /** The plan charter's stop target, rendered right after the charter's task text. The catalog
   * text is config-free, so the concrete eligible-plan count (`planBacklogTarget`) is supplied
   * here by the caller that holds the config; a role payload's `nextPrompt` therefore shows the
   * resolved number, never a placeholder. Omitted: every role but plan. */
  planTargetNote?: string;
  /** The bugfix run's flake tally, rendered by run-prompt.ts; omitted for every other role and
   * when no flake was excused in the window. */
  flakyChecks?: string;
  /** The no-check note (buildNoCheckNote, gate-notes.ts), rendered right after the run charter's
   * task text: what the plan or feature run must do when this project declares no deterministic
   * check and the team is closing the gap itself — the plan role writes the declaration entry,
   * the feature role implements it. Omitted: a check is declared, or this is not the
   * plan/feature turn the marker picks. */
  noCheck?: string;
  /** A per-role prompt the user queued for this role's next run (`tumwater prompt --role <id>`),
   * rendered as a labeled block near the top of the task text.
   * The role still owns find-something-to-do: the request steers, the role's rules and the
   * merge gate still apply unchanged. Omitted: no queued request this run. */
  userRequest?: string;
  /** The project's resolved check (detectBuildCheck against the live config), when one is
   * configured or detected (plans/portability.md §6/7) — names the verify command in the
   * rules instead of asserting npm. Omitted: no check — generic wording, no npm assertion. */
  check?: BuildCheck;
  /** The configured `check.gateCommand` (gateCommandOf), when set: the agent verifies with
   * targeted tests only; tumwater runs the full gate before it merges (BUGS.md 2026-10-28).
   * Omitted: the verify rule names the check itself. */
  gateCommand?: string;
  /** The file the project brief (the managed brief text + status) is read from —
   * TUMWATER.md when it owns the sections, else README.md (plans/portability.md §7a/7).
   * Omitted: the README.md compatibility default, exactly as prompts read before the brief
   * became resolvable. */
  briefFile?: string;
  /** Today's local date as YYYY-MM-DD (see dateLine). Omitted: todayStamp() — tests pin it. */
  today?: string;
  /** The agent backend this role resolves to (`configForRole(config, role).agent`), selecting
   * the prompt dialect (./dialect.ts). Omitted: pi's dialect. */
  agent?: string;
  /** True when tumwater handed this run a single backlog entry (its claim, with no queued
   * request): the run reads that entry first instead of the whole brief. The caller leaves an
   * assigned run's backlog index out itself, since it supplies it. Omitted: unassigned. */
  assigned?: boolean;
  /** The rendered rejected-review note (buildRejectedReviewNote, gate-notes.ts), when the role's
   * last change was rejected in review with no pending revision. Rendered at the very top of the
   * prompt, before the identity and charter, so the author cannot miss the reasons that organize
   * this run (plans/reviewer-as-role.md part 4/4). Omitted: no standing rejection — the prompt is
   * byte-unchanged. */
  rejectedReview?: string;
}

/** The retired names a model still meets in code, git history and logs, mapped to today's terms
 * (plans/terminology.md "Glossary"). The one place these words may appear in a prompt. */
const OLDER_NAMES_MAP = "loop = role, tick = run, fleet = team, landing/landed = merge/merged, vetted = approved, notebook = notes, initial prompt = brief"; // vocabulary-ok: maps retired names

/** The sentence every assembled prompt carries once: the older names and where all of them are
 * listed. Interpolated into the shared preamble and the reviewer and resolver openers. */
export const OLDER_NAMES_SENTENCE = `Older tumwater names still appear in code, git history and logs: ${OLDER_NAMES_MAP}; docs/glossary.md in tumwater's repository lists them all.`;

/** Shared opening of every role prompt: where the run happens and what day it is. The brief is
 * not inlined: the rules send each run to the brief file, which holds the same text. Defined
 * once so the run and director prompts cannot drift — and so the one sentence telling every
 * role to date its records from dateLine, not from the repo, reaches each of them without
 * editing any role text. */
function sharedPreamble(today?: string): string[] {
  return [
    `You work in a dedicated git worktree of this project; your changes will be committed and merged to main by tumwater after you finish.`,
    `${dateLine(today)} Stamp it on anything you record now — a new BUGS.md heading ends
"(found by the <role> role YYYY-MM-DD)", a BUGS.md record closes with "— fixed YYYY-MM-DD by the <role> role",
a finished plan's Done stamp reads "— done YYYY-MM-DD by the <role> role" appended after its
"(planned YYYY-MM-DD by the <role> role …)" parenthetical, and a Refused or
Needs-review note carries the date too — and count plan deadlines from it; never infer the date
from the repo.`,
    OLDER_NAMES_SENTENCE,
  ];
}

/** The prompt for one role run. */
export function buildRunPrompt(input: RunPromptInput): string {
  const dialect = dialectFor(input.agent);
  const day = input.today ?? todayStamp();
  const parts = [
    ...runIdentityBlocks(input.role, input.rejectedReview, day),
    ...runContextBlocks(input),
    ...runEvidenceBlocks(input),
    ...runNotesBlocks(input, day),
    ...runTaskBlocks(input),
    ...runRulesBlocks(input, dialect),
  ];
  return parts.join("\n\n");
}

/** The role identity line and the shared worktree + date preamble. */
function runIdentityBlocks(role: Role, rejectedReview: string | undefined, day: string): string[] {
  return [
    ...(rejectedReview ? [rejectedReview.trim()] : []),
    `You are the "${role.id}" role (${role.title}) on this project's tumwater team — tumwater runs a team of AI roles that develop the project.`,
    ...sharedPreamble(day),
  ];
}

/** The principles block and the explicit user-request steering block, in that order. */
function runContextBlocks(input: RunPromptInput): string[] {
  const parts: string[] = [];
  if (input.principles) parts.push(principlesBlock(input.principles));
  if (input.userRequest)
    parts.push(
      `An explicit request from the user, aimed at this role. Treat it as this run's steering;
your role's rules and the merge gate still apply unchanged. If the request is out of this
role's scope, say so in your reply instead of doing it anyway.\n<user-request>\n${input.userRequest.trim()}\n</user-request>`,
    );
  return parts;
}

/** The six rendered evidence blocks, in the fixed order. */
function runEvidenceBlocks(input: RunPromptInput): string[] {
  const parts: string[] = [];
  if (input.coverage) parts.push(input.coverage);
  if (input.ciParity) parts.push(input.ciParity);
  if (input.filings) parts.push(input.filings);
  if (input.digest) parts.push(digestBlock(input.digest));
  if (input.backlogStructure) parts.push(input.backlogStructure);
  if (input.backlogIndex) parts.push(input.backlogIndex);
  return parts;
}

/** The role-notes block (only when a note exists) and the live backlog state block. */
function runNotesBlocks(input: RunPromptInput, day: string): string[] {
  const parts: string[] = [];
  if (input.notes && input.notes.trim() !== "")
    parts.push(roleNotesBlock(input.notes, Boolean(input.backlogIndex), input.notesSavedDay, day));
  if (input.notesBacklog) parts.push(input.notesBacklog);
  return parts;
}

/** The task text and its optional noCheck/plan-target/flake/extra notes. */
function runTaskBlocks(input: RunPromptInput): string[] {
  const parts: string[] = [];
  parts.push(`Your task this run:\n${input.role.find.trim()}`);
  if (input.noCheck) parts.push(input.noCheck.trim());
  if (input.planTargetNote) parts.push(input.planTargetNote.trim());
  if (input.flakyChecks) parts.push(input.flakyChecks.trim());
  if (input.extraInstructions)
    parts.push(`Additional standing instructions from the user:\n${input.extraInstructions.trim()}`);
  return parts;
}

/** The note-write instruction and the shared rules, which close the prompt. */
function runRulesBlocks(input: RunPromptInput, dialect: PromptDialect): string[] {
  return [
    roleNotesInstruction(),
    commonRules(input.check, input.briefFile, input.role.scope, dialect, input.assigned, input.gateCommand).trim(),
  ];
}

/** The prompt for a director run, which routes a user request into the project. */
export function buildDirectorPrompt(
  userPrompt: string,
  principles?: string,
  /** The project's resolved check (plans/portability.md §6/7) — same threading as the run
   * prompt, since commonRules is shared by both builders. */
  check?: BuildCheck,
  /** The resolved brief file's name (plans/portability.md §7a/7) — same threading again. */
  briefFile?: string,
  /** Today's local date (see dateLine). Omitted: todayStamp() — tests pin it. */
  today?: string,
  /** Rendered actionable backlog index (see backlog-index.ts); the run prompt carries it
   * too, so the director can route against the same bounded view of the backlog. */
  backlogIndex?: string,
  /** The backend the director resolves to, selecting the prompt dialect (./dialect.ts).
   * Omitted: pi's dialect. */
  backend?: string,
  /** The director's `roles.director.instructions` override — its run prompt is otherwise the
   * user's request. Omitted: no `Additional standing instructions` block, exactly as today. */
  extraInstructions?: string,
): string {
  const parts = [
    `You are the "director" role on this project's tumwater team — tumwater runs a team of AI roles that develop the project. The user steers
the project by sending it requests; one has just arrived. Other specialist roles continuously
implement planned features from PLANS.md and fix bugs from BUGS.md.`,
    ...sharedPreamble(today),
  ];
  if (principles) parts.push(principlesBlock(principles));
  if (backlogIndex) parts.push(backlogIndex);
  parts.push(`The user's request:\n<user-request>\n${userPrompt.trim()}\n</user-request>`);
  parts.push(
    `Interpret the request as a project-level command and route it — do NOT implement substantial
work yourself:
- A feature request or substantial change: write a concrete plan for it in PLANS.md (goal,
  approach, files touched, acceptance criteria) so the feature role implements it. Do not build
  it now. ${PLAN_SIZING} ${PLAN_QUEUE_GUIDANCE}
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
  ${NEEDS_REVIEW_NOTE} note — per the user's direction.
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
  // in the prompt, where a model attends to it most (the run prompt's invariant too).
  parts.push(
    `Note on one boundary in the rules below, director only: user-defined-role requests and a
project check declaration are executed by writing .tumwater-config-request.json in your worktree
(shape and worked example above) — never by editing tumwater.json, which stays off-limits to you
as to every role. The request may carry only customRoles and check.command: tumwater validates it
and runs a declared check.command green in the worktree before writing it. A request that also
names any other setting (timeouts, budgets, role enablement, review settings, gateCommand,
mergeCommand, check.cwd) has that key discarded with a warning, so such a request is guidance
that stays staged or is recorded per the routing rules, not an edit you
can make.`,
  );
  // A director run is never assigned an entry.
  parts.push(commonRules(check, briefFile, undefined, dialectFor(backend)).trim());
  return parts.join("\n\n");
}
