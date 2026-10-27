/** The CLI layer of `tumwater questions` — the `tumwater questions` command body: list the open
 * questions in QUESTIONS.md numbered, or `answer <n> <decision>` one, which moves its entry from
 * `## Open` to `## Answered` with a dated operator answer. The markdown surgery itself — the
 * fence-aware `### ` block cut and the `## Answered` skeleton — lives in src/backlog/
 * question-answer.ts (the shared QUESTIONS.md core the TUI and dashboard also call); this module
 * is the command's argument scan, say/fail/editor jacket and commit-and-wake tail over that core,
 * routed to by src/cli.ts.
 */
import { fail, say, sayJson, warnIfUncommitted } from "./cli-output.js";
import { parseCountFlag, parsePositionFlag, rejectRepeatFlag } from "./cli-args.js";
import { JSON_FLAG, rejectEqualsForm } from "./cli-flag-specs.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { promptFileValue, readPromptFileArg } from "./cli-command-args.js";
import { editInEditor } from "./cli-editor.js";
import { gotSuffix, parsePositiveInt } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";
import { commitOperatorBacklogEdit } from "../backlog/backlog-commit.js";
import { stampedSubject } from "../git/commit-message.js";
import { wakeQuestionAsker } from "../operator/operator-intent.js";
import { answeredQuestionAt, answeredQuestionCount, answeredQuestionList, answeredQuestionPayload, openQuestionAt, openQuestionList, questionListPayload, renderShownQuestion, type AnswerOutcome, UNCLOSED_FENCE_MESSAGE, tryAnswerQuestion } from "../backlog/question-answer.js";
import { bodyStructureProblem, normalizeEntryBody } from "../backlog/backlog-write.js";

/** `questions --answered -n`'s ceiling: bounds how many answered questions one list shows,
 * so a typo'd huge count fails fast with the shared `must be between 1 and <max>` wording
 * (the logs/history/report pattern) instead of silently meaning "everything". The list data
 * is small (QUESTIONS.md), so the cap never meaningfully binds — it exists for the uniform
 * count-flag contract and the clear over-range rebuke, not for memory. */
const QUESTIONS_MAX_LISTED = 100_000;

/** The `tumwater questions answer` entry point: `tryAnswerQuestion` without a title check, its
 * refusals mapped to `fail` (exit 1) with the CLI's wording. Returns the answered question's
 * title plus the collapsed decision that landed in the file. */
export function answerQuestion(root: string, n: number, rawDecision: string): { title: string; decision: string } {
  return answeredOrFail(n, tryAnswerQuestion(root, n, rawDecision));
}

/** Map a non-answered outcome to the CLI's `fail` wording; shared by both CLI entry points. */
function answeredOrFail(n: number, outcome: AnswerOutcome): { title: string; decision: string } {
  if (outcome.status === "missing") {
    const range = outcome.open > 0 ? ` — valid: 1-${outcome.open}` : "";
    fail(`no question at position ${n} (${outcome.open} open)${range}`);
  }
  if (outcome.status === "fenced") fail(UNCLOSED_FENCE_MESSAGE);
  if (outcome.status === "moved") fail(`question ${n} is now "${outcome.title}" — the list changed while you edited; nothing changed`);
  if (outcome.status !== "answered") fail(`no question at position ${n}`);
  return { title: outcome.title, decision: outcome.decision };
}

/** `tumwater questions answer <n> --file <path>`: the decision's lines kept (normalizeEntryBody),
 * behind the same structural guard `plan --file` uses, so a stray `## ` line cannot grow a
 * phantom section. Refusals exit 1 through `fail`. */
function answerQuestionFromText(root: string, n: number, text: string, expectedTitle?: string): { title: string; decision: string } {
  const body = normalizeEntryBody(text);
  if (body === "") fail("questions answer needs a decision: the file is blank");
  const problem = bodyStructureProblem(body);
  if (problem !== null) fail(`questions answer --file: ${problem}`);
  return answeredOrFail(n, tryAnswerQuestion(root, n, body, expectedTitle, true));
}

/** The line that ends the decision area of the `questions answer <n>` editor buffer. */
export const ANSWER_EDITOR_CUT = "<!-- tumwater: write your decision above this line; this line and everything below it are dropped -->";

/** The editor buffer for bare `questions answer <n>`: an empty decision area, the cut line, then
 * the question's heading and body for reference. */
function answerEditorBuffer(title: string, body: string): string {
  return ["", "", ANSWER_EDITOR_CUT, `### ${title}`, body].join("\n");
}

/** The decision an edited `answerEditorBuffer` holds: the text before the first cut line (all of
 * it when the operator deleted the line). */
function decisionFromEditorBuffer(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => l.trim() === ANSWER_EDITOR_CUT);
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
}
/** The one confirmation line `questions answer` prints in prose mode: which position was
 * answered and which entry moved — `--json` swaps it for the answer result payload. */
export function sayAnswered(position: number, title: string, json: boolean, decision: string): void {
  if (json) sayJson({ answered: position, question: title, decision });
  else say(`answered question ${position}: ${title} — moved to ## Answered`);
}

/** One entry point for the list modes so cli.ts stays a dispatcher: --json prints the payload
 * document (an empty outbox still prints it), prose prints the numbered lines or the empty
 * line. */
function sayQuestionList(root: string, json: boolean, pattern?: string): void {
  if (json) sayJson(questionListPayload(root, pattern));
  else say(openQuestionList(root, pattern));
}

/** `questions answer`'s `--file <path>` flag: the decision comes from the file, lines kept. */
const FILE_SPEC = { names: ["--file"], value: true, valueName: "<path>" };

/** The parsed shape of `tumwater questions`' `args`: the position words (subcommand, number,
 * then decision prose) plus each flag's value. */
interface QuestionsInvocation {
  words: string[];
  jsonFlag: boolean;
  file: string | undefined;
  answeredFlag: boolean;
  limit: number | undefined;
  grep: string | undefined;
  show: number | undefined;
}

/** No requireReadyRepo gate, like backlog: the reader degrades to an empty list on a
 * missing QUESTIONS.md, so the command inspects any directory instead of refusing (a team
 * workspace still refuses).
 * The answer form's decision is free-form prose, so peelPositionals cannot route the
 * tokens: a decision word may begin with a single dash (`questions answer 1 "-50% spend
 * cap"`), and peelPositionals would hand it to the flag gate as an unknown flag — the
 * same masking parsePromptArgs avoids for prompt text by owning only `--`-prefixed
 * tokens. So the questions parse scans args itself: a `--json` token before the
 * question's number positional is the one flag (repeats refused, equals form named by
 * rejectEqualsForm), any other `--`-prefixed token before it is refused as unknown, and
 * every remaining token in order is prose — subcommand, position number, then the
 * decision words. Past the number positional, tokens are decision words even when one
 * is spelled `--json`: unquoted decision prose (`questions answer 1 keep --json output`)
 * reaches the command as separate argv tokens, and a flag scan that matched `--json`
 * anywhere silently ate the token out of the recorded decision and flipped the command
 * into JSON mode. Unknown `--`-prefixed tokens stay refused even there, so a misspelled
 * flag is still an error rather than silent decision text. */
function parseQuestionsInvocation(args: string[]): QuestionsInvocation {
  const words: string[] = [];
  let jsonFlag = false;
  let numbered = false;
  let file: string | undefined;
  let answeredFlag = false;
  let limit: number | undefined;
  let grep: string | undefined;
  let show: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!numbered && arg === "--show") {
      rejectRepeatFlag(show !== undefined, "--show");
      show = parsePositionFlag("--show", args[++i], "--show 2");
      continue;
    }
    if (!numbered && arg === "--answered") {
      rejectRepeatFlag(answeredFlag, "--answered");
      answeredFlag = true;
      continue;
    }
    if (!numbered && arg === "-n") {
      rejectRepeatFlag(limit !== undefined, "-n");
      limit = parseCountFlag("-n", args[++i], QUESTIONS_MAX_LISTED);
      continue;
    }
    if (!numbered && arg === "--grep") {
      rejectRepeatFlag(grep !== undefined, "--grep");
      const text = args[++i];
      if (text === undefined || text === "") fail("--grep needs text (usage: tumwater questions [--answered] --grep <text>)");
      grep = text;
      continue;
    }
    if (arg === "--file") {
      rejectRepeatFlag(file !== undefined, "--file");
      file = promptFileValue(args[++i]);
      continue;
    }
    if (!numbered && arg === "--json") {
      rejectRepeatFlag(jsonFlag, "--json");
      jsonFlag = true;
      continue;
    }
    if (arg.startsWith("--") && arg !== "--json") {
      rejectEqualsForm(arg, [JSON_FLAG, FILE_SPEC, { names: ["--show"], value: true, valueName: "<n>" }, { names: ["--grep"], value: true, valueName: "<text>" }]);
      // The complete flag set (this gate only sees `--`-flags, but `-n` is a real flag the
      // list should not omit) plus the same did-you-mean hint the sibling commands'
      // unknown-argument gate (cli-flag-specs's failUnknownArgument) attaches, so a mistyped
      // `--ansered` names `--answered` instead of only printing the valid list — the missing
      // treatment the questions gate was the one unknown-argument caller without.
      const spellings = ["--json", "--file", "--answered", "--show", "--grep", "-n"];
      fail(`unknown argument: ${arg} (valid flags for tumwater questions: ${spellings.join(", ")})${typoSuffix(arg, spellings)}`);
    }
    if (!numbered) {
      // The position is a plain-decimal positive integer (parsePositiveInt's rule, the same
      // one --cancel's position honors): bare Number() admitted hex ("0x2"), exponent
      // ("1e2"), and whitespace-padded spellings as a valid question number, answering a
      // question the operator never named.
      if (parsePositiveInt(arg) !== null) numbered = true;
    }
    words.push(arg);
  }
  if (limit !== undefined && !answeredFlag) fail("-n needs --answered (it limits the answered questions listed)");
  return { words, jsonFlag, file, answeredFlag, limit, grep, show };
}

/** The `--show` output branch: one open (or, with `--answered`, answered) question in full. */
function sayShownQuestion(root: string, inv: QuestionsInvocation): void {
  const { show, answeredFlag, jsonFlag, grep, words, file, limit } = inv;
  if (grep !== undefined) fail("--grep does not apply to --show");
  if (words.length > 0) fail("--show prints one open question; it takes no subcommand");
  if (file !== undefined) fail("--file only applies to questions answer <n>");
  if (answeredFlag) {
    if (limit !== undefined) fail("-n does not apply to --show");
    const a = answeredQuestionAt(root, show!);
    if (a === null) {
      const count = answeredQuestionCount(root);
      const range = count > 0 ? ` — valid: 1-${count}` : "";
      fail(`no answered question at position ${show} (${count} in QUESTIONS.md)${range}`);
    }
    if (jsonFlag) sayJson(a);
    else say(renderShownQuestion(a));
    return;
  }
  const q = openQuestionAt(root, show!);
  if (q === null) {
    const count = questionListPayload(root).questions.length;
    const range = count > 0 ? ` — valid: 1-${count}` : "";
    fail(`no open question at position ${show} (${count} in QUESTIONS.md)${range}`);
  }
  if (jsonFlag) sayJson(q);
  else say(renderShownQuestion(q));
}

/** The `--answered` list output branch. */
function sayAnsweredQuestions(root: string, inv: QuestionsInvocation): void {
  const { jsonFlag, grep, words, file, limit } = inv;
  if (words.length > 0) fail("--answered lists answered questions; it takes no subcommand");
  if (file !== undefined) fail("--file only applies to questions answer <n>");
  if (jsonFlag) sayJson(answeredQuestionPayload(root, limit ?? 10, grep));
  else say(answeredQuestionList(root, limit ?? 10, grep));
}

/** The `questions answer` branch: the inline, editor-backed and `--file` answer flows. */
async function runQuestionsAnswer(root: string, inv: QuestionsInvocation): Promise<void> {
  const { jsonFlag, grep, words, file } = inv;
  if (grep !== undefined) fail("--grep only applies to listing questions");
  if (words[0] !== "answer")
    fail(
      `unknown questions subcommand: ${words[0]} (use "answer <n> <decision>", or run \`tumwater questions\` with no subcommand to list them)${typoSuffix(words[0]!, ["answer"])}`,
    );
  // The offending token carries the same ` (got "...")` suffix every sibling number parser
  // adds (parsePositiveInt's flag callers, --cancel); the bare `answer` form names none.
  const raw = words.length > 1 ? words[1] : undefined;
  const n = raw === undefined ? null : parsePositiveInt(raw);
  if (n === null)
    fail(
      `questions answer needs a positive question number: questions answer <n> "<decision>"${gotSuffix(raw)}`,
    );
  if (file !== undefined) {
    if (words.length > 2) fail(`unexpected argument ${JSON.stringify(words[2])} — with --file the decision comes from the file`);
    const answered = answerQuestionFromText(root, n, readPromptFileArg(file));
    await commitAndReportAnswer(root, n, jsonFlag, answered.title, answered.decision);
    return;
  }
  const decision = words.slice(2).join(" ").trim();
  if (words.length === 2) {
    const open = questionListPayload(root).questions;
    const question = open[n - 1];
    if (question === undefined) {
      const range = open.length > 0 ? ` — valid: 1-${open.length}` : "";
      fail(`no question at position ${n} (${open.length} open)${range}`);
    }
    const edited = decisionFromEditorBuffer(
      editInEditor(answerEditorBuffer(question.title, question.body), `answer-${n}.md`, "pass a decision or --file <path>"),
    );
    if (edited.trim() === "") fail("questions answer needs a decision: the editor left it blank; nothing changed");
    const answered = answerQuestionFromText(root, n, edited, question.title);
    await commitAndReportAnswer(root, n, jsonFlag, answered.title, answered.decision);
    return;
  }
  if (decision === "")
    fail('questions answer needs a decision: questions answer <n> "<decision>"');
  // answerQuestion collapses the free-form decision to one line before writing it; report
  // that written text in the --json payload so it matches the file, not the caller's spacing.
  const { title, decision: writtenDecision } = answerQuestion(root, n, decision);
  await commitAndReportAnswer(root, n, jsonFlag, title, writtenDecision);
}

/** `tumwater questions`: list open questions, or answer one with `answer <n> <decision>`. */
export async function cmdQuestions(root: string, args: string[]): Promise<void> {
  const inv = parseQuestionsInvocation(args);
  refuseTeamWorkspace(root);
  if (inv.show !== undefined) {
    sayShownQuestion(root, inv);
    return;
  }
  if (inv.answeredFlag) {
    sayAnsweredQuestions(root, inv);
    return;
  }
  if (inv.words.length === 0) {
    if (inv.file !== undefined) fail("--file only applies to questions answer <n>");
    sayQuestionList(root, inv.jsonFlag, inv.grep);
    return;
  }
  await runQuestionsAnswer(root, inv);
}

/** Commit the answered question, report it in the requested output mode, and wake the
 * asking role in prose mode — the tail every `questions answer` branch ends with. */
async function commitAndReportAnswer(root: string, n: number, jsonFlag: boolean, title: string, decision: string): Promise<void> {
  warnIfUncommitted(await commitOperatorBacklogEdit(root, "QUESTIONS.md", stampedSubject("operator", `Answer question: ${title}`)), "QUESTIONS.md"); // vocabulary-ok: commit prefix stays
  sayAnswered(n, title, jsonFlag, decision);
  if (!jsonFlag) sayAskerWake(root, title);
}

/** Prose-mode follow-up to `questions answer`: wake the asking role and print the confirmation. */
function sayAskerWake(root: string, title: string): void {
  const wake = wakeQuestionAsker(root, title);
  if (wake !== null) say(wake);
}
