/** The CLI's per-command help topics: `<command> --help` (or `-h`, or riding beside other
 * flags), `help --help`, and `help <command>`, each answered before any ready-repo gate. The
 * help command itself lives in cli-help.test.ts, unknown and mistyped commands in
 * cli-help-unknown.test.ts, and `version` in cli-help-version.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

test("<command> --help prints that command's help topic", async () => {
  const dir = tmpdir();
  // Both spellings, and --help riding alongside other flags (help wins, like every CLI).
  // No ready repo is needed: the topic is answered before status's startup gate, so the
  // same invocation outside a git repo still prints usage instead of refusing.
  for (const args of [["status", "--help"], ["pause", "-h"], ["diff", "--role", "x", "--help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${args[0]}`));
  }
  const bare = await cli(tmpdir(), "status", "--help");
  assert.equal(bare.code, 0);
  assert.doesNotMatch(bare.stderr, /not a git repository/);
});

test("help --help prints the help command's own topic", async () => {
  // The convention covers every command, help included: `help --help`/`help -h` must answer
  // with the help topic, not fall through to a topic lookup for the literal flag text
  // (exit 1, "no help topic: \"--help\" — did you mean `help`?").
  for (const args of [["help", "--help"], ["help", "-h"]]) {
    const r = await cli(tmpdir(), ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /tumwater help \[<command>\]/);
  }
});

test("help <command> prints that command's topic without a ready repo", async () => {
  // The dispatch itself (cli.ts's `help` case), not just the topic parser: README documents
  // `tumwater help <command>` as the way to read one command's usage, so the primary spelling
  // must answer like `--help` does — same topic text, exit 0, and no ready-repo gate (help is
  // how an operator diagnoses a repo that is not ready in the first place).
  const dir = tmpdir();
  for (const name of ["status", "report", "help"]) {
    const r = await cli(dir, "help", name);
    assert.equal(r.code, 0, `help ${name}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${name}`));
    assert.doesNotMatch(r.stderr, /not a git repository/);
  }
});
