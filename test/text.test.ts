import test from "node:test";
import assert from "node:assert/strict";
import {
  compactTokens,
  collapseWhitespace,
  parseNonNegativeInt,
  parsePositiveInt,
  truncate,
} from "../src/text.js";

// text.ts is the single home of the one-line label semantics every display surface
// (live progress work items, transcript lines/thinking/errors, tool-call descriptions)
// relies on to keep one logical line at or below its column budget. These tests pin the
// documented contract directly instead of only through one indirect case per consumer.

test("collapseWhitespace folds runs of spaces, tabs, and newlines to single spaces", () => {
  assert.equal(collapseWhitespace("  fix   the\n\tzombie streams  "), "fix the zombie streams");
  // A run of mixed whitespace is one space, not several.
  assert.equal(collapseWhitespace("a \t\n b"), "a b");
});

test("collapseWhitespace keeps existing single spaces and passes through clean text", () => {
  assert.equal(collapseWhitespace("already clean"), "already clean");
  assert.equal(collapseWhitespace("a b c"), "a b c");
});

test("collapseWhitespace yields empty for empty or whitespace-only input", () => {
  assert.equal(collapseWhitespace(""), "");
  assert.equal(collapseWhitespace("   \n\t "), "");
});

test("truncate leaves a string unchanged when it fits, including the exact boundary", () => {
  const s = "hello world";
  assert.equal(truncate(s, s.length), s); // exactly max: no cut
  assert.equal(truncate(s, s.length + 5), s);
  assert.equal(truncate("", 10), "");
});

test("truncate cuts to at most max characters, ellipsis included", () => {
  const out = truncate("hello world", 8); // cut lands after the space: no trim needed
  assert.equal(out, "hello w…");
  assert.equal(out.length, 8);
  assert.match(truncate("x".repeat(100), 32), /^x{31}…$/);
});

test("truncate drops a trailing space the cut leaves behind before appending the ellipsis", () => {
  // The documented behavior: without the trimEnd, labels would show "hello …" with a
  // dangling space — and a refactor that dropped it would be invisible to the fits-case.
  assert.equal(truncate("hello world", 7), "hello…"); // shorter than max is fine
  // A whole run of spaces left by the cut is all dropped, not just one (trimEnd, not a
  // single-char trim).
  assert.equal(truncate("a  b c d e f g h i j k l m n o p q r s t u v w x y z", 4), "a…");
});

test("truncate handles tiny max values without breaking", () => {
  assert.equal(truncate("abc", 1), "…"); // nothing fits but the ellipsis itself
  assert.equal(truncate("abc", 2), "a…");
  assert.ok(truncate("anything at all", 3).length <= 3);
});

test("truncate never splits a surrogate pair (no lone surrogates in clipped labels)", () => {
  // Astral characters (emoji) are two UTF-16 code units; cutting between them would leave a
  // lone high surrogate that terminals render as garbage. The cut backs off and drops the
  // whole character instead, keeping the length invariant.
  const s = "ab🎉cd"; // 🎉 occupies code units 2..3
  assert.equal(truncate(s, 4), "ab…"); // cut at 3 would split the pair → back off to 2
  assert.equal(truncate("🎉", 1), "…"); // nothing but the ellipsis fits
  assert.equal(truncate("🎉x", 2), "…"); // cut at 1 splits the pair → back off to 0
  for (let max = 1; max <= s.length + 2; max++) {
    const out = truncate(s, max);
    assert.ok(out.length <= max, `max ${max}: ${out.length} chars: ${JSON.stringify(out)}`);
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(
          out.charCodeAt(i + 1) >= 0xdc00 && out.charCodeAt(i + 1) <= 0xdfff,
          `lone surrogate at ${i} in ${JSON.stringify(out)}`,
        );
      }
    }
  }
});

test("truncate never returns a string longer than max (the display-width invariant)", () => {
  // Every consumer sizes its column budget off this: progress work items (60), transcript
  // lines (120) and thinking (80), tool-call details (32). A result over max would wrap in
  // the TUI/GUI and break the one-logical-line-per-visual-line invariant. Sweep realistic
  // label shapes — including whitespace at every possible cut position — across all max.
  const samples = [
    "hello world",
    "a b c d e f g h i j k l m n o p q r s t u v w x y z",
    "ab  cd   ef\tgh\nij", // whitespace at many offsets
    "x".repeat(80),
    "word ".repeat(20).trimEnd(), // every 5th char is a space
  ];
  for (const s of samples) {
    for (let max = 1; max <= s.length + 2; max++) {
      const out = truncate(s, max);
      assert.ok(out.length <= max, `truncate(${JSON.stringify(s.slice(0, 12))}…, ${max}) → ${out.length} chars: ${JSON.stringify(out)}`);
    }
  }
});

// compactTokens is the single home of the token display format shared by the status table's
// gen/peak-ctx columns and the commit trailer's ctx field — pinning it here keeps those two
// surfaces from drifting even though they live in different modules.
test("compactTokens renders bare integers below 10,000", () => {
  assert.equal(compactTokens(0), "0");
  assert.equal(compactTokens(500), "500");
  assert.equal(compactTokens(9_999), "9999"); // just under the threshold: no k
});

test("compactTokens renders one-decimal k at and above 10,000", () => {
  assert.equal(compactTokens(10_000), "10.0k"); // boundary: compacted with a .0
  assert.equal(compactTokens(12_345), "12.3k");
});

// --- parsePositiveInt / parseNonNegativeInt (the shared numeric core) ---

test("parsePositiveInt accepts plain decimal only — hex, scientific, signed, and padded forms are null", () => {
  assert.equal(parsePositiveInt("1"), 1);
  assert.equal(parsePositiveInt("65535"), 65535);
  for (const raw of ["0x10", "1e3", "+5", "-5", " 5", "5 ", "", "abc", "2.5", "0"]) {
    assert.equal(parsePositiveInt(raw), null, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

test("parseNonNegativeInt accepts plain decimal only and allows zero", () => {
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(parseNonNegativeInt("42"), 42);
  for (const raw of ["0x10", "1e3", "+5", "-5", "-0", " 5", "", "abc"]) {
    assert.equal(parseNonNegativeInt(raw), null, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});
