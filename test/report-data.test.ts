// --- src/report/report-data.ts: the usage collectors (collectReport, collectReportSince) ---
// The day-window collector buckets tick_end/merged/landing events by LOCAL calendar day and
// tallies the backlog trackers' completions; the trailing-window collector totals a --since
// window with a coverage proof. The Markdown render of both lives one layer up in
// src/report/report-render.ts (test/report.test.ts); these tests pin the collectors' data contract.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { collectReport, collectReportSince } from "../src/report/report-data.js";
import { renderSinceReportMarkdown } from "../src/report/report-render.js";
import { REPORT_SINCE_MAX_MS } from "../src/events/event-window.js";
import { eventsLogPath } from "../src/paths.js";
import { atLocalTs as at, dayKey, HOUR, ago } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

// The report buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings) and compute expected keys the same way (dayKey).

test("collectReport buckets tick_end/merged events by local day and totals them", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Out of the 5-day window (7 days ago) — must not count.
    JSON.stringify({ ts: at(6), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: at(4), loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 500, costUsd: 0.5 }),
    // No tokens/costUsd fields — counts as a tick with zero spend (omitted when zero in the log).
    JSON.stringify({ ts: at(4), loop: "bugfix", type: "tick_end", tick: 3, result: "no_change" }),
    "this line is not json", // malformed lines are ignored
    JSON.stringify({ ts: at(3), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
    // Gap day (at 2) stays zero-filled.
    JSON.stringify({ ts: at(1), loop: "feature", type: "tick_end", tick: 5, result: "changed", tokens: 1500, costUsd: 1.25 }),
    JSON.stringify({ ts: at(0), loop: "steward", type: "merged", commit: "def5678", summary: "y" }),
    JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 6, result: "no_change", tokens: 10 }),
  ]);
  const data = collectReport(root, 5);

  assert.equal(data.days, 5);
  assert.equal(data.from, dayKey(at(4)));
  assert.equal(data.to, dayKey(at(0)));
  assert.equal(data.series.length, 5);
  for (let i = 1; i < data.series.length; i++) {
    const prev = data.series[i - 1]?.date ?? "";
    const cur = data.series[i]?.date ?? "";
    assert.ok(cur > prev, "series is oldest→newest");
  }

  const d0 = data.series[0]; // at(4)
  assert.equal(d0?.tokensOut, 500);
  assert.deepEqual(d0?.ticksByRole, { feature: 1, bugfix: 1 });
  assert.deepEqual(d0?.costByRole, { feature: 0.5 }, "cost splits by role from the same tick_end event");
  assert.ok(Math.abs((d0?.costUsd ?? -1) - 0.5) < 1e-9);
  const d1 = data.series[1]; // at(3): a commit day with no ticks
  assert.equal(d1?.commits, 1);
  assert.equal(d1?.tokensOut, 0);
  const d2 = data.series[2]; // at(2): zero-filled gap
  assert.deepEqual(d2, { date: dayKey(at(2)), tokensOut: 0, ticksByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 });
  const d3 = data.series[3]; // at(1)
  assert.equal(d3?.tokensOut, 1500);
  assert.deepEqual(d3?.costByRole, { feature: 1.25 });
  assert.ok(Math.abs((d3?.costUsd ?? -1) - 1.25) < 1e-9);
  const d4 = data.series[4]; // today
  assert.equal(d4?.commits, 1);
  assert.deepEqual(d4?.ticksByRole, { feature: 1 });

  assert.equal(data.totals.tokensOut, 2010);
  assert.equal(data.totals.ticks, 4);
  assert.equal(data.totals.commits, 2);
  assert.ok(Math.abs(data.totals.costUsd - 1.75) < 1e-9);
  // costByRole folds from the same tick_end events as costUsd (never a second pass), so the
  // per-day split sums exactly to the day's cost — and the window's to the Totals cost.
  for (const d of data.series) {
    assert.ok(Math.abs(Object.values(d.costByRole).reduce((a, b) => a + b, 0) - d.costUsd) < 1e-9, `${d.date} costByRole sums to costUsd`);
  }
  assert.equal(data.totals.featuresDone, 0);
  assert.equal(data.totals.bugsFixed, 0);
});

test("collectReport skips a future-dated or timestamp-less event instead of folding into a missing day", () => {
  // The usage fold indexes only the window's days: an event dated ahead of today (clock
  // skew, a bad writer) has no bucket, and the reader can hand the fold such an event —
  // scanEventsFile only drops lines OLDER than the window. The skip guard is load-bearing:
  // without it the event would be folded into `undefined` and the whole `tumwater report`
  // (and the GUI's report view with it) would crash on one skewed timestamp. The two
  // timestamp-less lines document the layer beneath: the reader itself drops events whose
  // day key is not a number, so the fold never sees them at all.
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(4), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.5 }),
    // Dated two days into the future: no bucket exists for it.
    JSON.stringify({ ts: at(-2), loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 9999 }),
    // ts present but not a number; eventDayKey returns null for it.
    JSON.stringify({ ts: "not-a-timestamp", loop: "bugfix", type: "tick_end", tick: 3, result: "changed", tokens: 8888 }),
    // ts omitted entirely.
    JSON.stringify({ loop: "dry", type: "tick_end", tick: 4, result: "changed", tokens: 7777 }),
  ]);
  const data = collectReport(root, 5);
  // Only the in-window, well-timestamped event counts; the others vanish without a trace.
  assert.equal(data.totals.tokensOut, 500);
  assert.equal(data.totals.ticks, 1);
  assert.deepEqual(data.series[0]?.ticksByRole, { feature: 1 });
  for (const d of data.series) {
    assert.deepEqual(Object.keys(d.ticksByRole), d.ticksByRole.feature ? ["feature"] : [], `${d.date} carries no phantom roles`);
  }
});

test("collectReport folds landed/land_failed usage into the day and totals, with the landing share named", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 100, costUsd: 0.1 }),
    JSON.stringify({ ts: at(0), loop: "feature", type: "landed", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }),
    JSON.stringify({ ts: at(0), loop: "docs", type: "land_failed", summary: "conflict", tokens: 300, costUsd: 0.01 }),
    JSON.stringify({ ts: at(0), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
  ]);
  const data = collectReport(root, 3);
  const today = data.series[2];
  // The day's tokensOut/costUsd include the landing share (the budget charges these same
  // events, so the day series must keep summing to the totals), while the landing fields
  // name the reviewer's part of it: both landing events' tokens/cost, 2 runs.
  assert.equal(today?.tokensOut, 45_600); // 100 tick tokens + 45,500 landing tokens
  assert.ok(Math.abs((today?.costUsd ?? -1) - 0.95) < 1e-9);
  assert.equal(today?.landingRuns, 2);
  assert.equal(today?.landingTokens, 45_500);
  assert.ok(Math.abs((today?.landingCostUsd ?? -1) - 0.85) < 1e-9);
  assert.equal(data.totals.landingRuns, 2);
  assert.equal(data.totals.landingTokens, 45_500);
  assert.ok(Math.abs(data.totals.landingCostUsd - 0.85) < 1e-9);
  assert.equal(data.totals.tokensOut, 45_600);
  assert.ok(Math.abs(data.totals.costUsd - 0.95) < 1e-9);
  assert.equal(data.totals.ticks, 1);
  assert.equal(data.totals.commits, 1, "merged still counts only as a commit");
  // costByRole stays a ticks-only breakdown — the landing line is how the reviewer's share
  // is named, not a role entry.
  assert.ok(Math.abs(Object.values(today?.costByRole ?? {}).reduce((a, b) => a + b, 0) - 0.1) < 1e-9);
  // Landing fields are sparse: a day that folded no landing event carries none.
  assert.ok(data.series.slice(0, 2).every((d) => !("landingCostUsd" in d)), "no landing keys on landing-free days");
});

test("collectReport reads a grown event log with bounded backwards I/O", () => {
  const root = tmpdir();
  // ~250 KB of out-of-window history (well past the 8 KB whole-read threshold) plus three
  // in-window events: the tail scan must stop at the window, not rescan the file.
  const lines: unknown[] = [];
  for (let i = 0; i < 2500; i++) {
    lines.push(JSON.stringify({ ts: at(40), loop: "feature", type: "tick_end", tick: i, result: "no_change", tokens: 1 }));
  }
  lines.push(JSON.stringify({ ts: at(3), loop: "bugfix", type: "merged", commit: "aaa", summary: "old" }));
  lines.push(JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 9, result: "changed", tokens: 777 }));
  writeEvents(root, lines);

  const data = collectReport(root, 7);
  assert.equal(data.totals.tokensOut, 777); // the 2500 old ticks are out of window
  assert.equal(data.totals.ticks, 1);
  assert.equal(data.totals.commits, 1);
  const today = data.series[data.series.length - 1];
  assert.deepEqual(today?.ticksByRole, { feature: 1 });
});

test("collectReport does not double-count an event appended between the cache's stat and its read", () => {
  const root = tmpdir();
  const first = JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 100 });
  writeEvents(root, [first]);
  const second = JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 2, result: "changed", tokens: 50 });
  const log = eventsLogPath(root);
  // Reproduce the full-re-read race: the fold records the outer stat's size as the offset it
  // will append from, then the event lands, then readWindowEvents scans the grown file and
  // folds the new event. The offset must come from the scan itself, or the next report reads
  // from the stale offset and folds the appended event a second time.
  let appended = false;
  const restoreStat = patchFsMethod("statSync", (orig) => (p, ...args) => {
    const st = orig(p, ...args) as fs.Stats;
    if (!appended && String(p) === log) {
      appended = true;
      fs.appendFileSync(log, second + "\n");
    }
    return st;
  });
  try {
    const raced = collectReport(root, 7);
    assert.equal(raced.totals.tokensOut, 150, "the racing read folds both events once");
    const after = collectReport(root, 7);
    assert.equal(after.totals.tokensOut, 150, "a repeat report must not fold the appended event again");
  } finally {
    restoreStat();
  }
});

test("collectReport counts features done and bugs fixed from backlog history", () => {
  const root = tmpdir();
  const d1 = dayKey(at(4));
  const d2 = dayKey(at(3));
  const d3 = dayKey(at(2));
  const dOld = dayKey(at(30)); // out of the 5-day window

  writeBacklogFile(root, "PLANS.md", [
    {
      heading: "## Planned",
      body: `### Still planned (planned ${dayKey(at(1))})

Body prose that mentions done ${d2} — the Planned section is never scanned.`,
    },
    {
      heading: "## Done",
      // The real-world false positive: a body bullet whose following prose paragraph carries a
      // lowercase cross-reference to another entry must not count as that other entry. The
      // wrapped entry's date lands on its second line.
      body: `### Full heading entry (planned 2026-09-01, done ${d1})

**Goal.** Body prose that says done ${d3} — only the heading's metadata counts.

- acceptance bullet without a date

**Relationship to other plans.** Sibling of the done daily-cost-budget plan (done ${d2}) — never counted.

### Wrapped heading entry (planned 2026-09-02, done
${d2})

Body.

- Compressed epitaph (planned 2026-08-25, done ${d3}; commit abc1234)
- No date epitaph (planned 2026-08-20; commit def5678)
- Out-of-window epitaph (planned 2026-07-01, done ${dOld}; commit 9999999)`,
    },
  ]);
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Open",
      body: `### Still open (found by qa loop ${dayKey(at(1))})\n\nBody.`,
    },
    {
      heading: "## Fixed",
      body: `### Full fixed entry (found by bugfix loop 2026-09-05, fixed ${d2})

**Symptom:** Body with a repro bullet that carries no date.

- repro step one

- Closed variant (reported 2026-08-30, closed ${d1}; commit abc)
- Resolved variant (found by human log analysis 2026-09-04, resolved ${d3}; commit def)
- Old epitaph (reported 2026-07-01, fixed ${dOld}; commit 8888888)`,
    },
  ]);

  const data = collectReport(root, 5);
  const byDate = new Map(data.series.map((d) => [d.date, d]));

  assert.equal(byDate.get(d1)?.featuresDone, 1); // full heading
  assert.equal(byDate.get(d2)?.featuresDone, 1); // wrapped heading — the body's "done" prose did not add one
  assert.equal(byDate.get(d3)?.featuresDone, 1); // compressed epitaph only (the body mention of d3 did not count)
  assert.equal(byDate.get(dOld)?.featuresDone ?? 0, 0);

  assert.equal(byDate.get(d1)?.bugsFixed, 1); // closed variant
  assert.equal(byDate.get(d2)?.bugsFixed, 1); // full heading (fixed)
  assert.equal(byDate.get(d3)?.bugsFixed, 1); // resolved variant
  assert.equal(data.totals.featuresDone, 3);
  assert.equal(data.totals.bugsFixed, 3);
});

test("a ### heading quoted in a fenced block inside a Fixed entry adds no phantom completion", () => {
  // An entry quoting a markdown template (or BUGS.md itself) must not count as completions of
  // its own: before the fix each fenced `### `/`- ` date line inflated the report's fixed count.
  const root = tmpdir();
  const d1 = dayKey(at(2));
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `### Real bug (found 2026-08-01, fixed ${d1})

Body prose.

\`\`\`md
## Fixed

### Quoted entry (fixed ${dayKey(at(1))})

- Quoted epitaph (fixed ${dayKey(at(0))}; commit abc)
\`\`\``,
    },
  ]);

  const data = collectReport(root, 5);
  assert.equal(data.totals.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d1)?.bugsFixed, 1);
});

test("a body bullet that mentions a completion date is not an entry; an epitaph's commit-bearing tail still is", () => {
  // A Fixed entry's body can carry a bulleted list whose items mention a sibling's completion
  // ("- same shape as the sibling bug (fixed 2026-09-24)") — those are body text, not entries,
  // and before the epitaph guard each one inflated the report's fixed count on the sibling's
  // day. An epitaph bullet keeps counting: its trailing parenthetical carries the date beside
  // its landing commit.
  const root = tmpdir();
  const d1 = dayKey(at(2));
  const d2 = dayKey(at(1));
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `### Real entry with a body list (found by bugfix loop ${d1}, fixed ${d1})

The sibling symptom was recorded twice before:

- a first false start (fixed ${d2})
- a second false start (fixed ${d2})

And a closing note.

- A real epitaph in the compressed style (found by telemetry loop ${d2}, fixed ${d2}; commit abc1234)`,
    },
  ]);

  const data = collectReport(root, 5);
  assert.equal(data.totals.bugsFixed, 2); // the entry's own day + the epitaph's day — not 5
  assert.equal(data.series.find((d) => d.date === d1)?.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d2)?.bugsFixed, 1); // the epitaph only
});

test("an epitaph whose trailing parenthetical quotes a nested parenthetical still counts; a body bullet with one still does not", () => {
  // The epitaph guard reads the trailing parenthetical to separate entries from body bullets.
  // The flat [^()] match could not span a nested group: "(…; commit abc (re-landed after
  // review fix))" matched only the innermost "(re-landed after review fix)", whose text
  // carries neither the date nor the commit reference, so the epitaph's completion date
  // vanished from the day report with no error. The nesting-aware backward scan keeps it.
  const root = tmpdir();
  const d1 = dayKey(at(2));
  const d2 = dayKey(at(1));
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `- Nested-paren epitaph (planned ${d1}, fixed ${d2}; commit abc1234 (re-landed after review fix))
- A body bullet after it (fixed ${d2})`,
    },
  ]);

  const data = collectReport(root, 5);
  assert.equal(data.totals.bugsFixed, 1); // the epitaph only — the body bullet still counts nowhere
  assert.equal(data.series.find((d) => d.date === d2)?.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d1)?.bugsFixed, 0); // zero-filled, not counted
});

test("a Fixed heading whose completion is recorded as re-landed counts on that date; an undated fixed mention counts nowhere", () => {
  // The bugfix prompt pins the completion DATE, not the verb: an entry whose first landing was
  // rejected in review is completed by the re-land, and its epitaph says "re-landed <date>" —
  // the real BUGS.md entry this reproduces. Before the fix the collector's verb list
  // (fixed|closed|resolved) matched nothing in that heading and the day's bug count came up one
  // short, silently. A heading that mentions "was fixed" with no dated verb still counts
  // nowhere — the date must ride a completion verb.
  const root = tmpdir();
  const d1 = dayKey(at(2));
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `### The rebuild's compile spawn failing (found by telemetry loop ${d1}; decomposed when the sustained-pin half was fixed; the spawn-classification half re-landed ${d1} after a review objection was addressed)

Body prose.

### Never dated as completed (found by qa loop ${d1}; the fix was attempted but never finished)

Body prose.`,
    },
  ]);

  const data = collectReport(root, 5);
  assert.equal(data.totals.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d1)?.bugsFixed, 1);
});

test("a Fixed heading's completion date is its LAST dated verb; a sibling's earlier dated fix mention does not steal the day", () => {
  // Headings routinely mention siblings with their own dated verbs ("decomposed from the X bug
  // fixed <date>") before the entry's own completion record. The collector read the FIRST
  // verb+date match in the meta, so the sibling's date won and the entry was counted on the
  // wrong day — silently, whenever the sibling landed the day before. The completion record is
  // conventionally the meta's last dated verb (found-by and decomposition mentions precede it).
  const root = tmpdir();
  const d1 = dayKey(at(3));
  const d2 = dayKey(at(2));
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `### A real entry (found by qa loop ${d2}, decomposed from the sibling bug fixed ${d1}, fixed ${d2})

Body prose.`,
    },
  ]);

  const data = collectReport(root, 5);
  assert.equal(data.totals.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d2)?.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d1)?.bugsFixed, 0); // the sibling's day stays at zero
});

test("an epitaph bullet's completion date is the LAST dated verb in its trailing parenthetical; a sibling's earlier dated fix mention inside it does not steal the day", () => {
  // The heading branch takes the meta's LAST dated verb (the previous fix), but the bullet
  // branch matched the trailing parenthetical's FIRST verb+date — so a decomposition
  // cross-reference inside the epitaph ("decomposed from the sibling bug fixed <date>, fixed
  // <date>") put the entry on the sibling's day, silently, whenever the sibling landed first.
  // The convention is the same for both shapes: found-by and sibling mentions precede the
  // completion record, so the last dated verb is the completion.
  const root = tmpdir();
  const d1 = dayKey(at(3));
  const d2 = dayKey(at(2));
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `- A real fix, cross-referencing its sibling inside the epitaph (decomposed from the sibling bug fixed ${d1}, fixed ${d2}; commit abc1234)`,
    },
  ]);

  const data = collectReport(root, 5);
  assert.equal(data.totals.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d2)?.bugsFixed, 1);
  assert.equal(data.series.find((d) => d.date === d1)?.bugsFixed, 0); // the sibling's day stays at zero
});

test("collectReport degrades to zeros when every source is missing", () => {
  const root = tmpdir(); // no .tumwater/, no PLANS.md, no BUGS.md
  const data = collectReport(root, 3);
  assert.equal(data.days, 3);
  assert.equal(data.from, dayKey(at(2)));
  assert.equal(data.to, dayKey(at(0)));
  for (const d of data.series) {
    assert.deepEqual(d.ticksByRole, {});
    assert.deepEqual(d.costByRole, {});
    assert.equal(d.tokensOut + d.commits + d.costUsd + d.featuresDone + d.bugsFixed, 0);
  }
  assert.deepEqual(data.totals, {
    tokensOut: 0,
    ticks: 0,
    commits: 0,
    costUsd: 0,
    featuresDone: 0,
    bugsFixed: 0,
    landingRuns: 0,
    landingTokens: 0,
    landingCostUsd: 0,
  });
});

// ---- report --since <duration> ----

test("collectReportSince totals a trailing window: cutoff filter, role split, and coverage proofs", () => {
  const root = tmpdir();
  const cutoff = ago(6 * HOUR); // Recompute the expected cutoff below from the returned sinceMs.
  writeEvents(root, [
    // Oldest: 7h ago — outside the 6h window (and older than the cutoff instant, so it proves
    // the retained log reaches back past the window start even when its local day matches the
    // cutoff's own day, the case a day-keyed read cannot decide).
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: ago(6.5 * HOUR), loop: "feature", type: "merged", commit: "old1234", summary: "outside" }),
    // Inside the window: two ticks and one commit.
    JSON.stringify({ ts: ago(HOUR), loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 100, costUsd: 0.1 }),
    JSON.stringify({ ts: ago(30 * 60_000), loop: "bugfix", type: "tick_end", tick: 3, result: "no_change" }),
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "merged", commit: "abc1234", summary: "inside" }),
    // Future-dated: dropped, matching collectReport's day-map guard.
    JSON.stringify({ ts: Date.now() + HOUR, loop: "feature", type: "tick_end", tick: 4, result: "changed", tokens: 5000, costUsd: 9 }),
    "this line is not json", // malformed lines are ignored
  ]);
  const data = collectReportSince(root, 6 * HOUR);

  assert.equal(data.sinceMs, 6 * HOUR);
  const cutoffIso = new Date(cutoff).toISOString();
  assert.ok(
    Math.abs(Date.parse(data.fromIso) - Date.parse(cutoffIso)) < 60_000,
    `fromIso ${data.fromIso} is the window's cutoff instant (±1min for test elapsed time)`,
  );
  assert.equal(data.totals.ticks, 2);
  assert.equal(data.totals.tokensOut, 100);
  assert.equal(data.totals.commits, 1);
  assert.ok(Math.abs(data.totals.costUsd - 0.1) < 1e-9);
  assert.deepEqual(data.ticksByRole, { feature: 1, bugfix: 1 });
  assert.deepEqual(data.costByRole, { feature: 0.1 }, "zero-cost ticks leave no cost key");
  assert.equal(data.coversFullWindow, true, "the log's oldest event predates the cutoff");
});

test("collectReportSince folds landed/land_failed usage into the window totals", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(2 * HOUR), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 100, costUsd: 0.1 }),
    JSON.stringify({ ts: ago(HOUR), loop: "feature", type: "landed", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }),
    JSON.stringify({ ts: ago(30 * 60_000), loop: "docs", type: "land_failed", summary: "conflict", tokens: 300, costUsd: 0.01 }),
    // Outside the 6h window: must not count.
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "landed", commit: "old1234", summary: "old", tokens: 9_999, costUsd: 9 }),
  ]);
  const data = collectReportSince(root, 6 * HOUR);
  assert.equal(data.totals.landingRuns, 2);
  assert.equal(data.totals.landingTokens, 45_500);
  assert.ok(Math.abs(data.totals.landingCostUsd - 0.85) < 1e-9);
  // The surfaced totals include the landing share — the same events the daily budget
  // charges — so the report and the budget header agree.
  assert.equal(data.totals.tokensOut, 45_600);
  assert.ok(Math.abs(data.totals.costUsd - 0.95) < 1e-9);
  assert.equal(data.totals.ticks, 1);
});

test("collectReportSince aggregation matches a same-seed collectReport slice", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 321, costUsd: 0.2 }),
    JSON.stringify({ ts: ago(5 * 60_000), loop: "bugfix", type: "tick_end", tick: 2, result: "no_change", tokens: 11 }),
    JSON.stringify({ ts: ago(2 * 60_000), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
  ]);
  const since = collectReportSince(root, HOUR);
  assert.equal(since.totals.ticks, 2);
  assert.equal(since.totals.tokensOut, 332);
  assert.equal(since.totals.commits, 1);
  assert.ok(Math.abs(since.totals.costUsd - 0.2) < 1e-9);
  // The same seed through the day collector: its 2-day window contains every seeded event
  // whenever the test itself has not crossed local midnight in the last 10 minutes, so the
  // two collectors must agree on the four totals. (Around midnight the day collector's window
  // legitimately spans two days the since view does not — the hand-computed assertions above
  // carry the check on their own.)
  if (dayKey(ago(10 * 60_000)) === dayKey(Date.now())) {
    const day = collectReport(root, 2);
    assert.equal(day.totals.ticks, since.totals.ticks);
    assert.equal(day.totals.tokensOut, since.totals.tokensOut);
    assert.equal(day.totals.commits, since.totals.commits);
    assert.ok(Math.abs(day.totals.costUsd - since.totals.costUsd) < 1e-9);
  }
});

test("collectReportSince proves coverage on a same-day log start and notes a log born inside the window", () => {
  // The log's oldest event is 7h old and the cutoff is 6h ago: the two may share a local day
  // (the day-keyed read then cannot prove coverage by itself), yet the oldest event's ts
  // predates the cutoff — no rotation note may fire.
  const proven = tmpdir();
  writeEvents(proven, [
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "tick_end", tick: 1, result: "no_change" }),
    JSON.stringify({ ts: ago(HOUR), loop: "feature", type: "tick_end", tick: 2, result: "no_change" }),
  ]);
  assert.equal(collectReportSince(proven, 6 * HOUR).coversFullWindow, true);
  assert.ok(!renderSinceReportMarkdown(collectReportSince(proven, 6 * HOUR)).includes("rotated"));

  // A log born inside the window (a fresh install's first hour): the oldest retained event
  // lies inside the window with no proof older data was not rotated away — the report notes
  // the possible truncation instead of silently presenting a sparse window as complete.
  const truncated = tmpdir();
  writeEvents(truncated, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "tick_end", tick: 1, result: "no_change" }),
  ]);
  const t = collectReportSince(truncated, 6 * HOUR);
  assert.equal(t.coversFullWindow, false);
  assert.match(renderSinceReportMarkdown(t), /the log's oldest retained event lies inside this window/);
});

test("collectReportSince rejects an out-of-range window and accepts the exact cap", () => {
  // The window length is the collector's contract with its callers (the CLI validates --since
  // before calling, but every future caller inherits this guard): zero, negative, and
  // past-the-cap windows are refused with the offending value named — never silently
  // truncated into a report that reads as complete.
  const root = tmpdir();
  assert.throws(() => collectReportSince(root, 0), /sinceMs must be between 1 and 7d \(got 0\)/);
  assert.throws(() => collectReportSince(root, -HOUR), /\(got -3600000\)/);
  assert.throws(
    () => collectReportSince(root, REPORT_SINCE_MAX_MS + 1),
    new RegExp(`\\(got ${REPORT_SINCE_MAX_MS + 1}\\)`),
  );
  // The cap itself is a valid window — exactly 7 days ends the legal range (an empty log,
  // so zero totals fall out of the same call).
  const data = collectReportSince(root, REPORT_SINCE_MAX_MS);
  assert.equal(data.sinceMs, REPORT_SINCE_MAX_MS);
  assert.equal(data.totals.ticks, 0);
});

test("collectReportSince treats an empty or missing event log as fully covered, not truncated", () => {
  const empty = tmpdir(); // No events.jsonl at all — a fresh directory.
  const data = collectReportSince(empty, 6 * HOUR);
  assert.deepEqual(data.totals, {
    tokensOut: 0,
    ticks: 0,
    commits: 0,
    costUsd: 0,
    landingRuns: 0,
    landingTokens: 0,
    landingCostUsd: 0,
  });
  assert.deepEqual(data.ticksByRole, {});
  assert.deepEqual(data.costByRole, {});
  assert.equal(data.coversFullWindow, true, "nothing was ever logged, so nothing rotated away");
  const out = renderSinceReportMarkdown(data);
  assert.ok(!out.includes("rotated"), "a missing log must not claim events rotated out");
  assert.match(out, /backlog tallies \(features done \/ bugs fixed\) need the day report/);
});
