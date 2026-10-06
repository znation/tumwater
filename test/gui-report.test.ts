import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectReport, type ReportData, type ReportDay } from "../src/report-data.js";
import { collectFailureReport } from "../src/failure/failure-data.js";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { eventsLogPath } from "../src/paths.js";
import { compactTokens } from "../src/format.js";
import { initProject } from "../src/init.js";
import { atLocalTs as atNoon, dayKey } from "./oracles.js";
import { withGui } from "./gui-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";
import { writeLogLines } from "./log-fixtures.js";
import { clientScope, iconStub } from "./gui-client-scope.js";

// The GUI report tab (PLANS.md "report 2/3"): /api/report serves collectReport's ReportData
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
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "tick_end", tick: 2, result: "no_change" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "tick_end", tick: 3, result: "no_change", tokens: 250, costUsd: 1.5 }),
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
  // costByRole rides along in the JSON — split from the same tick_end events as costUsd.
  const spendDay = d.series.find((x) => x.date === dayKey(atNoon(3)));
  assert.deepEqual(spendDay?.costByRole, { feature: 0.25 }, "/api/report carries costByRole per role");
  const todayTick = d.series.find((x) => x.date === dayKey(atNoon(0)));
  assert.deepEqual(todayTick?.costByRole, { steward: 1.5 });
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
  });
});

test("gui /api/failures serves the rendered digest and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "failures api test");
  // Seed events with explicit ts values across roles, including one error so the digest has a
  // cluster to render — the endpoint's whole job is to hand back renderFailureMarkdown's text.
  const evFile = eventsLogPath(repo);
  writeLogLines(evFile, [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "tick_end", tick: 2, result: "error", error: "pi exited 1" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "tick_end", tick: 3, result: "no_change" }),
    ]);

  await withGui(repo, async ({ base }) => {
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
  });
});

test("the Usage and Failures views fetch their window on activation, never on a timer", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // Both views have a container and a sidebar link; the window pickers choose the days.
  assert.match(GUI_PAGE, /<section id="report" class="view" aria-label="Usage" hidden><\/section>/);
  assert.match(GUI_PAGE, /<section id="failures" class="view" aria-label="Failures" hidden><\/section>/);
  assert.match(GUI_PAGE, /endpoint: \(days\) => "\/api\/report\?days=" \+ days/);
  assert.match(GUI_PAGE, /endpoint: \(days\) => "\/api\/failures\?days=" \+ days/);
  assert.match(GUI_PAGE, /if \(v === "usage"\) fetchReport\(\)/);
  assert.match(GUI_PAGE, /if \(v === "failures"\) fetchFailures\(\)/);
  // The fleet view's "today" tiles read a one-day report, refreshed on new events.
  assert.match(GUI_PAGE, /getJson\("\/api\/report\?days=1", pollSignal\(\)\)/);
  assert.equal(GUI_PAGE.match(/setTimeout\(pollLoop, 1000\)/g)?.length ?? 0, 1, "the only poll is the 1 s status refresh");
});
test("the report charts carry a cursor-following hover label", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
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
  type Builders = {
    chartTokens(d: ReportData): string;
    chartTicksByRole(d: ReportData): string;
    chartCommits(d: ReportData): string;
    chartCostByRole(d: ReportData): string;
    niceMax(v: number, integer: boolean): number;
    reportDayLabels(series: ReportDay[]): string[];
    REPORT_PALETTE: string[];
  };
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
  assert.ok(commitRects.some((r) => r.title === "2026-09-04: 2 commits landed"));

  // Ticks by loop: one segment per (day, loop); the busiest loop sits at the bottom and leads
  // the legend, each loop keeping one palette color.
  const stacked = parseRects(chartTicksByRole(data));
  assert.equal(stacked.length, 7 * 2 + 6 * 1);
  const day0 = stacked.filter((r) => r.title.startsWith("2026-09-01 "));
  const feat = day0.find((r) => r.title.includes("feature"))!;
  const bug = day0.find((r) => r.title.includes("bugfix"))!;
  assert.ok(feat.y > bug.y, "the busiest loop sits at the bottom of the stack");
  assert.ok(Math.abs(feat.h - 3 * bug.h) < 0.05, "segment heights are proportional to their values");
  assert.equal(feat.title, "2026-09-01 · feature: 3 ticks");
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

test("the lazily built Usage/Failures heads carry their blurbs — a dropped blurb never renders as \"undefined\"", async () => {
  // Regression (2026-09-30): the windowView configs initially omitted blurb, so the lazy-built
  // view heads rendered "<p>undefined</p>" where main showed their descriptive subtitles. The
  // delegates are driven here against a stub DOM so the built head is observed, not guessed.
  const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(): void }> = {};
  for (const id of ["report", "failures", "usagebody", "failbody", "usagewindow", "failwindow"]) {
    els[id] = { dataset: {}, innerHTML: "", addEventListener() {} };
  }
  const scope = clientScope<{ fetchReport(throttled?: boolean): Promise<void>; fetchFailures(): Promise<void>; viewHead(title: string, blurb?: string, pickerId?: string, choices?: number[], current?: number, refreshId?: string): string }>(
    ["view-scaffold"], ["fetchReport", "fetchFailures", "viewHead"], {
      document: { getElementById: (id: string) => els[id] ?? null },
      $: (id: string) => els[id] ?? null,
      markActive: () => {},
      recall: () => null,
      store: () => {},
      // The fetch itself rejects: the head is built before the body renders, so the assertion
      // sees the lazy-built head while the failure path exercises errorPanel wiring too.
      getJson: async () => { throw new Error("/api/report failed: HTTP 503"); },
      errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
      clickClosest: () => null,
      renderMarkdown: (md: string) => md,
      icon: iconStub,
    });

  await scope.fetchReport();
  assert.match(els.report!.innerHTML, /What the fleet produced and what it cost, per day and per loop\./,
    "the Usage head's subtitle survives the windowView extraction");
  assert.doesNotMatch(els.report!.innerHTML, /undefined/);
  assert.match(els.usagebody!.innerHTML, /Usage report unavailable/, "the error path still names the view");

  await scope.fetchFailures();
  assert.match(els.failures!.innerHTML, /What went wrong, where, and how often — the digest the telemetry loop reads\./,
    "the Failures head's subtitle survives the windowView extraction");
  assert.doesNotMatch(els.failures!.innerHTML, /undefined/);

  // And viewHead itself renders a dropped blurb as no subtitle at all, never the string.
  const head = scope.viewHead("T", undefined, "p", [7], 7, "r");
  assert.doesNotMatch(head, /undefined/);
  assert.doesNotMatch(head, /<p>/, "no blurb means no subtitle element");
  assert.match(scope.viewHead("T", "b", "p", [7], 7, "r"), /<p>b<\/p>/);
});
