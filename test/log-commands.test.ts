import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdLogs } from "../src/cli/log-commands.js";
import { logEvent } from "../src/events/events.js";
import { eventsLogPath, piLogPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { ensureParentDir } from "../src/files/files.js";
import { captureStdout } from "./helpers/exit-capture.js";

// The follow half of `tumwater logs` (`-f`) never returns — it polls until Ctrl+C — so the
// end-to-end tests run it in a spawned child. That leaves the in-process coverage of both
// follow callbacks and their edge cases (a log that does not exist yet, blank/malformed
// lines, non-renderable transcript events) unmeasured. These tests call cmdLogs directly,
// mock only setInterval so the poll can be driven deterministically, and never await the
// never-resolving command promise.

test("logs -f follows a missing event log without creating it, then picks up appended events, skipping blank and malformed lines", async (t) => {
  const repo = makeRepo();
  const cap = captureStdout();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let followError: unknown = null;
  try {
    void cmdLogs(repo, ["-f"]).catch((err: unknown) => (followError = err));

    // A fresh repo has no events.jsonl; following must tolerate that without creating it —
    // logs is read-only (writes to stdout only), so it never leaves harness state behind.
    const file = eventsLogPath(repo);
    t.mock.timers.tick(500);
    assert.ok(!fs.existsSync(file), "logs -f does not create the missing event log");
    assert.equal(cap.out(), "", "an empty log prints nothing");

    // Blank lines and unparseable JSON are dropped by the follow callback, not printed or thrown.
    // The test plays the log writer here, so it makes the file appear the way logEvent does
    // (parent dir included); cmdLogs itself still created nothing.
    ensureParentDir(file);
    fs.appendFileSync(file, "\n");
    fs.appendFileSync(file, "not json\n");
    t.mock.timers.tick(500);
    assert.equal(cap.out(), "", "blank and malformed lines are skipped");

    // A real event appended while following is rendered through the same formatter as the
    // one-shot path.
    logEvent(repo, { source: "clean", type: "run_start", run: 1 });
    t.mock.timers.tick(500);
    assert.match(cap.out(), /clean\s+run #1 started/);
    assert.equal(followError, null);
  } finally {
    t.mock.timers.reset();
    cap.restore();
  }
});

test("logs --transcript -f follows a transcript created after startup and skips non-renderable lines", async (t) => {
  const repo = makeRepo();
  const cap = captureStdout();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let followError: unknown = null;
  try {
    void cmdLogs(repo, ["--transcript", "clean", "-f"]).catch((err: unknown) => (followError = err));

    // No pi log yet: the command reports that, then follows the path it will appear at.
    assert.equal(cap.out(), "no transcript yet for clean\n");

    const file = piLogPath(repo, "clean");
    ensureParentDir(file);
    // A streaming delta renders no entry; printEntry's empty guard must print nothing.
    fs.appendFileSync(file, JSON.stringify({ type: "message_update" }) + "\n");
    t.mock.timers.tick(500);
    assert.equal(cap.out(), "no transcript yet for clean\n", "non-renderable lines print nothing");

    // A completed assistant turn appended later is rendered exactly once.
    fs.appendFileSync(file, assistantLine("live turn") + "\n");
    t.mock.timers.tick(500);
    assert.match(cap.out(), /live turn/);
    assert.equal(followError, null);
  } finally {
    t.mock.timers.reset();
    cap.restore();
  }
});

// A follow whose parent exits is reparented and would poll forever; the parent-death watch
// ends it. The fake ppid drives the watch without reparenting a real process.
async function assertFollowEndsWithParent(args: string[], file: (repo: string) => string, line: string, seen: RegExp, later: string) {
  const repo = makeRepo();
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  try {
    void cmdLogs(repo, args, { ppid: () => parent, intervalMs: 10 }).then(() => (done = true));
    ensureParentDir(file(repo));
    fs.appendFileSync(file(repo), line + "\n");
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(cond(), "condition met within 5s");
    };
    await until(() => seen.test(cap.out()));
    assert.equal(done, false, "still following while the parent is alive");
    parent = 1;
    await until(() => done);
    const before = cap.out();
    fs.appendFileSync(file(repo), later + "\n");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(cap.out(), before, "nothing printed after the follow ended");
  } finally {
    cap.restore();
  }
}

test("logs -f ends once its parent is gone", async () => {
  const ev = (run: number) => JSON.stringify({ ts: new Date().toISOString(), source: "clean", type: "run_start", run });
  await assertFollowEndsWithParent(["-f"], eventsLogPath, ev(1), /run #1 started/, ev(2));
});

test("logs --transcript -f ends once its parent is gone", async () => {
  await assertFollowEndsWithParent(
    ["--transcript", "clean", "-f"],
    (repo) => piLogPath(repo, "clean"),
    assistantLine("first turn"),
    /first turn/,
    assistantLine("second turn"),
  );
});
