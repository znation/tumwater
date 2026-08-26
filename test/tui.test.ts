import test from "node:test";
import assert from "node:assert/strict";
import { applyKey, backlogLines, renderInputView } from "../src/tui.js";

const key = (name: string, extra: Partial<{ ctrl: boolean; meta: boolean }> = {}) => ({ name, ...extra });

test("applyKey inserts printable characters at the cursor", () => {
  assert.deepEqual(applyKey("", 0, "h", key("h")), { text: "h", cursor: 1 });
  // Typing at the end appends (the pre-existing behavior).
  assert.deepEqual(applyKey("hello", 5, "!", key("!")), { text: "hello!", cursor: 6 });
  // Typing mid-text inserts at the cursor and shifts it right.
  assert.deepEqual(applyKey("hello world", 6, "X", key("X")), { text: "hello Xworld", cursor: 7 });
});

test("applyKey moves the cursor with left/right and clamps at both ends", () => {
  assert.deepEqual(applyKey("abc", 1, undefined, key("left")), { text: "abc", cursor: 0 });
  assert.deepEqual(applyKey("abc", 0, undefined, key("left")), { text: "abc", cursor: 0 });
  assert.deepEqual(applyKey("abc", 2, undefined, key("right")), { text: "abc", cursor: 3 });
  assert.deepEqual(applyKey("abc", 3, undefined, key("right")), { text: "abc", cursor: 3 });
});

test("applyKey backspace deletes before the cursor; delete after it", () => {
  assert.deepEqual(applyKey("hello", 5, undefined, key("backspace")), { text: "hell", cursor: 4 });
  assert.deepEqual(applyKey("hello world", 6, undefined, key("backspace")), { text: "helloworld", cursor: 5 });
  assert.deepEqual(applyKey("hello", 0, undefined, key("backspace")), { text: "hello", cursor: 0 });
  // Cursor just before the space: forward-delete removes it.
  assert.deepEqual(applyKey("hello world", 5, undefined, key("delete")), { text: "helloworld", cursor: 5 });
  // Cursor after the space: forward-delete removes the next character instead.
  assert.deepEqual(applyKey("hello world", 6, undefined, key("delete")), { text: "hello orld", cursor: 6 });
  assert.deepEqual(applyKey("hello", 5, undefined, key("delete")), { text: "hello", cursor: 5 });
});

test("a typo is fixable without retyping the rest of the prompt", () => {
  // Typed "dar k mode" (stray space); meant "dark mode". Move back over it and delete.
  let state = { text: "dar k mode", cursor: 10 };
  for (let i = 0; i < 6; i++) state = applyKey(state.text, state.cursor, undefined, key("left"));
  assert.equal(state.cursor, 4); // just after the stray space
  state = applyKey(state.text, state.cursor, undefined, key("backspace"));
  assert.deepEqual(state, { text: "dark mode", cursor: 3 });
});

test("applyKey ignores control and meta characters but clamps a stale cursor", () => {
  assert.deepEqual(applyKey("ab", 1, "\x03", key("c", { ctrl: true })), { text: "ab", cursor: 1 });
  assert.deepEqual(applyKey("ab", 1, "é", key("e", { meta: true })), { text: "ab", cursor: 1 });
  // An out-of-range cursor (stale after a submit) is clamped instead of corrupting the edit.
  assert.deepEqual(applyKey("ab", 9, "x", key("x")), { text: "abx", cursor: 3 });
});

test("renderInputView shows short prompts whole and long ones as a cursor window", () => {
  assert.equal(renderInputView("hi", 2, 80), "hi");
  // Cursor at the end: tail window with a leading ellipsis (the pre-existing behavior).
  const long = "a".repeat(50);
  assert.equal(renderInputView(long, 50, 10), "…" + "a".repeat(7));
  // Cursor in the middle: the window keeps it at the right edge.
  const text = "abcdefghijklmnopqrst"; // 20 chars
  assert.equal(renderInputView(text, 10, 8), "…ghijk");
  // Cursor near the start: no ellipsis when the window begins at index 0.
  assert.equal(renderInputView(text, 3, 8), "abcde");
});

test("the rendered prompt line never exceeds the terminal width", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  for (let width = 4; width <= 60; width++) {
    for (const cursor of [0, 5, Math.floor(text.length / 2), text.length]) {
      const line = "> " + renderInputView(text, cursor, width);
      assert.ok(line.length <= width, `width ${width}, cursor ${cursor}: ${line.length} cols`);
    }
  }
});

test("backlogLines renders subheaders with counts, entries in order", () => {
  assert.deepEqual(backlogLines(["plan A"], ["bug B"]), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
  ]);
});

test("backlogLines renders (none) under an empty section's subheader", () => {
  assert.deepEqual(backlogLines([], ["bug B"]), [
    "plans (0):",
    "(none)",
    "open bugs (1):",
    "bug B",
  ]);
  assert.deepEqual(backlogLines(["plan A"], []), [
    "plans (1):",
    "plan A",
    "open bugs (0):",
    "(none)",
  ]);
});

test("backlogLines with nothing at all is a single self-explanatory line", () => {
  assert.deepEqual(backlogLines([], []), ["(no planned features or open bugs)"]);
});
