import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { answerQuestion, openQuestionList, questionListPayload, sayAnswered } from "../src/question-commands.js";
import { openQuestionEntries } from "../src/backlog.js";
import { writeTextAtomic } from "../src/files.js";
import { tmpdir } from "./repo-fixtures.js";
import { attempt } from "./exit-capture.js";

/** src/question-commands.ts's own tests: the `tumwater questions` CLI layer — list
 * numbering, the answer move (one block, verbatim, with the dated operator paragraph), the
 * out-of-range error wording, the --json payloads, and the missing-file degradation —
 * exercised in-process against a seeded QUESTIONS.md in a temp project root. cmdQuestion's
 * paths only read or write QUESTIONS.md, so attempt's in-process exit capture is safe for them
 * (see test/exit-capture.ts's scope limit). */

const SKELETON = `# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

_None yet._

## Answered
`;

function seed(root: string, text: string): string {
  const file = path.join(root, "QUESTIONS.md");
  writeTextAtomic(file, text);
  return file;
}

function twoQuestionFile(): string {
  return `# Questions

## Open

### First: which renderer? (asked by director 2026-10-01)

The user reported flicker. Options and a recommendation follow.

- **Option A (recommended):** fix in place.
- **Option B:** adopt a framework.

### Second: which backend? (asked by bugfix 2026-10-03)

Any OpenAI-compatible model works.

## Answered
`;
}

test("the list numbers open questions 1..N in file order with an ellipsized body line", () => {
  const root = tmpdir();
  seed(root, twoQuestionFile());
  const rendered = openQuestionList(root);
  const lines = rendered.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^1\. First: which renderer\? \(asked by director 2026-10-01\) — The user reported flicker/);
  assert.match(lines[1]!, /^2\. Second: which backend\? \(asked by bugfix 2026-10-03\) — Any OpenAI-compatible model works\.$/);
});

test("a file with no open questions renders the empty line, not an error", () => {
  const root = tmpdir();
  seed(root, SKELETON);
  assert.equal(openQuestionList(root), "no open questions");
});

test("a missing QUESTIONS.md degrades to the empty list", () => {
  const root = tmpdir();
  assert.equal(openQuestionList(root), "no open questions");
  assert.deepEqual(questionListPayload(root), { questions: [] });
});

test("the --json payload numbers entries with verbatim titles and bodies", () => {
  const root = tmpdir();
  seed(root, twoQuestionFile());
  const payload = questionListPayload(root);
  assert.deepEqual(
    payload.questions.map((q) => [q.position, q.title]),
    [
      [1, "First: which renderer? (asked by director 2026-10-01)"],
      [2, "Second: which backend? (asked by bugfix 2026-10-03)"],
    ],
  );
  assert.match(payload.questions[0]!.body, /Option A \(recommended\)/);
});

test("answering question 1 moves only its block to ## Answered with the dated decision", () => {
  const root = tmpdir();
  const file = seed(root, twoQuestionFile());
  const { title } = answerQuestion(root, 1, "use ink");
  assert.equal(title, "First: which renderer? (asked by director 2026-10-01)");
  const md = read(file);
  // The Open section holds exactly the second question, renumbered 1 by the readers.
  assert.deepEqual(openQuestionEntries(root).map((q) => q.title), ["Second: which backend? (asked by bugfix 2026-10-03)"]);
  // The moved block is verbatim, in ## Answered, followed by the dated operator paragraph.
  assert.ok(md.includes("## Answered\n\n### First: which renderer? (asked by director 2026-10-01)"));
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.ok(md.includes(`**Answered ${stamp} by operator:** use ink`));
  // The decision is the last content in the Answered section.
  assert.ok(md.trimEnd().endsWith(`**Answered ${stamp} by operator:** use ink`));
  // The first question's body travelled with its heading, intact.
  assert.ok(md.includes("- **Option A (recommended):** fix in place."));
  // The Open section did not leak its old position numbering or a stray placeholder.
  assert.ok(!md.includes("_None._"));
});

test("answering the last question restores the skeleton's _None yet._ placeholder, not other text", () => {
  const root = tmpdir();
  seed(root, twoQuestionFile());
  answerQuestion(root, 1, "use ink");
  answerQuestion(root, 1, "any OpenAI-compatible one");
  const md = read(path.join(root, "QUESTIONS.md"));
  assert.ok(md.includes("## Open\n\n_None yet._"));
  assert.ok(!md.includes("_None._"));
  assert.deepEqual(openQuestionEntries(root), []);
});

test("answering the last question keeps the blank line between the restored placeholder and the next heading", () => {
  const root = tmpdir();
  seed(root, twoQuestionFile());
  answerQuestion(root, 1, "use ink");
  answerQuestion(root, 1, "any OpenAI-compatible one");
  const md = read(path.join(root, "QUESTIONS.md"));
  // The placeholder is its own paragraph: `## Answered` follows a blank line, not the text.
  assert.ok(md.includes("_None yet._\n\n## Answered"), md);
});

test("an out-of-range position fails with the prompt --cancel wording and exit 1", () => {
  const root = tmpdir();
  seed(root, twoQuestionFile());
  const o = attempt(() => answerQuestion(root, 9, "x"));
  if (!o.exited) assert.fail("expected process.exit, but the call returned");
  assert.equal(o.code, 1);
  assert.match(o.stderr, /^tumwater: no question at position 9 \(2 open\)\n$/);
});

test("answering in a file with no ## Answered section grows one at the end", () => {
  const root = tmpdir();
  seed(root, `# Questions\n\n## Open\n\n### Only: ship it? (asked by feature 2026-10-04)\n\nYes or no.\n`);
  answerQuestion(root, 1, "ship it");
  const md = read(path.join(root, "QUESTIONS.md"));
  assert.ok(md.includes("## Answered\n\n### Only: ship it? (asked by feature 2026-10-04)"));
  assert.ok(md.includes("Yes or no."));
  assert.ok(md.includes("by operator:** ship it"));
  assert.deepEqual(openQuestionEntries(root), []);
});

test("answering works when a fence after ## Answered runs unclosed to EOF", () => {
  // scanQuestions walks the file twice with one tracker; a tracker left inside an unclosed
  // fence at EOF made the second walk quote every Open heading, so the list showed the
  // question while `answer` refused it with "0 open".
  const root = tmpdir();
  seed(root, '# Questions\n\n## Open\n\n### Which database?\n\nsqlite or postgres\n\n## Answered\n\n_None yet._\n\nfenced tail:\n\n```\nnever closed\n');
  assert.match(openQuestionList(root), /^1\. Which database\?/);
  const { title } = answerQuestion(root, 1, "sqlite");
  assert.equal(title, "Which database?");
  const md = read(path.join(root, "QUESTIONS.md"));
  assert.ok(md.includes("### Which database?\n\nsqlite or postgres\n\n**Answered"));
  assert.ok(md.includes("## Open\n\n_None yet._"));
  assert.ok(md.includes("```\nnever closed"));
});

test("sayAnswered renders the prose confirmation or the answer-result JSON", async () => {
  const prose = attempt(() => sayAnswered(2, "Second: which backend?", false, "openai")).stdout.trimEnd();
  assert.equal(prose, "answered question 2: Second: which backend? — moved to ## Answered");
  const json = attempt(() => sayAnswered(2, "Second: which backend?", true, "openai")).stdout.trimEnd();
  assert.deepEqual(JSON.parse(json), { answered: 2, question: "Second: which backend?", decision: "openai" });
});

// --- helpers -------------------------------------------------------------

test("an intermediate ## section between Open and Answered survives an answer untouched", () => {
  // sectionLines (the --list reader) ends ## Open at the next ## heading of any title;
  // scanQuestions must use the same boundary, or one answer moves another section's
  // entries (and its heading) into ## Answered and out of the file.
  const root = tmpdir();
  const file = seed(
    root,
    `# Questions

## Open

### Which color?
blue or red

## Notes

internal notes live here

### decoy heading in notes

## Answered

_None yet._
`,
  );
  const { title } = answerQuestion(root, 1, "blue");
  assert.equal(title, "Which color?");
  const md = read(file);
  // The Notes section keeps its heading, body, and decoy entry, exactly where they were.
  assert.ok(md.includes("## Notes\n\ninternal notes live here\n\n### decoy heading in notes"), md);
  assert.deepEqual(openQuestionEntries(root).map((q) => q.title), []);
  // The emptied Open section regains its placeholder.
  assert.ok(md.includes("## Open\n\n_None yet._\n\n## Notes"), md);
  // The answered block carries only the question, not the Notes content.
  const answered = md.slice(md.indexOf("## Answered"));
  assert.ok(!answered.includes("decoy"), answered);
  assert.ok(answered.includes("### Which color?\nblue or red"), answered);
});

test("answering works when a fence inside ## Open runs unclosed to EOF", () => {
  // The openEnd walk and the blocks walk must not share a tracker: an unclosed fence in Open
  // runs the openEnd walk to EOF and leaves the tracker inside, so a shared blocks walk
  // quoted every `### ` heading and answered a later entry — Question B — on a file `--list`
  // had numbered as just Question A (whose body the fence swallows, per the list reader).
  const root = tmpdir();
  seed(root, '# Questions\n\n## Open\n\n### Question A\n\nbody\n\n```\nunclosed fence\n\n## Answered\n\n### Question B\n');
  assert.match(openQuestionList(root), /^1\. Question A/);
  const { title } = answerQuestion(root, 1, "yes");
  // The answer names the entry the list numbered, not a fenced tail's heading.
  assert.equal(title, "Question A");
  const md = read(path.join(root, "QUESTIONS.md"));
  assert.ok(md.includes("### Question A\n\nbody"), md);
  assert.ok(md.includes("**Answered"), md);
  assert.ok(md.includes("## Open\n\n_None yet._"), md);
});

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}