/** The CLI dispatcher's help command, driven as a child process like every CLI test (the spawn
 * helpers live in helpers/cli-harness.ts): usage with no command or `help`, the `--help`/`-h`
 * spellings that answer like `help` (bare, with a topic, or with a mistyped one), and help's
 * arity. Every test in this family spawns the CLI, so it is split by topic to keep each file
 * small for the gate: one command's topic lives in cli-help-topic.test.ts, unknown and mistyped
 * commands in cli-help-unknown.test.ts, and `version` in cli-help-version.test.ts. Split out of
 * cli.test.ts, which keeps the command bodies and indexes the other CLI test files. */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

test("help and no command print usage", async () => {
  const dir = tmpdir();
  for (const args of [[], ["help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /tumwater init/);
    assert.match(r.stdout, /tumwater prompt/);
  }
});

test("--help and -h answer like `help` — the flag spellings are commands themselves", async () => {
  // The <command> --help interception deliberately skips a command that IS --help/-h: those
  // fall through to the help dispatcher, where a following token is read as a topic name.
  // Bare, they print the full listing; with a token, the token's topic — so `tumwater --help
  // status` and `tumwater help status` print the same stanza, and a mistyped token gets the
  // dispatcher's no-topic error instead of silently printing the full list.
  const dir = tmpdir();
  for (const flag of ["--help", "-h"]) {
    const bare = await cli(dir, flag);
    assert.equal(bare.code, 0);
    assert.match(bare.stdout, /Usage:/);
    assert.match(bare.stdout, /tumwater init/);

    const topic = await cli(dir, flag, "status");
    assert.equal(topic.code, 0);
    assert.match(topic.stdout, /tumwater status/);

    const mistyped = await cli(dir, flag, "statis");
    assert.equal(mistyped.code, 1);
    assert.match(mistyped.stderr, /no help topic: "statis" — did you mean `status`\?/);
  }
});

test("help takes at most one command name", async () => {
  // Two tokens are never a topic: the arity failure must come from the help dispatcher
  // itself, before any topic lookup could misread the second token as a flag of the first.
  const r = await cli(tmpdir(), "help", "status", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /help takes at most one command name/);
});
