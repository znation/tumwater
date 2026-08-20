import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatEvent, logEvent, readEvents } from "../src/events.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox.js";
import { eventsLogPath } from "../src/paths.js";
import { tmpdir } from "./util.js";

test("logEvent appends and readEvents tails in order", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "clean", type: "tick_start", tick: 1 });
  logEvent(dir, { loop: "clean", type: "tick_end", tick: 1, result: "no_change" });
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tick_start");
  assert.equal(events[1]?.type, "tick_end");
  assert.deepEqual(readEvents(dir, 1).map((e) => e.type), ["tick_end"]);
});

test("readEvents skips corrupt lines", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "x", type: "warning", message: "ok" });
  fs.appendFileSync(eventsLogPath(dir), "{torn\n");
  logEvent(dir, { loop: "x", type: "warning", message: "after" });
  assert.equal(readEvents(dir).length, 2);
});

test("formatEvent renders each type as one line", () => {
  const cases = [
    { ts: 0, loop: "clean", type: "tick_start", tick: 3 },
    { ts: 0, loop: "clean", type: "tick_end", tick: 3, result: "changed", summary: "tidy up" },
    { ts: 0, loop: "clean", type: "tick_end", tick: 4, result: "error", error: "boom" },
    { ts: 0, loop: "clean", type: "merged", commit: "abcdef1234567890", summary: "tidy up" },
    { ts: 0, loop: "harness", type: "orchestrator_start", pid: 1 },
    { ts: 0, loop: "director", type: "prompt_enqueued", preview: "do x" },
  ] as const;
  for (const e of cases) {
    const line = formatEvent(e as never);
    assert.ok(line.includes(e.loop), `line should name the loop: ${line}`);
    assert.ok(!line.includes("\n"));
  }
  assert.match(formatEvent(cases[1] as never), /tidy up/);
  assert.match(formatEvent(cases[2] as never), /boom/);
  assert.match(formatEvent(cases[3] as never), /abcdef12/);
});

test("inbox is FIFO and dequeues to empty", () => {
  const dir = tmpdir();
  assert.equal(inboxSize(dir), 0);
  assert.equal(dequeuePrompt(dir), null);
  enqueuePrompt(dir, "first");
  enqueuePrompt(dir, "second");
  assert.equal(inboxSize(dir), 2);
  assert.equal(dequeuePrompt(dir), "first");
  assert.equal(dequeuePrompt(dir), "second");
  assert.equal(dequeuePrompt(dir), null);
});
