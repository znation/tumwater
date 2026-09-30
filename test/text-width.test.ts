import test from "node:test";
import assert from "node:assert/strict";
import { clipToWidth, displayWidth, padToWidth } from "../src/text-width.js";

// text-width.ts is the single home of terminal-column geometry — the wcwidth table and the
// displayWidth/padToWidth/clipToWidth clippers every aligned table and TUI line relies on.
// These tests pin the documented contract directly instead of only through one indirect case
// per consumer.

test("clipToWidth never exceeds the requested width, even at degenerate widths", () => {
  const text = "a much longer line than any of these widths";
  assert.equal(clipToWidth(text, 100), text, "shorter-than-width text is untouched");
  assert.equal(clipToWidth("abcd", 4), "abcd", "exact-fit text is untouched");
  for (const width of [0, 1, 2, 5, 80]) {
    const clipped = clipToWidth(text, width);
    assert.ok(clipped.length <= width, `width ${width} violated: ${clipped.length}`);
  }
  // A negative width fits nothing: without the guard, slice(0, -n) drops n trailing
  // characters instead of keeping none, so the "never exceeds width" invariant could not
  // even be stated for those inputs.
  assert.equal(clipToWidth(text, -1), "");
  assert.equal(clipToWidth("ab", -5), "");
  assert.match(clipToWidth(text, 5), /…$/, "over-wide text ends in an ellipsis");
});

test("clipToWidth never splits a surrogate pair (no lone surrogates in clipped lines)", () => {
  // Astral characters (emoji) are one code point — two UTF-16 code units — and cut on any
  // boundary but a code-point one would leave a lone high surrogate that terminals render
  // as garbage. clipToWidth cuts on code-point boundaries, dropping the whole character
  // when it cannot fit, keeping the width invariant.
  const text = "ab🎉cd ef"; // 🎉 occupies code units 2..3 and renders two columns wide
  assert.equal(clipToWidth(text, 4), "ab…"); // the ellipsis's column leaves no room for 🎉
  for (const width of [0, 1, 2, 3, 5, 8]) {
    const clipped = clipToWidth(text, width);
    assert.ok(clipped.length <= width, `width ${width} violated: ${clipped.length}`);
    assert.ok(displayWidth(clipped) <= width, `column width ${width} violated: ${JSON.stringify(clipped)}`);
    for (let i = 0; i < clipped.length - 1; i++) {
      const code = clipped.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(
          clipped.charCodeAt(i + 1) >= 0xdc00 && clipped.charCodeAt(i + 1) <= 0xdfff,
          `lone surrogate at ${i} in ${JSON.stringify(clipped)}`,
        );
      }
    }
  }
});

// displayWidth and the wide-range table are what make "width" mean terminal columns rather
// than UTF-16 code units: East Asian wide characters and emoji render two columns, so a
// clipper that counted them as one would overflow real terminals. These tests pin the
// degenerate widths too — where a wide character cannot fit at all and must be dropped
// whole, never halved into a lone surrogate.
test("clipToWidth counts wide characters as two columns and holds the invariant at every width", () => {
  assert.equal(displayWidth("監視"), 4, "each CJK ideograph is two columns");
  assert.equal(displayWidth("🎉ab"), 4, "an astral emoji is two columns, not two half units");
  assert.equal(clipToWidth("監視", 4), "監視", "text that fits the column budget is untouched");
  assert.equal(clipToWidth("監視", 3), "監…", "the ellipsis's column leaves room for one wide character");
  assert.equal(clipToWidth("監視", 2), "…", "nothing but the ellipsis fits beside a wide character");
  assert.equal(clipToWidth("監視", 1), "", "a wide character cannot fit a one-column budget at all");
  assert.equal(clipToWidth("監視", 0), "");
  assert.equal(clipToWidth("🎉abc", 1), "", "an astral wide character is dropped whole, never halved");
  assert.equal(clipToWidth("🎉abc", 3), "🎉…");
  assert.equal(clipToWidth("a監🎉b", 1), "a", "a one-column budget keeps the leading narrow character");
  // The sweep: at every width the result fits the column budget and carries no lone
  // surrogate — including the widths 1–2 where a wide first character cannot fit.
  for (const text of ["監視スクラップ", "🎉🎉🎉ab", "a監🎉b"]) {
    for (let width = 0; width <= 10; width++) {
      const clipped = clipToWidth(text, width);
      assert.ok(displayWidth(clipped) <= width, `column width ${width} exceeded: ${JSON.stringify(clipped)}`);
      for (let i = 0; i < clipped.length - 1; i++) {
        const code = clipped.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          assert.ok(clipped.charCodeAt(i + 1) >= 0xdc00 && clipped.charCodeAt(i + 1) <= 0xdfff,
            `lone surrogate at ${i} in ${JSON.stringify(clipped)}`);
        }
      }
    }
  }
});

test("padToWidth pads with spaces to the exact display column, and never past it", () => {
  assert.equal(padToWidth("ab", 4), "ab  ", "narrow text is space-padded to the budget");
  assert.equal(padToWidth("監", 4), "監  ", "a wide character counts its two columns, so two spaces pad");
  assert.equal(padToWidth("abcd", 4), "abcd", "exact-fit text is untouched");
  assert.equal(padToWidth("abcde", 4), "abcde", "text already past the width is returned unchanged");
  assert.equal(padToWidth("", 3), "   ", "the empty string pads to the full budget");
});
