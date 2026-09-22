import test from "node:test";
import assert from "node:assert/strict";
import {
  applyKey,
  inputViewWindow,
  parseBudgetInput,
  renderInputView,
  tuiTerminalError,
} from "../src/ui/tui-input.js";
import { cutSplitsSurrogatePair } from "../src/text.js";

const key = (name: string, extra: Partial<{ ctrl: boolean; meta: boolean }> = {}) => ({ name, ...extra });

test("applyKey inserts printable characters at the cursor", () => {
  assert.deepEqual(applyKey("", 0, "h", key("h")), { text: "h", cursor: 1 });
  // Typing at the end appends (the pre-existing behavior).
  assert.deepEqual(applyKey("hello", 5, "!", key("!")), { text: "hello!", cursor: 6 });
  // Typing mid-text inserts at the cursor and shifts it right.
  assert.deepEqual(applyKey("hello world", 6, "X", key("X")), { text: "hello Xworld", cursor: 7 });
});

test("applyKey inserts multi-character strings (IME composition) advancing the cursor fully", () => {
  // readline delivers composed IME text as one keypress whose str holds the whole string
  // and has no special name; the cursor must land after ALL of it, not one unit in.
  assert.deepEqual(applyKey("", 0, "你好", {}), { text: "你好", cursor: 2 });
  assert.deepEqual(applyKey("ab cd", 2, "xy", {}), { text: "abxy cd", cursor: 4 });
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

test("applyKey backspace/delete remove a whole astral character, never a lone surrogate", () => {
  // 😀 (U+1F600) is two UTF-16 code units; typing it lands the cursor right after both.
  const emoji = "\u{1f600}";
  assert.equal(emoji.length, 2);
  // Backspace just after a typed emoji removes BOTH units (the pre-fix behavior left a lone
  // high surrogate that terminals render as a U+FFFD box).
  let state = applyKey("", 0, emoji, {});
  assert.deepEqual(state, { text: emoji, cursor: 2 });
  state = applyKey(state.text, state.cursor, undefined, key("backspace"));
  assert.deepEqual(state, { text: "", cursor: 0 });
  // Backspace mid-text removes the whole pair, keeping the neighbours intact.
  state = applyKey("a\u{1f600}b", 3, undefined, key("backspace"));
  assert.deepEqual(state, { text: "ab", cursor: 1 });
  // Forward-delete at the start of a pair removes BOTH units (cursor stays put).
  state = applyKey("a\u{1f600}b", 1, undefined, key("delete"));
  assert.deepEqual(state, { text: "ab", cursor: 1 });
  // A BMP character is still removed one unit at a time (no regression).
  state = applyKey("a\u00e9b", 2, undefined, key("backspace"));
  assert.deepEqual(state, { text: "ab", cursor: 1 });
});

test("applyKey never strands the cursor inside a surrogate pair", () => {
  const emoji = "\u{1f600}";
  // left/right step over the whole astral character instead of into the middle of its pair:
  // a cursor at the low half of the pair would let backspace/delete cut it in half.
  assert.deepEqual(applyKey(emoji, 2, undefined, key("left")), { text: emoji, cursor: 0 });
  assert.deepEqual(applyKey(emoji, 0, undefined, key("right")), { text: emoji, cursor: 2 });
  assert.deepEqual(applyKey(`a${emoji}b`, 3, undefined, key("left")), { text: `a${emoji}b`, cursor: 1 });
  // A cursor handed in mid-pair (stale state) is snapped to the pair's start, so neither
  // edit direction can leave a lone surrogate behind.
  const backspaced = applyKey(emoji, 1, undefined, key("backspace"));
  assert.deepEqual(backspaced, { text: emoji, cursor: 0 });
  const deleted = applyKey(emoji, 1, undefined, key("delete"));
  assert.deepEqual(deleted, { text: "", cursor: 0 });
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

test("parseBudgetInput maps empty to disabled and validates the rest", () => {
  assert.deepEqual(parseBudgetInput(""), { ok: true, value: 0 }, "empty means no cap");
  assert.deepEqual(parseBudgetInput("   "), { ok: true, value: 0 }, "whitespace-only is empty too");
  assert.deepEqual(parseBudgetInput("25"), { ok: true, value: 25 });
  assert.deepEqual(parseBudgetInput("12.34"), { ok: true, value: 12.34 }, "fractional dollars allowed");
  assert.deepEqual(parseBudgetInput(".5"), { ok: true, value: 0.5 }, "leading-dot decimals stay admitted");
  for (const bad of [
    "abc",
    "-1",
    "Infinity",
    "1e999",
    // Non-decimal notations must not set a cap: Number() would read hex as 16 and finite
    // exponent notation as 100 — regression for the TUI accepting both as dollar amounts.
    "0x10",
    "1e2",
    "+5",
    // Absurd digit counts overflow to Infinity: the isFinite backstop still rejects them.
    "9".repeat(410),
  ]) {
    const r = parseBudgetInput(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.match(r.error, /number of 0 or more/);
  }
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

test("renderInputView windows astral text without a lone surrogate or a hidden cursor", () => {
  // Regression: a pair straddling the tail window's left edge used to leave a lone low
  // surrogate *and* start the window past the cursor. The two-emoji line fits whole once the
  // window is allowed to floor to index 0 (no ellipsis column is spent).
  assert.equal(renderInputView("\u{1f600}\u{1f600}", 4, 6), "\u{1f600}\u{1f600}");
  // Cursor at the end of a four-emoji line: re-anchor to the cursor rather than dropping
  // the tail. The window is one whole emoji at the right edge.
  assert.equal(renderInputView("\u{1f600}".repeat(4), 8, 6), "…\u{1f600}");

  // Regression: a cursor on an astral character in a room-1/2 window used to leave an
  // empty window (start === end), which renderInputView drew as a bare ellipsis — the whole
  // prompt line blank at width 4–5. The window now falls back to the character under the
  // cursor, and the ellipsis is dropped when it no longer fits beside it.
  assert.deepEqual(inputViewWindow("ab\u{1f600}\u{1f600}", 4, 2), { start: 4, end: 6 });
  assert.deepEqual(inputViewWindow("ab\u{1f600}\u{1f600}", 5, 2), { start: 4, end: 6 });
  assert.deepEqual(inputViewWindow("\u{1f600}\u{1f600}", 4, 1), { start: 2, end: 4 });
  assert.equal(renderInputView("ab\u{1f600}\u{1f600}", 4, 5), "…\u{1f600}");
  assert.equal(renderInputView("ab\u{1f600}\u{1f600}", 4, 4), "\u{1f600}");
  assert.equal(renderInputView("\u{1f600}\u{1f600}", 4, 4), "\u{1f600}");

  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const samples = ["a".repeat(40), "\u{1f600}".repeat(8), "x\u{1f600}y\u00e9\u{1f600}z".repeat(3)];
  for (const text of samples) {
    for (let width = 4; width <= 24; width++) {
      const room = Math.max(1, width - 3);
      for (let cursor = 0; cursor <= text.length; cursor++) {
        // Mid-pair cursors are not editable states (applyKey snaps them); the boundary ones
        // are what the window must keep visible.
        if (cutSplitsSurrogatePair(text, cursor)) continue;
        const where = `width ${width}, cursor ${cursor}`;
        const view = renderInputView(text, cursor, width);
        assert.ok(!loneSurrogate.test(view), `${where}: ${JSON.stringify(view)} has a lone surrogate`);
        assert.ok(("> " + view).length <= width, `${where}: ${JSON.stringify(view)} exceeds the width`);
        assert.ok(view.length > 0, `${where}: ${JSON.stringify(view)} is empty`);
        // The window must keep the (clamped) cursor inside it — the property the rejected
        // fix broke: it dropped tail units so the cursor fell off the right edge.
        const { start, end } = inputViewWindow(text, cursor, room);
        const c = Math.max(0, Math.min(cursor, text.length));
        assert.ok(start < end, `${where}: window [${start},${end}) is empty`);
        assert.ok(start <= c && c <= end, `${where}: window [${start},${end}) hides the cursor`);
        // renderInputView mirrors this window, dropping the ellipsis when the whole-character
        // fallback no longer leaves it room beside the slice.
        const slice = text.slice(start, end);
        const withEllipsis = start > 0 ? `…${slice}` : slice;
        const expected = withEllipsis.length <= width - 2 ? withEllipsis : slice;
        assert.equal(expected, text.length <= room ? text : view, `${where}: window/render drift`);
      }
    }
  }
});

test("tuiTerminalError names the missing stream and points at the non-interactive views", () => {
  assert.equal(
    tuiTerminalError(false, false),
    "tumwater tui needs an interactive terminal: neither stdin (prompt input) nor stdout (the dashboard) is a TTY — use `tumwater status` or `tumwater gui` for a non-interactive view",
  );
  assert.equal(
    tuiTerminalError(false, true),
    "tumwater tui needs an interactive terminal: stdin (prompt input) is not a TTY — use `tumwater status` or `tumwater gui` for a non-interactive view",
  );
  assert.equal(
    tuiTerminalError(true, false),
    "tumwater tui needs an interactive terminal: stdout (the dashboard) is not a TTY — use `tumwater status` or `tumwater gui` for a non-interactive view",
  );
});
