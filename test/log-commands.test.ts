import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdLogs } from "../src/ui/log-commands.js";
import { logEvent } from "../src/events.js";
import { eventsLogPath, piLogPath } from "../src/paths.js";
import { makeRepo } from "./repo-fixtures.js";
import { assistantLine } from "./pi-events.js";
import { ensureParentDir } from "../src/files.js";
import { captureStdout } from "./exit-capture.js";

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
    void cmdLogs(repo, ["-f"]).catch((e) => (followError = e));

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
    logEvent(repo, { loop: "clean", type: "tick_start", tick: 1 });
    t.mock.timers.tick(500);
    assert.match(cap.out(), /clean\s+tick #1 started/);
    assert.equal(followError, null);
  } finally {
    t.mock.timers.reset();
    cap.restore();
  }
});

test("logs --role -f follows a transcript created after startup and skips non-renderable lines", async (t) => {
  const repo = makeRepo();
  const cap = captureStdout();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let followError: unknown = null;
  try {
    void cmdLogs(repo, ["--role", "clean", "-f"]).catch((e) => (followError = e));

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
