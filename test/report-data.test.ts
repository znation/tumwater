// --- src/report/report-data.ts: the usage collectors (collectReport, collectReportSince) ---
// The day-window collector buckets run_end/merged/merge events by LOCAL calendar day and
// tallies the backlog trackers' completions; the trailing-window collector totals a --since
// window with a coverage proof. The Markdown render of both lives one layer up in
// src/report/report-render.ts (test/report.test.ts); these tests pin the collectors' data contract.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { collectReport, collectReportSince } from "../src/report/report-data.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "../src/report/report-render.js";
import { REPORT_SINCE_MAX_MS } from "../src/events/event-window.js";
import { eventsLogPath } from "../src/paths.js";
import { atLocalTs as at, dayKey, HOUR, ago, todayTs } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

// The report buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings) and compute expected keys the same way (dayKey).

test("collectReport buckets run_end/merged events by local day and totals them", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Out of the 5-day window (7 days ago) — must not count.
    JSON.stringify({ ts: at(6), loop: "feature", type: "run_end", run: 1, result: "no_change", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(4), loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 500, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    // No tokens/costUsd fields — counts as a run with zero spend (omitted when zero in the log).
    JSON.stringify({ ts: at(4), loop: "bugfix", type: "run_end", run: 3, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
    "this line is not json", // malformed lines are ignored
    JSON.stringify({ ts: at(3), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }), // retired-name-ok: legacy event field in a fixture
    // Gap day (at 2) stays zero-filled.
    JSON.stringify({ ts: at(1), loop: "feature", type: "run_end", run: 5, result: "changed", tokens: 1500, costUsd: 1.25 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "steward", type: "merged", commit: "def5678", summary: "y" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 6, result: "no_change", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
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
  assert.deepEqual(d0?.runsByRole, { feature: 1, bugfix: 1 });
  assert.deepEqual(d0?.costByRole, { feature: 0.5 }, "cost splits by role from the same run_end event");
  assert.ok(Math.abs((d0?.costUsd ?? -1) - 0.5) < 1e-9);
  const d1 = data.series[1]; // at(3): a commit day with no runs
  assert.equal(d1?.commits, 1);
  assert.equal(d1?.tokensOut, 0);
  const d2 = data.series[2]; // at(2): zero-filled gap
  assert.deepEqual(d2, { date: dayKey(at(2)), tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, commitsByRole: {}, workCommits: 0, maintenanceCommits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 });
  const d3 = data.series[3]; // at(1)
  assert.equal(d3?.tokensOut, 1500);
  assert.deepEqual(d3?.costByRole, { feature: 1.25 });
  assert.ok(Math.abs((d3?.costUsd ?? -1) - 1.25) < 1e-9);
  const d4 = data.series[4]; // today
  assert.equal(d4?.commits, 1);
  assert.deepEqual(d4?.runsByRole, { feature: 1 });

  assert.equal(data.totals.tokensOut, 2010);
  assert.equal(data.totals.runs, 4);
  assert.equal(data.totals.commits, 2);
  assert.ok(Math.abs(data.totals.costUsd - 1.75) < 1e-9);
  // costByRole folds from the same run_end events as costUsd (never a second pass), so the
  // per-day split sums exactly to the day's cost — and the window's to the Totals cost.
  for (const d of data.series) {
    assert.ok(Math.abs(Object.values(d.costByRole).reduce((a, b) => a + b, 0) - d.costUsd) < 1e-9, `${d.date} costByRole sums to costUsd`);
  }
  assert.equal(data.totals.featuresDone, 0);
  assert.equal(data.totals.bugsFixed, 0);
});

test("collectReport folds review_rejected events into per-day per-role rejections", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "qa", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    // Merely merge a commit is not a rejection: it must fold no rejection anywhere.
    JSON.stringify({ ts: at(1), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 4);
  const today = data.series[data.series.length - 1];
  assert.deepEqual(today?.rejectionsByRole, { feature: 2, qa: 1 });
  assert.deepEqual(today?.runsByRole, { feature: 1 }, "run_end still counts runs alongside rejections");
  // A day with no review_rejected has no rejectionsByRole key at all (zero means absent).
  for (const d of data.series) {
    if (d !== today) {
      assert.ok(!Object.hasOwn(d, "rejectionsByRole"), `${d.date} carries no rejectionsByRole`);
    }
  }
  // The window totals fold the same events: rejections sum across the series.
  const total = data.series.reduce(
    (m, d) => m + Object.values(d.rejectionsByRole ?? {}).reduce((a, b) => a + b, 0),
    0,
  );
  assert.equal(total, 3);
});

test("collectReportSince folds review_rejected events into the window totals", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "qa", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
    // Outside the 6 h window — must not count.
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReportSince(root, 6 * HOUR);
  assert.deepEqual(data.rejectionsByRole, { feature: 1, qa: 1 });
});

test("collectReport splits merged events by base role and by work/maintenance tier", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature-2", type: "merged", commit: "a" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "merged", commit: "b" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "merged", commit: "c" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "merged", commit: "d" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "readme", type: "merged", commit: "e" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 1);
  // The instance suffix folds into its base role, and the tier split names work vs upkeep.
  assert.deepEqual(data.totals.commitsByRole, { feature: 1, bugfix: 1, clean: 2, readme: 1 });
  assert.equal(data.totals.workCommits, 2);
  assert.equal(data.totals.maintenanceCommits, 3);
  assert.equal(data.totals.commits, 5);
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
    JSON.stringify({ ts: at(4), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 500, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    // Dated two days into the future: no bucket exists for it.
    JSON.stringify({ ts: at(-2), loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 9999 }), // retired-name-ok: legacy event field in a fixture
    // ts present but not a number; eventDayKey returns null for it.
    JSON.stringify({ ts: "not-a-timestamp", loop: "bugfix", type: "run_end", run: 3, result: "changed", tokens: 8888 }), // retired-name-ok: legacy event field in a fixture
    // ts omitted entirely.
    JSON.stringify({ loop: "dedupe", type: "run_end", run: 4, result: "changed", tokens: 7777 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 5);
  // Only the in-window, well-timestamped event counts; the others vanish without a trace.
  assert.equal(data.totals.tokensOut, 500);
  assert.equal(data.totals.runs, 1);
  assert.deepEqual(data.series[0]?.runsByRole, { feature: 1 });
  for (const d of data.series) {
    assert.deepEqual(Object.keys(d.runsByRole), d.runsByRole.feature ? ["feature"] : [], `${d.date} carries no phantom roles`);
  }
});

test("collectReport folds merge_done/merge_failed usage into the day and totals, with the merge share named", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "docs", type: "merge_failed", summary: "conflict", tokens: 300, costUsd: 0.01 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 3);
  const today = data.series[2];
  // The day's tokensOut/costUsd include the merge share (the budget charges these same
  // events, so the day series must keep summing to the totals), while the merge fields
  // name the reviewer's part of it: both merge events' tokens/cost, 2 runs.
  assert.equal(today?.tokensOut, 45_600); // 100 run tokens + 45,500 merge tokens
  assert.ok(Math.abs((today?.costUsd ?? -1) - 0.95) < 1e-9);
  assert.equal(today?.mergeRuns, 2);
  assert.equal(today?.mergeTokens, 45_500);
  assert.ok(Math.abs((today?.mergeCostUsd ?? -1) - 0.85) < 1e-9);
  assert.equal(data.totals.mergeRuns, 2);
  assert.equal(data.totals.mergeTokens, 45_500);
  assert.ok(Math.abs(data.totals.mergeCostUsd - 0.85) < 1e-9);
  assert.equal(data.totals.tokensOut, 45_600);
  assert.ok(Math.abs(data.totals.costUsd - 0.95) < 1e-9);
  assert.equal(data.totals.runs, 1);
  assert.equal(data.totals.commits, 1, "merged still counts only as a commit");
  // costByRole stays a runs-only breakdown — the merge line is how the reviewer's share
  // is named, not a role entry.
  assert.ok(Math.abs(Object.values(today?.costByRole ?? {}).reduce((a, b) => a + b, 0) - 0.1) < 1e-9);
  // Merge fields are sparse: a day that folded no merge event carries none.
  assert.ok(data.series.slice(0, 2).every((d) => !("mergeCostUsd" in d)), "no merge keys on merge-free days");
});

test("collectReport reads a grown event log with bounded backwards I/O", () => {
  const root = tmpdir();
  // ~250 KB of out-of-window history (well past the 8 KB whole-read threshold) plus three
  // in-window events: the tail scan must stop at the window, not rescan the file.
  const lines: unknown[] = [];
  for (let i = 0; i < 2500; i++) {
    lines.push(JSON.stringify({ ts: at(40), loop: "feature", type: "run_end", run: i, result: "no_change", tokens: 1 })); // retired-name-ok: legacy event field in a fixture
  }
  lines.push(JSON.stringify({ ts: at(3), loop: "bugfix", type: "merged", commit: "aaa", summary: "old" })); // retired-name-ok: legacy event field in a fixture
  lines.push(JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 9, result: "changed", tokens: 777 })); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, lines);

  const data = collectReport(root, 7);
  assert.equal(data.totals.tokensOut, 777); // the 2500 old runs are out of window
  assert.equal(data.totals.runs, 1);
  assert.equal(data.totals.commits, 1);
  const today = data.series[data.series.length - 1];
  assert.deepEqual(today?.runsByRole, { feature: 1 });
});

test("collectReport does not double-count an event appended between the cache's stat and its read", () => {
  const root = tmpdir();
  const first = JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100 }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [first]);
  const second = JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 50 }); // retired-name-ok: legacy event field in a fixture
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

test("collectReport tallies fixed bugs' Validation gap tags over the window, team-only", () => {
  const root = tmpdir();
  const d0 = dayKey(at(0));
  const d1 = dayKey(at(1));
  const dOld = dayKey(at(10)); // outside the 3-day window
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Fixed",
      body: `### Tagged no-repro (found 2026-09-01, fixed ${d0})

- **Validation gap:** no-repro — the flake never reproduced.

### Tagged no-repro again (found 2026-09-02, fixed ${d1})

**Validation gap:** no-repro — also never reproduced.

### Tagged no-fake (found 2026-09-03, fixed ${d1})

**Validation gap:** no-fake — had to write a shim.

### Untagged in window (found 2026-09-04, fixed ${d1})

**Symptom:** no trace line here.

### Tagged none but out of window (found 2026-09-01, fixed ${dOld})

**Validation gap:** none — the existing suite confirmed it.`,
    },
  ]);

  const team = collectReport(root, 3, undefined);
  assert.deepEqual(team.totals.validationGapsByTag, { "no-repro": 2, "no-fake": 1 });

  // The per-day series carries each day's tags: day d0 recorded one no-repro, day d1
  // recorded a no-repro and a no-fake, the untagged and out-of-window entries reach no day,
  // and the third (untagged) day omits the field (zero-means-absent).
  const dayOf = (date: string) => team.series.find((d) => d.date === date);
  assert.deepEqual(dayOf(d0)?.validationGapsByTag, { "no-repro": 1 });
  assert.deepEqual(dayOf(d1)?.validationGapsByTag, { "no-repro": 1, "no-fake": 1 });
  for (const d of team.series) {
    if (d.date === d0 || d.date === d1) continue;
    assert.ok(!("validationGapsByTag" in (d as object)), "an untagged day omits the field");
  }
  assert.ok(!dayOf(dOld), "the out-of-window entry reaches no day");

  // Role scope drops the tally: a tag has no role — neither the window map nor any series day.
  const scoped = collectReport(root, 3, "bugfix");
  assert.ok(!("validationGapsByTag" in scoped.totals));
  for (const d of scoped.series) assert.ok(!("validationGapsByTag" in (d as object)));

  // A window whose only fixed bug is untagged omits the key (zero-means-absent).
  const root2 = tmpdir();
  writeBacklogFile(root2, "BUGS.md", [
    { heading: "## Fixed", body: `### Untagged only (found 2026-09-01, fixed ${d0})\n\n**Symptom:** nothing.` },
  ]);
  const untagged = collectReport(root2, 3, undefined);
  assert.ok(!("validationGapsByTag" in untagged.totals));
  for (const d of untagged.series) assert.ok(!("validationGapsByTag" in (d as object)));
});

// The per-day filing read folds the same entry detection as the completion read, so an
// entry's opened day (its `planned`/`reported`/`found by` stamp) drives these two fields
// — not its completion stamp, which only the done/fixed read consumes.
test("collectReport counts plans added and bugs filed from backlog filing stamps", () => {
  const root = tmpdir();
  const d1 = dayKey(at(4));
  const d2 = dayKey(at(3));
  const d3 = dayKey(at(2)); // the completion day of the done entries — never a filing day

  writeBacklogFile(root, "PLANS.md", [
    {
      heading: "## Planned",
      body: `### Open plan (planned ${d1})\n\nBody.`,
    },
    {
      heading: "## Done",
      body: `### Closed plan (planned ${d2}, done ${d3})`,
    },
  ]);
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Open",
      body: `### Open bug (found by qa loop ${d1})\n\nBody.`,
    },
    {
      heading: "## Fixed",
      body: `### Fixed bug (reported ${d2}, fixed ${d3})`,
    },
  ]);

  const data = collectReport(root, 5);
  const byDate = new Map(data.series.map((d) => [d.date, d]));

  assert.equal(byDate.get(d1)?.plansAdded, 1); // the open plan
  assert.equal(byDate.get(d2)?.plansAdded, 1); // the done plan's FILING day, not its d3 completion
  assert.equal(byDate.get(d3)?.plansAdded ?? 0, 0);
  assert.equal(byDate.get(d1)?.bugsFiled, 1); // the open bug
  assert.equal(byDate.get(d2)?.bugsFiled, 1); // the fixed bug's filing day
  assert.equal(byDate.get(d3)?.bugsFiled ?? 0, 0);
  assert.equal(data.totals.plansAdded, 2);
  assert.equal(data.totals.bugsFiled, 2);
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
  // its merge commit.
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
  // The flat [^()] match could not span a nested group: "(…; commit abc (re-merged after
  // review fix))" matched only the innermost "(re-merged after review fix)", whose text
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

test("a Fixed heading whose completion is recorded as re-merged counts on that date; an undated fixed mention counts nowhere", () => {
  // The bugfix prompt pins the completion DATE, not the verb: an entry whose first merge was
  // rejected in review is completed by the re-merge, and its epitaph says "re-merged <date>" —
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
  // wrong day — silently, whenever the sibling merged the day before. The completion record is
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
  // <date>") put the entry on the sibling's day, silently, whenever the sibling merged first.
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
    assert.deepEqual(d.runsByRole, {});
    assert.deepEqual(d.costByRole, {});
    assert.equal(d.tokensOut + d.commits + d.costUsd + d.featuresDone + d.bugsFixed, 0);
  }
  assert.deepEqual(data.totals, {
    tokensOut: 0,
    runs: 0,
    commits: 0,
    commitsByRole: {},
    workCommits: 0,
    maintenanceCommits: 0,
    costUsd: 0,
    featuresDone: 0,
    bugsFixed: 0,
    mergeRuns: 0,
    mergeTokens: 0,
    mergeCostUsd: 0,
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
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "run_end", run: 1, result: "no_change", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(6.5 * HOUR), loop: "feature", type: "merged", commit: "old1234", summary: "outside" }), // retired-name-ok: legacy event field in a fixture
    // Inside the window: two runs and one commit.
    JSON.stringify({ ts: ago(HOUR), loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "bugfix", type: "run_end", run: 3, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "merged", commit: "abc1234", summary: "inside" }), // retired-name-ok: legacy event field in a fixture
    // Future-dated: dropped, matching collectReport's day-map guard.
    JSON.stringify({ ts: Date.now() + HOUR, loop: "feature", type: "run_end", run: 4, result: "changed", tokens: 5000, costUsd: 9 }), // retired-name-ok: legacy event field in a fixture
    "this line is not json", // malformed lines are ignored
  ]);
  const data = collectReportSince(root, 6 * HOUR);

  assert.equal(data.sinceMs, 6 * HOUR);
  const cutoffIso = new Date(cutoff).toISOString();
  assert.ok(
    Math.abs(Date.parse(data.fromIso) - Date.parse(cutoffIso)) < 60_000,
    `fromIso ${data.fromIso} is the window's cutoff instant (±1min for test elapsed time)`,
  );
  assert.equal(data.totals.runs, 2);
  assert.equal(data.totals.tokensOut, 100);
  assert.equal(data.totals.commits, 1);
  assert.ok(Math.abs(data.totals.costUsd - 0.1) < 1e-9);
  assert.deepEqual(data.runsByRole, { feature: 1, bugfix: 1 });
  assert.deepEqual(data.costByRole, { feature: 0.1 }, "zero-cost runs leave no cost key");
  assert.equal(data.coversFullWindow, true, "the log's oldest event predates the cutoff");
});

test("collectReportSince folds merge_done/merge_failed usage into the window totals", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(2 * HOUR), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(HOUR), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "docs", type: "merge_failed", summary: "conflict", tokens: 300, costUsd: 0.01 }), // retired-name-ok: legacy event field in a fixture
    // Outside the 6h window: must not count.
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "merge_done", commit: "old1234", summary: "old", tokens: 9_999, costUsd: 9 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReportSince(root, 6 * HOUR);
  assert.equal(data.totals.mergeRuns, 2);
  assert.equal(data.totals.mergeTokens, 45_500);
  assert.ok(Math.abs(data.totals.mergeCostUsd - 0.85) < 1e-9);
  // The surfaced totals include the merge share — the same events the daily budget
  // charges — so the report and the budget header agree.
  assert.equal(data.totals.tokensOut, 45_600);
  assert.ok(Math.abs(data.totals.costUsd - 0.95) < 1e-9);
  assert.equal(data.totals.runs, 1);
});

test("collectReportSince aggregation matches a same-seed collectReport slice", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 321, costUsd: 0.2 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(5 * 60_000), loop: "bugfix", type: "run_end", run: 2, result: "no_change", tokens: 11 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(2 * 60_000), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const since = collectReportSince(root, HOUR);
  assert.equal(since.totals.runs, 2);
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
    assert.equal(day.totals.runs, since.totals.runs);
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
    JSON.stringify({ ts: ago(7 * HOUR), loop: "feature", type: "run_end", run: 1, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(HOUR), loop: "feature", type: "run_end", run: 2, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
  ]);
  assert.equal(collectReportSince(proven, 6 * HOUR).coversFullWindow, true);
  assert.ok(!renderSinceReportMarkdown(collectReportSince(proven, 6 * HOUR)).includes("rotated"));

  // A log born inside the window (a fresh install's first hour): the oldest retained event
  // lies inside the window with no proof older data was not rotated away — the report notes
  // the possible truncation instead of silently presenting a sparse window as complete.
  const truncated = tmpdir();
  writeEvents(truncated, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "run_end", run: 1, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
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
  // A non-finite length is outside the range too, and would slip past both comparisons
  // (`NaN <= 0` and `NaN > MAX` are false): the guard tests finiteness first.
  assert.throws(() => collectReportSince(root, Number.NaN), /\(got NaN\)/);
  assert.throws(() => collectReportSince(root, Number.POSITIVE_INFINITY), /\(got Infinity\)/);
  assert.throws(
    () => collectReportSince(root, REPORT_SINCE_MAX_MS + 1),
    new RegExp(`\\(got ${REPORT_SINCE_MAX_MS + 1}\\)`),
  );
  // The cap itself is a valid window — exactly 7 days ends the legal range (an empty log,
  // so zero totals fall out of the same call).
  const data = collectReportSince(root, REPORT_SINCE_MAX_MS);
  assert.equal(data.sinceMs, REPORT_SINCE_MAX_MS);
  assert.equal(data.totals.runs, 0);
});

test("collectReportSince treats an empty or missing event log as fully covered, not truncated", () => {
  const empty = tmpdir(); // No events.jsonl at all — a fresh directory.
  const data = collectReportSince(empty, 6 * HOUR);
  assert.deepEqual(data.totals, {
    tokensOut: 0,
    runs: 0,
    commits: 0,
    costUsd: 0,
    mergeRuns: 0,
    mergeTokens: 0,
    mergeCostUsd: 0,
  });
  assert.deepEqual(data.runsByRole, {});
  assert.deepEqual(data.costByRole, {});
  assert.equal(data.coversFullWindow, true, "nothing was ever logged, so nothing rotated away");
  const out = renderSinceReportMarkdown(data);
  assert.ok(!out.includes("rotated"), "a missing log must not claim events rotated out");
  assert.match(out, /backlog tallies \(features done \/ bugs fixed \/ plans added \/ bugs filed\) need the day report/);
});

test("collectReport scopes the day series and totals to one role, leaving team cells off", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 500, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 100, costUsd: 0.2 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merged", commit: "abc1234" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "merged", commit: "def5678" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "aaa", tokens: 40, costUsd: 0.4 }), // retired-name-ok: legacy event field in a fixture
  ]);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Done", body: `- A (done ${dayKey(at(0))}; commit 1)` }]);
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Fixed", body: `- B (fixed ${dayKey(at(0))}; commit 2)` }]);

  const scoped = collectReport(root, 5, "feature");
  const today = scoped.series[scoped.series.length - 1];
  assert.equal(scoped.role, "feature");
  assert.equal(today?.tokensOut, 500, "only feature's run tokens; not bugfix's or the merge share");
  assert.deepEqual(today?.runsByRole, { feature: 1 });
  assert.deepEqual(today?.costByRole, { feature: 0.5 });
  assert.equal(today?.commits, 1);
  assert.deepEqual(today?.commitsByRole, { feature: 1 });
  assert.equal(today?.workCommits, 1);
  assert.equal(today?.maintenanceCommits, 0);
  assert.ok(Math.abs((today?.costUsd ?? -1) - 0.5) < 1e-9);
  assert.equal(today?.mergeRuns, undefined, "merge fields stay off the scoped series");
  assert.equal(today?.featuresDone, 0);
  assert.equal(today?.bugsFixed, 0);
  assert.equal(today?.plansAdded, undefined); // role scope leaves the filing tallies absent
  assert.equal(today?.bugsFiled, undefined);
  assert.equal(scoped.totals.tokensOut, 500);
  assert.equal(scoped.totals.runs, 1);
  assert.equal(scoped.totals.commits, 1);
  assert.ok(Math.abs(scoped.totals.costUsd - 0.5) < 1e-9);
  assert.equal(scoped.totals.featuresDone, 0);
  assert.equal(scoped.totals.bugsFixed, 0);
  assert.equal(scoped.totals.plansAdded, undefined);
  assert.equal(scoped.totals.bugsFiled, undefined);
  assert.equal(scoped.totals.mergeRuns, 0);

  // The same fixture without a role totals every role and reads the day-granular backlog tallies.
  const team = collectReport(root, 5);
  assert.equal(team.role, undefined);
  assert.equal(team.totals.tokensOut, 640); // 500 + 100 + the 40 merge tokens
  assert.equal(team.totals.runs, 2);
  assert.equal(team.totals.commits, 2);
  assert.ok(Math.abs(team.totals.costUsd - 1.1) < 1e-9);
  assert.equal(team.totals.featuresDone, 1);
  assert.equal(team.totals.bugsFixed, 1);
  assert.equal(team.totals.mergeRuns, 1);
});

test("collectReport scopes an instance id to its base role, aggregating its siblings' usage", () => {
  const root = tmpdir();
  // The day collector buckets by local calendar day while the --since collector drops
  // future-dated timestamps, so each anchor alone fails at one end of the clock: a bare
  // `ago(...)` lands in yesterday's bucket on a run just after midnight, and a bare `at(0)`
  // (noon) is future-dated before noon. The later of the two is always in today's bucket and
  // inside the HOUR window below — the case this fixture tests.
  const recent = (ms: number): number => Math.max(ago(ms), at(0, 0));
  writeEvents(root, [
    JSON.stringify({ ts: recent(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: recent(9 * 60_000), loop: "feature-2", type: "run_end", run: 1, result: "changed", tokens: 300, costUsd: 0.3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: recent(8 * 60_000), loop: "feature-2", type: "merged", commit: "abc1234" }), // retired-name-ok: legacy event field in a fixture
  ]);

  // The scope normalizes to the base role, so the instance's usage and its sibling's commits
  // both count — the same group the base-role cap reads (objection: exact-id vs base-role mix).
  const scoped = collectReport(root, 2, "feature-2");
  assert.equal(scoped.role, "feature");
  const today = scoped.series[scoped.series.length - 1];
  assert.equal(today?.tokensOut, 400);
  assert.deepEqual(today?.runsByRole, { feature: 2 });
  assert.ok(Math.abs((today?.costByRole.feature ?? -1) - 0.4) < 1e-9);
  assert.equal(today?.commits, 1);
  assert.deepEqual(today?.commitsByRole, { feature: 1 });
  assert.equal(scoped.totals.tokensOut, 400);
  assert.equal(scoped.totals.runs, 2);
  assert.equal(scoped.totals.commits, 1);
  assert.ok(Math.abs(scoped.totals.costUsd - 0.4) < 1e-9);

  const since = collectReportSince(root, HOUR, "feature-2");
  assert.equal(since.role, "feature");
  assert.equal(since.totals.tokensOut, 400);
  assert.equal(since.totals.runs, 2);
  assert.equal(since.totals.commits, 1);
  assert.ok(Math.abs(since.totals.costUsd - 0.4) < 1e-9);
  assert.deepEqual(since.runsByRole, { feature: 2 });
  assert.ok(Math.abs((since.costByRole.feature ?? -1) - 0.4) < 1e-9);
});

test("collectReportSince scopes a trailing window to one role, excluding the merge share", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 500, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(9 * 60_000), loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 100, costUsd: 0.2 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(8 * 60_000), loop: "feature", type: "merged", commit: "abc1234" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(7 * 60_000), loop: "clean", type: "merged", commit: "def5678" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(6 * 60_000), loop: "feature", type: "merge_done", commit: "aaa", tokens: 40, costUsd: 0.4 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const scoped = collectReportSince(root, HOUR, "feature");
  assert.equal(scoped.role, "feature");
  assert.deepEqual(scoped.totals, {
    tokensOut: 500,
    runs: 1,
    commits: 1,
    costUsd: 0.5,
    mergeRuns: 0,
    mergeTokens: 0,
    mergeCostUsd: 0,
  });
  assert.deepEqual(scoped.runsByRole, { feature: 1 });
  assert.deepEqual(scoped.costByRole, { feature: 0.5 });

  const team = collectReportSince(root, HOUR);
  assert.equal(team.role, undefined);
  assert.equal(team.totals.tokensOut, 640);
  assert.equal(team.totals.runs, 2);
  assert.equal(team.totals.commits, 2);
  assert.ok(Math.abs(team.totals.costUsd - 1.1) < 1e-9);
});

// The claude billing split (plans/agent-backends.md part 6a): a subscription run's cost is
// API-equivalent notional spend, summed on its own line and never in the budgeted totals.
test("subscription runs total as notional spend, never in the cost totals", () => {
  const root = tmpdir();
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push(
      JSON.stringify({
        ts: at(0),
        loop: "feature", // retired-name-ok: legacy event field in a fixture
        type: "run_end",
        run: i + 1,
        result: "changed",
        notionalCostUsd: 3,
        billing: "subscription",
      }),
    );
  }
  writeEvents(root, lines);

  const data = collectReport(root, 1);
  assert.equal(data.totals.notionalCostUsd, 30, "ten $3 subscription runs");
  assert.equal(data.totals.costUsd, 0, "against the cap");
  assert.equal(data.series[data.series.length - 1]?.notionalCostUsd, 30);
  assert.match(renderReportMarkdown(data), /claude subscription, API-equivalent: \$30\.00 estimated/);
});

test("collectReport carries notionalByRole per role id and narrows it for a role scope", () => {
  const root = tmpdir();
  const run = (loop: string, n: number) => // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop, type: "run_end", run: n, result: "changed", notionalCostUsd: 2, billing: "subscription" }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [run("feature", 1), run("feature-2", 2), run("plan", 3)]);
  const day = collectReport(root, 1).series[0];
  assert.deepEqual(day?.notionalByRole, { feature: 2, "feature-2": 2, plan: 2 });
  assert.deepEqual(collectReport(root, 1, "feature").series[0]?.notionalByRole, { feature: 4 });
  const empty = tmpdir();
  writeEvents(empty, [JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed" })]); // retired-name-ok: legacy event field in a fixture
  assert.equal("notionalByRole" in (collectReport(empty, 1).series[0] ?? {}), false);
});

// A subscription merge's API-equivalent spend joins the notional line, while only the real
// share reaches the budgeted cost totals (plans/agent-backends.md part 6a).
test("a subscription merge's spend is notional, never in the cost totals", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc", tokens: 40, costUsd: 0.5, notionalCostUsd: 2 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const data = collectReport(root, 1);
  assert.equal(data.totals.costUsd, 0.5, "only the real share is budgeted");
  assert.equal(data.totals.mergeCostUsd, 0.5);
  assert.equal(data.totals.notionalCostUsd, 2);
  assert.equal(data.series[data.series.length - 1]?.costUsd, 0.5);
  assert.equal(data.series[data.series.length - 1]?.notionalCostUsd, 2);
  assert.match(renderReportMarkdown(data), /claude subscription, API-equivalent: \$2\.00 estimated/);
});

// Role scoping carries a role's OWN notional spend (its run_end events), so `report --role`
// does not misreport a subscription role as $0; the merge slot's notional stays team-wide
// and omitted, exactly like its real cost (plans/agent-backends.md part 6a).
test("collectReport scopes notional spend to the role, like cost", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", notionalCostUsd: 3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 1, result: "changed", notionalCostUsd: 5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const scoped = collectReport(root, 1, "feature");
  assert.equal(scoped.totals.notionalCostUsd, 3, "the feature loop's own notional spend");
  assert.equal(scoped.totals.costUsd, 0);
  assert.equal(scoped.series[scoped.series.length - 1]?.notionalCostUsd, 3);

  const team = collectReport(root, 1);
  assert.equal(team.totals.notionalCostUsd, 8, "the team report sums both roles");
});

test("collectReportSince scopes notional spend to the role, like cost", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", notionalCostUsd: 3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(9 * 60_000), loop: "bugfix", type: "run_end", run: 1, result: "changed", notionalCostUsd: 5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const scoped = collectReportSince(root, HOUR, "feature");
  assert.equal(scoped.totals.notionalCostUsd, 3);
  assert.equal(scoped.totals.costUsd, 0);
});

test("collectReport and collectReportSince count model_fallback_started per role, zero meaning absent", () => {
  const root = tmpdir();
  const started = (ts: number, loop: string) => JSON.stringify({ ts, loop, type: "model_fallback_started" }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    started(todayTs(), "feature"),
    started(todayTs(), "feature"),
    started(todayTs(), "qa"),
    started(at(1), "feature-2"),
    JSON.stringify({ ts: todayTs(), loop: "bugfix", type: "model_fallback_ended", durationMs: 5000 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(2), loop: "feature", type: "run_end", run: 1, result: "no_change", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 3);
  assert.ok(!("fallbacksByRole" in (data.series[0] ?? {})), "a day with none carries no key");
  assert.deepEqual(data.series[1]?.fallbacksByRole, { "feature-2": 1 }, "yesterday");
  assert.deepEqual(data.series[2]?.fallbacksByRole, { feature: 2, qa: 1 }, "today; model_fallback_ended adds nothing");
  assert.match(renderReportMarkdown(data), /\*\*Fallbacks by role:\*\* feature — 2 · feature-2 — 1 · qa — 1/);

  const since = collectReportSince(root, 3 * 24 * HOUR);
  assert.deepEqual(since.fallbacksByRole, { feature: 2, "feature-2": 1, qa: 1 });
  assert.match(renderSinceReportMarkdown(since), /\*\*Fallbacks by role:\*\* feature — 2 · feature-2 — 1 · qa — 1/);
  assert.deepEqual(collectReportSince(root, 3 * 24 * HOUR, "feature").fallbacksByRole, { feature: 3 }, "feature-2 folds into feature");
  assert.match(renderReportMarkdown(collectReport(tmpdir(), 2)), /\*\*Fallbacks by role:\*\* -/);
});

test("collectReport and collectReportSince count image_reroute per role, zero meaning absent", () => {
  const root = tmpdir();
  const reroute = (ts: number, loop: string, preflight: boolean) => // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts, loop, type: "image_reroute", preflight }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    reroute(todayTs(), "feature", true),
    reroute(todayTs(), "feature", false),
    reroute(todayTs(), "qa", true),
    reroute(at(1), "feature-2", false),
    JSON.stringify({ ts: todayTs(), loop: "bugfix", type: "image_blind" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "bugfix", type: "model_fallback_started" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(2), loop: "feature", type: "run_end", run: 1, result: "no_change", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 3);
  assert.ok(!("imageReroutesByRole" in (data.series[0] ?? {})), "a day with none carries no key");
  assert.deepEqual(data.series[1]?.imageReroutesByRole, { "feature-2": 1 }, "yesterday");
  assert.deepEqual(data.series[2]?.imageReroutesByRole, { feature: 2, qa: 1 }, "today; image_blind and fallbacks add nothing");
  assert.match(renderReportMarkdown(data), /\*\*Image reroutes by role:\*\* feature — 2 · feature-2 — 1 · qa — 1/);

  const since = collectReportSince(root, 3 * 24 * HOUR);
  assert.deepEqual(since.imageReroutesByRole, { feature: 2, "feature-2": 1, qa: 1 });
  assert.match(renderSinceReportMarkdown(since), /\*\*Image reroutes by role:\*\* feature — 2 · feature-2 — 1 · qa — 1/);
  assert.deepEqual(collectReportSince(root, 3 * 24 * HOUR, "feature").imageReroutesByRole, { feature: 3 }, "feature-2 folds into feature");
  assert.match(renderReportMarkdown(collectReport(tmpdir(), 2)), /\*\*Image reroutes by role:\*\* -/);
});

test("collectReport gives each day the lower median of its passing full-suite checks, team scope only", () => {
  const root = tmpdir();
  const check = (status: string, scope: string, durationMs: number) =>
    JSON.stringify({ ts: at(0), loop: "lander", type: "build_check", status, scope, durationMs }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    check("passed", "merge", 60_000),
    check("passed", "batch", 120_000),
    check("passed", "baseline", 90_000),
    check("passed", "gate", 5_000), // a gate check can run a subset of the suite
    check("failed", "merge", 1_000),
  ]);
  const data = collectReport(root, 2);
  assert.equal(data.series[1]!.checkMedianMs, 90_000);
  assert.ok(!("checkMedianMs" in data.series[0]!));
  for (const d of collectReport(root, 2, "feature").series) assert.ok(!("checkMedianMs" in d));
});

test("collectReport counts each day's red full-suite merge checks, team scope only", () => {
  const root = tmpdir();
  const check = (status: string, scope: string) =>
    JSON.stringify({ ts: at(0), loop: "lander", type: "build_check", status, scope }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    check("failed", "merge"),
    check("failed", "batch"),
    check("failed", "baseline"),
    check("failed", "gate"), // a gate check can run a subset of the suite
    check("passed", "merge"),
  ]);
  const data = collectReport(root, 2);
  assert.equal(data.series[1]!.checkFailures, 3);
  assert.ok(!("checkFailures" in data.series[0]!));
  const passing = tmpdir();
  writeEvents(passing, [check("passed", "merge")]);
  assert.ok(!("checkFailures" in collectReport(passing, 2).series[1]!));
  for (const d of collectReport(root, 2, "feature").series) assert.ok(!("checkFailures" in d));
});

test("collectReport gives each day the lower median of its merge_done queuedMs, team scope only", () => {
  const root = tmpdir();
  const ev = (ts: number, type: string, extra: Record<string, unknown>) =>
    JSON.stringify({ ts, loop: "feature", type, summary: "x", ...extra }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    ev(at(0), "merge_done", { queuedMs: 60_000 }),
    ev(at(0), "merge_done", { queuedMs: 300_000 }),
    ev(at(0), "merge_done", { queuedMs: 120_000 }),
    ev(at(0), "merge_done", {}), // logged before queuedMs existed: skipped, not counted as zero
    ev(at(0), "merge_failed", { queuedMs: 9_000_000 }), // a failed merge's wait is not a merge wait
    ev(at(2), "merge_failed", { queuedMs: 5_000 }),
  ]);
  const data = collectReport(root, 3);
  assert.equal(data.series[2]!.mergeWaitMedianMs, 120_000);
  assert.ok(!("mergeWaitMedianMs" in data.series[1]!));
  assert.ok(!("mergeWaitMedianMs" in data.series[0]!), "a day with only a merge_failed has none");
  for (const d of collectReport(root, 3, "feature").series) assert.ok(!("mergeWaitMedianMs" in d));
});

test("collectReport gives each day the lower median of its provider_wait waitedMs, team scope only", () => {
  const root = tmpdir();
  const ev = (ts: number, type: string, extra: Record<string, unknown>) =>
    JSON.stringify({ ts, loop: "feature", type, summary: "x", ...extra }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    ev(at(0), "provider_wait", { waitedMs: 40_000 }),
    ev(at(0), "provider_wait", { waitedMs: 200_000 }),
    ev(at(0), "provider_wait", {}), // logged before waitedMs existed: skipped, not counted as zero
    ev(at(1), "provider_wait", { waitedMs: 0 }), // a zero wait is not a provider-slot wait
    ev(at(2), "merge_done", { queuedMs: 5_000 }), // a merge wait is not a provider wait
  ]);
  const data = collectReport(root, 3);
  assert.equal(data.series[2]!.providerWaitMedianMs, 40_000);
  assert.ok(!("providerWaitMedianMs" in data.series[1]!), "a day whose only wait is 0 ms has none");
  assert.ok(!("providerWaitMedianMs" in data.series[0]!), "a day with no provider_wait has none");
  for (const d of collectReport(root, 3, "feature").series) assert.ok(!("providerWaitMedianMs" in d));
});

test("collectReport gives each day the lower median of its slot_wait waitedMs, team scope only", () => {
  const root = tmpdir();
  const ev = (ts: number, type: string, extra: Record<string, unknown>) =>
    JSON.stringify({ ts, loop: "feature", type, summary: "x", ...extra }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    ev(at(0), "slot_wait", { waitedMs: 40_000 }),
    ev(at(0), "slot_wait", { waitedMs: 200_000 }),
    ev(at(1), "slot_wait", {}), // logged before waitedMs existed: skipped, not counted as zero
    ev(at(1), "slot_wait", { waitedMs: 0 }), // a zero wait is not a workspace-slot wait
    ev(at(2), "provider_wait", { waitedMs: 50_000 }), // a provider wait is not a workspace wait
  ]);
  const data = collectReport(root, 3);
  assert.equal(data.series[2]!.slotWaitMedianMs, 40_000);
  assert.ok(!("slotWaitMedianMs" in data.series[1]!), "a day whose only wait is 0 ms has none");
  assert.ok(!("slotWaitMedianMs" in data.series[0]!), "a day with only a provider_wait has none");
  for (const d of collectReport(root, 3, "feature").series) assert.ok(!("slotWaitMedianMs" in d));
});

test("collectReport gives each day the lower median of its check_wait waitedMs, team scope only", () => {
  const root = tmpdir();
  const ev = (ts: number, type: string, extra: Record<string, unknown>) =>
    JSON.stringify({ ts, loop: "feature", type, summary: "x", ...extra }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    ev(at(0), "check_wait", { waitedMs: 40_000 }),
    ev(at(0), "check_wait", { waitedMs: 200_000 }),
    ev(at(1), "check_wait", {}), // no waitedMs: skipped, not counted as zero
    ev(at(1), "check_wait", { waitedMs: 0 }), // a zero wait is not a check-slot wait
    ev(at(2), "slot_wait", { waitedMs: 50_000 }), // a workspace wait is not a check wait
  ]);
  const data = collectReport(root, 3);
  assert.equal(data.series[2]!.checkWaitMedianMs, 40_000);
  assert.ok(!("checkWaitMedianMs" in data.series[1]!), "a day whose only waits are 0 ms or unmeasured has none");
  assert.ok(!("checkWaitMedianMs" in data.series[0]!), "a day with only a slot_wait has none");
  assert.ok(!("slotWaitMedianMs" in data.series[2]!), "a check_wait does not feed the slot-wait median");
  assert.equal(data.series[0]!.slotWaitMedianMs, 50_000);
  for (const d of collectReport(root, 3, "feature").series) assert.ok(!("checkWaitMedianMs" in d));
});

test("collectReport and collectReportSince tally run_start per model, zero meaning absent, team scope only", () => {
  const start = (ts: number, model?: string) =>
    JSON.stringify({ ts, loop: "feature", type: "run_start", run: 1, ...(model === undefined ? {} : { model }) }); // retired-name-ok: legacy event field in a fixture
  const root = tmpdir();
  writeEvents(root, [
    start(todayTs(), "acme/m1"),
    start(todayTs(), "acme/m2"),
    start(todayTs(), "acme/m1"),
    start(todayTs()), // no configured model: contributes no key
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 3);
  assert.deepEqual(data.series[2]?.runsByModel, { "acme/m1": 2, "acme/m2": 1 }, "counts modelled starts, skips the model-less one");
  assert.ok(!("runsByModel" in (data.series[0] ?? {})), "a day with no modelled start omits the field");

  const since = collectReportSince(root, 3 * 24 * HOUR);
  assert.deepEqual(since.runsByModel, { "acme/m1": 2, "acme/m2": 1 }, "--since carries the same map");
  // Renders name the tally, count desc then name asc, team report only.
  assert.match(renderReportMarkdown(data), /\*\*Runs by model:\*\* acme\/m1 — 2 · acme\/m2 — 1/);
  assert.match(renderSinceReportMarkdown(since), /\*\*Runs by model:\*\* acme\/m1 — 2 · acme\/m2 — 1/);
  assert.doesNotMatch(renderReportMarkdown(collectReport(root, 3, "feature")), /\*\*Runs by model:/, "a scoped day report omits it");
  assert.doesNotMatch(renderSinceReportMarkdown(collectReportSince(root, 3 * 24 * HOUR, "feature")), /\*\*Runs by model:/, "a scoped --since report omits it");

  // Team-only: a model is not a role, so a role-scoped report carries no runsByModel.
  assert.deepEqual(collectReportSince(root, 3 * 24 * HOUR, "feature").runsByModel, {}, "scoped window carries an empty map");
  const scoped = collectReport(root, 3, "feature");
  assert.ok(!("runsByModel" in (scoped.series[2] ?? {})), "scoped day omits the field");

  // A log with no modelled start: the team day omits the field and --since returns an empty map.
  const plain = tmpdir();
  writeEvents(plain, [start(todayTs())]);
  assert.ok(!("runsByModel" in collectReport(plain, 2).series[0]!), "a model-less team day omits the field");
  assert.deepEqual(collectReportSince(plain, 2 * 24 * HOUR).runsByModel, {});
  // Zero-means-absent at the render: no modelled start prints no Runs by model line.
  assert.doesNotMatch(renderReportMarkdown(collectReport(plain, 2)), /\*\*Runs by model:/);
  assert.doesNotMatch(renderSinceReportMarkdown(collectReportSince(plain, 2 * 24 * HOUR)), /\*\*Runs by model:/);
});

test("collectReport and collectReportSince tally merge_failed by reason, zero meaning absent, team scope only", () => {
  const failed = (ts: number, result?: string) =>
    JSON.stringify({ ts, loop: "feature", type: "merge_failed", run: 1, ...(result === undefined ? {} : { result }) }); // retired-name-ok: legacy event field in a fixture
  const root = tmpdir();
  writeEvents(root, [
    failed(todayTs(), "rejected"),
    failed(todayTs(), "rejected"),
    failed(todayTs(), "merge_conflict"),
    failed(todayTs()), // legacy event with no result: folds under unknown
    failed(at(1), "merge_blocked"),
  ]);
  const data = collectReport(root, 3);
  assert.deepEqual(
    data.series[2]?.mergeFailedByReason,
    { rejected: 2, merge_conflict: 1, unknown: 1 },
    "bucket by result, folding a result-less event under unknown",
  );
  assert.deepEqual(data.series[1]?.mergeFailedByReason, { merge_blocked: 1 }, "another day's failures carry their own map");
  assert.ok(!("mergeFailedByReason" in (data.series[0] ?? {})), "a failure-free day omits the field");
  // Each day's reason buckets sum to its mergeFailed.
  const today = data.series[2]!;
  assert.equal(Object.values(today.mergeFailedByReason ?? {}).reduce((a, b) => a + b, 0), today.mergeFailed, "the reason buckets sum to mergeFailed");

  const since = collectReportSince(root, 3 * 24 * HOUR);
  assert.deepEqual(since.mergeFailedByReason, { rejected: 2, merge_conflict: 1, unknown: 1, merge_blocked: 1 }, "--since carries the same window map");
  // Renders name the tally, count desc then code asc, team report only.
  assert.match(renderReportMarkdown(data), /\*\*Merge failures by reason:\*\* rejected — 2 · merge_blocked — 1 · merge_conflict — 1 · unknown — 1/);
  assert.match(renderSinceReportMarkdown(since), /\*\*Merge failures by reason:\*\* rejected — 2 · merge_blocked — 1 · merge_conflict — 1 · unknown — 1/);
  assert.doesNotMatch(renderReportMarkdown(collectReport(root, 3, "feature")), /\*\*Merge failures by reason:/, "a scoped day report omits it");
  assert.doesNotMatch(renderSinceReportMarkdown(collectReportSince(root, 3 * 24 * HOUR, "feature")), /\*\*Merge failures by reason:/, "a scoped --since report omits it");

  // Team-only: a reason code is not a role, so a role-scoped report carries no map.
  assert.deepEqual(collectReportSince(root, 3 * 24 * HOUR, "feature").mergeFailedByReason, {}, "scoped window carries an empty map");
  const scoped = collectReport(root, 3, "feature");
  assert.ok(!("mergeFailedByReason" in (scoped.series[2] ?? {})), "scoped day omits the field");

  // A log with no merge_failed: the team day omits the field and --since returns an empty map.
  const plain = tmpdir();
  writeEvents(plain, [JSON.stringify({ ts: todayTs(), loop: "feature", type: "run_end", run: 1, result: "changed" })]); // retired-name-ok: legacy event field in a fixture
  assert.ok(!("mergeFailedByReason" in collectReport(plain, 2).series[0]!), "a failure-free team day omits the field");
  assert.deepEqual(collectReportSince(plain, 2 * 24 * HOUR).mergeFailedByReason, {});
});

test("collectReport and collectReportSince tally run_deferred by reason, zero meaning absent, team scope only", () => {
  const deferred = (ts: number, reason?: string) =>
    JSON.stringify({ ts, loop: "feature", type: "run_deferred", run: 1, ...(reason === undefined ? {} : { reason }) }); // retired-name-ok: legacy event field in a fixture
  const root = tmpdir();
  writeEvents(root, [
    deferred(todayTs(), "backlog"),
    deferred(todayTs(), "no-work"),
    deferred(todayTs(), "backlog"),
    deferred(todayTs()), // no reason: folds as no-work, matching deferredReasonText's fallback
    JSON.stringify({ ts: at(1), loop: "feature", type: "run_deferred", reason: "plans-full" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectReport(root, 3);
  assert.deepEqual(data.series[2]?.deferredByReason, { backlog: 2, "no-work": 2 }, "counts reasons and folds the reason-less one into no-work");
  assert.deepEqual(data.series[1]?.deferredByReason, { "plans-full": 1 }, "the plans-full day carries its own map");
  assert.ok(!("deferredByReason" in (data.series[0] ?? {})), "a day with no deferral omits the field");

  const since = collectReportSince(root, 3 * 24 * HOUR);
  assert.deepEqual(since.deferredByReason, { backlog: 2, "no-work": 2, "plans-full": 1 }, "--since carries the same window map");
  // Renders name the tally, count desc then name asc, team report only.
  assert.match(renderReportMarkdown(data), /\*\*Deferred runs by reason:\*\* backlog — 2 · no-work — 2 · plans-full — 1/);
  assert.match(renderSinceReportMarkdown(since), /\*\*Deferred runs by reason:\*\* backlog — 2 · no-work — 2 · plans-full — 1/);
  assert.doesNotMatch(renderReportMarkdown(collectReport(root, 3, "feature")), /\*\*Deferred runs by reason:/, "a scoped day report omits it");
  assert.doesNotMatch(renderSinceReportMarkdown(collectReportSince(root, 3 * 24 * HOUR, "feature")), /\*\*Deferred runs by reason:/, "a scoped --since report omits it");

  // Team-only: a reason is not a role, so a role-scoped report carries nothing.
  assert.ok(!("deferredByReason" in collectReportSince(root, 3 * 24 * HOUR, "feature")), "scoped window omits the field");
  const scoped = collectReport(root, 3, "feature");
  assert.ok(!("deferredByReason" in (scoped.series[2] ?? {})), "scoped day omits the field");

  // A deferral-free window: no run_deferred at all, so the team day and --since omit the
  // field and print no line.
  const plain = tmpdir();
  writeEvents(plain, [JSON.stringify({ ts: todayTs(), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 1 })]); // retired-name-ok: legacy event field in a fixture
  assert.ok(!("deferredByReason" in collectReport(plain, 2).series[0]!), "a deferral-free team day omits the field");
  assert.ok(!("deferredByReason" in collectReportSince(plain, 2 * 24 * HOUR)), "a deferral-free --since omits the field");
  assert.doesNotMatch(renderReportMarkdown(collectReport(plain, 2)), /\*\*Deferred runs by reason:/);
  assert.doesNotMatch(renderSinceReportMarkdown(collectReportSince(plain, 2 * 24 * HOUR)), /\*\*Deferred runs by reason:/);
});
