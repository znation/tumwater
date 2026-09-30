import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  EVENTS_MAX_BYTES,
  eventsRotationLabel,
  logEvent,
  parseEventLine,
  readEvents,
  readEventsTailWithEnd,
  subscribeEvents,
} from "../src/events.js";
import { followFile } from "../src/tail.js";
import { eventsLogPath } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";

test("eventsRotationLabel derives the report header's rotation phrase from EVENTS_MAX_BYTES", () => {
  // Pinned to the literal, not recomputed from the constant: a recomputation would pass even
  // if the function stopped deriving (the drift this pins) or the phrase changed shape.
  assert.equal(eventsRotationLabel(), "rotated at 16 MB");
  assert.equal(EVENTS_MAX_BYTES, 16 * 1024 * 1024);
});

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

// The seam `tumwater logs -f` follows from: the tail read reports the byte end it covered, so
// a follow seeded from that same read cannot skip an event appended after the read but before
// the follow starts — the both-neither gap a fresh `statOrNull(file).size` seed carried.
test("readEventsTailWithEnd reports the covered byte end, so a follow seeded from it delivers an event appended after the read", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "clean", type: "tick_start", tick: 1 });
  logEvent(dir, { loop: "clean", type: "tick_end", tick: 1, result: "no_change" });
  const file = eventsLogPath(dir);

  const { events, coveredEnd } = readEventsTailWithEnd(dir, 50);
  assert.equal(events.length, 2);
  // The read covers through EOF as of the read itself — the invariant the follow seed needs.
  assert.equal(coveredEnd, fs.statSync(file).size);

  // The race, replayed deterministically: an event lands AFTER the read (the old code's seed
  // stat, taken later, measured a size past it, so the event was printed by neither view).
  logEvent(dir, { loop: "clean", type: "tick_start", tick: 2 });

  // followFile's first poll runs synchronously, so the appended event must arrive immediately.
  const delivered: string[] = [];
  const stop = followFile(file, coveredEnd, (lines) => delivered.push(...lines));
  stop();
  assert.equal(delivered.length, 1, `exactly the appended event, not the read's window:\n${JSON.stringify(delivered)}`);
  assert.match(delivered[0] ?? "", /"tick":2/);
});

// The seed must sit on a line boundary even when the log's last line is torn (a write in
// flight): readCompleteLines' offset contract. A seed past the torn line's start would make
// the follow deliver the line's tail as a garbled fragment once the writer completes it,
// its head never delivered.
test("readEventsTailWithEnd's covered end stops at the last complete line when the log's last line is torn", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "clean", type: "tick_start", tick: 1 });
  const file = eventsLogPath(dir);
  const torn = '{"loop":"clean","type":"tick_end","tick":1'; // A write in flight: no newline yet.
  fs.appendFileSync(file, torn);

  const { events, coveredEnd } = readEventsTailWithEnd(dir, 50);
  assert.equal(events.length, 1, "the torn line is held back, not parsed");
  assert.equal(coveredEnd, fs.statSync(file).size - Buffer.byteLength(torn));

  // The writer completes the line; a follow seeded at coveredEnd delivers it whole, once.
  fs.appendFileSync(file, ',"result":"no_change"}\n');
  const delivered: string[] = [];
  const stop = followFile(file, coveredEnd, (lines) => delivered.push(...lines));
  stop();
  assert.equal(delivered.length, 1, `the completed line, whole:\n${JSON.stringify(delivered)}`);
  assert.match(delivered[0] ?? "", /"tick_end"/);
});

// And the boundary the seed must sit on exactly: coveredEnd is the read's EOF, so re-following
// from it after the read re-delivers nothing already read.
test("readEventsTailWithEnd on a missing log scans to nothing with coveredEnd 0", () => {
  const dir = tmpdir();
  assert.deepEqual(readEventsTailWithEnd(dir, 10), { events: [], coveredEnd: 0 });
});

test("readEvents skips corrupt lines", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "x", type: "warning", message: "ok" });
  fs.appendFileSync(eventsLogPath(dir), "{torn\n");
  logEvent(dir, { loop: "x", type: "warning", message: "after" });
  assert.equal(readEvents(dir).length, 2);
});

// A line of valid JSON that is not an event object (a scalar, null, or array) is just as
// corrupt as a torn one: it must read as no data, not as a truthy non-object the feed would
// render as garbage.
test("parseEventLine treats valid-JSON non-object lines as no data", () => {
  for (const line of ["null", "123", '"text"', "[1,2]", "true"]) {
    assert.equal(parseEventLine(line), null, line);
  }
  assert.deepEqual(parseEventLine('{"loop":"x","type":"warning"}'), { loop: "x", type: "warning" });
});

test("readEvents skips a valid-JSON non-object line", () => {
  const dir = tmpdir();
  logEvent(dir, { loop: "x", type: "warning", message: "ok" });
  fs.appendFileSync(eventsLogPath(dir), "123\n");
  logEvent(dir, { loop: "x", type: "warning", message: "after" });
  assert.deepEqual(readEvents(dir).map((e) => e.message), ["ok", "after"]);
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

// While events.jsonl ends with an unterminated line — a torn write in flight, or between a
// crash and the next event — that fragment must not occupy one of the `limit` slots: hold it
// back until its newline lands, the same policy as readCompleteLines.
test("readEvents holds back a torn trailing line instead of letting it eat a limit slot", () => {
  const dir = tmpdir();
  const limit = 5;
  for (let i = 0; i < limit + 2; i++) {
    logEvent(dir, { loop: "x", type: "warning", message: `event ${i}` });
  }
  fs.appendFileSync(eventsLogPath(dir), '{"loop":"x","type":"tick_end","resu'); // no trailing \n
  const events = readEvents(dir, limit);
  assert.equal(events.length, limit); // not limit-1: the fragment is held back, not counted
  assert.deepEqual(
    events.map((e) => e.message),
    ["event 2", "event 3", "event 4", "event 5", "event 6"],
  );
});

// A non-positive limit is an empty window, not a raw slice(-limit): slice(-0) is slice(0)
// (the whole scanned window comes back) and a negative limit is slice(k), a positive-start
// cut that keeps the window minus its first k lines. With 10 events, the pre-fix module
// returned 10 at limit 0 and 7 at limit -3 — both asserted empty here.
test("readEvents honors non-positive limits: slice(-0) must not widen the window", () => {
  const dir = tmpdir();
  for (let i = 1; i <= 10; i++) logEvent(dir, { loop: "x", type: "warning", message: `event ${i}` });
  assert.deepEqual(readEvents(dir, 0), []);
  assert.deepEqual(readEvents(dir, -3), []);
});

// NaN is not <= 0 (every comparison with NaN is false), so a `limit <= 0` guard passes it —
// and slice(-NaN) is slice(0), the whole window, exactly the widening the sibling entry
// fixed for 0 and negatives. The non-numeric boundary reads as none, like every
// non-positive one: with 10 events the pre-NaN-guard module returned all 10.
test("readEvents honors a non-numeric limit as an empty window: NaN must not pass the guard", () => {
  const dir = tmpdir();
  for (let i = 1; i <= 10; i++) logEvent(dir, { loop: "x", type: "warning", message: `event ${i}` });
  assert.deepEqual(readEvents(dir, NaN), []);
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
