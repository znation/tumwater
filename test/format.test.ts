import test from "node:test";
import assert from "node:assert/strict";
import { appendPromptNote, compactTokens, contextShareLabel, formatBytes, formatGB, shortSha, usd, usdCap } from "../src/text/format.js";

// format.ts is the single home of the number, money, and hash formats every display surface
// (status table, event feed, usage report, commit trailers) renders through. These tests pin
// the documented contracts directly instead of only through one indirect case per consumer.

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

// contextShareLabel is the single home of the peak-share parenthetical the status table's
// live peak-ctx column and the recorded `history <role> <n>` summary header both render, so
// the share format cannot drift between the live run and its trail.
test("contextShareLabel reads a peak against a declared window", () => {
  // 110k on a 128k window — past the compaction point, the share an operator needs.
  assert.match(contextShareLabel(110_000, 131_072), /^110\.0k \(84%\)$/);
  assert.equal(contextShareLabel(131_072, 131_072), "131.1k (100%)"); // compactTokens's one-decimal k
  // An unknown window (undefined, null, or 0) or a zero peak renders the bare peak, no share.
  assert.equal(contextShareLabel(110_000, undefined), compactTokens(110_000));
  assert.equal(contextShareLabel(110_000, null), compactTokens(110_000));
  assert.equal(contextShareLabel(110_000, 0), compactTokens(110_000));
  assert.equal(contextShareLabel(0, 131_072), compactTokens(0));
  // Rounds to a whole percent, not a fraction: the share is a coarse-hotness read.
  assert.equal(contextShareLabel(65_000, 131_072), "65.0k (50%)"); // 49.59% rounds to 50%
});
test("shortSha abbreviates a hash to its first 8 characters", () => {
  assert.equal(shortSha("abcdef1234567890"), "abcdef12");
  // Harness events carry fields loosely typed: coercion matches the old inline
  // String(...).slice(0, 8) exactly, and a finite number still renders.
  assert.equal(shortSha(123456789), "12345678");
  // A torn or hand-edited event with no hash (or a foreign value) reads as "?", the same
  // corrupt-value stand-in eventRole/outcomeText use, never String(undefined)'s "undefined".
  for (const sha of [undefined, null, {}, NaN, Number.POSITIVE_INFINITY] as const) {
    assert.equal(shortSha(sha), "?", `corrupt sha ${String(sha)} must read ?`);
  }
});

test("formatGB renders one decimal and the unit", () => {
  assert.equal(formatGB(8.2), "8.2 GB");
  assert.equal(formatGB(30), "30.0 GB"); // whole values keep the decimal
  assert.equal(formatGB(3.24), "3.2 GB"); // rounds to one decimal
});

test("formatBytes picks the largest of the B/KB/MB/GB tiers, one decimal each", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B"); // below the KB threshold stays bytes
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024), "1.0 KB"); // KB keeps one decimal, whole values included
  assert.equal(formatBytes(1536 * 1024), "1.5 MB");
  assert.equal(formatBytes(1536 * 1024 * 1024), "1.5 GB"); // GB tier is covered, not dead
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
});

// standalone unit pins for doctor-checks's claude transcript size and
// doctor-model-checks's opencode db/spill sizes, which route through formatBytes now.

test("usd always keeps two decimals; usdCap drops a whole-dollar .00", () => {
  assert.equal(usd(12.3), "$12.30");
  assert.equal(usd(0), "$0.00");
  assert.equal(usdCap(50), "$50"); // whole dollars stay bare
  assert.equal(usdCap(12.34), "$12.34"); // fractional keeps its cents
  assert.equal(usdCap(25), "$25"); // the TUI's `budget set to $25` flash
});

test("appendPromptNote joins a note to the prompt with one blank line, even an empty note", () => {
  assert.equal(appendPromptNote("a", "b"), "a\n\nb");
  assert.equal(appendPromptNote("a", ""), "a\n\n"); // appended unconditionally
  assert.equal(appendPromptNote("", "b"), "\n\nb");
  assert.equal(appendPromptNote(appendPromptNote("a", "b"), "c"), "a\n\nb\n\nc");
});
