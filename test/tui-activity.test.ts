import test from "node:test";
import assert from "node:assert/strict";
import { paneBody } from "../src/ui/tui/tui-pane.js";
import { eventTypeTally } from "../src/events/event-tally.js";
import { logEvent } from "../src/events/events.js";
import type { HarnessEvent } from "../src/events/events.js";
import { formatEvent } from "../src/events/event-format.js";
import { SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { makeTuiRepo } from "./fixtures/tui-fixtures.js";
import { ACTIVITY_WINDOWS } from "../src/ui/tui/tui-pane-session.js";

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

test("a notable Activity feed culls routine rows and tallies only the notable ones", async () => {
  const root = await makeTuiRepo();
  logEvent(root, { source: "clean", type: "run_start", run: 1 });
  const ev = logEvent(root, { source: "clean", type: "merged", run: 1 });
  const body = paneBody(
    { kind: "activity", role: null, grep: null, type: null, notable: true },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  ).body;
  // The routine run_start is culled, so the tally counts only the notable merged row.
  assert.equal(body.length, 2);
  assert.equal(text(body[0]!), "1 × merged (merged)");
  assert.equal(text(body[1]!), formatEvent(ev));
});

test("a notable feed with only routine rows renders the filter note", async () => {
  const root = await makeTuiRepo();
  logEvent(root, { source: "clean", type: "run_start", run: 1 });
  const p = paneBody(
    { kind: "activity", role: null, grep: null, type: null, notable: true },
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

// --- The trailing event window (Ctrl+Y, ACTIVITY_WINDOWS) -------------------------

/** Log one 25-hour-old event no ≤1-day window retains, then the two "recent" events (a few seconds
 * old — always the current day, so the read never depends on the wall-clock hour), written
 * oldest-first exactly like an append-only event log: `readEvents`/`readEventsSince` return file
 * (write) order, so writing oldest-first is what makes every window paint its rows oldest first. */
function logRecentAndOld(root: string, now: number): void {
  logEvent(root, { source: "old", type: "run_start", run: 1, ts: now - 25 * 3_600_000 });
  logEvent(root, { source: "other", type: "run_start", run: 1, ts: now - 30_000 });
  logEvent(root, { source: "clean", type: "run_start", run: 1, ts: now - 1_000 });
}

/** The source id a formatted event line carries (the first of `old`/`other`/`clean` in it). */
function src(line: string): string {
  return (/old|other|clean/.exec(line) ?? [""])[0]!;
}

test("a trailing window keeps its retained events, oldest first, with its tally, and drops older ones", async () => {
  const root = await makeTuiRepo();
  logRecentAndOld(root, Date.now());
  const body = paneBody(
    { kind: "activity", role: null, grep: null, type: null, since: 6 * 3_600_000 },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  ).body;
  // The 6h window keeps the two recent events, drops the 25h one, oldest first; the tally is the
  // first body line (a sparse note, when the read cannot prove coverage, sits after it).
  assert.equal(text(body[0]!), "2 × run started (run_start)");
  const lines = body.slice(1).map(text).filter((l) => l !== SPARSE_WINDOW_NOTE);
  assert.deepEqual(lines.map(src), ["other", "clean"], "keeps the two recent, oldest first, drops the 25h one");
});

test("a 1h window keeps the recent events; the all window keeps every retained event", async () => {
  const root = await makeTuiRepo();
  logRecentAndOld(root, Date.now());
  // 1h: keeps the two recent events (both well inside an hour), drops the 25h one.
  const hour = paneBody({ kind: "activity", role: null, grep: null, type: null, since: 3_600_000 }, { root, width: 200, eventBudget: 10, entryBudget: 5, state }).body;
  assert.equal(text(hour[0]!), "2 × run started (run_start)");
  assert.deepEqual(hour.slice(1).map(text).filter((l) => l !== SPARSE_WINDOW_NOTE).map(src), ["other", "clean"]);
  // The all window (null) is the fixed newest-200 tail: every retained event, oldest first.
  const all = paneBody({ kind: "activity", role: null, grep: null, type: null, since: null }, { root, width: 200, eventBudget: 10, entryBudget: 5, state }).body;
  assert.equal(text(all[0]!), "3 × run started (run_start)");
  assert.deepEqual(all.slice(1).map(text).filter((l) => l !== SPARSE_WINDOW_NOTE).map(src), ["old", "other", "clean"]);
});

test("a window whose log does not reach its cutoff paints the sparse note above the feed", async () => {
  const root = await makeTuiRepo();
  // A single event 30 seconds old inside a 1-day window: the read cannot prove it reached the
  // cutoff (rotation or idleness), so the shared sparse note rides the body.
  logEvent(root, { source: "clean", type: "run_start", run: 1, ts: Date.now() - 30_000 });
  const body = paneBody({ kind: "activity", role: null, grep: null, type: null, since: 24 * 3_600_000 }, { root, width: 200, eventBudget: 10, entryBudget: 5, state }).body;
  assert.ok(body.some((l) => text(l) === SPARSE_WINDOW_NOTE), "the sparse note is painted");
  assert.ok(body.some((l) => text(l).includes("clean")), "the in-window event is still painted");
});

test("an active window with no retained event names the filter, not the empty log", async () => {
  const root = await makeTuiRepo();
  // A single 25-hour-old event, outside a 1-day window: the window is empty, so an active
  // filter keeps its note (the unfiltered empty-log note is for a window-less feed).
  logEvent(root, { source: "old", type: "run_start", run: 1, ts: Date.now() - 25 * 3_600_000 });
  const p = paneBody({ kind: "activity", role: null, grep: null, type: null, since: 24 * 3_600_000 }, { root, width: 200, eventBudget: 10, entryBudget: 5, state });
  assert.deepEqual(p.body, []);
  assert.equal(p.emptyNote, "(no events match this filter)");
});

test("an active / search narrows a windowed feed's rows", async () => {
  const root = await makeTuiRepo();
  logRecentAndOld(root, Date.now());
  const searched = paneBody(
    { kind: "activity", role: null, grep: "other", type: null, since: 3_600_000 },
    { root, width: 200, eventBudget: 10, entryBudget: 5, state },
  ).body;
  // The search narrows the windowed rows before the tally, so the tally counts only the match;
  // the feed keeps that same single row.
  assert.equal(text(searched[0]!), "1 × run started (run_start)");
  assert.deepEqual(searched.slice(1).map(text).filter((l) => l !== SPARSE_WINDOW_NOTE).map(src), ["other"]);
});

test("ACTIVITY_WINDOWS is all/1h/6h/1d and the all slot is the newest-200 tail", () => {
  assert.deepEqual(
    ACTIVITY_WINDOWS.map(([ms, label]) => [ms, label]),
    [[null, "all"], [3_600_000, "1h"], [6 * 3_600_000, "6h"], [24 * 3_600_000, "1d"]],
  );
});
