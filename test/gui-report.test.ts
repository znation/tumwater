import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectReport, type ReportData, type ReportDay } from "../src/report/report-data.js";
import { collectFailureReport } from "../src/failure/failure-data.js";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { eventsLogPath } from "../src/paths.js";
import { SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { compactTokens } from "../src/text/format.js";
import { initProject } from "../src/init/init.js";
import { atLocalTs as atNoon, dayKey } from "./helpers/oracles.js";
import { withGui } from "./fixtures/gui-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { writeLogLines } from "./fixtures/log-fixtures.js";
import { clientScope, clientRegion, ESC_LINE, iconStub } from "./helpers/gui-client-scope.js";
import { GUI_CLIENT_REPORT_JS } from "../src/ui/gui/gui-client-report.js";
import { WINDOW_DAY_CASES } from "./fixtures/window-days.js";

// The GUI report tab: /api/report serves collectReport's ReportData
// as JSON with days clamped rather than errored, the page carries the tab nav + #report
// container, and its pure SVG chart builders are extracted from a marked region and tested.

// Local calendar-day timestamps come from oracles.ts's atLocalTs and day keys from its dayKey
// oracle — the report buckets by LOCAL day, the same rule report.test.ts's fixtures follow.

test("gui /api/report serves collectReport's JSON and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "report api test");
  // Seed events with explicit ts values across two roles (the role field is `loop`, as
  // collectReport reads it — a line using `role` would bucket under "?") plus one merged;
  // features/bugs come from dated headings in PLANS.md/BUGS.md, not from events.
  const evFile = eventsLogPath(repo);
  writeLogLines(evFile, [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "run_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "run_end", tick: 2, result: "no_change" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "run_end", tick: 3, result: "no_change", tokens: 250, costUsd: 1.5 }),
    ]);
  const today = dayKey(Date.now());
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### A done plan (planned ${today}, done ${today})\n`,
  );
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    `# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### A fixed bug (found by qa loop ${today}, fixed ${today})\n`,
  );

  await withGui(repo, async ({ base }) => {
  // Default window: the JSON equals collectReport's output for the same root/days.
  const res = await fetch(base + "/api/report");
  assert.equal(res.status, 200);
  const d = (await res.json()) as ReturnType<typeof collectReport>;
  assert.deepEqual(d, collectReport(repo, 14), "the endpoint serves collectReport's ReportData");
  // costByRole rides along in the JSON — split from the same run_end events as costUsd.
  const spendDay = d.series.find((x) => x.date === dayKey(atNoon(3)));
  assert.deepEqual(spendDay?.costByRole, { feature: 0.25 }, "/api/report carries costByRole per role");
  const todayTick = d.series.find((x) => x.date === dayKey(atNoon(0)));
  assert.deepEqual(todayTick?.costByRole, { steward: 1.5 });
  assert.equal(d.totals.featuresDone, 1, "a dated Done heading counts as a feature done");
  assert.equal(d.totals.bugsFixed, 1, "a dated Fixed heading counts as a bug fixed");

  // A role scope serves the scoped collector's payload (role field, only that role's maps,
  // zeroed backlog tallies); unknown and empty roles are the shared 400.
  const rf = await fetch(base + "/api/report?role=feature");
  assert.equal(rf.status, 200);
  assert.deepEqual(await rf.json(), collectReport(repo, 14, "feature"), "?role scopes /api/report");
  const rbad = await fetch(base + "/api/report?role=bogus");
  assert.equal(rbad.status, 400, "an unknown role is a 400, not a scope");
  assert.match(((await rbad.json()) as { error: string }).error, /unknown role "bogus" \(valid ids: /);
  const rempty = await fetch(base + "/api/report?role=");
  assert.equal(rempty.status, 400, "an empty role is present-but-unknown, not fleet-wide");

  // days follows windowDays's rule via WINDOW_DAY_CASES: missing or non-decimal → default,
  // out-of-range clamped — never an error.
  for (const [q, expected] of WINDOW_DAY_CASES) {
    const r = await fetch(base + "/api/report?" + q);
    assert.equal(r.status, 200, `${q} → 200 (a URL typo degrades to a window, not an error)`);
    const dd = (await r.json()) as { days: number; series: unknown[] };
    assert.equal(dd.days, expected, `${q} → ${expected}`);
    assert.equal(dd.series.length, expected, `series length follows the clamped window`);
  }
  });
});

test("gui /api/failures serves the rendered digest and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "failures api test");
  // Seed events with explicit ts values across roles, including one error so the digest has a
  // cluster to render — the endpoint's whole job is to hand back renderFailureMarkdown's text.
  const evFile = eventsLogPath(repo);
  writeLogLines(evFile, [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "run_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "run_end", tick: 2, result: "error", error: "pi exited 1" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "run_end", tick: 3, result: "no_change" }),
    ]);

  await withGui(repo, async ({ base }) => {
  // Default window: the markdown equals the pure renderer's output for the same root/days.
  const res = await fetch(base + "/api/failures");
  assert.equal(res.status, 200);
  const d = (await res.json()) as { markdown: string };
  assert.equal(d.markdown, renderFailureMarkdown(collectFailureReport(repo, 14)));
  assert.match(d.markdown, /^# tumwater failure digest/, "the tab renders the digest's heading first");

  // A role scope serves the scoped digest (its role line included); unknown and empty roles
  // are the shared 400.
  const rf = await fetch(base + "/api/failures?role=feature");
  assert.equal(rf.status, 200);
  const scoped = ((await rf.json()) as { markdown: string }).markdown;
  assert.equal(scoped, renderFailureMarkdown(collectFailureReport(repo, 14, "feature")), "?role scopes /api/failures");
  assert.match(scoped, /^role: feature$/m, "the scoped digest names its role");
  assert.equal((await fetch(base + "/api/failures?role=bogus")).status, 400);
  assert.equal((await fetch(base + "/api/failures?role=")).status, 400);

  // days follows the same windowDays rule as /api/report (WINDOW_DAY_CASES): compare each
  // against the digest rendered for the clamped count.
  for (const [q, expected] of WINDOW_DAY_CASES) {
    const r = await fetch(base + "/api/failures?" + q);
    assert.equal(r.status, 200, `${q} → 200 (a URL typo degrades to a window, not an error)`);
    const dd = (await r.json()) as { markdown: string };
    assert.equal(dd.markdown, renderFailureMarkdown(collectFailureReport(repo, expected)), `${q} → ${expected}`);
  }
  });
});

test("the Usage and Failures views fetch their window on activation, never on a timer", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  // Both views have a container and a sidebar link; the window pickers choose the days.
  assert.match(GUI_PAGE, /<section id="report" class="view" aria-label="Usage" hidden><\/section>/);
  assert.match(GUI_PAGE, /<section id="failures" class="view" aria-label="Failures" hidden><\/section>/);
  assert.match(GUI_PAGE, /endpoint: \(days, role, sinceMs\) => \(sinceMs \? "\/api\/report\?sinceMs=" \+ sinceMs : "\/api\/report\?days=" \+ days\)/);
  assert.match(GUI_PAGE, /endpoint: \(days, role, sinceMs\) => \(sinceMs \? "\/api\/failures\?sinceMs=" \+ sinceMs : "\/api\/failures\?days=" \+ days\)/);
  assert.match(GUI_PAGE, /if \(v === "usage"\) fetchReport\(\)/);
  assert.match(GUI_PAGE, /if \(v === "failures"\) fetchFailures\(\)/);
  // The fleet view's "today" tiles read a one-day report, refreshed on new events.
  assert.match(GUI_PAGE, /getJson\("\/api\/report\?days=1", pollSignal\(\)\)/);
  assert.equal(GUI_PAGE.match(/setTimeout\(pollLoop, 1000\)/g)?.length ?? 0, 1, "the only poll is the 1 s status refresh");
});
test("the report charts carry a cursor-following hover label", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  // The shared chip: fixed in viewport coordinates, inert to the pointer (so it cannot flicker
  // away the instant the cursor reaches it), hidden until a segment shows it.
  assert.match(GUI_PAGE, /#report-tip \{[^}]*position: ?fixed[^}]*pointer-events: ?none[^}]*display: ?none[^}]*\}/);
  assert.match(GUI_PAGE, /#report svg rect:hover \{[^}]*opacity: ?\.8/);
  // The label is each segment's own <title> — never re-derived — read off the #report
  // container, which re-renders its content but is never replaced, so one attach at start-up
  // survives every render.
  // The rect narrowing routes through clickClosest — the one home of the
  // instanceof-Element guard every delegated handler shares (gui-client.ts's
  // click-delegate region), which the page defines beside onClick.
  assert.match(GUI_PAGE, /const target = clickClosest\(ev, "rect"\);/);
  assert.match(GUI_PAGE, /function clickClosest\(ev, selector\) \{[\s\S]*?ev\.target instanceof Element/);
  assert.match(GUI_PAGE, /target\.querySelector\("title"\)\?\.textContent/);
  assert.match(GUI_PAGE, /attachReportTip\(\) \{\n    const panel = document\.getElementById\("report"\);[\s\S]*?panel\.addEventListener\("pointermove", /);
  assert.match(GUI_PAGE, /panel\.addEventListener\("pointerleave", /);
  assert.equal(GUI_PAGE.match(/attachReportTip\(\);/g)?.length, 1, "attached once, at start-up");
});
test("the Usage charts render bars on a shared scale, stacks per loop, and a labeled today", () => {
  interface Builders {
    chartTokens(d: ReportData): string;
    chartTicksByRole(d: ReportData): string;
    chartCommits(d: ReportData): string;
    chartCostByRole(d: ReportData): string;
    niceMax(v: number, integer: boolean): number;
    reportDayLabels(series: ReportDay[]): string[];
    REPORT_PALETTE: string[];
  }
  const { chartTokens, chartTicksByRole, chartCommits, chartCostByRole, niceMax, reportDayLabels, REPORT_PALETTE } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartTokens", "chartTicksByRole", "chartCommits", "chartCostByRole", "niceMax", "reportDayLabels", "REPORT_PALETTE"],
  );

  // 14 days — tokens rising to a max on the last day, two roles with distinct window totals
  // (feature > bugfix), one zero day in the middle.
  const mkDay = (date: string, tokensOut: number, ticksByRole: Record<string, number>, commits: number, costByRole: Record<string, number> = {}): ReportDay => ({
    date, tokensOut, ticksByRole, costByRole, commits, costUsd: 0.5, featuresDone: 0, bugsFixed: 0,
  });
  const series: ReportDay[] = [];
  for (let i = 0; i < 14; i++) {
    const date = `2026-09-${String(i + 1).padStart(2, "0")}`;
    if (i === 7) series.push({ ...mkDay(date, 0, {}, 0), costUsd: 0 });
    else series.push(mkDay(date, (i + 1) * 1000, i % 2 === 0 ? { feature: 3, bugfix: 1 } : { feature: 2 }, i % 3 === 0 ? 2 : 1, i % 2 === 0 ? { feature: 0.06, bugfix: 0.02 } : { feature: 0.04 }));
  }
  const data: ReportData = {
    days: 14, from: series[0]!.date, to: series[13]!.date, series,
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };
  const parseRects = (svg: string) =>
    [...svg.matchAll(/<rect x='([\d.]+)' y='([\d.]+)' width='([\d.]+)' height='([\d.]+)' rx='2' fill='([^']*)'><title>([^<]*)<\/title><\/rect>/g)].map(
      (r) => ({ x: +r[1]!, y: +r[2]!, w: +r[3]!, h: +r[4]!, fill: r[5]!, title: r[6]! }),
    );

  // The scale tops out at a round number at or above the tallest bar; small counts stay even so
  // the midline is a whole number.
  assert.deepEqual([niceMax(14_000, true), niceMax(3, true), niceMax(7, true), niceMax(0, true), niceMax(0.34, false)], [20_000, 4, 8, 2, 0.5]);

  // Output tokens: one bar per non-zero day on one baseline, the tallest the window's max.
  const tokens = chartTokens(data);
  const tokenRects = parseRects(tokens);
  assert.equal(tokenRects.length, 13, "one bar per non-zero day (the zero day keeps an empty slot)");
  const maxBar = tokenRects.find((r) => r.title === "2026-09-14: 14.0k output tokens");
  assert.ok(maxBar, "tooltips abbreviate like the stat tiles");
  for (const r of tokenRects) {
    assert.ok(r.h <= maxBar!.h + 1e-9, "no bar exceeds the window-max bar");
    assert.ok(Math.abs(r.y + r.h - (maxBar!.y + maxBar!.h)) < 1e-9, "every bar sits on the same baseline");
  }
  // The scale's labels: zero, the midline, the top.
  assert.match(tokens, />0<\/text>/);
  assert.match(tokens, />10\.0k<\/text>/);
  assert.match(tokens, />20\.0k<\/text>/);

  // Day labels: MM-DD, at most seven, counted back from the newest so today is always labeled.
  const labels = reportDayLabels(series).filter(Boolean);
  assert.ok(labels.length <= 7);
  assert.equal(reportDayLabels(series).at(-1), "09-14", "the newest day carries its label");

  // Landed commits: plain counts in the tooltip.
  const commitRects = parseRects(chartCommits(data));
  assert.equal(commitRects.length, 13);
  assert.ok(commitRects.some((r) => r.title === "2026-09-04: 2 commits merged"));

  // Ticks by loop: one segment per (day, loop); the busiest loop sits at the bottom and leads
  // the legend, each loop keeping one palette color.
  const stacked = parseRects(chartTicksByRole(data));
  assert.equal(stacked.length, 7 * 2 + 6 * 1);
  const day0 = stacked.filter((r) => r.title.startsWith("2026-09-01 "));
  const feat = day0.find((r) => r.title.includes("feature"))!;
  const bug = day0.find((r) => r.title.includes("bugfix"))!;
  assert.ok(feat.y > bug.y, "the busiest loop sits at the bottom of the stack");
  assert.ok(Math.abs(feat.h - 3 * bug.h) < 0.05, "segment heights are proportional to their values");
  assert.equal(feat.title, "2026-09-01 · feature: 3 runs");
  const legend = chartTicksByRole(data);
  assert.match(legend, new RegExp(`style='background:${REPORT_PALETTE[0]}'></span>feature</span>`), "first loop gets the first color");
  assert.match(legend, new RegExp(`style='background:${REPORT_PALETTE[1]}'></span>bugfix</span>`));

  // Spend by loop shares the ticks chart's order, colors, and legend; its values are money.
  const costRects = parseRects(chartCostByRole(data));
  assert.equal(costRects.length, 7 * 2 + 6 * 1);
  const costFeat = costRects.find((r) => r.title.startsWith("2026-09-01 · feature"))!;
  assert.equal(costFeat.title, "2026-09-01 · feature: $0.06");
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartCostByRole(data)), legendOf(chartTicksByRole(data)));

  // Loop names are dynamic (custom loops): escaped in legend and tooltips.
  const hostile: ReportData = { ...data, series: [mkDay("2026-09-01", 0, { "<b>x</b>": 2 }, 0)] };
  const hostileSvg = chartTicksByRole(hostile);
  assert.ok(!hostileSvg.includes("<b>x</b>"), "raw HTML in a loop name is not rendered");
  assert.match(hostileSvg, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal(parseRects(chartCostByRole(hostile)).length, 0, "a day without spend renders no cost segments");
});
test("the Usage charts count a loop named after an Object.prototype key", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartTicksByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole"],
  );
  // "constructor" is admitted by the custom-loop charset and collides with an
  // Object.prototype key; day 2 gives it spend but no ticks, so its ticksByRole read is absent.
  const mkDay = (date: string, ticksByRole: Record<string, number>, costByRole: Record<string, number>): ReportDay => ({
    date, tokensOut: 0, ticksByRole, costByRole, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
  });
  const data: ReportData = {
    days: 2, from: "2026-09-01", to: "2026-09-02",
    series: [
      mkDay("2026-09-01", { constructor: 5 }, { constructor: 0.1 }),
      mkDay("2026-09-02", {}, { constructor: 0.2 }),
    ],
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: true,
  };

  const order = reportRoleOrder(data);
  const entry = order.find(([role]) => role === "constructor");
  assert.ok(entry, "a constructor-named loop appears in the role order");
  assert.equal(typeof entry![1], "number", "its window total is a number, not the inherited function");
  assert.equal(entry![1], 5);
  // Day 2 has no ticks for it: the absent read must be 0, never the inherited function, so no
  // segment is fabricated and no coordinate is NaN.
  const svg = chartTicksByRole(data);
  assert.ok(!svg.includes("NaN"), "an absent role reads as 0, not Object.prototype's function");
  assert.match(svg, /style='background:#6366f1'><\/span>constructor<\/span>/, "the loop gets a legend entry");
});
test("the dashboard page abbreviates millions with M, in lockstep with compactTokens", async () => {
  // Regression (2026-09-20): the page's own fmtTokens copy stopped at `k`, so the loop
  // table's generated/peak-ctx cells and the report summary's output-tokens block rendered
  // 13,820,300 as "13820.3k" while `tumwater report` printed "13.8M". The page cannot import
  // TypeScript (a separate browser runtime), so its copy is pinned here from the page's own
  // source — same regex-extract + new Function pattern as the esc test — and every value is
  // cross-checked against the shared compactTokens so the deliberate duplicate cannot drift.
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const m = /const fmtTokens = \((\w+)\) => (.+);$/m.exec(GUI_PAGE);
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

test("the lazily built Usage/Failures heads carry their blurbs — a dropped blurb never renders as \"undefined\"", async () => {
  // Regression (2026-09-30): the windowView configs initially omitted blurb, so the lazy-built
  // view heads rendered "<p>undefined</p>" where main showed their descriptive subtitles. The
  // delegates are driven here against a stub DOM so the built head is observed, not guessed.
  const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(): void }> = {};
  for (const id of ["report", "failures", "usagebody", "failbody", "usagewindow", "failwindow"]) {
    els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
  }
  const scope = clientScope<{ fetchReport(throttled?: boolean): Promise<void>; fetchFailures(): Promise<void>; viewHead(title: string, blurb?: string, pickerId?: string, choices?: number[], current?: number, refreshId?: string): string }>(
    ["panel-build", "view-scaffold"], ["fetchReport", "fetchFailures", "viewHead"], {
      document: { getElementById: (id: string) => els[id] ?? null },
      $: (id: string) => els[id] ?? null,
      markActive: () => {},
      recall: () => null,
      store: () => {},
      lastStatus: null,
      // The fetch itself rejects: the head is built before the body renders, so the assertion
      // sees the lazy-built head while the failure path exercises errorPanel wiring too.
      getJson: async () => { throw new Error("/api/report failed: HTTP 503"); },
      errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
      clickClosest: () => null,
      renderMarkdown: (md: string) => md,
      icon: iconStub,
    });

  await scope.fetchReport();
  assert.match(els.report!.innerHTML, /What the team produced and what it cost, per day and per role\./,
    "the Usage head's subtitle survives the windowView extraction");
  assert.doesNotMatch(els.report!.innerHTML, /undefined/);
  assert.match(els.usagebody!.innerHTML, /Usage report unavailable/, "the error path still names the view");

  await scope.fetchFailures();
  assert.match(els.failures!.innerHTML, /What went wrong, where, and how often — the digest the telemetry role reads\./,
    "the Failures head's subtitle survives the windowView extraction");
  assert.doesNotMatch(els.failures!.innerHTML, /undefined/);

  // And viewHead itself renders a dropped blurb as no subtitle at all, never the string.
  const head = scope.viewHead("T", undefined, "p", [7], 7, "r");
  assert.doesNotMatch(head, /undefined/);
  assert.doesNotMatch(head, /<p>/, "no blurb means no subtitle element");
  assert.match(scope.viewHead("T", "b", "p", [7], 7, "r"), /<p>b<\/p>/);
});

test("the Usage sparse-window note is the shared SPARSE_WINDOW_NOTE, verbatim", async () => {
  // The note the CLI and TUI renders print when older events may have rotated out is
  // events/event-window.ts's SPARSE_WINDOW_NOTE; the page's Usage caption must carry that
  // same sentence rather than a re-typed copy, so the three surfaces cannot drift.
  const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(): void }> = {};
  for (const id of ["report", "usagebody", "usagewindow", "failures", "failbody", "failwindow"]) {
    els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
  }
  const day = {
    date: "2026-10-07", tokensOut: 100, ticksByRole: { feature: 1 }, costByRole: { feature: 0.01 },
    commits: 1, costUsd: 0.01, featuresDone: 0, bugsFixed: 0,
  };
  const report = {
    days: 7, from: "2026-10-01", to: "2026-10-07", series: [day],
    totals: { tokensOut: 100, ticks: 1, commits: 1, costUsd: 0.01, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 },
    coversFullWindow: false,
  };
  // reportSummary sits outside the marked regions, so the whole report blob runs here (the
  // composer test's seam) with stand-ins for its helpers — esc rides in via ESC_LINE.
  const inject = {
    document: { getElementById: (id: string) => els[id] ?? null },
    $: (id: string) => els[id] ?? null,
    markActive: () => {},
    recall: () => null,
    store: () => {},
    lastStatus: null,
    getJson: async () => report,
    errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
    clickClosest: () => null,
    renderMarkdown: (md: string) => md,
    icon: iconStub,
    plural: (n: number, one: string) => `${n} ${one}`,
    workSplit: (t: { workCommits?: number; maintenanceCommits?: number }) => `${t.workCommits ?? 0} work / ${t.maintenanceCommits ?? 0} maintenance`,
    fmtTokens: (n: number) => String(n),
    fmtUsd: (n: number) => "$" + n.toFixed(2),
  };
  const keys = Object.keys(inject);
  const run = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport };`) as (
    ...args: unknown[]
  ) => { fetchReport(throttled?: boolean): Promise<void> };
  await run(...keys.map((k) => inject[k as keyof typeof inject])).fetchReport();
  assert.match(els.usagebody!.innerHTML, /2026-10-01 → 2026-10-07/);
  assert.ok(els.usagebody!.innerHTML.includes(SPARSE_WINDOW_NOTE),
    "the sparse-window sentence is the shared constant, not a re-typed copy");
});

test("the scoped Usage render drops the fleet-only tiles and prints the scope line", async () => {
  // The Usage summary must not present the fleet-wide backlog tallies as the scoped role's:
  // when the payload carries a role, the Features done/Bugs fixed tiles stay out and one scope
  // line names the role and the omission. Both the whole report blob (the sparse-window test's
  // seam) and the scoped/unscoped payloads run here so the fleet-wide render is checked too.
  const day = {
    date: "2026-10-07", tokensOut: 100, ticksByRole: { feature: 1 }, costByRole: { feature: 0.01 },
    commits: 1, costUsd: 0.01, featuresDone: 0, bugsFixed: 0,
  };
  const totals = { tokensOut: 100, ticks: 1, commits: 1, costUsd: 0.01, featuresDone: 2, bugsFixed: 3, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 };
  const window = { days: 7, from: "2026-10-01", to: "2026-10-07", series: [day], totals, coversFullWindow: true };

  const runWith = async (payload: unknown): Promise<string> => {
    const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(): void }> = {};
    for (const id of ["report", "usagebody", "usagewindow", "failures", "failbody", "failwindow", "usagerole", "failrole"]) {
      els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
    }
    const inject = {
      document: { getElementById: (id: string) => els[id] ?? null },
      $: (id: string) => els[id] ?? null,
      markActive: () => {},
      recall: () => null,
      store: () => {},
      lastStatus: { loops: [{ role: "feature" }, { role: "bugfix" }] },
      getJson: async () => payload,
      errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
      clickClosest: () => null,
      renderMarkdown: (md: string) => md,
      icon: iconStub,
      plural: (n: number, one: string) => `${n} ${one}`,
      workSplit: (t: { workCommits?: number; maintenanceCommits?: number }) => `${t.workCommits ?? 0} work / ${t.maintenanceCommits ?? 0} maintenance`,
      fmtTokens: (n: number) => String(n),
      fmtUsd: (n: number) => "$" + n.toFixed(2),
    };
    const keys = Object.keys(inject);
    const run = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport };`) as (
      ...args: unknown[]
    ) => { fetchReport(throttled?: boolean): Promise<void> };
    await run(...keys.map((k) => inject[k as keyof typeof inject])).fetchReport();
    return els.usagebody!.innerHTML;
  };

  const scoped = await runWith({ ...window, role: "feature" });
  assert.match(scoped, /Role scope: feature/, "the scoped render names the role");
  assert.match(scoped, /merge runs and backlog tallies .* are team-wide and omitted/, "and states the omission");
  assert.doesNotMatch(scoped, /Features done/, "the fleet-only backlog tiles stay out");
  assert.doesNotMatch(scoped, /Bugs fixed/);

  const fleet = await runWith(window);
  assert.match(fleet, /Features done/, "the fleet-wide render keeps the backlog tiles");
  assert.match(fleet, /Bugs fixed/);
  assert.doesNotMatch(fleet, /Role scope:/, "and prints no scope line");
});

test("the report Loop picker offers base roles only, so an instance id never labels another scope's body", async () => {
  // The scoped collectors fold an instance id (`feature-2`) into its base role, so offering the
  // instance would collect `feature`'s whole body under `feature-2`'s name — the GUI twin of
  // the TUI Ctrl+G bug. syncRoles paints rolePickerOptions(reportBaseRoles(loops)), so the
  // picker offers one `feature` option and no `feature-2`, and a persisted instance scope falls
  // back to All roles instead of collecting the base body under the instance's name.
  const els: Record<string, { dataset: Record<string, string>; innerHTML: string; value?: string; addEventListener(): void }> = {};
  for (const id of ["report", "usagebody", "usagewindow", "failures", "failbody", "failwindow", "usagerole", "failrole"]) {
    els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
  }
  const stored: Array<[string, string]> = [];
  const inject = {
    document: { getElementById: (id: string) => els[id] ?? null },
    $: (id: string) => els[id] ?? null,
    markActive: () => {},
    // The persisted report scope names the instance id old builds offered.
    recall: (key: string) => (key === "usage-role" ? "feature-2" : null),
    store: (key: string, value: string) => { stored.push([key, value]); },
    lastStatus: { loops: [{ role: "feature" }, { role: "feature-2", instanceOf: "feature" }, { role: "clean" }] },
    getJson: async () => ({ markdown: "# usage" }),
    errorPanel: (title: string) => title,
    clickClosest: () => null,
    renderMarkdown: (md: string) => md,
    icon: iconStub,
    plural: (n: number, one: string) => `${n} ${one}`,
    workSplit: (t: { workCommits?: number }) => String(t.workCommits ?? 0),
    fmtTokens: (n: number) => String(n),
    fmtUsd: (n: number) => "$" + n.toFixed(2),
  };
  const keys = Object.keys(inject);
  const make = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport };`) as (
    ...args: unknown[]
  ) => { fetchReport(): Promise<void> };
  await make(...keys.map((k) => inject[k as keyof typeof inject])).fetchReport();
  const options = els.usagerole!.innerHTML;
  assert.match(options, /<option value='feature'>feature<\/option>/, "the base role is offered");
  assert.doesNotMatch(options, /feature-2/, "the instance id collects feature's body, so it is not an option");
  assert.equal(els.usagerole!.value, "", "a persisted instance scope falls back to All roles");
  assert.deepEqual(stored, [["usage-role", ""]], "and the fallback persists");
});

test("the Usage trailing-window control fetches ?sinceMs, renders markdown, and a day click reverts", async () => {
  // The dashboard twin of `tumwater report --since`: a persisted "usage-since" makes the Usage
  // tab fetch the windowed markdown shape and render it through the page's Markdown renderer;
  // clicking a day button clears it and fetches the day shape. The whole report blob runs here
  // (the sparse-window test's seam) so viewHead's since buttons, windowView's fetch, and its
  // click wiring are all exercised, not guessed.
  const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(type: string, fn: (ev: unknown) => void): void }> = {};
  const getJsonUrls: string[] = [];
  const markCalls: [string, unknown][] = [];
  let clickHandler: ((ev: unknown) => void) | null = null;
  for (const id of ["report", "failures", "usagebody", "failbody", "usagewindow", "failwindow", "usagerole", "failrole"]) {
    const el: { dataset: Record<string, string>; innerHTML: string; addEventListener(type: string, fn: (ev: unknown) => void): void } = {
      dataset: {}, innerHTML: "",
      addEventListener(type, fn) { if (type === "click" && id === "report") clickHandler = fn; },
    };
    els[id] = el;
  }
  // clickClosest's stand-in: report whichever button the current phase wants found.
  let sinceClick: { dataset: Record<string, string> } | null = null;
  let daysClick: { dataset: Record<string, string> } | null = null;
  const inject = {
    document: { getElementById: (id: string) => els[id] ?? null },
    $: (id: string) => els[id] ?? null,
    markActive: (_box: unknown, attr: string, cur: unknown) => { markCalls.push([attr, cur]); },
    recall: (key: string) => (key === "usage-since" ? "3600000" : null),
    store: () => {},
    lastStatus: null,
    getJson: async (url: string) => {
      getJsonUrls.push(url);
      return { markdown: "# tumwater usage report\n\nwindow: last 1h" };
    },
    errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
    clickClosest: (_ev: unknown, sel: string) => (sel === "[data-since]" ? sinceClick : sel === "[data-days]" ? daysClick : null),
    renderMarkdown: (md: string) => "<rendered>" + md + "</rendered>",
    icon: iconStub,
    plural: (n: number, one: string) => `${n} ${one}`,
    workSplit: (t: { workCommits?: number; maintenanceCommits?: number }) => `${t.workCommits ?? 0} work / ${t.maintenanceCommits ?? 0} maintenance`,
    fmtTokens: (n: number) => String(n),
    fmtUsd: (n: number) => "$" + n.toFixed(2),
  };
  const keys = Object.keys(inject);
  const run = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport };`) as (
    ...args: unknown[]
  ) => { fetchReport(throttled?: boolean): Promise<void> };
  const { fetchReport } = run(...keys.map((k) => inject[k as keyof typeof inject]));

  await fetchReport();
  assert.equal(getJsonUrls[0], "/api/report?sinceMs=3600000", "the persisted since window rides the request");
  assert.match(els.report!.innerHTML, /data-since='3600000'>1h</, "the toolbar carries the since button");
  assert.match(els.usagebody!.innerHTML, /<rendered>/, "the markdown payload renders through renderMarkdown");
  assert.match(els.usagebody!.innerHTML, /window: last 1h/);
  assert.doesNotMatch(els.usagebody!.innerHTML, /<svg/, "not the chart path");
  assert.ok(markCalls.some(([attr, cur]) => attr === "since" && cur === 3600000), "markActive marks the since button");
  assert.ok(markCalls.some(([attr, cur]) => attr === "days" && cur === -1), "and clears the day buttons");

  // A day-button click clears the persisted since window and fetches the day shape.
  sinceClick = null;
  daysClick = { dataset: { days: "7" } };
  clickHandler!({});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(getJsonUrls[1], "/api/report?days=7", "the day click reverts to ?days");
});

test("the report window pickers normalize a persisted value outside their menu", async () => {
  // Regression (2026-10-10): a persisted "usage-days" or "usage-since" outside the picker's
  // offered choices (a stale or hand-edited localStorage entry) used to ride the fetch while
  // marking no button, so the request and the shown window disagreed and never healed. windowView
  // now normalizes each persisted picker value to an offered choice at read.
  const run = async (stored: Record<string, string>) => {
    const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(): void }> = {};
    const getJsonUrls: string[] = [];
    const markCalls: [string, unknown][] = [];
    for (const id of ["report", "failures", "usagebody", "failbody", "usagewindow", "failwindow", "usagerole", "failrole"]) {
      els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
    }
    const inject = {
      document: { getElementById: (id: string) => els[id] ?? null },
      $: (id: string) => els[id] ?? null,
      markActive: (_box: unknown, attr: string, cur: unknown) => { markCalls.push([attr, cur]); },
      recall: (key: string) => stored[key] ?? null,
      store: () => {},
      lastStatus: null,
      getJson: async (url: string) => { getJsonUrls.push(url); return { markdown: "# usage" }; },
      errorPanel: (title: string) => title,
      clickClosest: () => null,
      renderMarkdown: (md: string) => md,
      icon: iconStub,
      plural: (n: number, one: string) => `${n} ${one}`,
      workSplit: (t: { workCommits?: number }) => String(t.workCommits ?? 0),
      fmtTokens: (n: number) => String(n),
      fmtUsd: (n: number) => "$" + n.toFixed(2),
    };
    const keys = Object.keys(inject);
    const make = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport };`) as (
      ...args: unknown[]
    ) => { fetchReport(): Promise<void> };
    await make(...keys.map((k) => inject[k as keyof typeof inject])).fetchReport();
    return { urls: getJsonUrls, marks: markCalls, els };
  };

  const offMenuDays = await run({ "usage-days": "45" });
  assert.equal(offMenuDays.urls[0], "/api/report?days=14", "an off-menu day count falls back to the view default");
  assert.ok(offMenuDays.marks.some(([attr, cur]) => attr === "days" && cur === 14), "the default day button is marked");
  assert.doesNotMatch(offMenuDays.els.report!.innerHTML, /data-days='45'/, "the toolbar offers only the configured choices");

  const offMenuSince = await run({ "usage-since": "12345" });
  assert.equal(offMenuSince.urls[0], "/api/report?days=14", "an off-menu trailing window falls back to the day window");
  assert.ok(offMenuSince.marks.some(([attr, cur]) => attr === "days" && cur === 14), "the day window is the active one");
});

test("the Usage notional chart and Spent-tile figure render only when notional spend exists", async () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartCostByRole(d: ReportData): string;
    chartNotionalByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartTicksByRole, chartCostByRole, chartNotionalByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartCostByRole", "chartNotionalByRole"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay>): ReportDay => ({
    date, tokensOut: 0, ticksByRole: { feature: 2 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, landingRuns: 0, landingTokens: 0, landingCostUsd: 0 };
  const data: ReportData = {
    days: 2, from: "2026-09-01", to: "2026-09-02",
    series: [
      mkDay("2026-09-01", { notionalByRole: { feature: 1.5, plan: 0.5 }, notionalCostUsd: 2 }),
      mkDay("2026-09-02", {}),
    ],
    totals: { ...totals, notionalCostUsd: 2 }, coversFullWindow: true,
  };
  const rects = (svg: string) => svg.match(/<rect /g)?.length ?? 0;
  assert.equal(rects(chartNotionalByRole(data)), 2, "one segment per (day, loop) with notional spend");
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartNotionalByRole(data)), legendOf(chartTicksByRole(data)));
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["plan", 0]], "a notional-only loop ranks after loops with ticks");
  assert.equal(rects(chartCostByRole(data)), 0, "absent costByRole renders no segments");

  const render = async (report: unknown): Promise<string> => {
    const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(): void }> = {};
    for (const id of ["report", "usagebody", "usagewindow", "failures", "failbody", "failwindow"]) {
      els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
    }
    const inject = {
      document: { getElementById: (id: string) => els[id] ?? null },
      $: (id: string) => els[id] ?? null,
      markActive: () => {}, recall: () => null, store: () => {}, lastStatus: null,
      getJson: async () => report,
      errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
      clickClosest: () => null, renderMarkdown: (md: string) => md, icon: iconStub,
      plural: (n: number, one: string) => `${n} ${one}`,
      workSplit: () => "0 work / 0 maintenance",
      fmtTokens: (n: number) => String(n),
      fmtUsd: (n: number) => "$" + n.toFixed(2),
    };
    const keys = Object.keys(inject);
    const run = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport };`) as (
      ...args: unknown[]
    ) => { fetchReport(throttled?: boolean): Promise<void> };
    await run(...keys.map((k) => inject[k as keyof typeof inject])).fetchReport();
    return els.usagebody!.innerHTML;
  };
  const withNotional = await render({
    ...data, totals: { ...totals, notionalCostUsd: 12.5 },
  });
  for (const s of ["Estimated spend by role", "API-equivalent, not in the cap", "$12.50 estimated"]) {
    assert.ok(withNotional.includes(s), s);
  }
  const without = await render({
    ...data, series: data.series.map((d) => mkDay(d.date, {})), totals,
  });
  for (const s of ["Estimated spend by role", "API-equivalent, not in the cap", "estimated"]) {
    assert.ok(!without.includes(s), s);
  }
});
