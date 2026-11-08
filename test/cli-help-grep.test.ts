/** The help listing's `--grep` search: `tumwater help --grep <text>` prints every usage
 * stanza whose command line or description contains the text, case-insensitively, in help
 * order. Unit-calls `searchHelp` directly (the search twin of helpTopic over the same stanza
 * text) and spawns the CLI for the search's answer shapes — matches, the no-match line, the
 * missing-value error and the extra-token error — plus unchanged bare-help and topic output
 * outside a git repo. The bare listing and per-command topics keep their homes in
 * cli-help.test.ts and cli-help-topic.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { HELP_GREP_VALUE_ERROR, helpStanzas, searchHelp } from "../src/cli/help.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

/** The oracle the search derives from: every stanza whose text contains the pattern, so the
 * search cannot drift from the stanza text helpStanzas splits. */
function expectedStanzas(text: string): string[] {
  const needle = text.toLowerCase();
  return helpStanzas()
    .filter((s) => s.text.toLowerCase().includes(needle))
    .map((s) => s.text);
}

test("searchHelp returns every stanza carrying a flag, verbatim and in help order", () => {
  // --since is shared by the history, logs and report usage forms; init carries it nowhere.
  const since = searchHelp("--since");
  assert.deepEqual(since, expectedStanzas("--since"));
  assert.ok(since.some((s) => s.startsWith("  tumwater history")));
  assert.ok(since.some((s) => s.startsWith("  tumwater logs")));
  assert.ok(!since.some((s) => s.startsWith("  tumwater init")));
  for (const s of since) assert.match(s, /--since/);
});

test("searchHelp matches case-insensitively and keeps usage forms separate", () => {
  // Both failure-digest usage forms carry `report --failures`; the plain-days form names the
  // digest only as prose ("with --failures"), so the search finds exactly those two.
  const upper = searchHelp("REPORT --FAILURES");
  assert.deepEqual(upper, expectedStanzas("REPORT --FAILURES"));
  assert.equal(upper.length, 2);
  assert.ok(upper.every((s) => s.startsWith("  tumwater report --failures")));
});

test("searchHelp finds a pattern that appears only in a description", () => {
  // "localhost" is gui's description prose; no stanza's usage line spells it.
  const gui = helpStanzas().filter((s) => s.command === "gui");
  assert.ok(gui.length === 1 && gui[0]!.text.includes("localhost"));
  assert.ok(!helpStanzas().some((s) => s.text.split("\n")[0]!.includes("localhost")));
  const matches = searchHelp("localhost");
  assert.deepEqual(matches, expectedStanzas("localhost"));
  assert.deepEqual(matches.map((s) => s.split("\n")[0]), ["  tumwater gui [--port N] [--all-interfaces] [--token <secret>]"]);
});

test("searchHelp returns an empty array when nothing matches", () => {
  assert.deepEqual(searchHelp("zzzz"), []);
  assert.deepEqual(searchHelp("zzzz"), expectedStanzas("zzzz"));
});

test("help --grep prints the stanzas containing the pattern, outside a git repo", async () => {
  const dir = tmpdir(); // not a git repo: the search needs no ready repo, like the topic form.
  const r = await cli(dir, "help", "--grep", "--since");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /tumwater history/);
  assert.match(r.stdout, /tumwater logs/);
  assert.doesNotMatch(r.stdout, /tumwater init/);
  assert.doesNotMatch(r.stderr, /not a git repository/);
});

test("help --grep matches case-insensitively and in descriptions", async () => {
  const dir = tmpdir();
  const usage = await cli(dir, "help", "--grep", "REPORT --FAILURES");
  assert.equal(usage.code, 0, usage.stderr);
  assert.match(usage.stdout, /tumwater report --failures/);
  const prose = await cli(dir, "help", "--grep", "localhost");
  assert.equal(prose.code, 0, prose.stderr);
  assert.match(prose.stdout, /tumwater gui/);
  assert.match(prose.stdout, /localhost only/);
});

test("help --grep prints the no-match line and exits 0", async () => {
  // A search that finds nothing is an answer, not an unknown topic.
  const r = await cli(tmpdir(), "help", "--grep", "zzzz");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'no help text matches "zzzz"');
});

test("help --grep needs its text value", async () => {
  const r = await cli(tmpdir(), "help", "--grep");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\bhelp --grep needs text \(usage: tumwater help --grep <text>\)/);
  // The dispatcher and the exported error share one wording.
  assert.match(r.stderr, new RegExp(HELP_GREP_VALUE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("help --grep takes only its search text", async () => {
  // A second token after the pattern is never part of the search: the search-only usage names
  // itself, like each --grep filter view refuses a stray positional.
  const r = await cli(tmpdir(), "help", "--grep", "x", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /help --grep takes only its search text \(usage: tumwater help --grep <text>\)/);
  // A repeated --grep is a leftover token too, not a second flag to ignore.
  const repeated = await cli(tmpdir(), "help", "--grep", "x", "--grep");
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /help --grep takes only its search text/);
});

test("bare help and the topic form are unchanged by the search", async () => {
  const dir = tmpdir();
  const bare = await cli(dir, "help");
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /Usage:/);
  // The new form has its own listed stanza, and a topic search over "help" finds both forms.
  assert.match(bare.stdout, /tumwater help --grep <text>/);
  const topic = await cli(dir, "help", "help");
  assert.equal(topic.code, 0);
  assert.match(topic.stdout, /tumwater help --grep <text>/);
  const status = await cli(dir, "help", "status");
  assert.equal(status.code, 0);
  assert.match(status.stdout, /tumwater status/);
  assert.doesNotMatch(status.stderr, /not a git repository/);
});
