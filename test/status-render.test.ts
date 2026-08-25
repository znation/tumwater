import test from "node:test";
import assert from "node:assert/strict";
import { clipToWidth, renderStatus } from "../src/status-render.js";
import type { StatusSnapshot } from "../src/status.js";
import { freshLoopState } from "../src/state.js";
import { tmpdir } from "./util.js";

function snapshotWith(loops: Array<Partial<ReturnType<typeof freshLoopState>> & { role: string }>): StatusSnapshot {
  return {
    running: false,
    inbox: 0,
    loops: loops.map((partial) => ({ ...freshLoopState(partial.role), ...partial })),
  };
}

test("status table ends with a totals row summing tokens and cost", () => {
  const snap = snapshotWith([
    { role: "clean", totalTokens: 900_000, totalCostUsd: 1.25 },
    { role: "dry", totalTokens: 350_000, totalCostUsd: 0.5 },
  ]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  const separator = lines[lines.length - 2] ?? "";
  assert.match(totals, /^total\b/);
  assert.match(totals, /1250\.0k/, "tokens sum is compact-formatted");
  assert.match(totals, /\$1\.75/);
  assert.match(separator, /^-+( +-+)+\s*$/, "totals row sits below a separator");
});

test("totals row shows zeros without breaking alignment", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "dry" }]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  assert.match(totals, /^total\b/);
  assert.match(totals, /\b0\b/);
  assert.match(totals, /\$0\.00/);
});

test("renderStatus with maxWidth clips every line and truncates wide cells", () => {
  const snap = snapshotWith([
    {
      role: "improve",
      lastResult: "changed",
      lastSummary: "an extremely long tick summary that would normally blow the table out past eighty columns easily",
      ticks: 3,
      commits: 1,
    },
    { role: "clean" },
  ]);
  const capped = renderStatus(tmpdir(), snap, 80);
  for (const line of capped.split("\n")) {
    assert.ok(line.length <= 80, `line exceeds 80 cols: ${JSON.stringify(line)} (${line.length})`);
  }
  assert.match(capped, /…/, "over-wide cells are ellipsis-truncated");
  // Uncapped output keeps the full summary.
  assert.match(renderStatus(tmpdir(), snap), /eighty columns easily/);
});

test("narrow terminals never receive a wrapping line even below column minimums", () => {
  const snap = snapshotWith([
    { role: "organize", lastResult: "changed", lastSummary: "x".repeat(120), ticks: 12, commits: 9 },
  ]);
  for (const width of [40, 60]) {
    for (const line of renderStatus(tmpdir(), snap, width).split("\n")) {
      assert.ok(line.length <= width, `width ${width} violated: ${line.length}`);
    }
  }
});

test("clipToWidth never exceeds the requested width, even at degenerate widths", () => {
  const text = "a much longer line than any of these widths";
  assert.equal(clipToWidth(text, 100), text, "shorter-than-width text is untouched");
  assert.equal(clipToWidth("abcd", 4), "abcd", "exact-fit text is untouched");
  for (const width of [0, 1, 2, 5, 80]) {
    const clipped = clipToWidth(text, width);
    assert.ok(clipped.length <= width, `width ${width} violated: ${clipped.length}`);
  }
  assert.match(clipToWidth(text, 5), /…$/, "over-wide text ends in an ellipsis");
});
