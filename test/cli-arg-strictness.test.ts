import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { dequeuePrompt, inboxSize } from "../src/inbox.js";
import { resetRequestPath, wakeRequestPath } from "../src/paths.js";
import { loadLoopState } from "../src/loop-state.js";
import { seedCounters } from "./loop-fixtures.js";
import { makeRepo, tmpdir } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";

// Argument-strictness child-process tests: every command must reject unknown arguments and
// keep the flag/positional boundary exact. The per-command validation lives in each command's
// tests; these walk several commands because the regression class is parser-wide, not
// command-local. Spawned via the CLI so node --test can run them in parallel processes.
test("prompt rejects unknown double-dash flags instead of baking them into content", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt unknown flag");

  // Before parsePromptArgs existed, `tumwater prompt --foo text` enqueued "--foo text" as the
  // prompt — the same class of hole init's parseInitArgs closed. The flag must fail and leave
  // the queue untouched.
  const r = await cli(repo, "prompt", "--foo", "text");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --foo/);
  assert.match(r.stderr, /--list, --json, --cancel <n>/);
  assert.equal(inboxSize(repo), 0, "the flag was not baked into queued content");
});

test("prompt keeps single-dash positionals as prompt content", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt single dash");

  // Only double-dash tokens are flags; a leading single dash is free-form content, like the
  // bullets init accepts.
  const r = await cli(repo, "prompt", "-x");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the director loop/);
  assert.equal(dequeuePrompt(repo), "-x");
});

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
  // the right spelling rather than treating "frobnicate" as prose.
  const sub = await cli(repo, "questions", "frobnicate");
  assert.equal(sub.code, 1);
  assert.match(sub.stderr, /unknown questions subcommand: frobnicate/);

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

test("commands reject unknown arguments instead of silently ignoring them", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli strict args");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  // A misspelled --role used to be ignored: reset-counters would zero EVERY loop instead of
  // the one named. Now it fails and leaves every counter (and no fleet marker) untouched.
  let r = await cli(repo, "reset-counters", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  assert.match(r.stderr, /--role <id>/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "no reset happened");
  assert.ok(!fs.existsSync(resetRequestPath(repo)), "no marker written");

  // A misspelled --port used to be ignored: gui would serve on the default port.
  r = await cli(repo, "gui", "--portt", "8080");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --portt/);

  // A doubled short flag used to be ignored: logs would run one-shot instead of following.
  r = await cli(repo, "logs", "-ff");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: -ff/);

  // `--reason` is pause's flag alone: wake must fail fast instead of silently ignoring it
  // (the same hole a prior pause --reason attempt left open on the per-role branch).
  r = await cli(repo, "wake", "--reason", "fixed");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --reason/);
  assert.match(r.stderr, /valid flags for tumwater wake: --role <id>/);
  assert.ok(!fs.existsSync(wakeRequestPath(repo)), "no marker written");

  // `run` takes exactly one flag (--branch); anything else is rejected and names it.
  r = await cli(repo, "run", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --verbose/);
  assert.match(r.stderr, /valid flags for tumwater run: --branch <name>/);

  // ...including version and help, which used to accept anything silently: `version --json`
  // printed a version as if it had answered the query, and `help extra` printed usage.
  r = await cli(repo, "version", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);

  // `help <command>` now prints that command's usage stanza; only a NON-command token is
  // still an error — pointed back at the full list instead of pretending it was answered.
  r = await cli(repo, "help", "gui");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tumwater gui/);

  r = await cli(repo, "help", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no help topic: extra/);

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--role", "clean");
  assert.equal(r.code, 0);
});

test("a malformed flag value is named before the ready-repo gate", async () => {
  // The missing-value gate above covers a flag whose value is ABSENT; this covers a value
  // present but malformed (`--since bogus`, `-n 0`, `--port abc`): the same masking applied —
  // outside an initialized repo the ready-repo gate reported "not a git repository" while the
  // operator's actual typo went unnamed. Each spec now re-runs its command body's own pure
  // shape parser at the gate, so the wording is the parser's, byte for byte, in both places.
  const empty = tmpdir();
  const cases: Array<[string[], RegExp]> = [
    [["logs", "--since", "bogus"], /--since needs a duration like 45s, 90m, 2h, or 1d \(got "bogus"\)/],
    [["history", "--since", "0s"], /--since needs a duration like 45s, 90m, 2h, or 1d \(got "0s"\)/],
    [["report", "--since", "45"], /--since needs a duration like 45s, 90m, 2h, or 1d \(got "45"\)/],
    [["logs", "-n", "0"], /-n needs a positive integer \(got "0"\)/],
    [["history", "-n", "abc"], /-n needs a positive integer \(got "abc"\)/],
    [["report", "--days", "abc"], /--days needs a positive integer \(got "abc"\)/],
    [["gui", "--port", "abc"], /--port must be an integer between 1 and 65535 \(got "abc"\)/],
    [["pause", "--for", "xyz"], /--for needs a duration like 45s, 90m, 2h, or 1d \(got "xyz"\)/],
  ];
  for (const [args, pattern] of cases) {
    const r = await cli(empty, ...args);
    assert.equal(r.code, 1, `tumwater ${args.join(" ")}`);
    assert.match(r.stderr, pattern, `tumwater ${args.join(" ")}`);
    assert.doesNotMatch(r.stderr, /git repository/, `tumwater ${args.join(" ")}`);
  }

  // In a ready repo the same slips fail identically — the gate runs there too.
  const repo = makeRepo();
  await initProject(repo, "cli malformed flag value");
  const ready = await cli(repo, "logs", "--since", "bogus");
  assert.equal(ready.code, 1);
  assert.match(ready.stderr, /--since needs a duration like 45s, 90m, 2h, or 1d \(got "bogus"\)/);
});

test("a valued flag left without its value is named before the ready-repo gate", async () => {
  // Outside an initialized repo, `pause --role` used to report "not a git repository": the
  // ready-repo gate sits between rejectUnknownArgs and each command's own parser, so the
  // missing value was masked until the operator had fixed an environment that was never the
  // problem. The gate now names it with the parser's own wording, and no marker is written.
  const empty = tmpdir();
  const r = await cli(empty, "pause", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater: --role needs a role id/);
  assert.doesNotMatch(r.stderr, /git repository/);

  // The pause reason's missing value names its own command, the same masking rule.
  const reasonless = await cli(empty, "pause", "--reason");
  assert.equal(reasonless.code, 1);
  assert.match(reasonless.stderr, /tumwater: pause --reason needs a reason/);
  assert.doesNotMatch(reasonless.stderr, /git repository/);

  // prompt has no rejectUnknownArgs (free-form positionals), so its parse runs before the
  // gate instead — the same slip, the same wording, no environment error.
  const p = await cli(empty, "prompt", "--role");
  assert.equal(p.code, 1);
  assert.match(p.stderr, /tumwater: --role needs a role id/);
  assert.doesNotMatch(p.stderr, /git repository/);

  // In a ready repo the same slips fail identically — the gate runs there too.
  const repo = makeRepo();
  await initProject(repo, "cli missing flag value");
  for (const args of [["pause", "--role"], ["prompt", "--role"]]) {
    const ready = await cli(repo, ...args);
    assert.equal(ready.code, 1);
    assert.match(ready.stderr, /tumwater: --role needs a role id/);
  }
});

test("tui rejects unknown arguments before anything launches", async () => {
  // tui's CLI dispatch (cli.ts's case "tui") takes no flags at all — the lazy ink import and
  // the ready-repo gate behind it must never see a malformed invocation, so the arg gate is
  // the first line. This also pins the dispatch's guard half without launching the TUI.
  const repo = makeRepo();
  await initProject(repo, "cli tui unknown flag");
  const r = await cli(repo, "tui", "--json");
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "tumwater: tumwater tui takes no arguments\n");
});

test("tui gates on a ready repo before the ink import", async () => {
  // The gate precedes the lazy `await import("./ui/tui.js")`: a bare directory answers with
  // readiness.ts's wording instead of the TUI failing on a missing state file mid-render.
  const dir = tmpdir();
  const r = await cli(dir, "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);
});

test("tui reaches its dispatch and answers a non-interactive terminal", async () => {
  // A ready repo carries the invocation past both guards to the lazy ink import and runTui —
  // which itself refuses a non-TTY stdio (a child process, like this test's spawn) with its
  // own wording and a clean exit, pointing at the interactive alternatives.
  const repo = makeRepo();
  await initProject(repo, "cli tui non-tty");
  const r = await cli(repo, "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs an interactive terminal/);
  assert.match(r.stderr, /tumwater status/);
});

test("prompt --at without a value fails with parseDurationFlag's message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt at missing value");
  // A bare --at claims a duration: a missing value is parseDurationFlag's own error, not a
  // silent enqueue of "--at re-check" as prompt text.
  const r = await cli(repo, "prompt", "--at");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--at needs a value/);
  assert.equal(inboxSize(repo), 0, "the flag pair was not baked into queued content");
});
