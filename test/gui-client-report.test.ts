import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_REPORT_JS } from "../src/ui/gui/gui-client-report.js";
import { GUI_CLIENT_REPORT_CHART_JS } from "../src/ui/gui/gui-client-report-chart.js";
import { clientScope, clientRegion, ESC_LINE, iconStub } from "./helpers/gui-client-scope.js";
import type { ReportData, ReportDay, ReportTotals } from "../src/report/report-types.js";

// The report tab's hover chip (gui-client-report.ts's report-tip region) runs in the
// browser, so it is exercised here through the same regex-extract + new Function seam as
// the chart builders in gui-report.test.ts — with a minimal DOM shim standing in for
// document/window/Element, the three globals the region reaches for.

type Style = Record<string, string>;
interface El {
  id: string;
  style: Style;
  children: El[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  box: { width: number; height: number };
  textContent: string;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  getBoundingClientRect(): { width: number; height: number };
}

function makeEl(id = ""): El {
  const el: El = {
    id,
    style: {},
    children: [],
    listeners: new Map(),
    box: { width: 100, height: 30 },
    textContent: "",
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    getBoundingClientRect() {
      return el.box;
    },
  };
  return el;
}

// A rect target inside the rendered SVG: closest("rect") finds it, and its <title> child
// carries the segment's tooltip text — the chip's label. The object must be an instance of
// the injected Element class — the region guards with `ev.target instanceof Element`.
function makeRectTarget(title: string, elementClass: abstract new () => unknown) {
  const rect = {
    querySelector: (sel: string) => (sel === "title" && title ? { textContent: title } : null),
  };
  return Object.assign(Object.create(elementClass.prototype), {
    closest: (sel: string) => (sel === "rect" ? rect : null),
  });
}

function makeDom() {
  // Real code assigns tip.id after createElement, so the registry resolves by each
  // element's *current* id rather than snapshotting at creation time.
  const created: El[] = [];
  const bodyChildren: El[] = [];
  const doc = {
    getElementById: (id: string) => created.find((el) => el.id === id),
    createElement: (_tag: string) => {
      const el = makeEl();
      created.push(el);
      return el;
    },
    body: { appendChild: (el: El) => bodyChildren.push(el) },
  };
  const win = { innerWidth: 1000, innerHeight: 768 };
  class ElementShim {}
  // The served clickClosest (gui-client.ts's click-delegate region) narrowed to this shim's
  // Element class, so the region's call resolves the way the browser resolves it.
  const clickClosest = (ev: { target?: unknown }, selector: string): unknown =>
    ev.target instanceof ElementShim
      ? (ev.target as { closest(sel: string): unknown }).closest(selector)
      : null;
  const body = new Function(
    "document",
    "window",
    "Element",
    "clickClosest",
    `${/\/\/ report-tip:start\n([\s\S]*?)\n  \/\/ report-tip:end/.exec(GUI_CLIENT_REPORT_JS)![1]}\nreturn { attachReportTip, hideReportTip };`,
  ) as (doc: unknown, win: unknown, element: unknown, clickClosest: unknown) => {
    attachReportTip(): void;
    hideReportTip(): void;
  };
  const api = body(doc, win, ElementShim, clickClosest);

  const panel = makeEl("report");
  created.push(panel);
  return {
    api,
    panel,
    created,
    bodyChildren,
    elementClass: ElementShim,
    move: (target: unknown, clientX: number, clientY: number) =>
      panel.listeners.get("pointermove")![0]!({ target, clientX, clientY }),
    leave: () => panel.listeners.get("pointerleave")![0]!(),
    tip: () => created.find((el) => el.id === "report-tip"),
  };
}

test("the report hover chip shows a rect's title beside the cursor and hides off-chart", () => {
  const dom = makeDom();
  dom.api.attachReportTip();

  // A rect hover shows the chip at the cursor + 12px, with the segment's tooltip text —
  // the same string the chart builders escaped into the <title>.
  dom.move(makeRectTarget("2026-09-01 feature: 3", dom.elementClass), 100, 100);
  let tip = dom.tip();
  assert.ok(tip, "the chip is created on first use");
  assert.equal(tip!.style.display, "block");
  assert.equal(tip!.textContent, "2026-09-01 feature: 3");
  assert.equal(tip!.style.left, "112px");
  assert.equal(tip!.style.top, "112px");

  // Moving onto a non-rect (gaps, axis, stats) hides the chip.
  dom.move(makeRectTarget("", dom.elementClass), 100, 100);
  assert.equal(dom.tip()!.style.display, "none", "no title hides the chip");
  dom.move(Object.assign(Object.create(dom.elementClass.prototype), { closest: () => null }), 100, 100);
  assert.equal(dom.tip()!.style.display, "none", "an Element that is not a rect hides the chip");

  // Leaving the panel hides it too.
  dom.move(makeRectTarget("2026-09-02: 1.0k", dom.elementClass), 100, 100);
  dom.leave();
  assert.equal(dom.tip()!.style.display, "none", "pointerleave hides the chip");
});

test("the report hover chip flips inside the viewport's right and bottom edges", () => {
  const dom = makeDom();
  dom.api.attachReportTip();

  // 12px right of x=990 would overflow the 1000px viewport, so the chip moves to the
  // cursor's other side (990 - 100 - 12); the same rule holds at the bottom edge.
  dom.move(makeRectTarget("2026-09-01: 5.0k", dom.elementClass), 990, 100);
  assert.equal(dom.tip()!.style.left, "878px", "right-edge overflow flips the chip left");
  assert.equal(dom.tip()!.style.top, "112px");

  dom.move(makeRectTarget("2026-09-01: 5.0k", dom.elementClass), 100, 760);
  assert.equal(dom.tip()!.style.top, "718px", "bottom-edge overflow flips the chip up");
  assert.equal(dom.tip()!.style.left, "112px");
});

test("the report hover chip is created once and lives outside #report", () => {
  const dom = makeDom();
  dom.api.attachReportTip();

  // Two hovers (as re-rendered charts would produce) still leave exactly one chip, appended
  // to document.body — fetchReport replaces #report's innerHTML, so a chip inside the panel
  // would be destroyed on every re-render.
  dom.move(makeRectTarget("2026-09-01: 5.0k", dom.elementClass), 100, 100);
  dom.move(makeRectTarget("2026-09-02: 1.0k", dom.elementClass), 120, 120);
  const chips = dom.created.filter((el) => el.id === "report-tip");
  assert.equal(chips.length, 1, "the chip is created idempotently");
  assert.deepEqual(
    dom.bodyChildren,
    chips,
    "the chip lives on document.body, outside the re-rendered #report",
  );
});

test("rolePickerOptions renders All roles plus one escaped option per role, order preserved", () => {
  // The Role picker's options are the pure half of the role scope every picker shares (the
  // Usage/Failures views and History): the team list comes from /api/status's roles, custom
  // roles included, so a role name can carry HTML metacharacters and must be escaped in both
  // the option's value and its label.
  const { rolePickerOptions } = clientScope<{ rolePickerOptions(roles?: string[]): string }>(
    ["format", "report-role"],
    ["rolePickerOptions"],
  );
  assert.equal(rolePickerOptions([]), "<option value=''>All roles</option>", "no roles leaves only the team-wide option");
  assert.equal(
    rolePickerOptions(["feature", "bugfix"]),
    "<option value=''>All roles</option>" +
      "<option value='feature'>feature</option>" +
      "<option value='bugfix'>bugfix</option>",
    "one option per role, in the order given",
  );
  const hostile = rolePickerOptions(["<b>x</b>"]);
  assert.doesNotMatch(hostile, /<b>x<\/b>/, "raw HTML in a role name is not rendered");
  assert.match(hostile, /<option value='&lt;b&gt;x&lt;\/b&gt;'>&lt;b&gt;x&lt;\/b&gt;<\/option>/, "value and label are escaped");
});

test("reportBaseRoles folds each instance into its `instanceOf` base role, once, in team order", () => {
  // The report views' Role picker must offer the same roles the scoped collectors honor. The
  // status payload names an instance's base as `instanceOf`; a bare row has none, so its own
  // role is the base. Dedupe keeps a multi-instance base to a single option.
  const { reportBaseRoles } = clientScope<{ reportBaseRoles(roles?: Array<{ role: string; instanceOf?: string }>): string[] }>(
    ["format", "report-role"],
    ["reportBaseRoles"],
  );
  assert.deepEqual(reportBaseRoles([]), [], "no roles leaves no roles");
  assert.deepEqual(
    reportBaseRoles([{ role: "feature" }, { role: "feature-2", instanceOf: "feature" }, { role: "bugfix-2", instanceOf: "bugfix" }, { role: "clean" }]),
    ["feature", "bugfix", "clean"],
    "one slot per base role, first occurrence order preserved",
  );
});

test("the Rejections by role chart stacks per role in the runs order and stays empty without a map", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartRejectionsByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartRunsByRole, chartRejectionsByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartRejectionsByRole"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, rejectionsByRole?: Record<string, number>): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
    ...(rejectionsByRole ? { rejectionsByRole } : {}),
  });
  const data: ReportData = {
    days: 2, from: "2026-09-01", to: "2026-09-02",
    series: [
      mkDay("2026-09-01", { feature: 3 }, { feature: 2, bugfix: 1 }),
      mkDay("2026-09-02", { feature: 1 }, { qa: 1 }),
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  const parseRects = (svg: string) =>
    [...svg.matchAll(/<rect x='([\d.]+)' y='([\d.]+)' width='([\d.]+)' height='([\d.]+)' rx='2' fill='([^']*)'><title>([^<]*)<\/title><\/rect>/g)].map(
      (r) => ({ y: +r[2]!, h: +r[3]!, title: r[6]! }),
    );
  // A role that rejected but never ran (qa) still keeps a stack row, after the tickers.
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0], ["qa", 0]]);
  const rects = parseRects(chartRejectionsByRole(data));
  assert.equal(rects.length, 3, "one segment per (day, role) with a rejection");
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartRejectionsByRole(data)), legendOf(chartRunsByRole(data)), "same per-role order and colors as the runs element");
  // A missing rejectionsByRole map renders the element empty (no segments).
  const none = mkDay("2026-09-01", { feature: 2 });
  const emptySvg = chartRejectionsByRole({ ...data, series: [none, { ...none, date: "2026-09-02" }] });
  assert.equal(parseRects(emptySvg).length, 0, "a missing map renders no segments");
});

test("the Post-merge rejections by role chart stacks per role and stays empty without a map", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartPostMergeRejectionsByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartRunsByRole, chartPostMergeRejectionsByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartPostMergeRejectionsByRole"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  // A role that rejected post-merge but never ran (qa) still keeps a stack row.
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { rejectionsByRole: { feature: 2, bugfix: 1 }, postMergeRejectionsByRole: { feature: 2, bugfix: 1 } }),
    mkDay("2026-09-02", { feature: 1 }, { rejectionsByRole: { qa: 1 }, postMergeRejectionsByRole: { qa: 1 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0], ["qa", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.equal(titles(chartPostMergeRejectionsByRole(data)).length, 3, "one segment per (day, role) with a post-merge rejection");
  assert.ok(titles(chartPostMergeRejectionsByRole(data)).some((t) => t.includes("2026-09-01 · feature: 2 post-merge rejections")));
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartPostMergeRejectionsByRole(data)), legendOf(chartRunsByRole(data)), "same per-role order and colors as the runs element");
  // A missing postMergeRejectionsByRole map renders the element empty (no segments).
  const none = mkDay("2026-09-01", { feature: 2 });
  const emptySvg = chartPostMergeRejectionsByRole({ ...data, series: [none, { ...none, date: "2026-09-02" }] });
  assert.equal(titles(emptySvg).length, 0, "a missing map renders no segments");
});

test("the image-reroute chart is gone and the Fallbacks chart stacks per role with seriesHasAny gating", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartFallbacksByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartRunsByRole, chartFallbacksByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartFallbacksByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { fallbacksByRole: { feature: 2 } }),
    mkDay("2026-09-02", { feature: 1 }, { fallbacksByRole: { bugfix: 1 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.equal(titles(chartFallbacksByRole(data)).length, 2);
  assert.ok(titles(chartFallbacksByRole(data)).some((t) => t.includes("2026-09-01 · feature: 2 fallbacks")));
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartFallbacksByRole(data)), legendOf(chartRunsByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { fallbacksByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "fallbacksByRole"), false);
  assert.equal(seriesHasAny(data, "fallbacksByRole"), true);
});

test("the Failed runs and Merge failures charts stack per role and seriesHasAny gates them", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartFailedRunsByRole(d: ReportData): string;
    chartMergeFailuresByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartRunsByRole, chartFailedRunsByRole, chartMergeFailuresByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartFailedRunsByRole", "chartMergeFailuresByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { failedRunsByRole: { feature: 2 }, mergeFailedByRole: { qa: 1 } }),
    mkDay("2026-09-02", { feature: 1 }, { failedRunsByRole: { bugfix: 1 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0], ["qa", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.equal(titles(chartFailedRunsByRole(data)).length, 2);
  assert.ok(titles(chartFailedRunsByRole(data)).some((t) => t.includes("2026-09-01 · feature: 2 failed runs")));
  assert.equal(titles(chartMergeFailuresByRole(data)).length, 1);
  assert.ok(titles(chartMergeFailuresByRole(data)).some((t) => t.includes("qa: 1 merge failure")));
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartFailedRunsByRole(data)), legendOf(chartRunsByRole(data)));
  assert.equal(legendOf(chartMergeFailuresByRole(data)), legendOf(chartRunsByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { failedRunsByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "failedRunsByRole"), false);
  assert.equal(seriesHasAny(plain, "mergeFailedByRole"), false);
  assert.equal(seriesHasAny(data, "failedRunsByRole"), true);
  assert.equal(seriesHasAny(data, "mergeFailedByRole"), true);
});

test("the Merged by role chart stacks per role and seriesHasAny gates it", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartMergedByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartRunsByRole, chartMergedByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartMergedByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { mergedByRole: { feature: 2, qa: 1 } }),
    mkDay("2026-09-02", { feature: 1 }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["qa", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles(chartMergedByRole(data)), ["2026-09-01 · feature: 2 merges", "2026-09-01 · qa: 1 merge"]);
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartMergedByRole(data)), legendOf(chartRunsByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 })]);
  const missing = mk([mkDay("2026-09-01", { feature: 1 }, { runsByRole: { feature: 1 } }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(seriesHasAny(plain, "mergedByRole"), false);
  assert.equal(titles(chartMergedByRole(missing)).length, 0, "a day whose mergedByRole map is missing renders no merged segments");
  assert.equal(seriesHasAny(data, "mergedByRole"), true);
});

test("the Commits by role chart stacks per role in the runs order", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartCommitsByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartRunsByRole, chartCommitsByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartCommitsByRole"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { commitsByRole: { feature: 2, qa: 1 } }),
    mkDay("2026-09-02", { feature: 1 }, { commitsByRole: {} }),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles(chartCommitsByRole(data)), ["2026-09-01 · feature: 2 commits", "2026-09-01 · qa: 1 commit"]);
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartCommitsByRole(data)), legendOf(chartRunsByRole(data)));
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["qa", 0]]);
  const missing = mk([mkDay("2026-09-01", { feature: 1 }, { runsByRole: { feature: 1 } }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(titles(chartCommitsByRole(missing)).length, 0, "a day whose commitsByRole map is missing renders no commit segments");
});

test("the Revisions chart stacks per role and seriesHasAny gates it", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartRevisionsByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartRunsByRole, chartRevisionsByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartRevisionsByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { revisionsByRole: { feature: 2 } }),
    mkDay("2026-09-02", { feature: 1 }, { revisionsByRole: { bugfix: 1 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  const got = titles(chartRevisionsByRole(data));
  assert.equal(got.length, 2);
  assert.ok(got.some((t) => t.includes("2026-09-01 · feature: 2 revisions")));
  assert.ok(got.some((t) => t.includes("2026-09-02 · bugfix: 1 revision")));
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartRevisionsByRole(data)), legendOf(chartRunsByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { revisionsByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "revisionsByRole"), false);
  assert.equal(seriesHasAny(data, "revisionsByRole"), true);
});

test("the Refusals chart stacks per role and seriesHasAny gates it", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartRefusalsByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartRunsByRole, chartRefusalsByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartRefusalsByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { refusalsByRole: { feature: 2 } }),
    mkDay("2026-09-02", { feature: 1 }, { refusalsByRole: { bugfix: 1 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  const got = titles(chartRefusalsByRole(data));
  assert.equal(got.length, 2);
  assert.ok(got.some((t) => t.includes("2026-09-01 · feature: 2 refusals")));
  assert.ok(got.some((t) => t.includes("2026-09-02 · bugfix: 1 refusal")));
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartRefusalsByRole(data)), legendOf(chartRunsByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { refusalsByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "refusalsByRole"), false, "a refusal-free series whose only refusal map is { feature: 0 } gates the chart off");
  assert.equal(seriesHasAny(data, "refusalsByRole"), true);
});

test("the Usage render chain gates the Refusals by role chart right after Revisions by role", () => {
  // The usage view's render chain must name the Refusals by role chart exactly once, gated
  // on the series really carrying refusals, sitting right after the Revisions by role term.
  const chain = GUI_CLIENT_REPORT_JS;
  const revisions = chain.indexOf('block("Revisions by role"');
  const refusals = chain.indexOf('block("Refusals by role"');
  assert.ok(revisions >= 0, "the Revisions by role term exists");
  assert.ok(refusals > revisions, "Refusals by role sits after Revisions by role in the chain");
  assert.match(chain, /seriesHasAny\(d, "refusalsByRole"\) \? block\("Refusals by role", chartRefusalsByRole\(d\)\) : ""/);
  // Exactly one such gated term.
  assert.equal((chain.match(/block\("Refusals by role", chartRefusalsByRole\(d\)\)/g) || []).length, 1);
});

test("the Usage render chain gates the Post-merge rejections by role chart right after Rejections by role", () => {
  // The usage view's render chain must name the Post-merge rejections by role chart exactly
  // once, gated on the series really carrying post-merge rejections, sitting right after the
  // Rejections by role term.
  const chain = GUI_CLIENT_REPORT_JS;
  const rejections = chain.indexOf('block("Rejections by role"');
  const postMerge = chain.indexOf('block("Post-merge rejections by role"');
  assert.ok(rejections >= 0, "the Rejections by role term exists");
  assert.ok(postMerge > rejections, "Post-merge rejections by role sits after Rejections by role in the chain");
  assert.match(chain, /seriesHasAny\(d, "postMergeRejectionsByRole"\) \? block\("Post-merge rejections by role", chartPostMergeRejectionsByRole\(d\)\) : ""/);
  // Exactly one such gated term.
  assert.equal((chain.match(/block\("Post-merge rejections by role", chartPostMergeRejectionsByRole\(d\)\)/g) || []).length, 1);
});

test("the Usage render chain gates the Estimated spend by backend chart right after Estimated spend by provider", () => {
  // The usage view's render chain must name the Estimated spend by backend chart exactly
  // once, gated on the series really carrying notionalByBackend, sitting right after the
  // Estimated spend by provider term, and team-only like that provider chart.
  const chain = GUI_CLIENT_REPORT_JS;
  const provider = chain.indexOf('block("Estimated spend by provider"');
  const backend = chain.indexOf('block("Estimated spend by backend"');
  assert.ok(provider >= 0, "the Estimated spend by provider term exists");
  assert.ok(backend > provider, "Estimated spend by backend sits after Estimated spend by provider in the chain");
  assert.match(chain, /!d\.role && seriesHasAny\(d, "notionalByBackend"\) \? block\("Estimated spend by backend", chartNotionalByBackend\(d\), "per day · API-equivalent, not in the cap"\) : ""/);
  // Exactly one such gated term.
  assert.equal((chain.match(/block\("Estimated spend by backend", chartNotionalByBackend\(d\),/g) || []).length, 1);
});

test("the Usage render chain gates the Prompt tokens by role chart right after Tokens by role", () => {
  // The usage view's render chain must name the Prompt tokens by role chart exactly once,
  // gated on the series really carrying promptTokensByRole, sitting after the Tokens by role
  // term and before the Spend by role term.
  const chain = GUI_CLIENT_REPORT_JS;
  const tokensOut = chain.indexOf('block("Tokens by role"');
  const prompt = chain.indexOf('block("Prompt tokens by role"');
  const spend = chain.indexOf('block("Spend by role"');
  assert.ok(tokensOut >= 0, "the Tokens by role term exists");
  assert.ok(spend >= 0, "the Spend by role term exists");
  assert.ok(prompt > tokensOut, "Prompt tokens by role sits after Tokens by role in the chain");
  assert.ok(prompt < spend, "Prompt tokens by role sits before Spend by role in the chain");
  assert.match(chain, /seriesHasAny\(d, "promptTokensByRole"\) \? block\("Prompt tokens by role", chartPromptTokensByRole\(d\)\) : ""/);
  // Exactly one such gated term.
  assert.equal((chain.match(/block\("Prompt tokens by role", chartPromptTokensByRole\(d\)\)/g) || []).length, 1);
});

test("the Usage render chain gates the Cached prompt tokens by role chart right after Prompt tokens by role", () => {
  // The usage view's render chain must name the Cached prompt tokens by role chart exactly
  // once, gated on the series really carrying cacheReadTokensByRole, sitting after the
  // Prompt tokens by role term and before the Spend by role term.
  const chain = GUI_CLIENT_REPORT_JS;
  const tokensOut = chain.indexOf('block("Tokens by role"');
  const prompt = chain.indexOf('block("Prompt tokens by role"');
  const cached = chain.indexOf('block("Cached prompt tokens by role"');
  const spend = chain.indexOf('block("Spend by role"');
  assert.ok(tokensOut >= 0, "the Tokens by role term exists");
  assert.ok(prompt >= 0, "the Prompt tokens by role term exists");
  assert.ok(cached >= 0, "the Cached prompt tokens by role term exists");
  assert.ok(spend >= 0, "the Spend by role term exists");
  assert.ok(cached > prompt, "Cached prompt tokens by role sits after Prompt tokens by role in the chain");
  assert.ok(cached < spend, "Cached prompt tokens by role sits before Spend by role in the chain");
  assert.match(chain, /seriesHasAny\(d, "cacheReadTokensByRole"\) \? block\("Cached prompt tokens by role", chartCacheReadTokensByRole\(d\)\) : ""/);
  // Exactly one such gated term.
  assert.equal((chain.match(/block\("Cached prompt tokens by role", chartCacheReadTokensByRole\(d\)\)/g) || []).length, 1);
});

test("the Tokens by role chart stacks per role and matches the runs legend", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartTokensByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartRunsByRole, chartTokensByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartTokensByRole"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, tokensByRole?: Record<string, number>): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
    ...(tokensByRole ? { tokensByRole } : {}),
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3, bugfix: 1 }, { feature: 1_500, bugfix: 2_000 }),
    mkDay("2026-09-02", { qa: 2 }, { qa: 1_500_000 }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 3], ["qa", 2], ["bugfix", 1]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles(chartTokensByRole(data)), [
    "2026-09-01 · feature: 1500 output tokens",
    "2026-09-01 · bugfix: 2000 output tokens",
    "2026-09-02 · qa: 1.5M output tokens",
  ]);
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartTokensByRole(data)), legendOf(chartRunsByRole(data)));
  // A day whose tokensByRole map is missing renders no token segments.
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(titles(chartTokensByRole(plain)).length, 0);
});

test("the Prompt tokens by role and Cached prompt tokens by role charts stack per role and match the runs legend", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartRunsByRole(d: ReportData): string;
    chartPromptTokensByRole(d: ReportData): string;
    chartCacheReadTokensByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartRunsByRole, chartPromptTokensByRole, chartCacheReadTokensByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartRunsByRole", "chartPromptTokensByRole", "chartCacheReadTokensByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, prompt?: { promptTokensByRole?: Record<string, number>; cacheReadTokensByRole?: Record<string, number> }): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
    ...(prompt?.promptTokensByRole ? { promptTokensByRole: prompt.promptTokensByRole } : {}),
    ...(prompt?.cacheReadTokensByRole ? { cacheReadTokensByRole: prompt.cacheReadTokensByRole } : {}),
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3, bugfix: 1 }, { promptTokensByRole: { feature: 1_500, bugfix: 2_000 }, cacheReadTokensByRole: { feature: 1_200 } }),
    mkDay("2026-09-02", { qa: 2 }, { promptTokensByRole: { qa: 1_500_000 }, cacheReadTokensByRole: { qa: 200 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 3], ["qa", 2], ["bugfix", 1]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles(chartPromptTokensByRole(data)), [
    "2026-09-01 · feature: 1500 prompt tokens",
    "2026-09-01 · bugfix: 2000 prompt tokens",
    "2026-09-02 · qa: 1.5M prompt tokens",
  ]);
  assert.deepEqual(titles(chartCacheReadTokensByRole(data)), [
    "2026-09-01 · feature: 1200 cached prompt tokens",
    "2026-09-02 · qa: 200 cached prompt tokens",
  ]);
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartPromptTokensByRole(data)), legendOf(chartRunsByRole(data)), "same per-role order and colors as the runs element");
  assert.equal(legendOf(chartCacheReadTokensByRole(data)), legendOf(chartRunsByRole(data)), "same per-role order and colors as the runs element");
  // A series with neither map renders no segments, and seriesHasAny stays false.
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(titles(chartPromptTokensByRole(plain)).length, 0);
  assert.equal(titles(chartCacheReadTokensByRole(plain)).length, 0);
  assert.equal(seriesHasAny(plain, "promptTokensByRole"), false);
  assert.equal(seriesHasAny(plain, "cacheReadTokensByRole"), false);
  assert.equal(seriesHasAny(data, "promptTokensByRole"), true);
  assert.equal(seriesHasAny(data, "cacheReadTokensByRole"), true);
});

test("the Merge check median chart draws one bar per checked day and seriesHasCheckMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartCheckMedian(d: ReportData): string;
    seriesHasCheckMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartCheckMedian, seriesHasCheckMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartCheckMedian", "seriesHasCheckMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { checkMedianMs: 95_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { checkMedianMs: 180_000 }),
  ]);
  const svg = chartCheckMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 95s median merge check", "2026-09-03: 3m median merge check"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasCheckMedian(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasCheckMedian(data), true);
});

test("the Merge wait median chart draws one bar per timed day and seriesHasMergeWaitMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartMergeWaitMedian(d: ReportData): string;
    seriesHasMergeWaitMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartMergeWaitMedian, seriesHasMergeWaitMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartMergeWaitMedian", "seriesHasMergeWaitMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { mergeWaitMedianMs: 95_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { mergeWaitMedianMs: 180_000 }),
  ]);
  const svg = chartMergeWaitMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 95s median merge wait", "2026-09-03: 3m median merge wait"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasMergeWaitMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasMergeWaitMedian(data), true);
});

test("the Merge slot median chart draws one bar per timed day and seriesHasMergeSlotMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartMergeSlotMedian(d: ReportData): string;
    seriesHasMergeSlotMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartMergeSlotMedian, seriesHasMergeSlotMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartMergeSlotMedian", "seriesHasMergeSlotMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { mergeSlotMedianMs: 95_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { mergeSlotMedianMs: 180_000 }),
  ]);
  const svg = chartMergeSlotMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 95s median merge slot", "2026-09-03: 3m median merge slot"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasMergeSlotMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasMergeSlotMedian(data), true);
});

test("the Usage render chain gates the Merge slot median chart right after Merge wait median", () => {
  const chain = GUI_CLIENT_REPORT_JS;
  const wait = chain.indexOf('block("Merge wait median"');
  const slot = chain.indexOf('block("Merge slot median", chartMergeSlotMedian(d)');
  assert.ok(wait >= 0, "the Merge wait median term exists");
  assert.ok(slot > wait, "Merge slot median sits after Merge wait median in the chain");
  assert.match(chain, /seriesHasMergeSlotMedian\(d\) \? block\("Merge slot median", chartMergeSlotMedian\(d\), "per day · verification start to outcome"\) : ""/);
  assert.equal((chain.match(/block\("Merge slot median", chartMergeSlotMedian\(d\), "per day · verification start to outcome"\)/g) || []).length, 1);
});

test("the Run duration median chart draws one bar per timed day and seriesHasRunMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartRunMedian(d: ReportData): string;
    seriesHasRunMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartRunMedian, seriesHasRunMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartRunMedian", "seriesHasRunMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { runMedianMs: 95_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { runMedianMs: 180_000 }),
  ]);
  const svg = chartRunMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 95s median run duration", "2026-09-03: 3m median run duration"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasRunMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasRunMedian(data), true);
});

test("the Review duration median chart draws one bar per timed day and seriesHasReviewMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartReviewMedian(d: ReportData): string;
    seriesHasReviewMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartReviewMedian, seriesHasReviewMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartReviewMedian", "seriesHasReviewMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { reviewMedianMs: 95_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { reviewMedianMs: 180_000 }),
  ]);
  const svg = chartReviewMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 95s median review", "2026-09-03: 3m median review"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasReviewMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasReviewMedian(data), true);
  assert.equal(seriesHasReviewMedian(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
});

test("the Backlog lag median chart draws one bar per lagged day and seriesHasBacklogLagMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartBacklogLagMedian(d: ReportData): string;
    seriesHasBacklogLagMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartBacklogLagMedian, seriesHasBacklogLagMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartBacklogLagMedian", "seriesHasBacklogLagMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { backlogLagMedianDays: 2 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { backlogLagMedianDays: 5 }),
  ]);
  const svg = chartBacklogLagMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 2d median backlog lag", "2026-09-03: 5d median backlog lag"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasBacklogLagMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasBacklogLagMedian(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
  // A same-day filing and completion is a real 0-day lag, not absence: the gate must keep it.
  assert.equal(seriesHasBacklogLagMedian(mk([mkDay("2026-09-01", { backlogLagMedianDays: 0 }), mkDay("2026-09-02")])), true);
  assert.equal(seriesHasBacklogLagMedian(data), true);
});

test("the Usage render chain gates the Backlog lag median chart right after Backlog items done", () => {
  const chain = GUI_CLIENT_REPORT_JS;
  const items = chain.indexOf('block("Backlog items done"');
  const lag = chain.indexOf('block("Backlog lag median", chartBacklogLagMedian(d)');
  assert.ok(items >= 0, "the Backlog items done term exists");
  assert.ok(lag > items, "Backlog lag median sits after Backlog items done in the chain");
  assert.match(chain, /seriesHasBacklogLagMedian\(d\) \? block\("Backlog lag median", chartBacklogLagMedian\(d\), "per day · filing to done"\) : ""/);
  assert.equal((chain.match(/block\("Backlog lag median", chartBacklogLagMedian\(d\), "per day · filing to done"\)/g) || []).length, 1);
});

test("the Provider wait median chart draws one bar per timed day and seriesHasProviderWaitMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartProviderWaitMedian(d: ReportData): string;
    seriesHasProviderWaitMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartProviderWaitMedian, seriesHasProviderWaitMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartProviderWaitMedian", "seriesHasProviderWaitMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { providerWaitMedianMs: 40_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { providerWaitMedianMs: 180_000 }),
  ]);
  const svg = chartProviderWaitMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 40s median provider wait", "2026-09-03: 3m median provider wait"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasProviderWaitMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasProviderWaitMedian(data), true);
});

test("the Workspace wait median chart draws one bar per timed day and seriesHasSlotWaitMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartSlotWaitMedian(d: ReportData): string;
    seriesHasSlotWaitMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartSlotWaitMedian, seriesHasSlotWaitMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartSlotWaitMedian", "seriesHasSlotWaitMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { slotWaitMedianMs: 40_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { slotWaitMedianMs: 180_000 }),
  ]);
  const svg = chartSlotWaitMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 40s median workspace wait", "2026-09-03: 3m median workspace wait"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasSlotWaitMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasSlotWaitMedian(data), true);
});

test("the Check wait median chart draws one bar per timed day and seriesHasCheckWaitMedian gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartCheckWaitMedian(d: ReportData): string;
    seriesHasCheckWaitMedian(d: ReportData): boolean;
  }
  const { chartCommits, chartCheckWaitMedian, seriesHasCheckWaitMedian } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartCheckWaitMedian", "seriesHasCheckWaitMedian"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { checkWaitMedianMs: 40_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { checkWaitMedianMs: 180_000 }),
  ]);
  const svg = chartCheckWaitMedian(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 40s median check wait", "2026-09-03: 3m median check wait"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasCheckWaitMedian(mk([mkDay("2026-09-01", { checkMedianMs: 5_000 }), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasCheckWaitMedian(data), true);
});

test("the Red merge checks chart draws one bar per red day and seriesHasCheckFailures gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartCheckFailures(d: ReportData): string;
    seriesHasCheckFailures(d: ReportData): boolean;
  }
  const { chartCommits, chartCheckFailures, seriesHasCheckFailures } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartCheckFailures", "seriesHasCheckFailures"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { checkFailures: 3 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { checkFailures: 1 }),
  ]);
  const svg = chartCheckFailures(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 3 red merge checks", "2026-09-03: 1 red merge check"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasCheckFailures(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasCheckFailures(data), true);
});

test("the Main red time chart draws one bar per red day and seriesHasMainRedMs gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartMainRedMs(d: ReportData): string;
    seriesHasMainRedMs(d: ReportData): boolean;
  }
  const { chartCommits, chartMainRedMs, seriesHasMainRedMs } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartMainRedMs", "seriesHasMainRedMs"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { mainRedMs: 63 * 60_000 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { mainRedMs: 180 * 60_000 }),
  ]);
  const svg = chartMainRedMs(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 63m main red", "2026-09-03: 3.0h main red"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasMainRedMs(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasMainRedMs(data), true);
});

test("the Backlog items chart stacks features and bugs per day and seriesHasBacklogItems gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartBacklogItems(d: ReportData): string;
    seriesHasBacklogItems(d: ReportData): boolean;
  }
  const { chartCommits, chartBacklogItems, seriesHasBacklogItems } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartBacklogItems", "seriesHasBacklogItems"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { featuresDone: 2, bugsFixed: 1 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { bugsFixed: 3 }),
  ]);
  const svg = chartBacklogItems(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles, ["2026-09-01: 2 features done", "2026-09-01: 1 bug fixed", "2026-09-03: 3 bugs fixed"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasBacklogItems(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasBacklogItems(data), true);
});

test("the Backlog items opened chart stacks plans added and bugs filed and seriesHasBacklogAdded gates it", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartBacklogItemsOpened(d: ReportData): string;
    seriesHasBacklogAdded(d: ReportData): boolean;
  }
  const { chartCommits, chartBacklogItemsOpened, seriesHasBacklogAdded } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartBacklogItemsOpened", "seriesHasBacklogAdded"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { plansAdded: 2, bugsFiled: 1 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { bugsFiled: 3 }),
  ]);
  const svg = chartBacklogItemsOpened(data);
  const titles = (s: string) => [...s.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.deepEqual(titles(svg), ["2026-09-01: 2 plans added", "2026-09-01: 1 bug filed", "2026-09-03: 3 bugs filed"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
  assert.equal(seriesHasBacklogAdded(mk([mkDay("2026-09-01"), mkDay("2026-09-02")])), false);
  assert.equal(seriesHasBacklogAdded(data), true);
});

test("the Spend by provider charts stack per provider and reportProviderOrder lists each provider once", () => {
  // The provider charts are the dashboard twin of the day report's "Cost by provider" lines:
  // one segment per (day, provider) stacked in reportProviderOrder's order, with the two
  // charts (real and notional) sharing one color and one legend position per provider. Both
  // maps are sparse, so a day with none keeps its empty slot.
  interface Builders {
    reportProviderOrder(d: ReportData): Array<[string, number]>;
    chartCostByProvider(d: ReportData): string;
    chartNotionalByProvider(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportProviderOrder, chartCostByProvider, chartNotionalByProvider, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportProviderOrder", "chartCostByProvider", "chartNotionalByProvider", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { costByProvider: { hf: 1.2 }, notionalByProvider: { claude: 0.5 } }),
    mkDay("2026-09-02", { costByProvider: { claude: 0.8 } }),
    mkDay("2026-09-03", { notionalByProvider: { omlx: 0.25 } }),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Spend desc, then name; a provider that only shows up notionally (omlx) still gets a row.
  assert.deepEqual(reportProviderOrder(data), [["hf", 1.2], ["claude", 0.8], ["omlx", 0]]);
  assert.deepEqual(titles(chartCostByProvider(data)), ["2026-09-01 · hf: $1.20", "2026-09-02 · claude: $0.80"]);
  assert.deepEqual(titles(chartNotionalByProvider(data)), ["2026-09-01 · claude: $0.50", "2026-09-03 · omlx: $0.25"]);
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartCostByProvider(data)), legendOf(chartNotionalByProvider(data)), "both charts share the provider order and colors");
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "costByProvider"), false);
  assert.equal(seriesHasAny(empty, "notionalByProvider"), false);
  assert.equal(seriesHasAny(data, "costByProvider"), true);
  assert.equal(seriesHasAny(data, "notionalByProvider"), true);
});

test("the Spend by backend chart stacks per backend and reportBackendOrder lists each backend once", () => {
  // The backend chart is the dashboard twin of the day report's per-backend notional line:
  // one segment per (day, backend) in reportBackendOrder's order. A backend has no
  // real-cost map, so the order reads only notionalByBackend, and a backend that only
  // spent notionally still counts.
  interface Builders {
    reportBackendOrder(d: ReportData): Array<[string, number]>;
    chartNotionalByBackend(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportBackendOrder, chartNotionalByBackend, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportBackendOrder", "chartNotionalByBackend", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { notionalByBackend: { claude: 0.5 } }),
    mkDay("2026-09-02", { notionalByBackend: { codex: 0.25 } }),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // A codex-only day draws one codex segment and the two-backend day draws both.
  // reportBackendOrder lists each backend once, read from notionalByBackend alone at 0
  // total (a backend has no real-cost sum field).
  assert.deepEqual(reportBackendOrder(data), [["claude", 0], ["codex", 0]]);
  assert.deepEqual(titles(chartNotionalByBackend(data)), ["2026-09-01 · claude: $0.50", "2026-09-02 · codex: $0.25"]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02")]);
  assert.equal(seriesHasAny(empty, "notionalByBackend"), false, "a backend-free series gates the chart off");
  assert.equal(seriesHasAny(data, "notionalByBackend"), true);
});

test("the Work vs maintenance chart stacks work and maintenance per day and matches chartCommits' labels", () => {
  interface Builders {
    chartCommits(d: ReportData): string;
    chartCommitTiers(d: ReportData): string;
  }
  const { chartCommits, chartCommitTiers } = clientScope<Builders>(
    ["format", "report-chart"],
    ["chartCommits", "chartCommitTiers"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { workCommits: 2, maintenanceCommits: 1, commits: 3 }),
    mkDay("2026-09-02"),
    mkDay("2026-09-03", { maintenanceCommits: 2, commits: 5 }),
  ]);
  const svg = chartCommitTiers(data);
  const titles = [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // 2026-09-03 has commits: 5 but only 2 tiered — the untiered plan/steward/observer commits
  // draw no segment here (they count in the total commits chart alone).
  assert.deepEqual(titles, ["2026-09-01: 2 work commits", "2026-09-01: 1 maintenance commit", "2026-09-03: 2 maintenance commits"]);
  const labels = (s: string) => (s.match(/<text [^>]*text-anchor='middle'/g) || []).length;
  assert.equal(labels(svg), labels(chartCommits(data)));
});

test("the Runs by model chart stacks per model and reportModelOrder lists each model once", () => {
  // The Runs by model chart is the dashboard twin of the day report's "Runs by model" line:
  // one segment per (day, model) stacked in reportModelOrder's order, from each run_start's
  // agent-qualified selector. The map is sparse, so a day with none keeps its empty slot.
  interface Builders {
    reportModelOrder(d: ReportData): Array<[string, number]>;
    chartRunsByModel(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportModelOrder, chartRunsByModel, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportModelOrder", "chartRunsByModel", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { runsByModel: { "acme/m2": 1, "acme/m1": 2 } }),
    mkDay("2026-09-02", { runsByModel: { "acme/m1": 1 } }),
    mkDay("2026-09-03"),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Count desc, then name asc: m1 (3) ahead of m2 (1).
  assert.deepEqual(reportModelOrder(data), [["acme/m1", 3], ["acme/m2", 1]]);
  assert.deepEqual(titles(chartRunsByModel(data)), ["2026-09-01 · acme/m1: 2 runs", "2026-09-01 · acme/m2: 1 run", "2026-09-02 · acme/m1: 1 run"]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "runsByModel"), false);
  assert.equal(seriesHasAny(data, "runsByModel"), true);
});

test("the Usage render chain gates the Runs by model chart right after Merged by role", () => {
  // The usage view's render chain must name the Runs by model chart once, team-only and
  // gated on the series really carrying a model, sitting right after the Merged by role term
  // the same team-only rule orders it after.
  const chain = GUI_CLIENT_REPORT_JS;
  const merged = chain.indexOf('block("Merged by role"');
  const runs = chain.indexOf('block("Runs by model"');
  assert.ok(merged >= 0, "the Merged by role term exists");
  assert.ok(runs > merged, "Runs by model sits after Merged by role in the chain");
  assert.match(chain, /!d\.role && seriesHasAny\(d, "runsByModel"\) \? block\("Runs by model", chartRunsByModel\(d\)\) : ""/);
  // Exactly one such gated term.
  assert.equal((chain.match(/block\("Runs by model", chartRunsByModel\(d\)\)/g) || []).length, 1);
});

test("reportMergeFailureOrder lists each reason once and chartMergeFailuresByReason stacks per day, gated by seriesHasAny", () => {
  interface Builders {
    reportMergeFailureOrder(data: ReportData): [string, number][];
    chartMergeFailuresByReason(data: ReportData): string;
    seriesHasAny(data: ReportData, field: string): boolean;
  }
  const { reportMergeFailureOrder, chartMergeFailuresByReason, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportMergeFailureOrder", "chartMergeFailuresByReason", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { mergeFailedByReason: { rejected: 2, unknown: 1 } }),
    mkDay("2026-09-02", { mergeFailedByReason: { merge_conflict: 1, rejected: 1 } }),
    mkDay("2026-09-03"),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Count desc, then name asc: rejected (3) ahead of merge_conflict and unknown (1 each, name asc).
  assert.deepEqual(reportMergeFailureOrder(data), [["rejected", 3], ["merge_conflict", 1], ["unknown", 1]]);
  assert.deepEqual(titles(chartMergeFailuresByReason(data)), [
    "2026-09-01 · rejected: 2 merge failures",
    "2026-09-01 · unknown: 1 merge failure",
    "2026-09-02 · rejected: 1 merge failure",
    "2026-09-02 · merge_conflict: 1 merge failure",
  ]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "mergeFailedByReason"), false);
  assert.equal(seriesHasAny(data, "mergeFailedByReason"), true);
});

test("the Usage render chain gates the Merge failures by reason chart right after Merge failures by role", () => {
  const chain = GUI_CLIENT_REPORT_JS;
  const byRole = chain.indexOf('block("Merge failures by role"');
  const byReason = chain.indexOf('block("Merge failures by reason"');
  assert.ok(byRole >= 0, "the Merge failures by role term exists");
  assert.ok(byReason > byRole, "Merge failures by reason sits after Merge failures by role in the chain");
  assert.match(chain, /seriesHasAny\(d, "mergeFailedByReason"\) \? block\("Merge failures by reason", chartMergeFailuresByReason\(d\)\) : ""/);
  assert.equal((chain.match(/block\("Merge failures by reason", chartMergeFailuresByReason\(d\)\)/g) || []).length, 1);
});

test("reportValidationGapOrder lists each tag once and chartValidationGaps stacks per day, gated by seriesHasAny", () => {
  interface Builders {
    reportValidationGapOrder(data: ReportData): [string, number][];
    chartValidationGaps(data: ReportData): string;
    seriesHasAny(data: ReportData, field: string): boolean;
  }
  const { reportValidationGapOrder, chartValidationGaps, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportValidationGapOrder", "chartValidationGaps", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { validationGapsByTag: { "no-repro": 2 } }),
    mkDay("2026-09-02", { validationGapsByTag: { "no-repro": 1, "no-fake": 1 } }),
    mkDay("2026-09-03"),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Count desc, then tag asc: no-repro (3) ahead of no-fake (1).
  assert.deepEqual(reportValidationGapOrder(data), [["no-repro", 3], ["no-fake", 1]]);
  assert.deepEqual(titles(chartValidationGaps(data)), [
    "2026-09-01 · no-repro: 2 validation gaps",
    "2026-09-02 · no-repro: 1 validation gap",
    "2026-09-02 · no-fake: 1 validation gap",
  ]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "validationGapsByTag"), false);
  assert.equal(seriesHasAny(data, "validationGapsByTag"), true);
});

test("the Usage render chain gates the Validation gaps chart right after Merge failures by reason", () => {
  const chain = GUI_CLIENT_REPORT_JS;
  const byReason = chain.indexOf('block("Merge failures by reason"');
  const byGaps = chain.indexOf('block("Validation gaps", chartValidationGaps(d)');
  assert.ok(byReason >= 0, "the Merge failures by reason term exists");
  assert.ok(byGaps > byReason, "Validation gaps sits after Merge failures by reason in the chain");
  assert.match(chain, /!d\.role && seriesHasAny\(d, "validationGapsByTag"\) \? block\("Validation gaps", chartValidationGaps\(d\), "per day · what made fixed bugs hard to confirm"\) : ""/);
  assert.equal((chain.match(/block\("Validation gaps", chartValidationGaps\(d\)/g) || []).length, 1);
});

test("reportMainRedTestOrder and chartMainRedByTest rank and stack each day's failing tests", () => {
  // The Main red by test chart is the dashboard twin of the day report's "Main red by test"
  // line: one segment per (day, failing test) ranked count desc then name asc, from each
  // day's mainRedByTest map. The map is sparse, so a day with none keeps its empty slot.
  interface Builders {
    reportMainRedTestOrder(data: ReportData): [string, number][];
    chartMainRedByTest(data: ReportData): string;
    seriesHasAny(data: ReportData, field: string): boolean;
  }
  const { reportMainRedTestOrder, chartMainRedByTest, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportMainRedTestOrder", "chartMainRedByTest", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { mainRedByTest: { "test/a.test.ts": 2 } }),
    mkDay("2026-09-02", { mainRedByTest: { "test/a.test.ts": 1, "test/b.test.ts": 1 } }),
    mkDay("2026-09-03"),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Count desc, then name asc: test/a.test.ts (3) ahead of test/b.test.ts (1).
  assert.deepEqual(reportMainRedTestOrder(data), [["test/a.test.ts", 3], ["test/b.test.ts", 1]]);
  assert.deepEqual(titles(chartMainRedByTest(data)), [
    "2026-09-01 · test/a.test.ts: 2 red checks",
    "2026-09-02 · test/a.test.ts: 1 red check",
    "2026-09-02 · test/b.test.ts: 1 red check",
  ]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "mainRedByTest"), false);
  assert.equal(seriesHasAny(data, "mainRedByTest"), true);
});

test("reportMainRedCulpritOrder and chartMainRedByMerge stack each day's blamed merges", () => {
  // The Main red by merge chart is the dashboard twin of the day report's "Main red by merge"
  // line: one segment per (day, <role> <shortSha> culprit) ranked count desc then name asc,
  // from each day's mainRedByCulprit map. The map is sparse, so a day with none keeps its
  // empty slot. The culprit label is <role> <shortSha>, escaped by the legend/title path.
  interface Builders {
    reportMainRedCulpritOrder(data: ReportData): [string, number][];
    chartMainRedByMerge(data: ReportData): string;
    seriesHasAny(data: ReportData, field: string): boolean;
  }
  const { reportMainRedCulpritOrder, chartMainRedByMerge, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportMainRedCulpritOrder", "chartMainRedByMerge", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { mainRedByCulprit: { "feature abc12345": 1 } }),
    mkDay("2026-09-02", { mainRedByCulprit: { "bugfix def67890": 2 } }),
    mkDay("2026-09-03"),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Count desc, then name asc: bugfix def67890 (2) ahead of feature abc12345 (1).
  assert.deepEqual(reportMainRedCulpritOrder(data), [["bugfix def67890", 2], ["feature abc12345", 1]]);
  assert.deepEqual(titles(chartMainRedByMerge(data)), [
    "2026-09-01 · feature abc12345: 1 blame",
    "2026-09-02 · bugfix def67890: 2 blames",
  ]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "mainRedByCulprit"), false);
  assert.equal(seriesHasAny(data, "mainRedByCulprit"), true);
});

test("the Usage render chain gates the Main red by test and Main red by merge charts after Main red time", () => {
  // The usage view's render chain must name the Main red by test and Main red by merge charts
  // once each, team-only and gated on the series really carrying the map, sitting right after
  // the Main red time term each is the twin of.
  const chain = GUI_CLIENT_REPORT_JS;
  const redTime = chain.indexOf('block("Main red time"');
  const byTest = chain.indexOf('block("Main red by test"');
  const byMerge = chain.indexOf('block("Main red by merge"');
  assert.ok(redTime >= 0, "the Main red time term exists");
  assert.ok(byTest > redTime, "Main red by test sits after Main red time in the chain");
  assert.ok(byMerge > byTest, "Main red by merge sits after Main red by test in the chain");
  assert.match(chain, /!d\.role && seriesHasAny\(d, "mainRedByTest"\) \? block\("Main red by test", chartMainRedByTest\(d\), "per day · failing tests main's red checks named"\) : ""/);
  assert.match(chain, /!d\.role && seriesHasAny\(d, "mainRedByCulprit"\) \? block\("Main red by merge", chartMainRedByMerge\(d\), "per day · merges the main watch blamed"\) : ""/);
  assert.equal((chain.match(/block\("Main red by test", chartMainRedByTest\(d\)/g) || []).length, 1);
  assert.equal((chain.match(/block\("Main red by merge", chartMainRedByMerge\(d\)/g) || []).length, 1);
});

test("the Deferred runs by reason chart stacks per reason and reportDeferredOrder lists each code once", () => {
  // The Deferred runs by reason chart is the dashboard twin of the day report's "Deferred
  // runs by reason" line: one segment per (day, reason code) stacked in reportDeferredOrder's
  // order, from each run_deferred event's reason. The map is sparse, so a day with none
  // keeps its empty slot.
  interface Builders {
    reportDeferredOrder(d: ReportData): Array<[string, number]>;
    chartDeferredByReason(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportDeferredOrder, chartDeferredByReason, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportDeferredOrder", "chartDeferredByReason", "seriesHasAny"],
  );
  const mkDay = (date: string, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 3, from: "2026-09-01", to: "2026-09-03", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { deferredByReason: { "no-work": 1, backlog: 2 } }),
    mkDay("2026-09-02", { deferredByReason: { backlog: 1 } }),
    mkDay("2026-09-03"),
  ]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  // Count desc, then name asc: backlog (3) ahead of no-work (1).
  assert.deepEqual(reportDeferredOrder(data), [["backlog", 3], ["no-work", 1]]);
  assert.deepEqual(titles(chartDeferredByReason(data)), ["2026-09-01 · backlog: 2 deferrals", "2026-09-01 · no-work: 1 deferral", "2026-09-02 · backlog: 1 deferral"]);
  const empty = mk([mkDay("2026-09-01"), mkDay("2026-09-02"), mkDay("2026-09-03")]);
  assert.equal(seriesHasAny(empty, "deferredByReason"), false);
  assert.equal(seriesHasAny(data, "deferredByReason"), true);
});

test("the Usage render chain gates the Deferred runs by reason chart after Runs by model, team only", () => {
  // The usage view's render chain must name the Deferred runs by reason chart once, team-only
  // and gated on the series really carrying a reason, sitting right after the Runs by model
  // term the same team-only rule orders it after.
  const chain = GUI_CLIENT_REPORT_JS;
  const runs = chain.indexOf('block("Runs by model"');
  const deferred = chain.indexOf('block("Deferred runs by reason"');
  assert.ok(runs >= 0, "the Runs by model term exists");
  assert.ok(deferred > runs, "Deferred runs by reason sits after Runs by model in the chain");
  assert.match(chain, /!d\.role && seriesHasAny\(d, "deferredByReason"\) \? block\("Deferred runs by reason", chartDeferredByReason\(d\), "per day · backlog, no-work, plans-full"\) : ""/);
  // Exactly one such gated term (the chain term carries its caption as a third argument).
  assert.equal((chain.match(/block\("Deferred runs by reason", chartDeferredByReason\(d\), "per day · backlog, no-work, plans-full"\)/g) || []).length, 1);
});

test("mergeShareText prints the merge-share line in the CLI's wording" , () => {
  // The browser twin of report-render.ts's mergeShareLine must say exactly what the CLI says —
  // the "of which merge runs:" lead, the optional " (N failed)" clause, the tokens and cost
  // clauses, and the trailing "(reviewer + conflict resolution)" — with only the number
  // formatters differing, so the browser and CLI lines cannot drift on what they say.
  const { mergeShareText } = clientScope<{ mergeShareText(t: ReportTotals): string }>(
    ["format", "report-chart"],
    ["mergeShareText"],
  );
  const withFailed = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 3, mergeTokens: 8000, mergeCostUsd: 1.5, mergeFailed: 1 };
  assert.equal(
    mergeShareText(withFailed),
    "of which merge runs: 3 runs (1 failed) · 8000 tokens · $1.50 (reviewer + conflict resolution)",
  );
  const noFailed = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 2, mergeTokens: 4000, mergeCostUsd: 0.5 };
  assert.equal(
    mergeShareText(noFailed),
    "of which merge runs: 2 runs · 4000 tokens · $0.50 (reviewer + conflict resolution)",
  );
  // The singular count is the drift case the CLI pins: mergeShareLine (report-render.ts)
  // prints a bare "1 runs" (frozen by test/report.test.ts), and the twin must match it rather
  // than pluralise, or the browser and CLI lines diverge for a one-merge-run window.
  const single = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 1, mergeTokens: 900, mergeCostUsd: 0.4 };
  assert.equal(
    mergeShareText(single),
    "of which merge runs: 1 runs · 900 tokens · $0.40 (reviewer + conflict resolution)",
  );
});

test("the Usage render chain draws the merge-share line under the stats grid when the window has merge runs", () => {
  // The usage view's render chain must render the merge-share paragraph directly under the
  // stats grid and above the charts, gated on the window really having merge runs.
  const chain = GUI_CLIENT_REPORT_JS;
  const summary = chain.indexOf("reportSummary(d)");
  const merge = chain.indexOf("merge-share");
  const grid = chain.indexOf("grid-2 even");
  assert.ok(summary >= 0, "the reportSummary term exists");
  assert.ok(merge > summary, "the merge-share paragraph sits after reportSummary(d)");
  assert.ok(merge < grid, "the merge-share paragraph sits before the grid-2 even chart grid");
  assert.match(chain, /d\.totals\.mergeRuns > 0 \? "<p class='muted merge-share'>" \+ esc\(mergeShareText\(d\.totals\)\) \+ "<\/p>" : ""/);
  assert.equal((chain.match(/<p class='muted merge-share'>/g) || []).length, 1);
});

test("costPerCommitText and estimatedPerCommitText print the cost-per-commit lines in the CLI's wording", () => {
  // The browser twins of report-render.ts's costPerCommitLine must say exactly what the CLI
  // says: roles with spend and commits ranked by cost-per-commit desc then name asc, then
  // spend-only roles ranked by spend — with the instance id folded to its base role and only
  // the number formatters differing, so the browser and CLI lines cannot drift on what they
  // say. A series with no positive spend renders "-".
  const { costPerCommitText, estimatedPerCommitText } = clientScope<{
    costPerCommitText(label: string, series: ReportDay[], pick?: (d: ReportDay) => Record<string, number>): string;
    estimatedPerCommitText(series: ReportDay[]): string;
  }>(
    ["format", "report-chart"],
    ["costPerCommitText", "estimatedPerCommitText"],
  );
  const series: ReportDay[] = [{
    date: "2026-09-01",
    tokensOut: 0, runsByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
    costByRole: { feature: 0.2, "feature-2": 0.1, clean: 0.9, plan: 0.9 },
    commitsByRole: { feature: 2, clean: 3 },
  }];
  assert.equal(
    costPerCommitText("Cost per commit", series),
    "Cost per commit: clean — $0.30 (3) · feature — $0.15 (2) · plan — $0.90, no commits",
  );
  assert.equal(
    costPerCommitText("Cost per commit", [{ date: "2026-09-01", tokensOut: 0, runsByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, costByRole: {} }]),
    "Cost per commit: -",
  );
  assert.equal(
    estimatedPerCommitText([{ date: "2026-09-01", tokensOut: 0, runsByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, costByRole: {}, notionalByRole: { feature: 0.4, plan: 0.5 }, commitsByRole: { feature: 3 } }]),
    "Estimated per commit: feature — $0.13 (3) · plan — $0.50, no commits",
  );
});

test("the Usage render chain draws the cost-per-commit lines under the merge-share paragraph", () => {
  // The usage view's render chain must render the two cost-per-commit paragraphs directly under
  // the merge-share line and above the charts grid: the priced line always, the estimated line
  // gated on the window really having notional spend.
  const chain = GUI_CLIENT_REPORT_JS;
  const merge = chain.indexOf("merge-share");
  const cost = chain.indexOf("cost-per-commit");
  const grid = chain.indexOf("grid-2 even");
  assert.ok(cost > merge, "the cost-per-commit paragraph sits after the merge-share line");
  assert.ok(cost < grid, "the cost-per-commit paragraph sits before the grid-2 even chart grid");
  assert.equal((chain.match(/<p class='muted cost-per-commit'>/g) || []).length, 2);
  assert.match(chain, /costPerCommitText\("Cost per commit", d\.series\)/);
  assert.match(chain, /d\.totals\.notionalCostUsd > 0 \? "<p class='muted cost-per-commit'>" \+ esc\(estimatedPerCommitText\(d\.series\)\) \+ "<\/p>" : ""/);
});

test("quarantineCardHtml renders a Release button per entry and returns empty for none", () => {
  // The Failures view paints the server-served { warning, rows } quarantine as a structured
  // card below the digest, one Release button per row — the twin of `tumwater quarantine
  // --release <n>`.
  const { quarantineCardHtml } = clientScope<{ quarantineCardHtml(q?: unknown): string }>(
    ["report-quarantine"],
    ["quarantineCardHtml"],
  );
  const html = quarantineCardHtml({
    warning: "quarantine holds 1 test over 3 days",
    rows: [{ position: 1, test: "test/T.ts", detail: "first seen 5d ago, last seen 0s ago, 2 flakes — not filed" }],
  });
  assert.match(html, /<h2>Flake quarantine<\/h2>/);
  assert.match(html, /quarantine holds 1 test over 3 days/);
  assert.match(html, /test\/T\.ts/);
  assert.match(html, /first seen 5d ago/);
  assert.match(html, /data-action='quarantine-release' data-test='test\/T\.ts'/);
  assert.equal(quarantineCardHtml(undefined), "");
  assert.equal(quarantineCardHtml({}), "");
  assert.equal(quarantineCardHtml({ warning: null, rows: [] }), "");
});

test("the Failures release click chain arms, posts, and refetches only after the release lands", async () => {
  // Drive quarantineReleaseClick the same way the card's wireClicks branch does: a first click
  // on a row arms it (relabelling to confirm, posting nothing); a second click on the same row
  // posts the release and re-fetches only after the post resolves — the still-present row would
  // otherwise win the refetch's race; a row with no test id just disarms.
  const { quarantineReleaseClick } = clientScope<{
    quarantineReleaseClick(rel: unknown, post: (test: string) => Promise<unknown>, refetch: () => void): Promise<string>;
  }>(["report-quarantine"], ["quarantineReleaseClick"]);
  const row = { dataset: { test: "test/T.ts" }, textContent: "" };
  const postedTests: string[] = [];
  let fetches = 0;
  const recordPost = async (t: string) => { postedTests.push(t); };
  const countFetch = () => { fetches++; };
  // The first click arms, relabels, and posts nothing.
  assert.equal(await quarantineReleaseClick(row, recordPost, countFetch), "armed");
  assert.equal(row.textContent, "Click again to release");
  assert.equal(postedTests.length, 0, "an armed release posts nothing");
  assert.equal(fetches, 0);
  // The second click posts; the refetch waits for the post to resolve.
  let releasePost: (() => void) | undefined;
  const fence = new Promise<void>((resolve) => { releasePost = resolve; });
  let posted = false;
  const firing = quarantineReleaseClick(row, async (t: string) => { posted = true; postedTests.push(t); await fence; }, countFetch);
  await Promise.resolve();
  assert.equal(posted, true, "the second click posts the release");
  assert.equal(fetches, 0, "the refetch waits for the release post to resolve");
  releasePost!();
  assert.equal(await firing, "released");
  assert.equal(fetches, 1);
  assert.equal(postedTests.length, 1);
  assert.equal(postedTests[0], "test/T.ts");
  // A row with no test id disarms without relabelling or posting.
  const blank = { dataset: { test: "" }, textContent: "" };
  assert.equal(await quarantineReleaseClick(blank, async (_: string) => { postedTests.push("?"); }, countFetch), "disarmed");
  assert.equal(postedTests.length, 1, "a blank row never posts");
});

test("the Failures release arm is throttle-safe and clears on a new arm or a click elsewhere", async () => {
  // The two revisions' fixes live in the view wiring, not the bare helper: fetchView clears the
  // arm only when it actually rebuilds the Failures body (a throttled refetch that returns early
  // must not disarm a button the user armed), and every path that moves off an armed row —
  // clicking a different row, or anywhere else — restores the armed button's "Release" label.
  // Drive the real fetchFailures + wireClicks against the served blob so both fixes are tested
  // in context rather than exported side-effects.
  const els: Record<string, { dataset: Record<string, string>; innerHTML: string; addEventListener(type: string, fn: (ev: unknown) => void): void }> = {};
  let clickHandler: ((ev: unknown) => void) | null = null;
  for (const id of ["report", "failures", "usagebody", "failbody", "usagewindow", "failwindow", "usagerole", "failrole"]) {
    els[id] = {
      dataset: {}, innerHTML: "",
      addEventListener(type, fn) { if (type === "click" && id === "failures") clickHandler = fn; },
    };
  }
  // The card's Release buttons as the clickClosest stand-in hands them to wireClicks.
  const buttons: Record<string, { dataset: Record<string, string>; textContent: string }> = {
    "test/A.test.ts": { dataset: { test: "test/A.test.ts" }, textContent: "" },
    "test/B.test.ts": { dataset: { test: "test/B.test.ts" }, textContent: "" },
  };
  const A = buttons["test/A.test.ts"]!;
  const B = buttons["test/B.test.ts"]!;
  let relButton: { dataset: Record<string, string>; textContent: string } | null = null;
  const postedTests: string[] = [];
  const inject = {
    document: { getElementById: (id: string) => els[id] ?? null },
    $: (id: string) => els[id] ?? null,
    markActive: () => {},
    recall: () => null,
    store: () => {},
    lastStatus: null,
    getJson: async (url: string) => {
      if (url.startsWith("/api/failures")) {
        return {
          markdown: "# Failure digest\n\nfug",
          quarantine: {
            warning: null,
            rows: [
              { position: 1, test: "test/A.test.ts", detail: "first seen 5d ago, last seen 0s ago, 2 flakes — not filed" },
              { position: 2, test: "test/B.test.ts", detail: "first seen 1h ago, last seen 0s ago, 1 flake — not filed" },
            ],
          },
        };
      }
      return { markdown: "# usage" };
    },
    errorPanel: (title: string) => "<div class='error'>" + title + "</div>",
    clickClosest: (_ev: unknown, sel: string) => (sel === "[data-action='quarantine-release']" ? relButton : null),
    renderMarkdown: (md: string) => md,
    icon: iconStub,
    plural: (n: number, one: string) => `${n} ${one}`,
    workSplit: () => "",
    fmtTokens: (n: number) => String(n),
    fmtUsd: (n: number) => "$" + n.toFixed(2),
    postAction: (_path: string, body: unknown, pick: (d: unknown) => unknown) => { postedTests.push((body as { test: string }).test); return pick({ message: "ok" }); },
  };
  const keys = Object.keys(inject);
  const run = new Function(...keys, `${[ESC_LINE, clientRegion("panel-build"), GUI_CLIENT_REPORT_CHART_JS, GUI_CLIENT_REPORT_JS].join("\n")}\nreturn { fetchReport, fetchFailures };`) as (...args: unknown[]) => { fetchReport(throttled?: boolean): Promise<void>; fetchFailures(): Promise<void> };
  const { fetchReport, fetchFailures } = run(...keys.map((k) => inject[k as keyof typeof inject]));
  const click = () => { clickHandler!({}); };

  // Usage fetches first so its fetchedAt is set; a later throttled refetch returns early at the
  // throttle check and thus (the fix) must not touch a Failures arm.
  await fetchReport();
  await fetchFailures();
  relButton = A;
  click(); // arms A
  assert.equal(A.textContent, "Click again to release");
  // The throttled usage refetch returns before any rebuild, so the arm survives it.
  await fetchReport(true);
  assert.equal(A.textContent, "Click again to release", "a throttled refetch that rebuilds nothing must not disarm");

  // Clicking elsewhere disarms and restores the armed row's label.
  relButton = null;
  click();
  assert.equal(A.textContent, "Release", "a click elsewhere restores the armed label");

  // A rebuild of the Failures body disarms, so one click on the fresh Release button arms again
  // instead of passing for the confirming second click; only the second click on that armed
  // button posts the release.
  relButton = A;
  click(); // arm A
  await fetchFailures(); // rebuild disarms
  assert.equal(A.textContent, "Release", "a rebuild restores the label");
  click(); // one click after the rebuild arms again (not the confirming second)
  assert.equal(A.textContent, "Click again to release");
  click(); // the second click on that armed button is the confirming click: it posts
  assert.equal(A.textContent, "Release", "the confirming second click restores the label");
  assert.equal(postedTests.length, 1, "the confirming second click posts the release");

  // Arming a different row disarms and restores the earlier row's label.
  relButton = A;
  click(); // arm A
  assert.equal(A.textContent, "Click again to release");
  relButton = B;
  click(); // arm B
  assert.equal(A.textContent, "Release", "arming B restores A's label");
  assert.equal(B.textContent, "Click again to release");
  assert.equal(postedTests.length, 1, "the arm-switch never posts");
});
