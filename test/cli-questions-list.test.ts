import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// Spawned-CLI tests for `tumwater questions`' list and subcommand surface: the open-question
// numbering, the missing-file degradation, the --json payload and its repeat refusal, and the
// non-answer-subcommand / missing-decision refusals. The answer form's free-form decision
// boundary and question-number rule live in cli-questions-strictness.test.ts; the command
// bodies themselves are exercised in-process in question-commands.test.ts. Split out of the
// strictness file so the two surfaces run in parallel processes via the CLI child.
test("questions lists the open questions, in prose and as JSON", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions list");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );

  // The bare command is the list form every backlog-style command shares: the open questions
  // numbered from 1, the same numbering `questions answer <n>` consumes. A missing
  // QUESTIONS.md degrades to the "no open questions" line instead of failing, so the command
  // inspects any directory (the backlog/report precedent).
  const r = await cli(repo, "questions");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1\. Cap the spend\?/);
  const empty = await cli(tmpdir(), "questions");
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /no open questions/);

  // --json prints the payload document (the backlog --json pattern): each entry's 1-based
  // position, its verbatim heading, and its body.
  const j = await cli(repo, "questions", "--json");
  assert.equal(j.code, 0);
  const payload = JSON.parse(j.stdout) as { questions: { position: number; title: string; body: string }[] };
  assert.deepEqual(payload.questions, [{ position: 1, title: "Cap the spend?", body: "body" }]);

  // A repeated --json is refused, not silently consumed twice (the flag's own arity rule).
  const dup = await cli(repo, "questions", "--json", "--json");
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /--json may only be given once/);
});

test("questions rejects a non-answer subcommand and an answer with no decision", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions arity");

  // Anything but `answer` as the first word is a subcommand typo, not a list arg: fail with
  // the right spelling rather than treating "frobnicate" as prose — and name the listing form
  // (bare `tumwater questions`), since `questions list` is the natural typo this message
  // answers.
  const sub = await cli(repo, "questions", "frobnicate");
  assert.equal(sub.code, 1);
  assert.match(sub.stderr, /unknown questions subcommand: frobnicate/);
  assert.match(sub.stderr, /run `tumwater questions` with no subcommand to list them/);

  // `answer <n>` with nothing after the number has no decision to record — the command
  // fails with the decision form instead of writing an empty answer.
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );
  const noDecision = await cli(repo, "questions", "answer", "1");
  assert.equal(noDecision.code, 1);
  assert.match(noDecision.stderr, /needs a decision/);
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /### Cap the spend\?/, "the open entry stayed open");
  assert.doesNotMatch(md, /\*\*Answered/);
});
