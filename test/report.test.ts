import test from "node:test";
import assert from "node:assert/strict";
import { collectReport, collectReportSince, type ReportData } from "../src/report/report-data.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "../src/report/report-render.js";
import { atLocalTs as at, dayKey, HOUR, ago } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { cli, runCli } from "./helpers/cli-harness.js";

// The usage collectors' unit tests (collectReport, collectReportSince) live in
// test/report-data.test.ts; this file pins the Markdown renders and the `tumwater report`
// CLI surface over them.

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
  assert.equal(lines[13], "**Tokens by role:** -", "no token spend renders '-' like the cost line");
  assert.equal(lines[14], "**Cost by role:** -");
  assert.equal(lines[15], "**Rejections by role:** -", "no rejections renders the line as '-', the shared zero-means-absent convention");
});

test("renderReportMarkdown prints a Rejections by role line ranked by count, only when rejections exist", () => {
  const md = renderReportMarkdown({
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", tokensOut: 0, ticksByRole: {}, costByRole: {}, rejectionsByRole: { feature: 1 }, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 0, ticksByRole: {}, costByRole: {}, rejectionsByRole: { feature: 2, qa: 1 }, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  });
  assert.match(md, /\*\*Rejections by role:\*\* feature — 3 · qa — 1/, "window rejections rank by count desc then name asc");
});

test("report folds revision events into Revisions by role, beside Rejections by role", async () => {
  const root = makeRepo();
  // One rejection yesterday; two revisions today, on distinct roles. The window's day report
  // must render rejections and revisions as two independent lines, and --json must carry the
  // new revisionsByRole field only on the day(s) that have one (zero-means-absent).
  writeEvents(root, [
    JSON.stringify({ ts: at(1), loop: "feature", type: "review_rejected" }),
    JSON.stringify({ ts: at(0), loop: "feature", type: "revision", action: "applied", round: 1, sha: "abc" }),
    JSON.stringify({ ts: at(0), loop: "clean", type: "revision", action: "conflict", round: 2, sha: "def" }),
  ]);

  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Rejections by role:\*\* feature — 1/);
  assert.match(md.out, /\*\*Revisions by role:\*\* clean — 1 · feature — 1/, "revisions fold as their own line, ranked desc then name asc like rejections");

  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  const today = json.series[1];
  const yesterday = json.series[0];
  assert.deepEqual(today.revisionsByRole, { feature: 1, clean: 1 }, "--json carries revisionsByRole on the day that has them");
  assert.ok(!("revisionsByRole" in yesterday), "a day with no revision carries no revisionsByRole key (zero means absent)");
  assert.equal(yesterday.rejectionsByRole?.feature, 1, "the rejection still lands on its own day");
});

test("report renders 'Revisions by role: -' when the window has no revision events", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 10 }),
  ]);
  const md = await runCli(root, "report", "--days", "1");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Revisions by role:\*\* -/, "no revisions render the line as '-', the zero-means-absent convention");
});

test("report --since narrows Revisions by role to the scoped base role", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "revision", action: "applied", round: 1, sha: "abc" }),
    JSON.stringify({ ts: ago(30 * 60_000), loop: "clean", type: "revision", action: "conflict", round: 1, sha: "def" }),
  ]);

  const fleet = await runCli(root, "report", "--since", "6h");
  assert.equal(fleet.code, 0);
  assert.match(fleet.out, /\*\*Revisions by role:\*\* clean — 1 · feature — 1/, "the fleet window sums both roles' revisions, ranked name asc on a tie");

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /\*\*Revisions by role:\*\* feature — 1/, "scoping --since narrows revisions to the base role");
  const scopedJson = JSON.parse((await runCli(root, "report", "--role", "feature", "--json", "--since", "6h")).out);
  assert.deepEqual(scopedJson.revisionsByRole, { feature: 1 }, "the scoped since JSON narrows revisionsByRole");

  const cleanNone = await runCli(root, "report", "--role", "bugfix", "--since", "6h");
  assert.equal(cleanNone.code, 0);
  assert.match(cleanNone.out, /\*\*Revisions by role:\*\* -/, "a scoped role with no revisions carries an empty map that renders '-'");
});

test("renderReportMarkdown prints commits by role and the work/maintenance split with commits per item", () => {
  const data: ReportData = {
    days: 1,
    from: "2026-09-10",
    to: "2026-09-10",
    series: [
      { date: "2026-09-10", tokensOut: 0, ticksByRole: {}, costByRole: {}, commits: 5, commitsByRole: { clean: 3, feature: 2 }, workCommits: 2, maintenanceCommits: 3, costUsd: 0, featuresDone: 1, bugsFixed: 1 },
    ],
    totals: { tokensOut: 0, ticks: 0, commits: 5, commitsByRole: { clean: 3, feature: 2 }, workCommits: 2, maintenanceCommits: 3, costUsd: 0, featuresDone: 1, bugsFixed: 1, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };
  const md = renderReportMarkdown(data);
  assert.match(md, /\*\*Commits by role:\*\* clean — 3 · feature — 2/);
  assert.match(md, /\*\*Commits:\*\* 2 work \/ 3 maintenance · 2\.5 commits per backlog item/);
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

test("renderReportMarkdown prints a Tokens by role line ranked by tokens desc, its own data", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      // alpha carries 4000 tokens but spends $0 — it must lead the tokens line while the
      // cost line omits it, proving the tokens line renders its own data.
      { date: base.from, tokensOut: 0, ticksByRole: { feature: 5, alpha: 1 }, tokensByRole: { alpha: 4000, feature: 5000 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, ticksByRole: { bugfix: 1 }, tokensByRole: { feature: 7000, beta: 800 }, costByRole: { beta: 0.5 }, commits: 0, costUsd: 0.5, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, ticks: 7, costUsd: 0.5 },
  };
  const md = renderReportMarkdown(data);
  // feature 5000+7000 = 12.0k, alpha 4000, beta 800 — ranked tokens desc then name asc.
  assert.match(md, /\*\*Tokens by role:\*\* feature — 12\.0k · alpha — 4000 · beta — 800/);
  // alpha holds 4000 tokens but spent $0, so it leads the tokens line while the cost line
  // omits it — the two lines render different data, not a re-render of Cost by role.
  assert.match(md, /\*\*Cost by role:\*\* beta — \$0\.50/);
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

test("renderSinceReportMarkdown pins the header, totals voice, role ranking, and zero window", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    ticksByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    revisionsByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    coversFullWindow: true,
  });
  assert.match(zero, /^# tumwater usage report/);
  assert.match(zero, /window: last 1h \(since /);
  assert.match(zero, /\*\*Totals:\*\* 0 output tokens · 0 ticks · 0 commits · \$0\.00/);
  assert.match(zero, /\*\*Ticks by role:\*\* -/);
  assert.match(zero, /\*\*Tokens by role:\*\* -/);
  assert.match(zero, /\*\*Cost by role:\*\* -/);
  assert.ok(!zero.includes("rotated"));

  const data = renderSinceReportMarkdown({
    sinceMs: 90 * 60_000,
    fromIso: new Date(ago(90 * 60_000)).toISOString(),
    totals: { tokensOut: 1500, ticks: 5, commits: 1, costUsd: 0.75, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    // Equal totals rank by name asc; a zero-cost role is omitted from the cost line.
    ticksByRole: { bugfix: 2, feature: 2, clean: 1 },
    costByRole: { feature: 0.75, bugfix: 0 },
    rejectionsByRole: { feature: 1, clean: 1 },
    revisionsByRole: { feature: 1 },
    // clean carries the most tokens but $0 spend — it must appear on the tokens line (its
    // own ranked data) while the cost line omits it, proving the lines differ.
    tokensByRole: { clean: 12000, feature: 5000, bugfix: 800 },
    commitsByRole: {},
    coversFullWindow: true,
  });
  assert.match(data, /window: last 90m \(since /);
  assert.match(data, /\*\*Totals:\*\* 1500 output tokens · 5 ticks · 1 commits · \$0\.75/);
  assert.match(data, /\*\*Ticks by role:\*\* bugfix — 2 · feature — 2 · clean — 1/);
  assert.match(data, /\*\*Tokens by role:\*\* clean — 12\.0k · feature — 5000 · bugfix — 800/);
  assert.match(data, /\*\*Cost by role:\*\* feature — \$0\.75/);
  assert.match(data, /\*\*Rejections by role:\*\* clean — 1 · feature — 1/, "equal rejection counts rank by name asc");
  assert.match(data, /\*\*Revisions by role:\*\* feature — 1/);
  assert.match(data, /backlog tallies \(features done \/ bugs fixed\) need the day report \(--days\)/);
});

test("renderSinceReportMarkdown shows the landing line under Totals only when landing ran", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    ticksByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    revisionsByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    coversFullWindow: true,
  });
  assert.ok(!zero.includes("landing runs"), "zero landing runs omit the line entirely");

  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 1000, ticks: 2, commits: 0, costUsd: 0.5, landingRuns: 1, landingTokens: 900, landingCostUsd: 0.4 },
    ticksByRole: { feature: 2 },
    costByRole: { feature: 0.1 },
    rejectionsByRole: {},
    revisionsByRole: {},
    tokensByRole: { feature: 900 },
    commitsByRole: {},
    coversFullWindow: true,
  });
  assert.match(data, /of which landing runs: 1 runs · 900 tokens · \$0\.40 \(reviewer \+ conflict resolution\)/);
});

test("renderSinceReportMarkdown prints Commits by role and Notional by role matching the day render", () => {
  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 1500, ticks: 5, commits: 4, costUsd: 0.75, notionalCostUsd: 0.9, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    ticksByRole: { feature: 5 },
    costByRole: { feature: 0.75 },
    rejectionsByRole: {},
    revisionsByRole: { feature: 3 },
    tokensByRole: { feature: 1500 },
    // The same ranking (count desc / spend desc, then name asc) and `usd` formatting the
    // day render applies to its Commits/Notional by role lines — window and day speak one shape.
    commitsByRole: { feature: 3, clean: 1 },
    notionalByRole: { feature: 0.4, plan: 0.5 },
    coversFullWindow: true,
  });
  assert.match(data, /\*\*Commits by role:\*\* feature — 3 · clean — 1/);
  assert.match(data, /\*\*Notional by role:\*\* plan — \$0\.50 · feature — \$0\.40/);
});

test("renderSinceReportMarkdown renders an empty window's Commits by role and omits Notional by role", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    ticksByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    revisionsByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    coversFullWindow: true,
  });
  // The now-required commitsByRole renders "-" when empty; a window with no notional spend
  // carries no Notional by role line at all — the same conditional omission the day render uses.
  assert.match(zero, /\*\*Commits by role:\*\* -/);
  assert.ok(!zero.includes("**Notional by role:"), "no notional spend omits the line entirely");
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

  // --days is the one remaining rival shape; --failures --since dispatches the windowed
  // digest (covered in test/failure-render.test.ts), so it is no longer a failure.
  const rival = ["--days", "3"];
  const r = await runCli(root, "report", "--since", "6h", ...rival);
  assert.notEqual(r.code, 0, `--since with ${rival[0]} fails`);
  assert.match(r.out, new RegExp(`report --since cannot be combined with ${rival[0]}`), "the failure names the rival");
  assert.match(r.out, /--since/, "the failure names both flags");

  const over = await runCli(root, "report", "--since", "8d");
  assert.notEqual(over.code, 0);
  assert.match(over.out, /capped at 7d/);

  for (const bad of ["abc", ""]) {
    const r = await runCli(root, "report", "--since", bad);
    assert.notEqual(r.code, 0, `--since ${bad} fails`);
    assert.match(r.out, /report --since needs a duration like 45s, 90m, 1h30m, or 2d/);
  }
  const missing = await runCli(root, "report", "--since");
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /report --since needs a value/);

  const help = await runCli(root, "help", "report");
  assert.equal(help.code, 0);
  assert.match(help.out, /report --since <duration>/);
});

test("tumwater report --since prints Commits/Notional by role and --json carries them", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "merged", commit: "abc1234" }),
    JSON.stringify({ ts: ago(9 * 60_000), loop: "clean", type: "merged", commit: "def5678" }),
    JSON.stringify({ ts: ago(8 * 60_000), loop: "plan", type: "tick_end", tick: 1, result: "changed", tokens: 10, notionalCostUsd: 0.5 }),
  ]);

  const md = await runCli(root, "report", "--since", "6h");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Commits by role:\*\* clean — 1 · feature — 1/);
  assert.match(md.out, /\*\*Notional by role:\*\* plan — \$0\.50/);

  const json = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.deepEqual(parsed.commitsByRole, { feature: 1, clean: 1 }, "the since JSON carries commitsByRole");
  assert.deepEqual(parsed.notionalByRole, { plan: 0.5 }, "the since JSON carries notionalByRole when nonzero");
  assert.ok(!("series" in parsed), "the since shape carries totals, not a day series");
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

test("report --since --role omits Notional by role when the scoped role spent none", async () => {
  const root = makeRepo();
  // The fleet window has notional spend (plan's tick), but feature spends none — scoping to
  // feature must drop the line/field, not render an empty "Notional by role: -".
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "plan", type: "tick_end", tick: 1, result: "changed", tokens: 10, notionalCostUsd: 0.5 }),
    JSON.stringify({ ts: ago(9 * 60_000), loop: "feature", type: "merged", commit: "abc1234" }),
  ]);

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /\*\*Commits by role:\*\* feature — 1/);
  assert.ok(!scoped.out.includes("**Notional by role:"), "a scoped role with no notional omits the line");

  const scopedJson = JSON.parse((await runCli(root, "report", "--role", "feature", "--json", "--since", "6h")).out);
  assert.deepEqual(scopedJson.commitsByRole, { feature: 1 });
  assert.ok(!("notionalByRole" in scopedJson), "the scoped role's JSON carries no notionalByRole");

  const fleet = await runCli(root, "report", "--since", "6h");
  assert.equal(fleet.code, 0);
  assert.match(fleet.out, /\*\*Notional by role:\*\* plan — \$0\.50/, "the fleet window still shows the notional spend");
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
  assert.deepEqual(parsed.commitsByRole, {}, "the since payload carries commitsByRole always");
  assert.ok(!("notionalByRole" in parsed), "notionalByRole is absent when the window has none");
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

test("renderReportMarkdown scopes a role report: role line, no backlog tail, scope note", () => {
  const data: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    role: "feature",
    series: [
      { date: "2026-09-09", tokensOut: 0, ticksByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 500, ticksByRole: { feature: 1 }, costByRole: { feature: 0.5 }, commits: 1, commitsByRole: { feature: 1 }, workCommits: 1, maintenanceCommits: 0, costUsd: 0.5, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 500, ticks: 1, commits: 1, costUsd: 0.5, featuresDone: 0, bugsFixed: 0, commitsByRole: { feature: 1 }, workCommits: 1, maintenanceCommits: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };
  const out = renderReportMarkdown(data);
  assert.match(out, /^role: feature$/m);
  assert.match(out, /^\*\*Totals:\*\* 500 output tokens · 1 ticks · 1 commits · \$0\.50$/m);
  assert.ok(!out.includes('features done · 0 bugs fixed'), "the fleet backlog cells are dropped from the totals line");
  assert.ok(!out.includes("of which landing runs"), "no landing-share line prints");
  assert.match(out, /role scope: landing runs and backlog tallies \(features done \/ bugs fixed\) are fleet-wide and omitted/);
});

test("tumwater report --role scopes the report, scopes --since/--json, and validates the flag", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 313, costUsd: 0.31 }),
    JSON.stringify({ ts: ago(9 * 60_000), loop: "bugfix", type: "tick_end", tick: 2, result: "changed", tokens: 42, costUsd: 0.04 }),
  ]);

  const scoped = await runCli(root, "report", "--role", "feature");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /^role: feature$/m);
  assert.match(scoped.out, /313 output tokens/);
  assert.ok(!scoped.out.includes("42 output tokens"), "the other role's tokens are excluded");
  assert.match(scoped.out, /role scope: landing runs and backlog tallies/);

  const fleet = await runCli(root, "report");
  assert.ok(!/^role:/m.test(fleet.out), "the fleet report carries no role line");

  const json = JSON.parse((await runCli(root, "report", "--role", "feature", "--json")).out) as {
    role?: string;
    totals: { tokensOut: number };
  };
  assert.equal(json.role, "feature");
  assert.equal(json.totals.tokensOut, 313);

  const since = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(since.code, 0);
  assert.match(since.out, /^role: feature$/m);
  assert.match(since.out, /role scope: landing runs and backlog tallies/);
  // The scope note already states the backlog-tally omission, so the --days pointer (which
  // would imply a scoped day report shows tallies it too omits) must not also print.
  assert.ok(!since.out.includes("need the day report"), "scoped --since does not repeat the --days tally pointer");

  const bogus = await runCli(root, "report", "--role", "bogus");
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.out, /unknown role: bogus/);

  // --role now scopes the failure digest too: the old rival-shape rejection is retired.
  const scopedFailures = await runCli(root, "report", "--role", "feature", "--failures");
  assert.equal(scopedFailures.code, 0);
  assert.match(scopedFailures.out, /^role: feature$/m);
  const failuresJson = JSON.parse(
    (await runCli(root, "report", "--failures", "--role", "feature", "--json")).out,
  ) as { role?: string };
  assert.equal(failuresJson.role, "feature");

  const scopedSince = await runCli(root, "report", "--failures", "--role", "feature", "--since", "6h");
  assert.equal(scopedSince.code, 0);
  assert.match(scopedSince.out, /^role: feature$/m);

  const bogusFailures = await runCli(root, "report", "--failures", "--role", "bogus");
  assert.notEqual(bogusFailures.code, 0);
  assert.match(bogusFailures.out, /unknown role: bogus/);

  const trailing = await runCli(root, "report", "--role");
  assert.notEqual(trailing.code, 0);
  assert.match(trailing.out, /--role needs a role id/);
});

test("renderReportMarkdown prints each role's cost per landed commit, folding instances and days", () => {
  const day = (date: string, costByRole: Record<string, number>, commitsByRole: Record<string, number>) => ({
    date, tokensOut: 0, ticksByRole: {}, costByRole, commits: 0, commitsByRole, workCommits: 0, maintenanceCommits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
  });
  const render = (series: ReportData["series"]) =>
    renderReportMarkdown({
      days: series.length, from: "2026-09-10", to: "2026-09-11", series,
      totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
      coversFullWindow: true,
    });
  const want = "**Cost per commit:** clean — $0.30 (3) · feature — $0.15 (2) · plan — $0.90, no commits";
  const one = render([day("2026-09-10", { feature: 0.2, "feature-2": 0.1, clean: 0.9, plan: 0.9 }, { feature: 2, clean: 3 })]);
  assert.ok(one.split("\n").includes(want), one);
  const two = render([
    day("2026-09-10", { feature: 0.2, clean: 0.4, plan: 0.5 }, { feature: 1, clean: 1 }),
    day("2026-09-11", { "feature-2": 0.1, clean: 0.5, plan: 0.4 }, { feature: 1, clean: 2 }),
  ]);
  assert.ok(two.split("\n").includes(want), two);
  const free = render([day("2026-09-10", {}, { docs: 4 })]);
  assert.ok(free.split("\n").includes("**Cost per commit:** -"), free);
});

test("renderReportMarkdown prints notional spend by role and per commit only when the window has any", () => {
  const day = (date: string, extra: object) => ({
    date, tokensOut: 0, ticksByRole: {}, costByRole: {}, commits: 0, commitsByRole: {}, workCommits: 0, maintenanceCommits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const render = (series: ReportData["series"], notionalCostUsd?: number) =>
    renderReportMarkdown({
      days: series.length, from: "2026-09-10", to: "2026-09-11", series,
      totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0, ...(notionalCostUsd ? { notionalCostUsd } : {}) },
      coversFullWindow: true,
    });
  const out = render([
    day("2026-09-10", { notionalByRole: { feature: 0.4, plan: 0.5 }, commitsByRole: { feature: 2 } }),
    day("2026-09-11", { notionalByRole: { "feature-2": 0.2 }, commitsByRole: { feature: 1 } }),
  ], 1.1).split("\n");
  assert.ok(out.includes("**Notional by role:** plan — $0.50 · feature — $0.40 · feature-2 — $0.20"), out.join("\n"));
  assert.ok(out.includes("**Notional per commit:** feature — $0.20 (3) · plan — $0.50, no commits"), out.join("\n"));
  assert.ok(out.includes("**Cost per commit:** -"));
  const none = render([day("2026-09-10", {})]).split("\n");
  assert.ok(!none.some((l) => l.startsWith("**Notional")));
});
