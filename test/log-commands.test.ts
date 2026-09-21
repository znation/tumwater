import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdLogs } from "../src/ui/log-commands.js";
import { logEvent } from "../src/events.js";
import { eventsLogPath, piLogPath } from "../src/paths.js";
import { assistantLine, makeRepo } from "./util.js";

// The follow half of `tumwater logs` (`-f`) never returns — it polls until Ctrl+C — so the
// end-to-end tests run it in a spawned child. That leaves the in-process coverage of both
// follow callbacks and their edge cases (a log that does not exist yet, blank/malformed
// lines, non-renderable transcript events) unmeasured. These tests call cmdLogs directly,
// mock only setInterval so the poll can be driven deterministically, and never await the
// never-resolving command promise.

/** Intercept process.stdout.write for the duration of a test; restore() must run in finally. */
function captureStdout(): { out: () => string; restore: () => void } {
  const stdout = process.stdout as unknown as { write: (s: string) => boolean };
  const real = stdout.write;
  let out = "";
  stdout.write = (s: string) => ((out += s), true);
  return { out: () => out, restore: () => (stdout.write = real) };
}

test("logs -f creates a missing event log and follows appended events, skipping blank and malformed lines", async (t) => {
  const repo = makeRepo();
  const cap = captureStdout();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let followError: unknown = null;
  try {
    void cmdLogs(repo, ["-f"]).catch((e) => (followError = e));

    // A fresh repo has no events.jsonl; following must create it rather than crash.
    const file = eventsLogPath(repo);
    assert.ok(fs.existsSync(file), "logs -f creates the missing event log");
    assert.equal(cap.out(), "", "an empty log prints nothing");

    // Blank lines and unparseable JSON are dropped by the follow callback, not printed or thrown.
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
