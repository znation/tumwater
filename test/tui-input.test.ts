import test from "node:test";
import assert from "node:assert/strict";
import {
  applyKey,
  inputViewWindow,
  parseBudgetInput,
  parseRolePromptInput,
  renderInputView,
  tuiTerminalError,
} from "../src/ui/tui/tui-input.js";
import { cutSplitsSurrogatePair } from "../src/text/text.js";
import { displayWidth } from "../src/text/text-width.js";
import { hasLoneSurrogate } from "./oracles.js";

const key = (name: string, extra: Partial<{ ctrl: boolean; meta: boolean }> = {}) => ({ name, ...extra });

test("parseRolePromptInput trims and rejects an empty line with the way out", () => {
  assert.deepEqual(parseRolePromptInput("  write more tests  "), { ok: true, value: "write more tests" });
  assert.equal(parseRolePromptInput("").ok, false);
  assert.equal(parseRolePromptInput("   ").ok, false);
  // The error names Esc so an operator who opened the editor by accident learns the exit.
  const empty = parseRolePromptInput("  ");
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.error, /Esc to cancel/);
});

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

test("applyKey jumps to the text's start and end with home/end", () => {
  // Readline delivers the Home and End keys as name "home"/"end"; the TUI binds nothing
  // else to them, so they belong to the line editor like left/right.
  assert.deepEqual(applyKey("hello world", 6, undefined, key("home")), { text: "hello world", cursor: 0 });
  assert.deepEqual(applyKey("hello world", 6, undefined, key("end")), { text: "hello world", cursor: 11 });
  // No-ops at the ends they already sit on.
  assert.deepEqual(applyKey("abc", 0, undefined, key("home")), { text: "abc", cursor: 0 });
  assert.deepEqual(applyKey("abc", 3, undefined, key("end")), { text: "abc", cursor: 3 });
  // A stale out-of-range cursor still lands on a real boundary.
  assert.deepEqual(applyKey("abc", 9, undefined, key("end")), { text: "abc", cursor: 3 });
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

test("applyKey kills the word before the cursor with Alt+Backspace", () => {
  // Readline's unix-word-rubout shape: the token before the cursor goes, and the cursor
  // ends up just after the separator that preceded it.
  const first = applyKey("configure the loop", 18, undefined, key("backspace", { meta: true }));
  assert.deepEqual(first, { text: "configure the ", cursor: 14 });
  // A second press eats the separator space plus the previous token.
  assert.deepEqual(applyKey(first.text, first.cursor, undefined, key("backspace", { meta: true })), {
    text: "configure ",
    cursor: 10,
  });
  // Mid-word the kill starts at the cursor, not the word's end: only "wo" goes.
  assert.deepEqual(applyKey("hello world", 8, undefined, key("backspace", { meta: true })), {
    text: "hello rld",
    cursor: 6,
  });
  // Trailing whitespace before the cursor: the run of spaces and the token before them
  // go together — the same press that peels "word" off "word   " would otherwise strand
  // the separator for a second press that kills nothing.
  assert.deepEqual(applyKey("ab   ", 5, undefined, key("backspace", { meta: true })), {
    text: "",
    cursor: 0,
  });
  // No-op at the line start, like plain backspace.
  assert.deepEqual(applyKey("hi", 0, undefined, key("backspace", { meta: true })), { text: "hi", cursor: 0 });
  // An astral token is killed whole — no lone surrogate is ever left behind.
  const emoji = "\u{1f600}";
  assert.deepEqual(applyKey(`${emoji} tail`, 7, undefined, key("backspace", { meta: true })), {
    text: `${emoji} `,
    cursor: 3,
  });
});

test("applyKey kills from the line start to the cursor with Ctrl+U", () => {
  assert.deepEqual(applyKey("hello world", 5, "\x15", key("u", { ctrl: true })), { text: " world", cursor: 0 });
  // Everything dies when the cursor sits at the end.
  assert.deepEqual(applyKey("all gone", 8, "\x15", key("u", { ctrl: true })), { text: "", cursor: 0 });
  // No-op at the line start.
  assert.deepEqual(applyKey("hi", 0, "\x15", key("u", { ctrl: true })), { text: "hi", cursor: 0 });
  // A plain "u" still types: the kill is bound to the ctrl spelling only.
  assert.deepEqual(applyKey("heo", 2, "u", key("u")), { text: "heuo", cursor: 3 });
});

test("applyKey kills from the cursor to the line end with Ctrl+K", () => {
  assert.deepEqual(applyKey("hello world", 5, "\x0b", key("k", { ctrl: true })), { text: "hello", cursor: 5 });
  // No-op when the cursor sits at the end.
  assert.deepEqual(applyKey("hi", 2, "\x0b", key("k", { ctrl: true })), { text: "hi", cursor: 2 });
  // Everything dies when the cursor sits at the start.
  assert.deepEqual(applyKey("all gone", 0, "\x0b", key("k", { ctrl: true })), { text: "", cursor: 0 });
  // A plain "k" still types: the kill is bound to the ctrl spelling only.
  assert.deepEqual(applyKey("heo", 2, "k", key("k")), { text: "heko", cursor: 3 });
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
    // A 25-digit run stays finite (1e24), so isFinite passes it — but the value is past
    // Number.MAX_SAFE_INTEGER and no longer an exactly representable dollar amount, the same
    // overflow rule text.ts's parseDecimalInt applies to every count/position input. The
    // setter's own check (checkDailyBudgetUsd) admits any finite non-negative number, so
    // without this bound a one-zero typo in the TUI's cap editor silently writes an
    // effectively uncapped budget. Regression: parseBudgetInput returned { ok: true,
    // value: 1e24 } on the unfixed tree.
    "9".repeat(25),
  ]) {
    const r = parseBudgetInput(bad);
    assert.equal(r.ok, false, bad);
    // The one message names the MAX_SAFE_INTEGER bound as well: a 25-digit run IS "a number
    // of 0 or more", so a bounds rejection that omitted the cap would name the wrong rule.
    if (!r.ok) assert.match(r.error, new RegExp(`number of 0 or more, at most ${Number.MAX_SAFE_INTEGER}`));
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

  // "你好世界你好" is 6 UTF-16 units but 12 display columns — the unit-vs-column mismatch
  // this suite's samples once missed entirely.
  const samples = [
    "a".repeat(40),
    "\u{1f600}".repeat(8),
    "x\u{1f600}y\u00e9\u{1f600}z".repeat(3),
    "你好世界你好",
    "x你好\u{1f600}y",
  ];
  for (const text of samples) {
    for (let width = 4; width <= 24; width++) {
      const room = Math.max(1, width - 3);
      for (let cursor = 0; cursor <= text.length; cursor++) {
        // Mid-pair cursors are not editable states (applyKey snaps them); the boundary ones
        // are what the window must keep visible.
        if (cutSplitsSurrogatePair(text, cursor)) continue;
        const where = `width ${width}, cursor ${cursor}`;
        const view = renderInputView(text, cursor, width);
        assert.ok(!hasLoneSurrogate(view), `${where}: ${JSON.stringify(view)} has a lone surrogate`);
        // Measured in display columns, not UTF-16 units — the unit spelling passed while a
        // wide-character line still wrapped the terminal.
        assert.ok(displayWidth("> " + view) <= width, `${where}: ${JSON.stringify(view)} exceeds the width`);
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
        // When the whole text fits beside the prefix, renderInputView shows it whole and
        // never consults the window; otherwise it mirrors the window's render rule.
        const whole = displayWidth(text) <= width - 2;
        const windowed = displayWidth(withEllipsis) <= width - 2 ? withEllipsis : slice;
        assert.equal(whole ? text : windowed, view, `${where}: window/render drift`);
      }
    }
  }
});

test("renderInputView budgets the prompt line in display columns, not UTF-16 units", () => {
  // Regression: "你好世界你好" is 6 code units but 12 columns; the unit-budgeted fit check
  // returned the whole line beside the "> " prefix — 14 columns on a 10-column terminal,
  // wrapping the prompt line the one-line-per-visual-line invariant forbids.
  const text = "你好世界你好";
  // Cursor at end: the widest window of ≤ 7 columns ending at the last character.
  assert.equal(renderInputView(text, text.length, 10), "…界你好");
  const view = renderInputView(text, text.length, 10);
  assert.ok(displayWidth("> " + view) <= 10, `got ${JSON.stringify(view)}`);
  // The window keeps the cursor's character visible (cursor at end of text).
  assert.ok(view.includes("好"), `cursor character not visible in ${JSON.stringify(view)}`);
  // A line that fits whole in columns shows whole even when its unit length would have
  // tripped the old unit-budgeted check: "ab你好cd" is 6 units but 8 columns.
  assert.equal(renderInputView("ab你好cd", 6, 10), "ab你好cd");
  // And an all-ASCII line still windows exactly as before.
  assert.equal(renderInputView("a".repeat(50), 50, 10), "…" + "a".repeat(7));
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
