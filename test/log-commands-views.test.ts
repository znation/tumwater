import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdLogs } from "../src/cli/log-commands.js";
import { logEvent } from "../src/events/events.js";
import { piLogPath } from "../src/paths.js";
import { makeRepo } from "./repo-fixtures.js";
import { assistantLine, userLine } from "./pi-events.js";
import { ensureParentDir } from "../src/files.js";
import { expectFailAsync, expectOkAsync } from "./exit-capture.js";

// The follow half of cmdLogs is covered by log-commands.test.ts (in-process, driven by mocked
// timers). These tests cover the one-shot views the follow tests never reach: the -n dump,
// the --grep filter and its no-match note, the --since window and its rotation caveat, the
// --role transcript without -f, and every mutually-exclusive-flag failure that guards the
// rival shapes. All failures are caught in-process with a process.exit stub (the shared
// stub in test/exit-capture.ts), so no spawned child is needed.

/** A repo with three distinct tick events logged, in order. */
function repoWithEvents(): string {
  const repo = makeRepo();
  logEvent(repo, { loop: "clean", type: "tick_start", tick: 1 });
  logEvent(repo, { loop: "tests", type: "tick_start", tick: 1 });
  logEvent(repo, { loop: "clean", type: "tick_end", tick: 1, result: "changed" });
  return repo;
}

test("logs -n dumps the last N events in order without following", async () => {
  const repo = repoWithEvents();
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["-n", "2"]));
  // The last two events, oldest of the pair first: the log order is the print order,
  // and the first of the three logged events is cut by the count.
  assert.match(out, /tests\s+tick #1 started/);
  assert.match(out, /clean\s+tick #1 changed/);
  assert.ok(!/clean\s+tick #1 started/.test(out), "only the requested count is shown");
});

test("logs --grep filters the -n view by raw type and rendered line, case-insensitively", async () => {
  const repo = repoWithEvents();
  // The raw type id matches even where the rendering paraphrases it.
  const { stdout: raw } = await expectOkAsync(() => cmdLogs(repo, ["--grep", "tick_end"]));
  assert.match(raw, /clean\s+tick #1 changed/);
  assert.ok(!raw.includes("started"), "the unmatched tick_start row is filtered out");

  // Case-insensitive, and matches the rendered line too.
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["--grep", "TICK"]));
  assert.match(out, /tick #1 started/);
  assert.match(out, /tick #1 changed/);
});

test("logs --grep with no matches says so instead of printing nothing silently", async () => {
  const repo = repoWithEvents();
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--grep", "land_failed"]));
  assert.match(stdout, /no events matching "land_failed"/);
});

test("logs --since prints a bounded past window oldest-first and flags an unproven window", async () => {
  const repo = repoWithEvents();
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["--since", "1h"]));
  // Oldest first, unlike the -n view: a window reads forward.
  const first = out.indexOf("started");
  const second = out.indexOf("changed");
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

test("logs --role prints a one-shot transcript and reports a missing log", async () => {
  const repo = makeRepo();
  const { stdout: missing } = await expectOkAsync(() => cmdLogs(repo, ["--role", "clean"]));
  assert.equal(missing, "no transcript yet for clean\n");

  const file = piLogPath(repo, "clean");
  ensureParentDir(file);
  fs.appendFileSync(file, userLine("fix the leak") + "\n");
  fs.appendFileSync(file, assistantLine("on it") + "\n");
  const { stdout: out } = await expectOkAsync(() => cmdLogs(repo, ["--role", "clean"]));
  assert.ok(!out.includes("no transcript yet"), "an existing log is printed, not the missing note");
  assert.match(out, /on it/);
  // Without --prompt the exact prompt text stays hidden.
  assert.ok(!out.includes("fix the leak"), "prompts are hidden unless --prompt is passed");
});

test("logs --prompt with --role shows the exact prompt text in the transcript view", async () => {
  const repo = makeRepo();
  const file = piLogPath(repo, "clean");
  ensureParentDir(file);
  fs.appendFileSync(file, userLine("fix the leak") + "\n");
  const { stdout } = await expectOkAsync(() => cmdLogs(repo, ["--role", "clean", "--prompt"]));
  assert.match(stdout, /fix the leak/);
});

test("logs rejects rival flag shapes, naming both flags in each failure", async () => {
  const repo = makeRepo();
  // --grep pairs
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep", "x", "--role", "clean"])), /--grep cannot be combined with --role/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep", "x", "--since", "1h"])), /--grep cannot be combined with --since/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep"])), /--grep needs a pattern/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--grep", ""])), /--grep needs a pattern/);
  // --since pairs
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "1h", "-f"])), /--since cannot be combined with -f\/--follow/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "1h", "-n", "5"])), /--since cannot be combined with -n/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "1h", "--role", "clean"])), /--since cannot be combined with --role/);
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--since", "30d"])), /capped at 7d/);
  // --prompt needs a role: a transcript, not the event log, is what could show prompts.
  assert.match(await expectFailAsync(() => cmdLogs(repo, ["--prompt"])), /--prompt needs --role/);
});
