import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { logEvent, readEvents, subscribeEvents } from "../src/events.js";
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

// Reference implementation: read the whole file (what readEvents used to do).
function referenceTail(root: string, limit: number) {
  const lines = fs.readFileSync(eventsLogPath(root), "utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

test("readEvents matches a full-file read on a log past the tail-scan threshold", () => {
  const dir = tmpdir();
  // ~150 bytes per event; 4000 events ≈ 600KB, well over the 256KB threshold.
  for (let i = 0; i < 4000; i++) {
    logEvent(dir, { loop: "clean", type: "warning", message: `event number ${i} with some padding to grow the file` });
  }
  assert.ok(fs.statSync(eventsLogPath(dir)).size > 256 * 1024);
  for (const limit of [1, 7, 40, 200, 3999]) {
    const got = readEvents(dir, limit).map((e) => e.message as string);
    const want = referenceTail(dir, limit).map((e: { message?: unknown }) => String(e.message));
    assert.deepEqual(got, want, `limit ${limit}`);
  }
});

// formatEvent's tests live in test/event-format.test.ts (presentation module).

test("subscribeEvents sees logged events until unsubscribed", () => {
  const dir = tmpdir();
  const seen: string[] = [];
  const unsubscribe = subscribeEvents((e) => seen.push(e.type));
  logEvent(dir, { loop: "x", type: "tick_start", tick: 1 });
  unsubscribe();
  logEvent(dir, { loop: "x", type: "tick_end", tick: 1, result: "no_change" });
  assert.deepEqual(seen, ["tick_start"]);
});
