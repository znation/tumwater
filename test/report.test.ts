import test from "node:test";
import assert from "node:assert/strict";
import { collectReport, collectReportSince, type ReportData } from "../src/report-data.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "../src/ui/report.js";
import { REPORT_SINCE_MAX_MS } from "../src/event-window.js";
import { atLocalTs as at, dayKey } from "./oracles.js";
import { writeEvents } from "./log-fixtures.js";
import { makeRepo, tmpdir, writeBacklogFile } from "./repo-fixtures.js";
import { cli, runCli } from "./cli-harness.js";

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

test("renderReportMarkdown pins the header, totals, table shape, and role line", () => {
  const from = "2026-09-08";
  const to = "2026-09-10";
  const data: ReportData = {
    days: 3,
    from,
    to,
    series: [
      { date: "2026-09-08", tokensOut: 0, ticksByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-09", tokensOut: 600_000, ticksByRole: { feature: 3, bugfix: 1 }, costByRole: {}, commits: 2, costUsd: 0.86, featuresDone: 1, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 1_234_567, ticksByRole: { feature: 2 }, costByRole: {}, commits: 1, costUsd: 1.48, featuresDone: 0, bugsFixed: 1 },
    ],
    totals: { tokensOut: 1_834_567, ticks: 6, commits: 3, costUsd: 2.34, featuresDone: 1, bugsFixed: 1, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };
  const lines = renderReportMarkdown(data).split("\n");

  assert.equal(lines[0], "# tumwater usage report");
  assert.equal(lines[1], "");
  assert.equal(lines[2], `Window: ${from} → ${to} (3 days) · source: events.jsonl (rotated at 16 MB)`);
  assert.equal(lines[3], "");
  assert.equal(
    lines[4],
    "**Totals:** 1.8M output tokens · 6 ticks · 3 commits · $2.34 · 1 features done · 1 bugs fixed",
  );
  assert.equal(lines[5], "");
  assert.equal(lines[6], "| day | tokens out | ticks | commits | cost |");
  assert.equal(lines[7], "| --- | ---: | ---: | ---: | ---: |");
  // Zero day: no bar, token count as-is.
  assert.equal(lines[8], `| 09-08 | 0 | 0 | 0 | $0.00 |`);
  // Middle day: one decimal + k suffix; bar = round(20·600000/1234567) = 10 blocks.
  assert.equal(lines[9], `| 09-09 | 600.0k ${"█".repeat(10)} | 4 | 2 | $0.86 |`);
  // Max day: exactly 20 blocks; M suffix above a million.
  assert.equal(lines[10], `| 09-10 | 1.2M ${"█".repeat(20)} | 2 | 1 | $1.48 |`);
  assert.equal(lines[11], "");
  // Window totals per role: feature 3+2=5 before bugfix 1 (count desc); the cost line under
  // it renders "-" — no role in this fixture carries spend.
  assert.equal(lines[12], "**Ticks by role:** feature — 5 · bugfix — 1");
  assert.equal(lines[13], "**Cost by role:** -");
});

test("renderReportMarkdown shows the landing line under Totals only when landing ran", () => {
  const base = collectReport(tmpdir(), 2);
  // Zero landing runs: the line is omitted entirely, so a fleet with no landing spend
  // renders byte-identically to the pre-landing-line shape.
  assert.ok(!renderReportMarkdown(base).includes("landing runs"));
  const data: ReportData = {
    ...base,
    totals: { ...base.totals, tokensOut: 45_500, costUsd: 0.95, landingRuns: 12, landingTokens: 45_200, landingCostUsd: 0.84 },
  };
  assert.match(
    renderReportMarkdown(data),
    /of which landing runs: 12 runs · 45\.2k tokens · \$0\.84 \(reviewer \+ conflict resolution\)/,
  );
});

test("renderReportMarkdown renders token counts through the shared compactTokens rule", () => {
  const data: ReportData = {
    days: 1,
    from: "2026-09-10",
    to: "2026-09-10",
    series: [
      { date: "2026-09-10", tokensOut: 1_500, ticksByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 1_500, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };
  const md = renderReportMarkdown(data);
  // compactTokens leaves values below 10k bare (the report's old private copy suffixed them at
  // 1k); pin the shared rule so the table and totals cannot drift from the status table again.
  assert.match(md, /\| 09-10 \| 1500 █{20} \| 0 \| 0 \| \$0\.00 \|/);
  assert.match(md, /\*\*Totals:\*\* 1500 output tokens/);
});

test("renderReportMarkdown shows a one-day window as one whole day, matching the failure digest", () => {
  const data: ReportData = {
    days: 1,
    from: "2026-09-10",
    to: "2026-09-10",
    series: [
      { date: "2026-09-10", tokensOut: 0, ticksByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(data), /^Window: 2026-09-10 → 2026-09-10 \(1 day\) · source: events\.jsonl \(rotated at 16 MB\)$/m);
});

test("renderReportMarkdown shows no bars for an all-zero window and min width 1 above zero", () => {
  const data = collectReport(tmpdir(), 3); // every source missing → all zeros
  const md = renderReportMarkdown(data);
  assert.ok(!md.includes("█"), "no bars when every day is zero");
  for (const d of data.series) {
    assert.match(md, new RegExp(`\\| ${d.date.slice(5)} \\| 0 \\| 0 \\| 0 \\| \\$0\\.00 \\|`));
  }
  assert.match(md, /\*\*Ticks by role:\*\* -/);

  // <1000 renders as-is; a nonzero day below the max still gets one block (min width).
  const tweaked: ReportData = {
    ...data,
    series: data.series.map((d) => ({
      ...d,
      tokensOut: d.date === data.to ? 999 : d.date === data.from ? 1 : 0,
    })),
    totals: { ...data.totals, tokensOut: 1000 },
  };
  const md2 = renderReportMarkdown(tweaked);
  assert.match(md2, new RegExp(`\\| ${data.to.slice(5)} \\| 999 ${"█".repeat(20)} \\|`));
  assert.match(md2, new RegExp(`\\| ${data.from.slice(5)} \\| 1 █ \\|`));
});

test("renderReportMarkdown orders the role line by count desc then name asc", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      { date: base.from, tokensOut: 0, ticksByRole: { zeta: 5, alpha: 5 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, ticksByRole: { beta: 2 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, ticks: 12 },
  };
  assert.match(renderReportMarkdown(data), /\*\*Ticks by role:\*\* alpha — 5 · zeta — 5 · beta — 2/);
});

test("renderReportMarkdown prints a Cost by role line ranked by spend desc then name asc", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      { date: base.from, tokensOut: 0, ticksByRole: { feature: 3, zeta: 1 }, costByRole: { feature: 0.3 }, commits: 0, costUsd: 0.3, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, ticksByRole: { bugfix: 1 }, costByRole: { alpha: 0.9, bugfix: 0.9, feature: 0 }, commits: 0, costUsd: 1.8, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, ticks: 5, costUsd: 2.1 },
  };
  const md = renderReportMarkdown(data);
  // Ranked by spend (the two $0.90 roles first), not by tick count — feature leads the ticks
  // line with 3 ticks but sits last on the cost line; equal spend breaks by name asc (alpha
  // before bugfix). zeta has ticks but no spend, and feature's $0 entry: both omitted.
  assert.match(md, /\*\*Cost by role:\*\* alpha — \$0\.90 · bugfix — \$0\.90 · feature — \$0\.30/);
  assert.match(md, /\*\*Ticks by role:\*\* feature — 3 · bugfix — 1 · zeta — 1/);
  // The window's role split sums exactly to the Totals cost (both sourced from tick_end alone).
  assert.match(md, /\*\*Totals:\*\* 0 output tokens · 5 ticks · 0 commits · \$2\.10 ·/);
});

// This file's assertions match combined stdout+stderr via the shared runCli bridge; a few
// assertions need the streams apart, so those call cli-harness's cli() directly.

test("tumwater report prints the Markdown report and validates --days", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(3), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 313 }),
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 2, result: "changed", tokens: 42 }),
  ]);
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned" },
    { heading: "## Done", body: `- Epitaph (planned 2026-09-01, done ${dayKey(at(0))}; commit abc)` },
  ]);

  const full = await runCli(root, "report");
  assert.equal(full.code, 0);
  assert.match(full.out, /^# tumwater usage report/m);
  assert.match(full.out, /\(14 days\)/); // default window
  assert.match(full.out, /355 output tokens/); // 313 + 42 in the totals line
  assert.match(full.out, /1 features done/);

  const one = await runCli(root, "report", "--days", "1");
  assert.equal(one.code, 0);
  assert.match(one.out, new RegExp(`\\| ${dayKey(at(0)).slice(5)} \\| 42`)); // today only…
  assert.ok(!one.out.includes("313"), "…and the older day is outside a 1-day window");

  for (const bad of ["0", "abc"]) {
    const r = await runCli(root, "report", "--days", bad);
    assert.notEqual(r.code, 0, `--days ${bad} fails`);
    assert.match(r.out, /--days needs a positive integer/);
  }
});

// ---- report --since <duration> ----

const HOUR = 3_600_000;
const ago = (ms: number): number => Date.now() - ms;

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
  assert.throws(() => collectReportSince(root, 0), /sinceMs must be between 1 and REPORT_SINCE_MAX_MS \(got 0\)/);
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

test("renderSinceReportMarkdown pins the header, totals voice, role ranking, and zero window", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    ticksByRole: {},
    costByRole: {},
    coversFullWindow: true,
  });
  assert.match(zero, /^# tumwater usage report/);
  assert.match(zero, /window: last 1h \(since /);
  assert.match(zero, /\*\*Totals:\*\* 0 output tokens · 0 ticks · 0 commits · \$0\.00/);
  assert.match(zero, /\*\*Ticks by role:\*\* -/);
  assert.match(zero, /\*\*Cost by role:\*\* -/);
  assert.ok(!zero.includes("rotated"));

  const data = renderSinceReportMarkdown({
    sinceMs: 90 * 60_000,
    fromIso: new Date(ago(90 * 60_000)).toISOString(),
    totals: { tokensOut: 1500, ticks: 5, commits: 1, costUsd: 0.75, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    // Equal totals rank by name asc; a zero-cost role is omitted from the cost line.
    ticksByRole: { bugfix: 2, feature: 2, clean: 1 },
    costByRole: { feature: 0.75, bugfix: 0 },
    coversFullWindow: true,
  });
  assert.match(data, /window: last 90m \(since /);
  assert.match(data, /\*\*Totals:\*\* 1500 output tokens · 5 ticks · 1 commits · \$0\.75/);
  assert.match(data, /\*\*Ticks by role:\*\* bugfix — 2 · feature — 2 · clean — 1/);
  assert.match(data, /\*\*Cost by role:\*\* feature — \$0\.75/);
  assert.match(data, /backlog tallies \(features done \/ bugs fixed\) need the day report \(--days\)/);
});

test("renderSinceReportMarkdown shows the landing line under Totals only when landing ran", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    ticksByRole: {},
    costByRole: {},
    coversFullWindow: true,
  });
  assert.ok(!zero.includes("landing runs"), "zero landing runs omit the line entirely");

  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 1000, ticks: 2, commits: 0, costUsd: 0.5, landingRuns: 1, landingTokens: 900, landingCostUsd: 0.4 },
    ticksByRole: { feature: 2 },
    costByRole: { feature: 0.1 },
    coversFullWindow: true,
  });
  assert.match(data, /of which landing runs: 1 runs · 900 tokens · \$0\.40 \(reviewer \+ conflict resolution\)/);
});

test("tumwater report --since prints the window totals and validates its flags", async () => {
  const root = makeRepo();
  // The event log is append-only and chronological: seed oldest first, like every log the
  // harness itself writes (a reverse-ordered log is malformed input, not a coverage case).
  writeEvents(root, [
    JSON.stringify({ ts: ago(8 * HOUR), loop: "feature", type: "tick_end", tick: 2, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 777, costUsd: 0.5 }),
  ]);

  const ok = await runCli(root, "report", "--since", "6h");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^# tumwater usage report/m);
  assert.match(ok.out, /window: last 6h \(since /);
  assert.match(ok.out, /777 output tokens/);
  assert.match(ok.out, /\*\*Ticks by role:\*\* feature — 1/);
  assert.ok(!ok.out.includes("999"), "the 8h-old event is outside the 6h window");
  assert.match(ok.out, /backlog tallies \(features done \/ bugs fixed\) need the day report/);

  for (const rival of [["--days", "3"], ["--failures"]]) {
    const r = await runCli(root, "report", "--since", "6h", ...rival);
    assert.notEqual(r.code, 0, `--since with ${rival[0]} fails`);
    assert.match(r.out, new RegExp(`report --since cannot be combined with ${rival[0]}`), "the failure names the rival");
    assert.match(r.out, /--since/, "the failure names both flags");
  }

  const over = await runCli(root, "report", "--since", "8d");
  assert.notEqual(over.code, 0);
  assert.match(over.out, /capped at 7d/);

  for (const bad of ["abc", ""]) {
    const r = await runCli(root, "report", "--since", bad);
    assert.notEqual(r.code, 0, `--since ${bad} fails`);
    assert.match(r.out, /--since needs a duration like 45s, 90m, 2h, or 1d/);
  }
  const missing = await runCli(root, "report", "--since");
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /--since needs a value/);

  const help = await runCli(root, "help", "report");
  assert.equal(help.code, 0);
  assert.match(help.out, /report --since <duration>/);
});

// --- report through the real CLI entry point: main()'s wiring that the in-process pins
// above cannot see — report runs WITHOUT a readiness gate (it degrades to zeros in any
// directory) and --days shares /api/report's window bound: above it the command fails fast
// with the offending value instead of building an unbounded series.

test("report prints a zero-filled window outside a repo and honors --days", async () => {
  // No readiness gate: in a bare directory every source degrades to zeros, so the report
  // still renders (an all-zero default window).
  const r = await cli(tmpdir(), "report");
  assert.equal(r.code, 0, `expected exit 0 in any directory:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# tumwater usage report$/m);
  assert.match(r.stdout, /\(14 days\)/);

  const r2 = await cli(tmpdir(), "report", "--days", "3");
  assert.equal(r2.code, 0, `expected exit 0 with --days 3:\n${r2.stdout}\n${r2.stderr}`);
  assert.match(r2.stdout, /\(3 days\)/);
});

test("report --days above the shared bound fails fast with the offending value", async () => {
  const r = await cli(tmpdir(), "report", "--days", "91");
  assert.equal(r.code, 1, `expected exit 1 for --days 91:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /--days must be between 1 and 90 \(got "91"\)/);

  // The bound itself is allowed — the GUI clamps to it, so the CLI accepts exactly that.
  const ok = await cli(tmpdir(), "report", "--days", "90");
  assert.equal(ok.code, 0, `expected exit 0 at the bound:\n${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /\(90 days\)/);
});

// ---- report --json ----

test("report --json --days prints the collector's payload; the Markdown render is untouched", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.5 }),
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 2, result: "no_change", tokens: 42 }),
  ]);
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned" },
    { heading: "## Done", body: `- Epitaph (planned 2026-09-01, done ${dayKey(at(0))}; commit abc)` },
  ]);

  const json = await runCli(root, "report", "--json", "--days", "4");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out); // one document, parseable, nothing else on the stream
  const direct = collectReport(root, 4);
  assert.deepEqual(parsed, direct, "--json prints the collector's own payload");
  assert.equal(parsed.days, 4);
  assert.equal(parsed.from, dayKey(at(3)));
  assert.equal(parsed.to, dayKey(at(0)));
  assert.equal(parsed.totals.tokensOut, 542);
  assert.equal(parsed.totals.featuresDone, 1);

  // The same fixtures through the Markdown path render identically: --json swapped only the
  // printing, not the collection, so both views agree on the numbers they show.
  const md = await runCli(root, "report", "--days", "4");
  assert.equal(md.code, 0);
  assert.equal(md.out, renderReportMarkdown(direct) + "\n");
  assert.match(md.out, /542 output tokens/);
  assert.match(md.out, /1 features done/);

  const help = await runCli(root, "help", "report");
  assert.equal(help.code, 0);
  assert.match(help.out, /--json/);
});

test("report --json --since prints the window totals with the coverage proof", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(8 * HOUR), loop: "feature", type: "tick_end", tick: 2, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 777, costUsd: 0.5 }),
  ]);

  const json = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  // The cutoff instant is the collector's own now, so only its payload fields are pinned;
  // fromIso is checked as a fresh ISO string rather than deep-equalled across two nows.
  const direct = collectReportSince(root, 6 * HOUR);
  assert.equal(parsed.sinceMs, 6 * HOUR);
  assert.notEqual(Date.parse(parsed.fromIso), NaN, "fromIso is an ISO instant");
  assert.deepEqual(parsed.totals, direct.totals);
  assert.deepEqual(parsed.ticksByRole, direct.ticksByRole);
  assert.deepEqual(parsed.costByRole, direct.costByRole);
  assert.equal(parsed.totals.ticks, 1);
  assert.equal(parsed.totals.tokensOut, 777);
  assert.deepEqual(parsed.ticksByRole, { feature: 1 });
  assert.equal(parsed.coversFullWindow, true, "the log reaches back before the cutoff");
  assert.ok(!("series" in parsed), "the since shape carries totals, not a day series");
});

test("report --json carries the landing fields in totals and the day series", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 100, costUsd: 0.1 }),
    JSON.stringify({ ts: at(0), loop: "feature", type: "landed", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }),
  ]);
  const json = await runCli(root, "report", "--json", "--days", "2");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.totals.landingRuns, 1);
  assert.equal(parsed.totals.landingTokens, 45_200);
  assert.ok(Math.abs(parsed.totals.landingCostUsd - 0.84) < 1e-9);
  const today = parsed.series[parsed.series.length - 1];
  assert.equal(today.landingCostUsd, 0.84, "the day series carries landingCostUsd");
  assert.ok(Math.abs(today.tokensOut - 45_300) < 1e-9, "the day's tokensOut includes the landing share");
});

test("report --failures --json prints the digest's collected data; --since --json stays legal", async () => {
  const root = makeRepo();
  // The digest's FailureReportData is the machine-readable form (the time-and-spend fold gave
  // it a stable shape), so --failures --json prints the collector's own payload — the
  // report --json and doctor --json precedent — instead of refusing the combination.
  const parsed = JSON.parse((await runCli(root, "report", "--failures", "--json")).out) as {
    ticks: number;
    lossCauses: unknown[];
  };
  assert.equal(parsed.ticks, 0);
  assert.deepEqual(parsed.lossCauses, []);

  // --since --json stays legal: --json composes with every report shape.
  const sinceJson = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(sinceJson.code, 0);
});
