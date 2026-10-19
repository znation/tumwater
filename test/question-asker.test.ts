import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { questionAsker } from "../src/backlog/question-answer.js";
import { wakeQuestionAsker } from "../src/operator/operator-intent.js";
import { loadLoopState } from "../src/runner/runner-state.js";
import { wakeRequestPath } from "../src/paths.js";

// Answering a question wakes the role named in the heading's `(asked by <role> …)` clause.

test("questionAsker reads the role id after `asked by`, or null", () => {
  assert.equal(questionAsker("Ship X? (asked by plan 2026-10-12)"), "plan");
  assert.equal(questionAsker("Ship X? (asked by feature-2 2026-10-12)"), "feature-2");
  assert.equal(questionAsker("Ship X?"), null);
});

test("wakeQuestionAsker wakes a known asker and no one else", async () => {
  const repo = makeRepo();
  await initProject(repo, "question asker");
  const text = wakeQuestionAsker(repo, "Q? (asked by plan 2026-10-12)");
  assert.equal(typeof text, "string");
  assert.ok((loadLoopState(repo, "plan").nextRunAt ?? 0) <= Date.now());
  fs.rmSync(wakeRequestPath(repo), { force: true });
  assert.equal(wakeQuestionAsker(repo, "Q? (asked by nobody 2026-10-12)"), null);
  assert.equal(wakeQuestionAsker(repo, "Q? no clause"), null);
  assert.equal(fs.existsSync(wakeRequestPath(repo)), false);
});

test("questions answer prints the wake line in prose and leaves --json alone", async () => {
  const repo = makeRepo();
  await initProject(repo, "question asker cli");
  const write = (): void =>
    fs.writeFileSync(
      path.join(repo, "QUESTIONS.md"),
      "# Questions\n\n## Open\n\n### Ship X? (asked by plan 2026-10-12)\n\nbody\n\n## Answered\n\n_None._\n",
    );
  write();
  const r = await cli(repo, "questions", "answer", "1", "yes");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0] as string, /^answered question 1: Ship X\?/);
  assert.ok(lines.length >= 2, r.stdout);
  write();
  const j = await cli(repo, "questions", "answer", "--json", "1", "yes");
  assert.equal(j.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(j.stdout)).sort(), ["answered", "decision", "question"]);
});
