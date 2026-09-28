import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdLogs } from "../src/ui/log-commands.js";
import { logEvent } from "../src/events.js";
import { piLogPath } from "../src/paths.js";
import { makeRepo } from "./repo-fixtures.js";
import { assistantLine, userLine } from "./pi-events.js";

// The follow half of cmdLogs is covered by log-commands.test.ts (in-process, driven by mocked
// timers). These tests cover the one-shot views the follow tests never reach: the -n dump,
// the --grep filter and its no-match note, the --since window and its rotation caveat, the
// --role transcript without -f, and every mutually-exclusive-flag failure that guards the
// rival shapes. All failures are caught in-process with a process.exit stub (the idiom from
// cli-args.test.ts), so no spawned child is needed.

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

type Outcome<T> = { exited: true; code: number; stderr: string } | { exited: false; value: T };

/** Run fn with process.exit and process.stderr intercepted so fail() paths are assertable
 * in-process; both globals are always restored. */
async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  const realExit = process.exit;
  const realWrite = (process.stderr as unknown as { write: (s: string) => boolean }).write;
  let stderr = "";
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stderr += s;
    return true;
  };
  try {
    return { exited: false, value: await fn() };
  } catch (err) {
    if (err instanceof ExitError) return { exited: true, code: err.code, stderr };
    throw err;
  } finally {
    process.exit = realExit;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = realWrite;
  }
}

async function expectFail(fn: () => Promise<unknown>): Promise<string> {
  const out = await attempt(fn);
  if (!out.exited) assert.fail(`expected process.exit, but the call returned normally`);
  assert.equal(out.code, 1);
  return out.stderr;
}

/** Intercept process.stdout.write for the duration of a test; restore() must run in finally. */
function captureStdout(): { out: () => string; restore: () => void } {
  const stdout = process.stdout as unknown as { write: (s: string) => boolean };
  const real = stdout.write;
  let out = "";
  stdout.write = (s: string) => ((out += s), true);
  return { out: () => out, restore: () => (stdout.write = real) };
}

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
  const cap = captureStdout();
  try {
    await cmdLogs(repo, ["-n", "2"]);
    const out = cap.out();
    // The last two events, oldest of the pair first: the log order is the print order,
    // and the first of the three logged events is cut by the count.
    assert.match(out, /tests\s+tick #1 started/);
    assert.match(out, /clean\s+tick #1 changed/);
    assert.ok(!/clean\s+tick #1 started/.test(out), "only the requested count is shown");
  } finally {
    cap.restore();
  }
});

test("logs --grep filters the -n view by raw type and rendered line, case-insensitively", async () => {
  const repo = repoWithEvents();
  const cap = captureStdout();
  try {
    // The raw type id matches even where the rendering paraphrases it.
    await cmdLogs(repo, ["--grep", "tick_end"]);
    assert.match(cap.out(), /clean\s+tick #1 changed/);
    assert.ok(!cap.out().includes("started"), "the unmatched tick_start row is filtered out");

    // Case-insensitive, and matches the rendered line too.
    cap.restore();
    const cap2 = captureStdout();
    try {
      await cmdLogs(repo, ["--grep", "TICK"]);
      const out = cap2.out();
      assert.match(out, /tick #1 started/);
      assert.match(out, /tick #1 changed/);
    } finally {
      cap2.restore();
    }
  } finally {
    cap.restore();
  }
});

test("logs --grep with no matches says so instead of printing nothing silently", async () => {
  const repo = repoWithEvents();
  const cap = captureStdout();
  try {
    await cmdLogs(repo, ["--grep", "land_failed"]);
    assert.match(cap.out(), /no events matching "land_failed"/);
  } finally {
    cap.restore();
  }
});

test("logs --since prints a bounded past window oldest-first and flags an unproven window", async () => {
  const repo = repoWithEvents();
  const cap = captureStdout();
  try {
    await cmdLogs(repo, ["--since", "1h"]);
    const out = cap.out();
    // Oldest first, unlike the -n view: a window reads forward.
    const first = out.indexOf("started");
    const second = out.indexOf("changed");
    assert.ok(first >= 0 && second > first, `events print oldest-first: ${JSON.stringify(out)}`);
    // A fresh repo's log cannot prove it covers the window's start, so the rotation
    // caveat rides along with the rows.
    assert.match(out, /older events may have rotated out/);
  } finally {
    cap.restore();
  }
});

test("logs --since with no events in the window says so without a false rotation claim", async () => {
  const repo = makeRepo(); // no events at all
  const cap = captureStdout();
  try {
    await cmdLogs(repo, ["--since", "1h"]);
    assert.match(cap.out(), /no events in 1h/);
    assert.ok(!cap.out().includes("rotated out"), "no rows means no sparse-window note");
  } finally {
    cap.restore();
  }
});

test("logs --role prints a one-shot transcript and reports a missing log", async () => {
  const repo = makeRepo();
  const cap = captureStdout();
  try {
    await cmdLogs(repo, ["--role", "clean"]);
    assert.equal(cap.out(), "no transcript yet for clean\n");

    const file = piLogPath(repo, "clean");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, userLine("fix the leak") + "\n");
    fs.appendFileSync(file, assistantLine("on it") + "\n");
    cap.restore();
    const cap2 = captureStdout();
    try {
      await cmdLogs(repo, ["--role", "clean"]);
      const out = cap2.out();
      assert.ok(!out.includes("no transcript yet"), "an existing log is printed, not the missing note");
      assert.match(out, /on it/);
      // Without --prompt the exact prompt text stays hidden.
      assert.ok(!out.includes("fix the leak"), "prompts are hidden unless --prompt is passed");
    } finally {
      cap2.restore();
    }
  } finally {
    cap.restore();
  }
});

test("logs --prompt with --role shows the exact prompt text in the transcript view", async () => {
  const repo = makeRepo();
  const file = piLogPath(repo, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, userLine("fix the leak") + "\n");
  const cap = captureStdout();
  try {
    await cmdLogs(repo, ["--role", "clean", "--prompt"]);
    assert.match(cap.out(), /fix the leak/);
  } finally {
    cap.restore();
  }
});

test("logs rejects rival flag shapes, naming both flags in each failure", async () => {
  const repo = makeRepo();
  // --grep pairs
  assert.match(await expectFail(() => cmdLogs(repo, ["--grep", "x", "--role", "clean"])), /--grep cannot be combined with --role/);
  assert.match(await expectFail(() => cmdLogs(repo, ["--grep", "x", "--since", "1h"])), /--grep cannot be combined with --since/);
  assert.match(await expectFail(() => cmdLogs(repo, ["--grep"])), /--grep needs a pattern/);
  assert.match(await expectFail(() => cmdLogs(repo, ["--grep", ""])), /--grep needs a pattern/);
  // --since pairs
  assert.match(await expectFail(() => cmdLogs(repo, ["--since", "1h", "-f"])), /--since cannot be combined with -f\/--follow/);
  assert.match(await expectFail(() => cmdLogs(repo, ["--since", "1h", "-n", "5"])), /--since cannot be combined with -n/);
  assert.match(await expectFail(() => cmdLogs(repo, ["--since", "1h", "--role", "clean"])), /--since cannot be combined with --role/);
  assert.match(await expectFail(() => cmdLogs(repo, ["--since", "30d"])), /capped at 7d/);
  // --prompt needs a role: a transcript, not the event log, is what could show prompts.
  assert.match(await expectFail(() => cmdLogs(repo, ["--prompt"])), /--prompt needs --role/);
});
