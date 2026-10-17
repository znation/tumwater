import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_REPORT_JS } from "../src/ui/gui/gui-client-report.js";
import { clientScope } from "./helpers/gui-client-scope.js";
import type { ReportData, ReportDay } from "../src/report/report-data.js";

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
  // The Loop picker's options are the pure half of the role scope every picker shares (the
  // Usage/Failures views and History): the team list comes from /api/status's loops, custom
  // loops included, so a role name can carry HTML metacharacters and must be escaped in both
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
  // The report views' Loop picker must offer the same roles the scoped collectors honor. The
  // status payload names an instance's base as `instanceOf`; a bare row has none, so its own
  // role is the base. Dedupe keeps a multi-instance base to a single option.
  const { reportBaseRoles } = clientScope<{ reportBaseRoles(loops?: Array<{ role: string; instanceOf?: string }>): string[] }>(
    ["format", "report-role"],
    ["reportBaseRoles"],
  );
  assert.deepEqual(reportBaseRoles([]), [], "no loops leaves no roles");
  assert.deepEqual(
    reportBaseRoles([{ role: "feature" }, { role: "feature-2", instanceOf: "feature" }, { role: "bugfix-2", instanceOf: "bugfix" }, { role: "clean" }]),
    ["feature", "bugfix", "clean"],
    "one slot per base role, first occurrence order preserved",
  );
});

test("the Rejections by loop chart stacks per role in the ticks order and stays empty without a map", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartRejectionsByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartTicksByRole, chartRejectionsByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartRejectionsByRole"],
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
  // A role that rejected but never ticked (qa) still keeps a stack row, after the tickers.
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0], ["qa", 0]]);
  const rects = parseRects(chartRejectionsByRole(data));
  assert.equal(rects.length, 3, "one segment per (day, loop) with a rejection");
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartRejectionsByRole(data)), legendOf(chartTicksByRole(data)), "same per-role order and colors as the ticks element");
  // A missing rejectionsByRole map renders the element empty (no segments).
  const none = mkDay("2026-09-01", { feature: 2 });
  const emptySvg = chartRejectionsByRole({ ...data, series: [none, { ...none, date: "2026-09-02" }] });
  assert.equal(parseRects(emptySvg).length, 0, "a missing map renders no segments");
});

test("the Fallbacks and Image reroutes charts stack per role and seriesHasAny gates them", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartFallbacksByRole(d: ReportData): string;
    chartImageReroutesByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartTicksByRole, chartFallbacksByRole, chartImageReroutesByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartFallbacksByRole", "chartImageReroutesByRole", "seriesHasAny"],
  );
  const mkDay = (date: string, runsByRole: Record<string, number>, extra: Partial<ReportDay> = {}): ReportDay => ({
    date, tokensOut: 0, runsByRole, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const totals = { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 };
  const mk = (series: ReportDay[]): ReportData => ({ days: 2, from: "2026-09-01", to: "2026-09-02", series, totals, coversFullWindow: true });
  const data = mk([
    mkDay("2026-09-01", { feature: 3 }, { fallbacksByRole: { feature: 2 }, imageReroutesByRole: { qa: 1 } }),
    mkDay("2026-09-02", { feature: 1 }, { fallbacksByRole: { bugfix: 1 } }),
  ]);
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["bugfix", 0], ["qa", 0]]);
  const titles = (svg: string) => [...svg.matchAll(/<rect [^>]*><title>([^<]*)<\/title><\/rect>/g)].map((r) => r[1]!);
  assert.equal(titles(chartFallbacksByRole(data)).length, 2);
  assert.ok(titles(chartFallbacksByRole(data)).some((t) => t.includes("2026-09-01 · feature: 2 fallbacks")));
  assert.equal(titles(chartImageReroutesByRole(data)).length, 1);
  assert.ok(titles(chartImageReroutesByRole(data)).some((t) => t.includes("qa: 1 image reroute")));
  const legendOf = (svg: string) => svg.slice(svg.indexOf("<div class='legend'>"));
  assert.equal(legendOf(chartFallbacksByRole(data)), legendOf(chartTicksByRole(data)));
  assert.equal(legendOf(chartImageReroutesByRole(data)), legendOf(chartTicksByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { fallbacksByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "fallbacksByRole"), false);
  assert.equal(seriesHasAny(plain, "imageReroutesByRole"), false);
  assert.equal(seriesHasAny(data, "fallbacksByRole"), true);
  assert.equal(seriesHasAny(data, "imageReroutesByRole"), true);
});

test("the Failed runs and Merge failures charts stack per role and seriesHasAny gates them", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartFailedRunsByRole(d: ReportData): string;
    chartMergeFailuresByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartTicksByRole, chartFailedRunsByRole, chartMergeFailuresByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartFailedRunsByRole", "chartMergeFailuresByRole", "seriesHasAny"],
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
  assert.equal(legendOf(chartFailedRunsByRole(data)), legendOf(chartTicksByRole(data)));
  assert.equal(legendOf(chartMergeFailuresByRole(data)), legendOf(chartTicksByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { failedRunsByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "failedRunsByRole"), false);
  assert.equal(seriesHasAny(plain, "mergeFailedByRole"), false);
  assert.equal(seriesHasAny(data, "failedRunsByRole"), true);
  assert.equal(seriesHasAny(data, "mergeFailedByRole"), true);
});

test("the Merged by role chart stacks per role and seriesHasAny gates it", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartMergedByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartTicksByRole, chartMergedByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartMergedByRole", "seriesHasAny"],
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
  assert.equal(legendOf(chartMergedByRole(data)), legendOf(chartTicksByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 })]);
  const missing = mk([mkDay("2026-09-01", { feature: 1 }, { runsByRole: { feature: 1 } }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(seriesHasAny(plain, "mergedByRole"), false);
  assert.equal(titles(chartMergedByRole(missing)).length, 0, "a day whose mergedByRole map is missing renders no merged segments");
  assert.equal(seriesHasAny(data, "mergedByRole"), true);
});

test("the Commits by role chart stacks per role in the ticks order", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartCommitsByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartTicksByRole, chartCommitsByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartCommitsByRole"],
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
  assert.equal(legendOf(chartCommitsByRole(data)), legendOf(chartTicksByRole(data)));
  assert.deepEqual(reportRoleOrder(data), [["feature", 4], ["qa", 0]]);
  const missing = mk([mkDay("2026-09-01", { feature: 1 }, { runsByRole: { feature: 1 } }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(titles(chartCommitsByRole(missing)).length, 0, "a day whose commitsByRole map is missing renders no commit segments");
});

test("the Revisions chart stacks per role and seriesHasAny gates it", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartRevisionsByRole(d: ReportData): string;
    seriesHasAny(d: ReportData, field: string): boolean;
  }
  const { reportRoleOrder, chartTicksByRole, chartRevisionsByRole, seriesHasAny } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartRevisionsByRole", "seriesHasAny"],
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
  assert.equal(legendOf(chartRevisionsByRole(data)), legendOf(chartTicksByRole(data)));
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 }, { revisionsByRole: { feature: 0 } })]);
  assert.equal(seriesHasAny(plain, "revisionsByRole"), false);
  assert.equal(seriesHasAny(data, "revisionsByRole"), true);
});

test("the Tokens by role chart stacks per role and matches the ticks legend", () => {
  interface Builders {
    reportRoleOrder(d: ReportData): Array<[string, number]>;
    chartTicksByRole(d: ReportData): string;
    chartTokensByRole(d: ReportData): string;
  }
  const { reportRoleOrder, chartTicksByRole, chartTokensByRole } = clientScope<Builders>(
    ["format", "report-chart"],
    ["reportRoleOrder", "chartTicksByRole", "chartTokensByRole"],
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
  assert.equal(legendOf(chartTokensByRole(data)), legendOf(chartTicksByRole(data)));
  // A day whose tokensByRole map is missing renders no token segments.
  const plain = mk([mkDay("2026-09-01", { feature: 1 }), mkDay("2026-09-02", { feature: 1 })]);
  assert.equal(titles(chartTokensByRole(plain)).length, 0);
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
