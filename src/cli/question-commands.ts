/** The CLI layer of `tumwater questions` — the `tumwater questions` command body: list the open
 * questions in QUESTIONS.md numbered, or `answer <n> <decision>` one, which moves its entry from
 * `## Open` to `## Answered` with a dated operator answer. The markdown surgery itself — the
 * fence-aware `### ` block cut and the `## Answered` skeleton — lives in src/backlog/
 * question-answer.ts (the shared QUESTIONS.md core the TUI and dashboard also call); this module
 * is only the command's say/fail/editor jacket over that core, imported by src/cli/
 * cli-query-commands.ts.
 */
import { fail, say, sayJson } from "./cli-output.js";
import { openQuestionList, questionListPayload, type AnswerOutcome, UNCLOSED_FENCE_MESSAGE, tryAnswerQuestion } from "../backlog/question-answer.js";
import { bodyStructureProblem, normalizeEntryBody } from "../backlog/backlog-write.js";
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
export function answerQuestionFromText(root: string, n: number, text: string, expectedTitle?: string): { title: string; decision: string } {
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
export function answerEditorBuffer(title: string, body: string): string {
  return ["", "", ANSWER_EDITOR_CUT, `### ${title}`, body].join("\n");
}

/** The decision an edited `answerEditorBuffer` holds: the text before the first cut line (all of
 * it when the operator deleted the line). */
export function decisionFromEditorBuffer(text: string): string {
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
export function sayQuestionList(root: string, json: boolean, pattern?: string): void {
  if (json) sayJson(questionListPayload(root, pattern));
  else say(openQuestionList(root, pattern));
}
