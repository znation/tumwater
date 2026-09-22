import test from "node:test";
import assert from "node:assert/strict";
import {
  backlogLines,
  entryBodyWindow,
  moveEntrySelection,
  stepEntryScroll,
} from "../src/ui/tui-backlog.js";

test("backlogLines renders subheaders with counts, entries in order", () => {
  assert.deepEqual(backlogLines(["plan A"], ["bug B"], []), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
    "open questions (0):",
    "(none)",
  ]);
  assert.deepEqual(backlogLines(["plan A"], ["bug B"], ["question Q"]), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
    "open questions (1):",
    "question Q",
  ]);
});

test("backlogLines renders (none) under an empty section's subheader", () => {
  assert.deepEqual(backlogLines([], ["bug B"], []), [
    "plans (0):",
    "(none)",
    "open bugs (1):",
    "bug B",
    "open questions (0):",
    "(none)",
  ]);
  assert.deepEqual(backlogLines(["plan A"], [], []), [
    "plans (1):",
    "plan A",
    "open bugs (0):",
    "(none)",
    "open questions (0):",
    "(none)",
  ]);
});

test("backlogLines with nothing at all is a single self-explanatory line", () => {
  assert.deepEqual(backlogLines([], [], []), ["(no planned features, open bugs, or open questions)"]);
});

// Entry browsing in the project-status pane (PLANS.md "Read backlog entries in full"): the
// cursor math and body rendering are pure, so they are pinned here without a TTY.

test("moveEntrySelection opens the first entry on down and the last on up from list mode", () => {
  assert.equal(moveEntrySelection(3, null, "down"), 0);
  assert.equal(moveEntrySelection(3, null, "up"), 2);
});

test("moveEntrySelection wraps at both ends across the flat entry list", () => {
  // Three entries: plans (indices 0-1) then bugs (index 2). Down from a plan's last index
  // crosses into the next section; up from the first wraps to the last.
  assert.equal(moveEntrySelection(3, 1, "down"), 2); // plans → bugs boundary
  assert.equal(moveEntrySelection(3, 2, "down"), 0); // wraps back to the first plan
  assert.equal(moveEntrySelection(3, 0, "up"), 2); // wraps from the front to the end
  assert.equal(moveEntrySelection(3, 2, "up"), 1);
});

test("moveEntrySelection with no entries stays in list mode", () => {
  assert.equal(moveEntrySelection(0, null, "down"), null);
  assert.equal(moveEntrySelection(0, null, "up"), null);
  assert.equal(moveEntrySelection(0, 5, "down"), null); // a stale selection also clears
});

test("entryBodyWindow at offset zero clips each line and keeps the head within budget", () => {
  const body = "a very long first line that will not fit\nsecond line\nthird line";
  assert.deepEqual(entryBodyWindow(body, 0, 2, 10), { lines: ["a very lo…", "second li…"], total: 3 });
  // Lines that fit are untouched; the head window is unchanged from today's entryBodyLines.
  assert.deepEqual(entryBodyWindow("short\nalso short", 0, 5, 80), { lines: ["short", "also short"], total: 2 });
  // A bare heading has an empty body: one self-explanatory placeholder line, zero total
  // (so the scroll affordance never appears for it).
  assert.deepEqual(entryBodyWindow("", 0, 3, 100), { lines: ["(no details for this entry)"], total: 0 });
});

test("entryBodyWindow pages through the middle and tail of a long body", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  // Middle window: lines 3-5 (offset 2, budget 3).
  assert.deepEqual(entryBodyWindow(body, 2, 3, 80), { lines: ["line 3", "line 4", "line 5"], total: 10 });
  // Tail window: the last three lines.
  assert.deepEqual(entryBodyWindow(body, 7, 3, 80), { lines: ["line 8", "line 9", "line 10"], total: 10 });
});

test("entryBodyWindow clamps an offset past either end (a resize or budget shrink cannot strand it)", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  // An offset far beyond the tail clamps to the last possible window.
  assert.deepEqual(entryBodyWindow(body, 99, 3, 80), { lines: ["line 8", "line 9", "line 10"], total: 10 });
  // A negative offset clamps to the head.
  assert.deepEqual(entryBodyWindow(body, -5, 3, 80), { lines: ["line 1", "line 2", "line 3"], total: 10 });
});

test("stepEntryScroll pages down to the tail and back up to the head, clamped at both ends", () => {
  // Ten lines, budget three → maxOffset 7. From the head each PgDn advances one page…
  assert.equal(stepEntryScroll(0, 10, 3, "down"), 3);
  assert.equal(stepEntryScroll(3, 10, 3, "down"), 6);
  // …until it clamps at the tail (offset 7 shows lines 8-10) and stays put.
  assert.equal(stepEntryScroll(6, 10, 3, "down"), 7);
  assert.equal(stepEntryScroll(7, 10, 3, "down"), 7);
  // PgUp mirrors: back up one page per press, clamped at the head.
  assert.equal(stepEntryScroll(7, 10, 3, "up"), 4);
  assert.equal(stepEntryScroll(4, 10, 3, "up"), 1);
  assert.equal(stepEntryScroll(1, 10, 3, "up"), 0);
  assert.equal(stepEntryScroll(0, 10, 3, "up"), 0);
});

test("stepEntryScroll is a no-op when the body fits its budget", () => {
  // A single window: every step lands on (and stays at) the head.
  assert.equal(stepEntryScroll(0, 3, 5, "down"), 0);
  assert.equal(stepEntryScroll(2, 3, 5, "up"), 0); // even a stale offset resets to the head
  assert.equal(stepEntryScroll(9, 0, 4, "down"), 0); // an empty body has no window at all
});
