import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdLogs } from "../src/cli/log-commands.js";
import { logEvent } from "../src/events/events.js";
import { piLogPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { assistantLine, userLine } from "./fixtures/pi-events.js";
import { ensureParentDir } from "../src/files/files.js";
import { expectFailAsync, expectOkAsync } from "./helpers/exit-capture.js";

// The follow half of cmdLogs is covered by log-commands.test.ts (in-process, driven by mocked
// timers). These tests cover the one-shot views the follow tests never reach: the -n dump,
// the --grep filter and its no-match note, the --since window and its rotation caveat, the
// --transcript transcript without -f, and every mutually-exclusive-flag failure that guards the
// rival shapes. All failures are caught in-process with a process.exit stub (the shared
// stub in test/helpers/exit-capture.ts), so no spawned child is needed.

/** A repo with three distinct tick events logged, in order. */
function repoWithEvents(): string {
  const repo = makeRepo();
  logEvent(repo, { source: "clean", type: "run_start", run: 1 });
  logEvent(repo, { source: "tests", type: "run_start", run: 1 });
  logEvent(repo, { source: "clean", type: "run_end", run: 1, result: "changed" });
  return repo;
}

test("logs -n dumps the last N events in order without following", async () => {
  const repo = repoWithEvents();
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["-n", "2"]));
  // The last two events, oldest of the pair first: the log order is the print order,
  // and the first of the three logged events is cut by the count.
  assert.match(out, /tests\s+run #1 started/);
  assert.match(out, /clean\s+run #1 merged/);
  assert.ok(!/clean\s+run #1 started/.test(out), "only the requested count is shown");
});

test("logs --grep filters the -n view by raw type and rendered line, case-insensitively", async () => {
  const repo = repoWithEvents();
  // The raw type id matches even where the rendering paraphrases it.
  const { stdout: raw } = await expectOkAsync(() => cmdLogs(repo, ["--grep", "run_end"]));
  assert.match(raw, /clean\s+run #1 merged/);
  assert.ok(!raw.includes("started"), "the unmatched run_start row is filtered out");

  // Case-insensitive, and matches the rendered line too.
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["--grep", "RUN"]));
  assert.match(out, /run #1 started/);
  assert.match(out, /run #1 merged/);
});

test("logs --grep with no matches says so instead of printing nothing silently", async () => {
  const repo = repoWithEvents();
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--grep", "merge_failed"]));
  assert.match(stdout, /no events matching "merge_failed"/);
});

test("logs --since prints a bounded past window oldest-first and flags an unproven window", async () => {
  const repo = repoWithEvents();
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["--since", "1h"]));
  // Oldest first, unlike the -n view: a window reads forward.
  const first = out.indexOf("started");
  const second = out.indexOf("merged");
  assert.ok(first >= 0 && second > first, `events print oldest-first: ${JSON.stringify(out)}`);
  // A fresh repo's log cannot prove it covers the window's start, so the rotation
  // caveat rides along with the rows.
  assert.match(out, /older events may have rotated out/);
});

test("logs --since with no events in the window says so without a false rotation claim", async () => {
  const repo = makeRepo(); // no events at all
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--since", "1h"]));
  assert.match(stdout, /no events in 1h/);
  assert.ok(!stdout.includes("rotated out"), "no rows means no sparse-window note");
});

test("logs --transcript prints a one-shot transcript and reports a missing log", async () => {
  const repo = makeRepo();
  const { stdout: missing } = await expectOkAsync(() => cmdLogs(repo, ["--transcript", "clean"]));
  assert.equal(missing, "no transcript yet for clean\n");

  const file = piLogPath(repo, "clean");
  ensureParentDir(file);
  fs.appendFileSync(file, userLine("fix the leak") + "\n");
  fs.appendFileSync(file, assistantLine("on it") + "\n");
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["--transcript", "clean"]));
  assert.ok(!out.includes("no transcript yet"), "an existing log is printed, not the missing note");
  assert.match(out, /on it/);
  // Without --prompt the exact prompt text stays hidden.
  assert.ok(!out.includes("fix the leak"), "prompts are hidden unless --prompt is passed");
});

test("logs --prompt with --transcript shows the exact prompt text in the transcript view", async () => {
  const repo = makeRepo();
  const file = piLogPath(repo, "clean");
  ensureParentDir(file);
  fs.appendFileSync(file, userLine("fix the leak") + "\n");
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--transcript", "clean", "--prompt"]));
  assert.match(stdout, /fix the leak/);
});

test("logs rejects rival flag shapes, naming both flags in each failure", async () => {
  const repo = makeRepo();
  // --grep pairs
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep", "x", "--transcript", "clean"])), /--grep cannot be combined with --transcript/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep", "x", "--since", "1h"])), /--grep cannot be combined with --since/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep"])), /--grep needs a pattern/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep", ""])), /--grep needs a pattern/);
  // --since pairs
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "1h", "-f"])), /--since cannot be combined with -f\/--follow/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "1h", "-n", "5"])), /--since cannot be combined with -n/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "1h", "--transcript", "clean"])), /--since cannot be combined with --transcript/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "30d"])), /capped at 7d/);
  // --prompt needs a role: a transcript, not the event log, is what could show prompts.
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--prompt"])), /--prompt needs --transcript/);
});

test("logs --count tallies event types most-frequent-first over the -n window", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "clean", type: "run_start", run: 1 });
  logEvent(repo, { source: "clean", type: "run_start", run: 2 });
  logEvent(repo, { source: "tests", type: "run_start", run: 1 });
  logEvent(repo, { source: "clean", type: "run_end", run: 2, result: "changed" });
  logEvent(repo, { source: "clean", type: "run_end", run: 3, result: "none" });
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count"]));
  // Three run_start, two run_end: most-frequent first.
  assert.equal(stdout, "3 × run started (run_start)\n2 × run finished (run_end)\n");
});

test("logs --count breaks ties alphabetically by type", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "a", type: "run_end", run: 1, result: "changed" });
  logEvent(repo, { source: "b", type: "run_start", run: 1 });
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count"]));
  // Equal counts: ties break by type (run_end before run_start).
  assert.equal(stdout, "1 × run finished (run_end)\n1 × run started (run_start)\n");
});

test("logs --count --since scopes the tally to the window and never prints the rotation note", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "a", type: "run_start", run: 1 });
  logEvent(repo, { source: "b", type: "run_start", run: 2 });
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count", "--since", "1h"]));
  assert.equal(stdout, "2 × run started (run_start)\n");
  assert.ok(!stdout.includes("rotated out"), "a count never prints the sparse-window note");
});

test("logs --count --since with an empty window prints the plain view's empty prose", async () => {
  const repo = makeRepo();
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count", "--since", "1h"]));
  assert.match(stdout, /no events in 1h/);
  assert.ok(!stdout.includes("rotated out"), "no rows means no sparse-window note");
});

test("logs --count -n scopes the tally to the last N events", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "a", type: "run_start", run: 1 });
  logEvent(repo, { source: "a", type: "run_start", run: 2 });
  logEvent(repo, { source: "b", type: "run_end", run: 2, result: "changed" });
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count", "-n", "2"]));
  assert.equal(stdout, "1 × run finished (run_end)\n1 × run started (run_start)\n");
});

test("logs --count --grep and --type count only their matches", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "a", type: "run_start", run: 1 });
  logEvent(repo, { source: "a", type: "run_end", run: 1, result: "changed" });
  logEvent(repo, { source: "b", type: "run_start", run: 2 });
  const grepped = await expectOkAsync(() => cmdLogs(repo, ["--count", "--grep", "run_start"]));
  assert.equal(grepped.stdout, "2 × run started (run_start)\n");
  const typed = await expectOkAsync(() => cmdLogs(repo, ["--count", "--type", "run_end"]));
  assert.equal(typed.stdout, "1 × run finished (run_end)\n");
});

test("logs --count --grep with no matches prints the no-match prose", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "a", type: "run_start", run: 1 });
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count", "--grep", "merge_failed"]));
  assert.equal(stdout, 'no events matching "merge_failed"\n');
});

test("logs --count --json emits a sorted type→count object", async () => {
  const repo = makeRepo();
  logEvent(repo, { source: "clean", type: "run_end", run: 1, result: "changed" });
  logEvent(repo, { source: "clean", type: "run_start", run: 1 });
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--count", "--json"]));
  // One compact object, keys sorted alphabetically.
  assert.equal(stdout.trim(), '{"run_end":1,"run_start":1}');
});

test("logs --count rejects the rival shapes, naming both flags", async () => {
  const repo = makeRepo();
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--count", "-f"])), /--count cannot be combined with -f\/--follow/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--count", "--follow"])), /--count cannot be combined with -f\/--follow/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--count", "--transcript", "clean"])), /--count cannot be combined with --transcript/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--count", "--prompt", "--transcript", "clean"])), /--count cannot be combined with --transcript/);
});
