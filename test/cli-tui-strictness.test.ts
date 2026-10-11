import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// Spawned-CLI guard tests for `tumwater tui`: the dispatch's no-arguments rule, the ready-repo
// gate that precedes the lazy ink import, and runTui's non-interactive-terminal refusal. Split
// out of cli-arg-strictness.test.ts, which keeps the parser-wide unknown-argument and
// flag-value gates, so node --test runs each command's strictness cases in parallel processes.
test("tui rejects unknown arguments before anything launches", async () => {
  // tui's CLI dispatch (cli.ts's case "tui") takes no flags at all — the lazy ink import and
  // the ready-repo gate behind it must never see a malformed invocation, so the arg gate is
  // the first line. This also pins the dispatch's guard half without launching the TUI.
  const repo = makeRepo();
  await initProject(repo, "cli tui unknown flag");
  const r = await cli(repo, "tui", "--json");
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'tumwater: tumwater tui takes no arguments (got "--json")\n');
});

test("tui gates on a ready repo before the ink import", async () => {
  // The gate precedes the lazy `await import("./ui/tui/tui.js")`: a bare directory answers with
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
