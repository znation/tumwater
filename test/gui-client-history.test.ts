import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_HISTORY_JS } from "../src/ui/gui-client-history.js";
import { GUI_CLIENT_JS } from "../src/ui/gui-client.js";
import { clientScope, iconStub } from "./gui-client-scope.js";

// The dashboard's History view (src/ui/gui-client-history.ts): the table it paints from
// /api/history's rows, its tick drill-down (the per-row details toggle and the card /api/tick
// serves), and its place in the assembled script.

test("GUI_CLIENT_JS carries the history module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_HISTORY_JS), "the module's constant appears verbatim in the assembled script");
});

// The regions the History view's pieces run with: the shared format/view-model helpers, the
// drill-down state and card renderer, then the table.
const HISTORY_REGIONS = ["format", "view-model", "history-detail", "history-table"];

test("the History table renders tick rows, escapes them, and filters by outcome", () => {
  const { historyTableHtml, historyClass } = clientScope<{
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>): string;
    historyClass(result: string): string;
  }>(HISTORY_REGIONS, ["historyTableHtml", "historyClass"], { icon: iconStub });
  const now = Date.now();
  const rows = [
    { ts: now - 5 * 60_000, time: "2026-09-29 15:33:31", loop: "coverage", tick: 5, result: "queued", durationMs: 45_000, usage: "12.0k tok · $0.04", detail: "bumped coverage" },
    { ts: now - 9 * 60_000, time: "2026-09-29 15:29:00", loop: "gone-loop", tick: 7, result: "no_change", durationMs: null, usage: "", detail: "" },
    { ts: now - 20 * 60_000, time: "2026-09-29 15:18:00", loop: "qa", tick: 2, result: "error", durationMs: 240_000, usage: "900 tok", detail: "<script>x</script>" },
  ];
  const html = historyTableHtml(rows, "all", new Set(["coverage", "qa"]));
  assert.match(html, /<tr class='clickable' data-open='coverage'>/, "a fleet loop's row opens its drawer");
  assert.match(html, /<tr><td class='c-x'><\/td><td title='2026-09-29 15:29:00'>/, "a row for a loop no longer in the fleet is plain and carries no toggle");
  assert.match(html, /5m ago/);
  assert.match(html, /#5/);
  assert.match(html, /<span class='res t-indigo'>Queued to land<\/span>/);
  assert.match(html, /<td class='num c-dur'>45s<\/td>/);
  assert.match(html, /<td class='num c-dur'>4m<\/td>/);
  assert.match(html, /<td class='num c-dur'>—<\/td>/, "a missing duration is a dash, never NaN");
  assert.doesNotMatch(html, /NaN|<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  // The per-row drill-down toggle: a fleet loop's row carries one, addressed by role+tick.
  assert.match(html, /data-tickdetail='1' data-role='coverage' data-tick='5' aria-expanded='false'/);
  assert.match(html, /data-tickdetail='1' data-role='qa' data-tick='2'/);
  // The outcome filter's buckets.
  assert.deepEqual(["changed", "queued", "no_change", "skipped", "user_aborted", "error", "rejected"].map(historyClass),
    ["changes", "changes", "none", "none", "none", "problems", "problems"]);
  const problems = historyTableHtml(rows, "problems", new Set());
  assert.equal((problems.match(/<tr>/g) ?? []).length, 2, "the header row and the one error row");
  assert.match(historyTableHtml(rows, "changes", new Set()), /bumped coverage/);
  assert.match(historyTableHtml([], "all", new Set()), /No ticks yet/);
  assert.match(historyTableHtml(rows.slice(1, 2), "changes", new Set()), /No ticks match this filter/);
  assert.match(historyTableHtml(null, "all", new Set()), /No ticks yet/, "a response without rows reads as none");
});

test("histDetailCardHtml branches on the entry's state: loading, error, then the fetched card", () => {
  const { histDetailCardHtml } = clientScope<{ histDetailCardHtml(entry: unknown): string }>(
    HISTORY_REGIONS,
    ["histDetailCardHtml"],
    { icon: iconStub },
  );
  // Absent and loading entries render the placeholder — a truthy-but-loading entry can never
  // fall into the fetched path and read as an empty trail.
  assert.match(histDetailCardHtml(undefined), /Loading tick detail…/);
  assert.match(histDetailCardHtml({ state: "loading" }), /Loading tick detail…/);
  assert.doesNotMatch(histDetailCardHtml({ state: "loading" }), /No events/);
  // An errored fetch shows the server's message, escaped.
  assert.match(histDetailCardHtml({ state: "error", message: "no tick #9 for clean <b>" }), /no tick #9 for clean &lt;b&gt;/);
  assert.match(histDetailCardHtml({ state: "error" }), /Tick detail unavailable/, "a message-less failure still reads as one");
  // A fetched entry: the first line is the summary header, the rest the events, escaped.
  const card = histDetailCardHtml({ state: "ok", text: "clean tick #9 — changed · 46s\nevent one\nevent <two>" });
  assert.match(card, /hist-detail-head/);
  assert.match(card, /clean tick #9 — changed · 46s/);
  assert.match(card, /event one/);
  assert.match(card, /event &lt;two&gt;/);
  // A text with only the header line (an event-less block) says so instead of an empty pre.
  assert.match(histDetailCardHtml({ state: "ok", text: "clean tick #1 — unpaired" }), /No events in this tick's block/);
});

test("the drill-down toggle expands one row's card, caches it, and collapses on re-toggle", async () => {
  const calls: string[] = [];
  let renders = 0;
  const scope = clientScope<{
    histDetails: Map<string, { state: string; text?: string; message?: string }>;
    histDetailOpen: string;
    toggleHistDetail(role: string, tick: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>): string;
  }>(HISTORY_REGIONS, ["histDetails", "histDetailOpen", "toggleHistDetail", "historyTableHtml"], {
    icon: iconStub,
    getJson: (path: string) => {
      calls.push(path);
      return Promise.resolve({ text: "clean tick #9 — changed · 46s\nevent one" });
    },
    renderHistory: () => {
      renders++;
    },
  });
  const { histDetails, toggleHistDetail, historyTableHtml } = scope;
  const rows = [{ ts: 0, time: "t", loop: "clean", tick: 9, result: "changed", durationMs: 46_000, usage: "", detail: "d" }];
  const htmlWith = () => historyTableHtml(rows, "all", new Set(["clean"]));

  // Expanding installs the loading entry synchronously and paints it before the fetch answers.
  toggleHistDetail("clean", "9");
  assert.equal(histDetails.get("clean#9")?.state, "loading", "the loading entry is the fetch's synchronous prefix");
  assert.match(htmlWith(), /<tr class='detail-row'><td colspan='8'><div class='empty'>Loading tick detail…<\/div>/);
  assert.match(htmlWith(), /aria-expanded='true'/, "the open row's toggle says so");

  // The fetch answers into the cache; the card then shows the pre-rendered trail.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["/api/tick?role=clean&tick=9"]);
  assert.equal(histDetails.get("clean#9")?.state, "ok");
  const card = htmlWith();
  assert.match(card, /clean tick #9 — changed · 46s/);
  assert.match(card, /event one/);
  assert.doesNotMatch(card, /Loading tick detail…/);

  // Collapsing closes the card; re-expanding reuses the cached one without refetching.
  toggleHistDetail("clean", "9");
  assert.doesNotMatch(htmlWith(), /detail-row/);
  toggleHistDetail("clean", "9");
  assert.match(htmlWith(), /event one/);
  assert.deepEqual(calls, ["/api/tick?role=clean&tick=9"], "the cached card is reused, not refetched");

  // A refetch invalidates the cache (fetchHistory clears it), so the next expand fetches again.
  histDetails.clear();
  toggleHistDetail("clean", "9"); // collapse the still-open card first
  toggleHistDetail("clean", "9"); // expand again: the cache is empty, so this fetches
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2, "the cleared cache fetches anew");
  assert.ok(renders >= 4, "each transition repaints the view");
});

test("a failed detail fetch renders the server's message in the card, not a stuck loading state", async () => {
  const scope = clientScope<{
    histDetails: Map<string, { state: string; message?: string }>;
    toggleHistDetail(role: string, tick: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>): string;
  }>(HISTORY_REGIONS, ["histDetails", "toggleHistDetail", "historyTableHtml"], {
    icon: iconStub,
    getJson: () => Promise.reject(new Error("no tick #9 for clean in the scanned window")),
    renderHistory: () => {},
  });
  const { histDetails, toggleHistDetail, historyTableHtml } = scope;
  toggleHistDetail("clean", "9");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(histDetails.get("clean#9")?.state, "error");
  const html = historyTableHtml([{ ts: 0, time: "t", loop: "clean", tick: 9, result: "changed", durationMs: null, usage: "", detail: "d" }], "all", new Set(["clean"]));
  assert.match(html, /no tick #9 for clean in the scanned window/);
  assert.doesNotMatch(html, /Loading tick detail…/);
  // And the errored entry is cached: re-expanding reuses it without a second request.
  toggleHistDetail("clean", "9");
  toggleHistDetail("clean", "9");
  assert.equal(histDetails.get("clean#9")?.state, "error", "the error caches like an answer");
});
