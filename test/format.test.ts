import test from "node:test";
import assert from "node:assert/strict";
import { compactTokens, shortSha, usd, usdCap } from "../src/format.js";

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

test("shortSha abbreviates a hash to its first 8 characters", () => {
  assert.equal(shortSha("abcdef1234567890"), "abcdef12");
  // Harness events carry fields loosely typed: coercion matches the old inline
  // String(...).slice(0, 8) exactly, and a non-string still renders.
  assert.equal(shortSha(123456789), "12345678");
});

test("usd always keeps two decimals; usdCap drops a whole-dollar .00", () => {
  assert.equal(usd(12.3), "$12.30");
  assert.equal(usd(0), "$0.00");
  assert.equal(usdCap(50), "$50"); // whole dollars stay bare
  assert.equal(usdCap(12.34), "$12.34"); // fractional keeps its cents
  assert.equal(usdCap(25), "$25"); // the TUI's `budget set to $25` flash
});