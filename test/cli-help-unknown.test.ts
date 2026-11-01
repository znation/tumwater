/** What the CLI dispatcher does with a command it must not run as typed: an unknown command
 * fails with a hint, a near miss (of a command or a help topic) suggests the closest name, and
 * the `<command> --help` interception stands down for an unknown command and for a --help token
 * inside a free-form command's text. The help command lives in cli-help.test.ts, one command's
 * topic in cli-help-topic.test.ts, and `version` in cli-help-version.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

test("unknown command fails with a hint", async () => {
  const r = await cli(tmpdir(), "frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: "frobnicate"/);
});

test("a mistyped command suggests the closest listed one", async () => {
  const r = await cli(tmpdir(), "statis");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: "statis" — did you mean `status`\?/);
});

test("a mistyped help topic suggests the closest command too", async () => {
  const r = await cli(tmpdir(), "help", "statu");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no help topic: "statu" — did you mean `status`\?/);
});

test("--help does not rescue an unknown command", async () => {
  const r = await cli(tmpdir(), "frobnicate", "--help");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: "frobnicate"/);
});

test("a free-form text command carrying a --help token files the text, not the help topic", async () => {
  // The <command> --help interception answers a flag-shaped help request, but the free-form
  // position commands (init, prompt, bug, plan) read their positionals as operator text — a
  // text containing a standalone --help/-h token (`tumwater bug the TUI mishandles --help
  // output`) used to be swallowed whole: the topic printed, exit 0, the text gone with no
  // trace. When such a command carries any non-flag token (real text), the interception must
  // stand down and let the command read the text; with only flags present (`tumwater bug
  // --help`, `prompt --role qa --help`) the topic still answers.
  const dir = tmpdir();
  await initProject(dir, "test team");
  const filed = await cli(dir, "bug", "the", "TUI", "mishandles", "--help", "output");
  assert.equal(filed.code, 0, `bug --help text: ${filed.stderr}`);
  assert.doesNotMatch(filed.stdout, /Usage:/);
  assert.match(fs.readFileSync(path.join(dir, "BUGS.md"), "utf8"), /the TUI mishandles --help output/);

  const prompted = await cli(dir, "prompt", "fix", "the", "--help", "flag");
  // prompt (and init) read flag values, so a help token beside text is ambiguous there —
  // the parser's named error answers instead of either silently queuing or printing help.
  assert.equal(prompted.code, 1);
  assert.match(prompted.stderr, /unknown argument: --help/);
  assert.doesNotMatch(prompted.stderr, /Usage:/);

  // Flag-only invocations keep the topic answer.
  for (const args of [["bug", "--help"], ["prompt", "--role", "qa", "--help"], ["init", "--help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${args[0]}`));
  }
});
