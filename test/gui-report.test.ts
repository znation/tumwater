import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startGui } from "../src/ui/gui.js";
import { collectReport, type ReportData, type ReportDay } from "../src/ui/report.js";
import { collectFailureReport, renderFailureMarkdown } from "../src/failure-report.js";
import { eventsLogPath } from "../src/paths.js";
import { compactTokens } from "../src/text.js";
import { initProject } from "../src/init.js";
import { makeRepo } from "./util.js";

// The GUI report tab (PLANS.md "report 2/3"): /api/report serves collectReport's ReportData
// as JSON with days clamped rather than errored, the page carries the tab nav + #report
// container, and its pure SVG chart builders are extracted from a marked region and tested.

/** Local calendar-day timestamp `daysAgo` days back at noon — same local-date-part rule as
 * test/report.test.ts's fixtures (the report buckets by LOCAL day). */
function atNoon(daysAgo: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("gui /api/report serves collectReport's JSON and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "report api test");
  // Seed events with explicit ts values across two roles (the role field is `loop`, as
  // collectReport reads it — a line using `role` would bucket under "?") plus one merged;
  // features/bugs come from dated headings in PLANS.md/BUGS.md, not from events.
  const evFile = eventsLogPath(repo);
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  fs.writeFileSync(
    evFile,
    [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "tick_end", tick: 2, result: "no_change" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "tick_end", tick: 3, result: "no_change", tokens: 250, costUsd: 1.5 }),
    ].join("\n") + "\n",
  );
  const today = localDayKey(Date.now());
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### A done plan (planned ${today}, done ${today})\n`,
  );
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    `# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### A fixed bug (found by qa loop ${today}, fixed ${today})\n`,
  );

  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Default window: the JSON equals collectReport's output for the same root/days.
    const res = await fetch(base + "/api/report");
    assert.equal(res.status, 200);
    const d = (await res.json()) as ReturnType<typeof collectReport>;
    assert.deepEqual(d, collectReport(repo, 14), "the endpoint serves collectReport's ReportData");
    assert.equal(d.totals.featuresDone, 1, "a dated Done heading counts as a feature done");
    assert.equal(d.totals.bugsFixed, 1, "a dated Fixed heading counts as a bug fixed");

    // days: missing or non-decimal → default 14; out-of-range clamped to 1..90 — never an
    // error. Non-decimal follows the shared plain-digit rule (text.parseNonNegativeInt):
    // hex/scientific/signed/padded spellings are not counts, so they get the default instead
    // of a coerced value (raw Number.parseInt read "1e3" as 1 and "0x10" as 0).
    const cases: Array<[string, number]> = [
      ["days=14", 14],
      ["days=", 14],
      ["days=abc", 14],
      ["days=-5", 14], // signed spelling is not a count — default, not clamped coercion
      ["days=1e3", 14], // scientific spelling likewise
      ["days=0x10", 14], // hex prefix: raw parseInt stopped at "x" and coerced to 0 → 1 day
      ["days=%207", 14], // whitespace-padded spelling is not a count
      ["days=0", 1],
      ["days=91", 90],
      ["days=900", 90],
    ];
    for (const [q, expected] of cases) {
      const r = await fetch(base + "/api/report?" + q);
      assert.equal(r.status, 200, `${q} → 200 (a URL typo degrades to a window, not an error)`);
      const dd = (await r.json()) as { days: number; series: unknown[] };
      assert.equal(dd.days, expected, `${q} → ${expected}`);
      assert.equal(dd.series.length, expected, `series length follows the clamped window`);
    }
  } finally {
    server.close();
  }
});

test("gui /api/failures serves the rendered digest and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "failures api test");
  // Seed events with explicit ts values across roles, including one error so the digest has a
  // cluster to render — the endpoint's whole job is to hand back renderFailureMarkdown's text.
  const evFile = eventsLogPath(repo);
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  fs.writeFileSync(
    evFile,
    [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "tick_end", tick: 2, result: "error", error: "pi exited 1" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "tick_end", tick: 3, result: "no_change" }),
    ].join("\n") + "\n",
  );

  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Default window: the markdown equals the pure renderer's output for the same root/days.
    const res = await fetch(base + "/api/failures");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { markdown: string };
    assert.equal(d.markdown, renderFailureMarkdown(collectFailureReport(repo, 14)));
    assert.match(d.markdown, /^# tumwater failure digest/, "the tab renders the digest's heading first");

    // days follows /api/report's exact rule: missing/non-decimal → 14; out-of-range clamped to
    // 1..90 — never an error. Compare each against the digest rendered for the clamped count.
    const cases: Array<[string, number]> = [
      ["days=14", 14],
      ["days=", 14],
      ["days=abc", 14],
      ["days=-5", 14], // signed spelling is not a count — default, not clamped coercion
      ["days=1e3", 14], // scientific spelling likewise
      ["days=0x10", 14], // hex prefix: raw parseInt stopped at "x" and coerced to 0 → 1 day
      ["days=%207", 14], // whitespace-padded spelling is not a count
      ["days=0", 1],
      ["days=91", 90],
      ["days=900", 90],
    ];
    for (const [q, expected] of cases) {
      const r = await fetch(base + "/api/failures?" + q);
      assert.equal(r.status, 200, `${q} → 200 (a URL typo degrades to a window, not an error)`);
      const dd = (await r.json()) as { markdown: string };
      assert.equal(dd.markdown, renderFailureMarkdown(collectFailureReport(repo, expected)), `${q} → ${expected}`);
    }
  } finally {
    server.close();
  }
});

test("the dashboard page carries the report tab nav and its view containers", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // Nav row under the h1 with all three tabs; fleet is active by default.
  assert.match(
    GUI_PAGE,
    /<nav id="viewnav"><a href="#" id="tab-fleet" class="active">fleet<\/a>[\s\S]*?<a href="#" id="tab-report">report<\/a>[\s\S]*?<a href="#" id="tab-failures">failures<\/a><\/nav>/,
  );

  // The fleet view wraps exactly the four fleet elements; #report and #failures are hidden
  // siblings shown when active (the page's existing hidden-attribute pattern).
  assert.match(
    GUI_PAGE,
    /<div id="fleet-view">\n<table>[\s\S]*?<\/table>\n<div id="transcript" hidden><\/div>\n<div id="backlog"><\/div>\n<div id="feed"><\/div>\n<\/div>/,
  );
  assert.match(GUI_PAGE, /<\/div>\n<div id="report" hidden><\/div>\n<div id="failures" hidden><\/div>\n<script>/);
  // #failures reuses #transcript's box, so the digest keeps its newlines and scrolls.
  assert.match(GUI_PAGE, /#transcript, #failures \{[\s\S]*?white-space:pre-wrap/);

  // The director prompt form sits outside the fleet view — visible on every tab.
  const formIdx = GUI_PAGE.indexOf('<form id="promptform">');
  const viewIdx = GUI_PAGE.indexOf('<div id="fleet-view">');
  assert.ok(formIdx !== -1 && viewIdx !== -1 && formIdx < viewIdx, "the prompt form stays outside the fleet view");

  // Report and failures are fetched on tab activation only — no per-second polls of them.
  assert.match(GUI_PAGE, /getJson\("\/api\/report\?days=14"\)/);
  assert.match(GUI_PAGE, /if \(v === "report"\) fetchReport\(\)/);
  assert.match(GUI_PAGE, /getJson\("\/api\/failures\?days=14"\)/);
  assert.match(GUI_PAGE, /if \(v === "failures"\) fetchFailures\(\)/);
  assert.equal(GUI_PAGE.match(/setInterval\(/g)?.length ?? 0, 1, "the only poll is the existing 1s status refresh");
});

test("the report charts carry a cursor-following hover label", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // The shared chip: fixed in viewport coordinates, inert to the pointer (so it cannot
  // flicker away the instant the cursor reaches it), hidden until a segment shows it.
  assert.match(GUI_PAGE, /#report-tip \{[^}]*position:fixed[^}]*pointer-events:none[^}]*display:none[^}]*\}/);
  // The only hover affordance on the charts is the dimmed segment; legend/stats/axis text
  // stay untouched.
  assert.match(GUI_PAGE, /#report svg rect:hover \{[^}]*opacity:\.8/);

  // The label is read from each segment's existing <title> — the abbreviated value the
  // chart-builder test pins byte-for-byte — never re-derived, so the tooltip cannot drift
  // from the builders' label strings.
  assert.match(GUI_PAGE, /ev\.target instanceof Element \? ev\.target\.closest\("rect"\) : null/);
  assert.match(GUI_PAGE, /target\.querySelector\("title"\)\?\.textContent/);

  // The listeners delegate off the #report container itself — which fetchReport re-renders
  // by innerHTML but never replaces — so one attach at init survives every re-render;
  // pointerleave hides the chip when the pointer leaves the panel.
  assert.match(GUI_PAGE, /attachReportTip\(\) \{\n    const panel = document\.getElementById\("report"\);[\s\S]*?panel\.addEventListener\("pointermove", /);
  assert.match(GUI_PAGE, /panel\.addEventListener\("pointerleave", /);

  // The tooltip JS is a marked region (the page's loop-sort / last-tick-fmt convention)
  // wired in once at init, immediately before the final refresh + 1 s poll.
  assert.match(GUI_PAGE, /\/\/ report-tip:start\n[\s\S]*?\n  \/\/ report-tip:end/);
  assert.match(GUI_PAGE, /attachReportTip\(\);\n  refresh\(\);\n  setInterval\(refresh, 1000\);/);
});

test("the report tab's SVG chart builders render bars, stacks, and thinned labels", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // Extract the marked region — same regex-extract + new Function pattern as the esc test.
  // The page's own esc is injected so role names escape exactly like every other dynamic value;
  // the page's own fmtTokens is extracted the same way (the esc test's single-line-const seam)
  // and injected so the chart labels rule cannot drift from the stat blocks above them.
  const m = GUI_PAGE.match(/\/\/ report-chart:start\n([\s\S]*?)\n  \/\/ report-chart:end/);
  assert.ok(m, "report-chart region found in the page");
  const fm = GUI_PAGE.match(/const fmtTokens = \((\w+)\) => (.+);$/m);
  assert.ok(fm, "fmtTokens definition found in the page");
  const fmtTokens = new Function(fm[1]!, `return (${fm[2]});`) as (n: number) => string;
  type ChartBuilders = {
    chartTokens(d: ReportData): string;
    chartTicksByRole(d: ReportData): string;
    chartCommits(d: ReportData): string;
  };
  const escImpl = (s: string) => String(s).replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c] as string));
  const builders = new Function("esc", "fmtTokens", `${m[1]}\nreturn { chartTokens, chartTicksByRole, chartCommits };`) as unknown as (
    esc: (s: string) => string,
    fmtTokens: (n: number) => string,
  ) => ChartBuilders;
  const { chartTokens, chartTicksByRole, chartCommits } = builders(escImpl, fmtTokens);

  // Fixture: 14 days — tokens rising to a max on the last day, two roles with distinct window
  // totals (feature > bugfix), one zero day in the middle.
  const mkDay = (date: string, tokensOut: number, ticksByRole: Record<string, number>, commits: number): ReportDay => ({
    date,
    tokensOut,
    ticksByRole,
    commits,
    costUsd: 0.5,
    featuresDone: 0,
    bugsFixed: 0,
  });
  const series: ReportDay[] = [];
  for (let i = 0; i < 14; i++) {
    const date = `2026-09-${String(i + 1).padStart(2, "0")}`;
    if (i === 7) series.push({ ...mkDay(date, 0, {}, 0), costUsd: 0 }); // the zero day
    else series.push(mkDay(date, (i + 1) * 1000, i % 2 === 0 ? { feature: 3, bugfix: 1 } : { feature: 2 }, i % 3 === 0 ? 2 : 1));
  }
  const data: ReportData = {
    days: 14,
    from: series[0]!.date,
    to: series[13]!.date,
    series,
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
  };

  const parseRects = (svg: string) =>
    [...svg.matchAll(/<rect x='([\d.]+)' y='([\d.]+)' width='([\d.]+)' height='([\d.]+)' fill='([^']*)'><title>([^<]*)<\/title><\/rect>/g)].map(
      (r) => ({ x: +r[1]!, y: +r[2]!, w: +r[3]!, h: +r[4]!, fill: r[5]!, title: r[6]! }),
    );

  // "Output tokens per day": one bar per non-zero day; the window-max day's bar is the tallest.
  const tokenRects = parseRects(chartTokens(data));
  assert.equal(tokenRects.length, 13, "one bar per non-zero day (the zero day leaves an empty slot)");
  const maxBar = tokenRects.find((r) => r.title === "2026-09-14: 14.0k");
  assert.ok(maxBar, "tokens ≥ 10k are abbreviated like the stat blocks");
  for (const r of tokenRects) {
    assert.ok(r.h <= maxBar!.h + 1e-9, "no bar exceeds the window-max bar");
    assert.ok(Math.abs(r.y + r.h - (maxBar!.y + maxBar!.h)) < 1e-9, "every bar sits on the same baseline");
  }

  // X-axis labels: MM-DD like the Markdown table, thinned to at most seven.
  const labels = [...chartTokens(data).matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((t) => t[1]!);
  assert.ok(labels.length <= 7, "labels thinned to at most seven");
  assert.equal(labels[0], "09-01", "the first day is always labeled (MM-DD)");

  // "Commits per day": one bar per non-zero day with the abbreviated value in its tooltip
  // (counts below 10k pass through unchanged).
  const commitRects = parseRects(chartCommits(data));
  assert.equal(commitRects.length, 13);
  assert.ok(commitRects.some((r) => r.title === "2026-09-04: 2"), "small commit tooltips are unchanged");

  // "Ticks per day by role": one segment per (day, role) with ticks; the highest-count role
  // sits at the bottom of each stack and first in the legend, colored from the fixed palette.
  const stacked = parseRects(chartTicksByRole(data));
  assert.equal(stacked.length, 7 * 2 + 6 * 1, "one segment per (day, role) with ticks");
  const day0 = stacked.filter((r) => r.title.startsWith("2026-09-01 "));
  assert.equal(day0.length, 2);
  const feat = day0.find((r) => r.title.includes("feature"))!;
  const bug = day0.find((r) => r.title.includes("bugfix"))!;
  assert.ok(feat.y > bug.y, "the highest-count role (feature) sits at the bottom of the stack");
  assert.ok(Math.abs(feat.h - 3 * bug.h) < 0.05, "segment heights are proportional to their values");
  const legend = chartTicksByRole(data);
  assert.match(legend, /style='background:#7ec8ff'><\/span>feature<\/span>/, "first role gets palette[0]");
  assert.match(legend, /style='background:#7fd88f'><\/span>bugfix<\/span>/, "second role gets palette[1]");

  // Role names are dynamic strings (custom loops): escaped in legend and tooltips like every
  // other dynamic value — raw HTML in a role name must not render.
  const hostile: ReportData = {
    ...data,
    series: [mkDay("2026-09-01", 0, { "<b>x</b>": 2 }, 0)],
  };
  const hostileSvg = chartTicksByRole(hostile);
  assert.ok(!hostileSvg.includes("<b>x</b>"), "raw HTML in a role name is not rendered");
  assert.match(hostileSvg, /&lt;b&gt;x&lt;\/b&gt;/, "role names are escaped in legend and tooltips");
});

test("the dashboard page abbreviates millions with M, in lockstep with compactTokens", async () => {
  // Regression (2026-09-20): the page's own fmtTokens copy stopped at `k`, so the loop
  // table's generated/peak-ctx cells and the report summary's output-tokens block rendered
  // 13,820,300 as "13820.3k" while `tumwater report` printed "13.8M". The page cannot import
  // TypeScript (a separate browser runtime), so its copy is pinned here from the page's own
  // source — same regex-extract + new Function pattern as the esc test — and every value is
  // cross-checked against the shared compactTokens so the deliberate duplicate cannot drift.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const m = GUI_PAGE.match(/const fmtTokens = \((\w+)\) => (.+);$/m);
  assert.ok(m, "fmtTokens definition found in the page");
  const fmtTokens = new Function(m[1]!, `return (${m[2]});`) as (n: number) => string;

  assert.equal(fmtTokens(9_999), "9999", "bare below the k threshold");
  assert.equal(fmtTokens(14_000), "14.0k", "one-decimal k unchanged");
  assert.equal(fmtTokens(1_000_000), "1.0M", "boundary: swaps k for M");
  assert.equal(fmtTokens(13_820_300), "13.8M", "13.8M, not 13820.3k");
  assert.equal(fmtTokens(undefined as unknown as number), "0", "a missing payload field renders as 0");
  for (const n of [0, 500, 9_999, 10_000, 12_345, 999_999, 1_000_000, 13_820_300]) {
    assert.equal(fmtTokens(n), compactTokens(n), `page and compactTokens agree on ${n}`);
  }
});
