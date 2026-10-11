import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// Spawned-CLI argument-strictness tests for `tumwater questions answer`: the free-form decision
// boundary (single-dash words and a `--json` token past the number are prose, unknown flags
// stay refused) and the question number's positive-integer rule. The list/--json forms and the
// subcommand arity live in cli-questions-list.test.ts; the command bodies themselves are
// exercised in-process in question-commands.test.ts. Split out of cli-arg-strictness.test.ts,
// which keeps the parser-wide unknown-argument and flag-value gates.
test("questions answer keeps single-dash decision words as prose", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions dash decision");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );

  // The answer form's decision is free-form prose, so a dash-leading word ("-50%") is
  // content, not a flag — the parsePromptArgs rule. peelPositionals used to hand such a
  // token to the flag gate, so `questions answer 1 "-50% spend cap"` failed with
  // "unknown argument" and the decision could never be recorded.
  const r = await cli(repo, "questions", "answer", "1", "-50%", "spend", "cap");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /answered question 1/);
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /\*\*Answered .* by operator:\*\* -50% spend cap/);

  // Unknown double-dash flags stay refused, never baked into the decision.
  const bad = await cli(repo, "questions", "answer", "1", "--rol", "x");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown argument: --rol/);
});

test("questions answer keeps a decision token spelled --json as prose", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions json decision");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );

  // Unquoted decision prose reaches the command as separate argv tokens, so a word spelled
  // like the command's one flag is a decision word once the question number has been read:
  // `tumwater questions answer 1 keep --json output` used to have its `--json` token eaten
  // by the flag scan — the decision was recorded as "keep output" and the command flipped
  // into JSON mode. A `--json` token before the number is still the flag.
  const r = await cli(repo, "questions", "answer", "1", "keep", "--json", "output");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /answered question 1/, "the flag was not consumed from the decision");
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /\*\*Answered .* by operator:\*\* keep --json output/);

  // Unknown double-dash tokens stay refused past the number, never baked into the decision.
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );
  const bad = await cli(repo, "questions", "answer", "1", "keep", "--rol", "output");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown argument: --rol/);
});

test("questions answer --json reports the decision as written, with whitespace collapsed", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions json collapsed");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );

  // The file gets the collapsed decision (a stamp paragraph is one line) but the payload
  // used to echo the caller's raw spacing, so --json and the file disagreed about what
  // landed. --json before the number is the flag; the decision is one argv token holding
  // runs of spaces.
  const r = await cli(repo, "questions", "answer", "--json", "1", "a   b");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { decision: string };
  assert.equal(payload.decision, "a b");
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /\*\*Answered .* by operator:\*\* a b\n/);
});

test("questions answer refuses a non-integer or non-positive question number", async () => {
  // The number is read before the decision (the noDecision test covers the sibling), so a
  // number that fails Number.isInteger(n) || n >= 1 must fail with the number form — a
  // mistyped "0" or "1st" must never be read as a question to answer.
  const repo = makeRepo();
  await initProject(repo, "cli questions bad number");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n",
  );
  for (const args of [
    ["questions", "answer", "0", "no"],
    ["questions", "answer", "-1", "no"],
    ["questions", "answer", "1st", "no"],
    ["questions", "answer"], // a missing number reads as NaN, the same refusal
    // Bare Number() parsing admitted spellings Number() accepts and the plain-decimal rule
    // rejects: `answer 0x2` answered question 2, `1e2` would have answered question 100.
    ["questions", "answer", "0x2", "no"],
    ["questions", "answer", "1e2", "no"],
    ["questions", "answer", " 2", "no"],
  ]) {
    const r = await cli(repo, ...args);
    assert.equal(r.code, 1, `exit 1 for ${JSON.stringify(args.slice(1))}`);
    assert.match(
      r.stderr,
      /needs a positive question number: questions answer <n> "<decision>"/,
      `number usage for ${JSON.stringify(args.slice(1))}`,
    );
  }
  // The refusal names the offending token, like --cancel's ` (got "...")` suffix; the
  // bare `answer` form above has no token to name and stays the plain usage line.
  const named = await cli(repo, "questions", "answer", "0x2", "no");
  assert.match(
    named.stderr,
    /positive question number: questions answer <n> "<decision>" \(got "0x2"\)/,
  );
  // And every refusal left the question open.
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /### Cap the spend\?/, "the open entry stayed open");
  assert.doesNotMatch(md, /\*\*Answered/);
});
