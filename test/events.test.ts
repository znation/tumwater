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

// A crash or power loss mid-append leaves the last line without its newline. Without
// termination the next append glues onto the fragment and BOTH lines fail JSON.parse forever —
// one complete event lost from every consumer until rotation.
test("logEvent terminates a torn trailing line before appending", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "x", type: "warning", message: "ok" });
  const frag = '{"loop":"x","type":"tick_end","tick":1,"resu'; // no trailing \n
  fs.appendFileSync(eventsLogPath(dir), frag);
  logEvent(dir, { loop: "x", type: "warning", message: "after" });
  const lines = fs.readFileSync(eventsLogPath(dir), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3); // ok / torn fragment on its own line / after
  assert.equal(lines[1], frag); // terminated in place — not glued onto the next event
  const events = readEvents(dir);
  assert.deepEqual(events.map((e) => e.message), ["ok", "after"]); // the torn fragment is skipped, "after" survives
});

// Reference implementation: read the whole file (what readEvents used to do).
function referenceTail(root: string, limit: number) {
  const lines = fs.readFileSync(eventsLogPath(root), "utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

// The windowed path must return exactly the last `limit` lines at every log size past the
// whole-read threshold — including mid-size logs where limit < total line count (the case a
// grown event log spends most of its life in, polled every second by the TUI and GUI).
test("readEvents matches a full-file read on logs past the tail-scan threshold", () => {
  for (const [count, minBytes] of [
    [100, 8 * 1024], // just over the threshold: window smaller than the file
    [4000, 384 * 1024], // well past it: many chunks back from EOF
  ] as const) {
    const dir = tmpdir();
    // ~115 bytes per event; 4000 events ≈ 460KB.
    for (let i = 0; i < count; i++) {
      logEvent(dir, { loop: "clean", type: "warning", message: `event number ${i} with some padding to grow the file` });
    }
    assert.ok(fs.statSync(eventsLogPath(dir)).size > minBytes);
    for (const limit of [1, 7, 40, 200, count - 1]) {
      const got = readEvents(dir, limit).map((e) => e.message as string);
      const want = referenceTail(dir, limit).map((e: { message?: unknown }) => String(e.message));
      assert.deepEqual(got, want, `count ${count}, limit ${limit}`);
    }
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
