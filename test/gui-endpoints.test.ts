import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { handleReport, handleFailures } from "../src/ui/gui-endpoints.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../src/event-window.js";
import { atLocalTs as at, dayKey, writeEvents } from "./util.js";
import { tmpdir } from "./repo-fixtures.js";

// The GET data endpoints of the dashboard (src/ui/gui-endpoints.ts), exercised at the unit
// level: handleReport and handleFailures have no other direct coverage — gui.test.ts drives
// /api/prompt, /api/transcript, and /api/backlog through the live server but never these two.
// Both handlers only read the parsed query (the server threads it down from the one
// parseRequestTarget call) and write one JSON response, so a fake res that captures
// writeHead/end is enough; the domain work runs for real against a seeded repo.

interface Captured {
  status?: number;
  contentType?: string;
  body: string;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = { body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.contentType = headers["content-type"];
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function serveReport(root: string, query = ""): { captured: Captured; data: unknown } {
  const { res, captured } = fakeRes();
  handleReport(new URLSearchParams(query), res, root);
  return { captured, data: JSON.parse(captured.body) };
}

test("handleReport serves seeded usage as JSON: status, content-type, and real totals", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Out of the 5-day window — must not count in any total.
    JSON.stringify({ ts: at(6), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: at(4), loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 500, costUsd: 0.5 }),
    JSON.stringify({ ts: at(3), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
    JSON.stringify({ ts: at(0), loop: "steward", type: "merged", commit: "def5678", summary: "y" }),
  ]);
  // A PLANS.md Done entry dated today counts as one feature done in the window.
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    ["# Plans", "", "## Done", "", `### Something (planned 2026-09-20, done ${dayKey(at(0))}; commit abc1234)`, "", ""].join("\n"),
  );

  const { captured, data } = serveReport(root, "?days=5");
  const report = data as { days: number; series: { date: string; tokensOut: number; commits: number; featuresDone: number; costByRole: Record<string, number> }[]; totals: { tokensOut: number; ticks: number; commits: number; featuresDone: number; costUsd: number } };

  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.equal(report.days, 5);
  assert.equal(report.series.length, 5);
  assert.equal(report.series[report.series.length - 1]?.date, dayKey(at(0)));
  assert.equal(report.totals.tokensOut, 500); // the out-of-window 999 is excluded
  assert.equal(report.totals.ticks, 1);
  assert.equal(report.totals.commits, 2);
  assert.equal(report.totals.featuresDone, 1);
  assert.deepEqual(report.series[0]?.costByRole, { feature: 0.5 });
});

test("handleReport degrades a bad days value to the default and clamps the range", () => {
  const root = tmpdir();
  // windowDays's documented rule: the default (14) on any non-plain-digit spelling — hex,
  // scientific, signed — and a clamp into [1, REPORT_MAX_DAYS] for real counts. A URL typo
  // must degrade to the default window, never error.
  const cases: [string, number][] = [
    ["", REPORT_DEFAULT_DAYS],
    ["?days=abc", REPORT_DEFAULT_DAYS],
    ["?days=1e3", REPORT_DEFAULT_DAYS], // raw parseInt would read this as 1
    ["?days=0x10", REPORT_DEFAULT_DAYS],
    ["?days=-5", REPORT_DEFAULT_DAYS],
    ["?days=0", 1],
    ["?days=1", 1],
    [`?days=${REPORT_MAX_DAYS + 1}`, REPORT_MAX_DAYS],
  ];
  for (const [query, expectedDays] of cases) {
    const { captured, data } = serveReport(root, query);
    const report = data as { days: number; series: unknown[] };
    assert.equal(captured.status, 200, query);
    assert.equal(report.days, expectedDays, query);
    assert.equal(report.series.length, expectedDays, query);
  }
});

test("handleFailures serves the digest as JSON markdown, empty and after an error tick", () => {
  // Empty log: the digest still answers 200 with its header, not an error.
  const empty = tmpdir();
  const { captured, data } = serveFailures(empty);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.match((data as { markdown: string }).markdown, /^# tumwater failure digest/);

  // A seeded error tick surfaces as a real outcome row in the same digest.
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 1, result: "error" }),
  ]);
  const seeded = serveFailures(root);
  const markdown = (seeded.data as { markdown: string }).markdown;
  assert.match(markdown, /^# tumwater failure digest/);
  assert.match(markdown, /bugfix/);
  assert.match(markdown, /error/);
});

function serveFailures(root: string, query = ""): { captured: Captured; data: unknown } {
  const { res, captured } = fakeRes();
  handleFailures(new URLSearchParams(query), res, root);
  return { captured, data: JSON.parse(captured.body) };
}
