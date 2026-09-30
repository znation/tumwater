import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_REPORT_JS } from "../src/ui/gui-client-report.js";

// The report tab's hover chip (gui-client-report.ts's report-tip region) runs in the
// browser, so it is exercised here through the same regex-extract + new Function seam as
// the chart builders in gui-report.test.ts — with a minimal DOM shim standing in for
// document/window/Element, the three globals the region reaches for.

type Style = Record<string, string>;
type El = {
  id: string;
  style: Style;
  children: El[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  box: { width: number; height: number };
  textContent: string;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  getBoundingClientRect(): { width: number; height: number };
};

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
    `${GUI_CLIENT_REPORT_JS.match(/\/\/ report-tip:start\n([\s\S]*?)\n  \/\/ report-tip:end/)![1]}\nreturn { attachReportTip, hideReportTip };`,
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
