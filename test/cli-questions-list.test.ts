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
  const noDecision = await cli(repo, "questions", "answer", "1", "");
  assert.equal(noDecision.code, 1);
  assert.match(noDecision.stderr, /needs a decision/);
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /### Cap the spend\?/, "the open entry stayed open");
  assert.doesNotMatch(md, /\*\*Answered/);
});

test("questions --answered lists the newest answers and refuses misuse", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions answered");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Open one\n\nbody\n\n## Answered\n\n### Old\n\n**Answered 2026-10-01 by operator:** a\n\n### New\n\n**Answered 2026-10-02 by operator:** b\n",
  );
  const r = await cli(repo, "questions", "--answered");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /answered questions in QUESTIONS\.md, newest first:\n1\. New/);
  const j = await cli(repo, "questions", "--answered", "-n", "1", "--json");
  const payload = JSON.parse(j.stdout) as { questions: { title: string }[]; older: number };
  assert.equal(payload.questions.length, 1);
  assert.equal(payload.older, 1);
  const n = await cli(repo, "questions", "-n", "2");
  assert.equal(n.code, 1);
  assert.match(n.stderr, /-n needs --answered/);
  const twice = await cli(repo, "questions", "--answered", "--answered");
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /may only be given once/);
  const sub = await cli(repo, "questions", "--answered", "answer", "1", "x");
  assert.equal(sub.code, 1);
  assert.match(sub.stderr, /takes no subcommand/);
  const bogus = await cli(repo, "questions", "--bogus");
  assert.match(bogus.stderr, /--answered/);
});

test("questions --answered -n refuses a count above the cap like the sibling count flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions answered cap");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Open one\n\nbody\n\n## Answered\n\n### New\n\n**Answered 2026-10-02 by operator:** b\n",
  );
  const over = await cli(repo, "questions", "--answered", "-n", "100001");
  assert.equal(over.code, 1);
  assert.match(over.stderr, /-n must be between 1 and 100000 \(got \"100001\"\)/);
  const ok = await cli(repo, "questions", "--answered", "-n", "100000");
  assert.equal(ok.code, 0);
});

test("questions --answered --grep lists matches under their unfiltered numbers", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions grep");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n## Answered\n\n### Old\n\nabout Budget\n\n**Answered 2026-10-01 by operator:** a\n\n### Mid\n\nother\n\n**Answered 2026-10-02 by operator:** b\n\n### New budget\n\n**Answered 2026-10-03 by operator:** c\n",
  );
  const r = await cli(repo, "questions", "--answered", "--grep", "BUDGET");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^answered questions in QUESTIONS\.md matching "BUDGET", newest first:\n1\. New budget.*\n3\. Old.*\n$/);
  assert.doesNotMatch(r.stdout, /Mid/);
  const j = JSON.parse((await cli(repo, "questions", "--answered", "--grep", "budget", "--json")).stdout) as {
    questions: { position: number }[];
  };
  assert.deepEqual(j.questions.map((q) => q.position), [1, 3]);
  assert.equal((await cli(repo, "questions", "--answered", "--grep", "zzz")).stdout, 'no answered questions match "zzz"\n');
  const bare = await cli(repo, "questions", "--grep", "x");
  assert.equal(bare.code, 0);
  assert.equal(bare.stdout, 'no open questions match "x"\n');
  const show = await cli(repo, "questions", "--show", "1", "--answered", "--grep", "x");
  assert.equal(show.code, 1);
});

test("questions --grep lists matching open questions under their unfiltered numbers", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions open grep");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Raise the Budget?\n\na\n\n### Other\n\nb\n\n### Third\n\nabout budget\n\n## Answered\n\n_None._\n",
  );
  const r = await cli(repo, "questions", "--grep", "BUDGET");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^1\. Raise the Budget\?.*\n3\. Third.*\n$/);
  const j = JSON.parse((await cli(repo, "questions", "--grep", "budget", "--json")).stdout) as {
    questions: { position: number }[];
  };
  assert.deepEqual(j.questions.map((q) => q.position), [1, 3]);
  const none = await cli(repo, "questions", "--grep", "zzz");
  assert.equal(none.code, 0);
  assert.equal(none.stdout, 'no open questions match "zzz"\n');
  const ans = await cli(repo, "questions", "--grep", "x", "answer", "1", "d");
  assert.equal(ans.code, 1);
  assert.match(ans.stderr, /--grep only applies to listing questions/);
  assert.match(fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8"), /### Raise the Budget\?/);
});

const SHOW_QUESTIONS =
  "# q\n\n## Open\n\n### First one (asked by feature, 2026-10-10)\n\nshort\n\n### Second one (asked by plan, 2026-10-12)\n\nline a\nline b\n\n- option\n\n## Answered\n\n_None._\n";

test("questions --show prints one open question in full, in prose and as JSON", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions show");
  fs.writeFileSync(path.join(repo, "QUESTIONS.md"), SHOW_QUESTIONS);
  const r = await cli(repo, "questions", "--show", "2");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trimEnd(), "Second one (asked by plan, 2026-10-12)\n\nline a\nline b\n\n- option");
  const list = JSON.parse((await cli(repo, "questions", "--json")).stdout) as { questions: unknown[] };
  for (const order of [["--show", "2", "--json"], ["--json", "--show", "2"]]) {
    const j = await cli(repo, "questions", ...order);
    assert.equal(j.code, 0);
    const q = JSON.parse(j.stdout) as { position: number; title: string; body: string; since?: string; ageDays?: number };
    assert.equal(q.position, 2);
    assert.equal(q.since, "2026-10-12");
    assert.equal(typeof q.ageDays, "number");
    assert.deepEqual(q, list.questions[1]);
  }
});

test("questions --show <n> --answered prints one answered question in full", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions show answered");
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    "# q\n\n## Open\n\n### Open one\n\nshort\n\n## Answered\n\n### Old\n\nctx\n\n**Answered 2026-10-01 by operator:** a\n\n### New\n\nline a\nline b\n\n**Answered 2026-10-02 by operator:**\n\nkeep\nthis\n",
  );
  const r = await cli(repo, "questions", "--show", "1", "--answered");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trimEnd(), "New\n\nline a\nline b\n\n**Answered 2026-10-02 by operator:**\n\nkeep\nthis");
  const old = await cli(repo, "questions", "--show", "2", "--answered");
  assert.equal(old.stdout.trimEnd(), "Old\n\nctx\n\n**Answered 2026-10-01 by operator:** a");
  const j = await cli(repo, "questions", "--answered", "--show", "1", "--json");
  const q = JSON.parse(j.stdout) as { position: number; title: string; body: string; answeredOn: string };
  assert.equal(q.position, 1);
  assert.equal(q.title, "New");
  assert.match(q.body, /keep\nthis/);
  assert.equal(q.answeredOn, "2026-10-02");
  const past = await cli(repo, "questions", "--show", "3", "--answered");
  assert.equal(past.code, 1);
  assert.match(past.stderr, /no answered question at position 3 \(2 in QUESTIONS\.md\) — valid: 1-2\n$/);
  const n = await cli(repo, "questions", "--show", "1", "--answered", "-n", "2");
  assert.equal(n.code, 1);
  assert.match(n.stderr, /-n does not apply to --show/);
  assert.match((await cli(repo, "questions", "--show", "1")).stdout, /^Open one/);
});

test("questions --show refuses misuse", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli questions show refusals");
  fs.writeFileSync(path.join(repo, "QUESTIONS.md"), SHOW_QUESTIONS);
  const cases: [string[], RegExp][] = [
    [["--show", "3"], /no open question at position 3 \(2 in QUESTIONS\.md\) — valid: 1-2\n$/],
    [["--show", "0"], /--show needs a positive integer/],
    [["--show"], /--show needs a position number/],
    [["--show", "1", "--show", "2"], /--show may only be given once/],
    [["--show=1"], /--show/],
    [["--show", "1", "--file", "x"], /--file only applies to questions answer <n>/],
    [["answer", "--show", "1"], /--show prints one open question; it takes no subcommand/],
  ];
  for (const [args, re] of cases) {
    const r = await cli(repo, "questions", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, re, args.join(" "));
  }
});
