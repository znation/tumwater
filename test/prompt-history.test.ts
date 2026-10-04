import test from "node:test";
import assert from "node:assert/strict";
import {
  newPromptHistory,
  pushPromptHistory,
  recallPromptHistory,
  resetPromptRecall,
  settlePromptRecall,
} from "../src/ui/prompt-history.js";

test("recallPromptHistory walks back and forward with readline's draft rule", () => {
  const h = newPromptHistory();
  // An empty history does nothing in either direction.
  assert.equal(recallPromptHistory(h, "", 0, "older"), null);
  assert.equal(recallPromptHistory(h, "", 0, "newer"), null);

  let state = pushPromptHistory(h, "first");
  state = pushPromptHistory(state, "second");
  // Up from the live line saves the draft — text and cursor — and lands on the newest
  // entry, cursor at its end.
  let r = recallPromptHistory(state, "draft text", 5, "older");
  assert.deepEqual(r, {
    history: { items: ["first", "second"], index: 1, draft: "draft text", draftCursor: 5 },
    text: "second",
    cursor: 6,
  });
  // Another Up walks to the older entry, the saved draft kept for the trip back.
  r = recallPromptHistory(r!.history, "", 0, "older");
  assert.equal(r!.text, "first");
  assert.equal(r!.history.draft, "draft text");
  // Up at the oldest entry stays there.
  r = recallPromptHistory(r!.history, "", 0, "older");
  assert.equal(r!.text, "first");
  // Down walks forward, then past the newest entry restores the saved draft, cursor and all.
  r = recallPromptHistory(r!.history, "", 0, "newer");
  assert.equal(r!.text, "second");
  r = recallPromptHistory(r!.history, "", 0, "newer");
  assert.deepEqual(r, {
    history: { items: ["first", "second"], index: 2, draft: "", draftCursor: 0 },
    text: "draft text",
    cursor: 5,
  });
  // Down on the live line does nothing.
  assert.equal(recallPromptHistory(r!.history, "", 0, "newer"), null);
});

test("settlePromptRecall hands the saved draft to another editor; reset ends a browse", () => {
  // Not browsing: the line and cursor pass through untouched, the same history back.
  const live = { items: ["p1"], index: 1, draft: "", draftCursor: 0 };
  assert.deepEqual(settlePromptRecall(live, "typing", 3), {
    history: live,
    text: "typing",
    cursor: 3,
  });
  // Mid-recall: the recalled entry on the line is swapped for the saved draft, with its
  // cursor, and the recall state resets so no stale index or draft crosses the mode switch.
  const browsing = { items: ["p1", "p2"], index: 0, draft: "real draft", draftCursor: 4 };
  assert.deepEqual(settlePromptRecall(browsing, "p1", 2), {
    history: { items: ["p1", "p2"], index: 2, draft: "", draftCursor: 0 },
    text: "real draft",
    cursor: 4,
  });
  // resetPromptRecall ends a browse without touching the line: the restored text becomes
  // the live draft, so the next Up saves it afresh instead of resuming the stale browse.
  assert.deepEqual(resetPromptRecall(browsing), {
    items: ["p1", "p2"],
    index: 2,
    draft: "",
    draftCursor: 0,
  });
  assert.deepEqual(resetPromptRecall(live), live); // already live: unchanged
});

test("pushPromptHistory skips a repeat of the newest entry and records nothing empty", () => {
  let h = pushPromptHistory(newPromptHistory(), "");
  assert.deepEqual(h, { items: [], index: 0, draft: "", draftCursor: 0 });
  h = pushPromptHistory(h, "nudge");
  h = pushPromptHistory(h, "nudge"); // ignoredups: a re-send of the same prompt is not a second entry
  assert.deepEqual(h, { items: ["nudge"], index: 1, draft: "", draftCursor: 0 });
  // A repeat after another entry is kept, and any push resets the recall state to the live
  // draft (dropping a stale saved draft).
  h = pushPromptHistory(
    { items: ["nudge", "stop"], index: 0, draft: "half-typed", draftCursor: 2 },
    "nudge",
  );
  assert.deepEqual(h, { items: ["nudge", "stop", "nudge"], index: 3, draft: "", draftCursor: 0 });
});