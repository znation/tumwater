import test from "node:test";
import assert from "node:assert/strict";
import { paneBody } from "../src/ui/tui/tui-pane.js";
import { eventTypeTally } from "../src/events/event-tally.js";
import { logEvent } from "../src/events/events.js";
import type { HarnessEvent } from "../src/events/events.js";
import { formatEvent } from "../src/events/event-format.js";
import { makeTuiRepo } from "./fixtures/tui-fixtures.js";

const state = {
  selectedEntry: null,
  entryScroll: 0,
  selectedQueued: null,
  queuedRows: [],
  paneCache: null,
  noteCache: null,
  changeCache: null,
  trailCache: null,
  paneScroll: 0,
  activityScroll: null,
};

const text = (line: Array<{ text: string }>): string => line.map((s) => s.text).join("");

test("eventTypeTally counts present types, most-frequent first with type-name ties", () => {
  const events = [{ type: "a" }, { type: "a" }, { type: "b" }, { type: "c" }] as unknown as HarnessEvent[];
  assert.deepEqual(eventTypeTally(events), [["a", 2], ["b", 1], ["c", 1]]);
  assert.deepEqual(eventTypeTally([]), []);
});

test("the Activity pane's tally line counts every type above the feed", async () => {
  const root = await makeTuiRepo();
  const ev1 = logEvent(root, { source: "clean", type: "run_start", run: 1 });
  const ev2 = logEvent(root, { source: "clean", type: "run_start", run: 2 });
  const ev3 = logEvent(root, { source: "clean", type: "merge_failed", run: 2 });
  const body = paneBody(
    { kind: "activity", role: null, grep: null, type: null },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  ).body;
  assert.equal(body.length, 4);
  assert.equal(text(body[0]!), "2 × run started (run_start) · 1 × merge failed (merge_failed)");
  // The remaining three lines are the formatted event lines, oldest first.
  assert.equal(text(body[1]!), formatEvent(ev1));
  assert.equal(text(body[2]!), formatEvent(ev2));
  assert.equal(text(body[3]!), formatEvent(ev3));
});

test("a selected type keeps the full tally above the filtered feed", async () => {
  const root = await makeTuiRepo();
  logEvent(root, { source: "clean", type: "run_start", run: 1 });
  logEvent(root, { source: "clean", type: "run_start", run: 2 });
  const ev3 = logEvent(root, { source: "clean", type: "merge_failed", run: 2 });
  const body = paneBody(
    { kind: "activity", role: null, grep: null, type: "merge_failed" },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  ).body;
  // The tally is built from the type-unfiltered rows, so the filtered-out run_start count stays.
  assert.equal(body.length, 2);
  assert.equal(text(body[0]!), "2 × run started (run_start) · 1 × merge failed (merge_failed)");
  assert.equal(text(body[1]!), formatEvent(ev3));
});

test("a role scope tallies only that role's events", async () => {
  const root = await makeTuiRepo();
  logEvent(root, { source: "clean", type: "run_start", run: 1 });
  const ev = logEvent(root, { source: "other", type: "merge_failed", run: 1 });
  const body = paneBody(
    { kind: "activity", role: "other", grep: null, type: null },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  ).body;
  assert.equal(body.length, 2);
  assert.equal(text(body[0]!), "1 × merge failed (merge_failed)");
  assert.equal(text(body[1]!), formatEvent(ev));
});

test("an empty filtered feed renders the filter note without a tally", async () => {
  const root = await makeTuiRepo();
  logEvent(root, { source: "clean", type: "run_start", run: 1 });
  const p = paneBody(
    { kind: "activity", role: null, grep: "nomatch", type: null },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  );
  assert.deepEqual(p.body, []);
  assert.equal(p.emptyNote, "(no events match this filter)");
});

test("an empty log renders (no events yet) without a tally", async () => {
  const root = await makeTuiRepo();
  const p = paneBody(
    { kind: "activity", role: null, grep: null, type: null },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  );
  assert.deepEqual(p.body, []);
  assert.equal(p.emptyNote, "(no events yet)");
});

test("the tally consumes one line of the tail budget", async () => {
  const root = await makeTuiRepo();
  logEvent(root, { source: "clean", type: "run_start", run: 1 });
  const ev2 = logEvent(root, { source: "clean", type: "run_start", run: 2 });
  const ev3 = logEvent(root, { source: "clean", type: "merge_failed", run: 2 });
  const body = paneBody(
    { kind: "activity", role: null, grep: null, type: null },
    { root, width: 200, eventBudget: 3, entryBudget: 5, state },
  ).body;
  // The tally line plus the newest two event lines: the tally consumes one line of the tail budget.
  assert.equal(body.length, 3);
  assert.equal(text(body[0]!), "2 × run started (run_start) · 1 × merge failed (merge_failed)");
  assert.equal(text(body[1]!), formatEvent(ev2));
  assert.equal(text(body[2]!), formatEvent(ev3));
});
