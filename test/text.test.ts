import test from "node:test";
import assert from "node:assert/strict";
import {
  compactTokens,
  collapseWhitespace,
  parseNonNegativeInt,
  parsePositiveInt,
  suggestClosest,
  typoSuffix,
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
    for (let max = 0; max <= s.length + 2; max++) {
      const out = truncate(s, max);
      assert.ok(out.length <= max, `truncate(${JSON.stringify(s.slice(0, 12))}…, ${max}) → ${out.length} chars: ${JSON.stringify(out)}`);
    }
  }
});

test("truncate with a non-positive max fits nothing and returns the empty string", () => {
  // Without the guard, cut = max - 1 is negative and s.slice(0, -n) drops n trailing
  // characters instead of keeping none — truncate("abc", 0) returned "ab…" (3 chars for a 0
  // budget), violating the length invariant every display consumer sizes off.
  assert.equal(truncate("abc", 0), "");
  assert.equal(truncate("a much longer string than the budget", 0), "");
  assert.equal(truncate("abc", -1), "");
  assert.equal(truncate("", 0), "");
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

// Regression (2026-09-20): the millions branch was added to report.ts's private formatTokens
// but not to this shared formatter or the GUI's browser-side copy, so a window total of
// 13,820,300 rendered as "13820.3k". `compactTokens` and the page's fmtTokens must agree with
// the report's rule (uppercase M) at and above one million.
test("compactTokens renders one-decimal M at and above 1,000,000", () => {
  assert.equal(compactTokens(1_000_000), "1.0M"); // boundary: swaps k for M
  assert.equal(compactTokens(13_820_300), "13.8M");
  // 999,999 still uses the k branch — and rounds up to "1000.0k", exactly as report.ts's
  // formatTokens does, so the dashboards keep printing what the Markdown table prints.
  assert.equal(compactTokens(999_999), "1000.0k");
});

// --- parsePositiveInt / parseNonNegativeInt (the shared numeric core) ---

test("parsePositiveInt accepts plain decimal only — hex, scientific, signed, and padded forms are null", () => {
  assert.equal(parsePositiveInt("1"), 1);
  assert.equal(parsePositiveInt("65535"), 65535);
  for (const raw of ["0x10", "1e3", "+5", "-5", " 5", "5 ", "", "abc", "2.5", "0"]) {
    assert.equal(parsePositiveInt(raw), null, `expected ${JSON.stringify(raw)} to be rejected`);
  }
  // A digit run Number() cannot represent exactly must not read as a valid count. 400 nines
  // overflow to Infinity (the old `n >= 1` guard let it through as an unbounded count);
  // 1e16 is finite but above MAX_SAFE_INTEGER, so its integer value is a lie.
  for (const raw of ["9".repeat(400), "1".repeat(17), String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(parsePositiveInt(raw), null, `expected over-long ${raw.slice(0, 8)}… to be rejected`);
  }
  assert.equal(parsePositiveInt(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test("parseNonNegativeInt accepts plain decimal only and allows zero", () => {
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(parseNonNegativeInt("42"), 42);
  for (const raw of ["0x10", "1e3", "+5", "-5", "-0", " 5", "", "abc"]) {
    assert.equal(parseNonNegativeInt(raw), null, `expected ${JSON.stringify(raw)} to be rejected`);
  }
  for (const raw of ["9".repeat(400), "1".repeat(17)]) {
    assert.equal(parseNonNegativeInt(raw), null, `expected over-long ${raw.slice(0, 8)}… to be rejected`);
  }
});

// (describeToolCall and backendKindPhrase moved with their module to test/phrases.test.ts)

// suggestClosest is the shared did-you-mean behind the unknown-command and unknown-config-key
// errors. The contract the CLI wording relies on: a typo (≤2 edits, case-insensitive) names
// its closest real token, a different word or an empty input gets null, and ties/near-misses
// never invent a candidate — the caller still prints the full valid list.
test("suggestClosest names the closest candidate within two edits, case-insensitively", () => {
  assert.equal(suggestClosest("modle", ["model", "thinking"]), "model");
  assert.equal(suggestClosest("MODLE", ["model"]), "model");
  assert.equal(suggestClosest("statis", ["status", "logs"]), "status");
  assert.equal(suggestClosest("frobnicate", ["model", "status"]), null);
  assert.equal(suggestClosest("", ["model"]), null);
  // The closest candidate wins even when another is also within the cap:
  // modle→model is 2 edits, modle→modeller 3, so the nearer spelling is named.
  assert.equal(suggestClosest("modle", ["modeller", "model"]), "model");
  // An empty candidate list has nothing to suggest.
  assert.equal(suggestClosest("model", []), null);
});

// typoSuffix composes suggestClosest + didYouMean — the suffix every unknown-X error appends.
// It renders the suggestion through didYouMean's pinned wording, and the empty string when
// suggestClosest has nothing close enough (the same contract as its two halves).
test("typoSuffix appends the did-you-mean wording for a close typo, nothing otherwise", () => {
  assert.equal(typoSuffix("modle", ["model", "status"]), " — did you mean `model`?");
  assert.equal(typoSuffix("frobnicate", ["model", "status"]), "");
  assert.equal(typoSuffix("model", []), "");
});
