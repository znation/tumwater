import { sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_HISTORY_JS } from "../src/ui/gui/gui-client-history.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { historyClass as sharedHistoryClass } from "../src/history/history-data.js";
import { SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { clientRegion, clientScope, ESC_LINE, iconStub } from "./helpers/gui-client-scope.js";

// The dashboard's History view (src/ui/gui/gui-client-history.ts): the table it paints from
// /api/history's rows, its tick drill-down (the per-row details toggle and the card /api/run
// serves), and its place in the assembled script.

test("GUI_CLIENT_JS carries the history module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_HISTORY_JS), "the module's constant appears verbatim in the assembled script");
});

// The regions the History view's pieces run with: the shared format/view-model helpers, the
// drill-down state and card renderer, then the table.
const HISTORY_REGIONS = ["format", "labels", "view-model", "history-detail", "history-table"];

test("the History table renders tick rows, escapes them, and filters by outcome", () => {
  const { historyTableHtml, historyClass } = clientScope<{
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, grep?: string, sinceKey?: string): string;
    historyClass(result: string): string;
  }>(HISTORY_REGIONS, ["historyTableHtml", "historyClass"], { icon: iconStub });
  const now = Date.now();
  const rows = [
    { ts: now - 5 * 60_000, time: "2026-09-29 15:33:31", role: "coverage", run: 5, result: "queued", model: "acme/m1", durationMs: 45_000, usage: "12.0k tok · $0.04", detail: "bumped coverage" },
    { ts: now - 9 * 60_000, time: "2026-09-29 15:29:00", role: "gone-loop", run: 7, result: "no_change", model: null, durationMs: null, usage: "", detail: "" },
    { ts: now - 20 * 60_000, time: "2026-09-29 15:18:00", role: "qa", run: 2, result: "error", model: "claude/x", durationMs: 240_000, usage: "900 tok", detail: "<script>x</script>" },
  ];
  const html = historyTableHtml(rows, "all", new Set(["coverage", "qa"]));
  assert.match(html, /<th class='c-model'>Model<\/th>/, "the History table names a Model column after Result");
  assert.match(html, /<td class='c-model'><span class='clamp1' title='acme\/m1'>acme\/m1<\/span><\/td>/, "a row that ran on a model shows its selector");
  assert.match(html, /<td class='c-model'><span class='clamp1' title='claude\/x'>claude\/x<\/span><\/td>/);
  assert.match(html, /<td class='c-model'><span class='clamp1' title=''><span class='muted'>—<\/span><\/span><\/td>/, "a row with no model shows a muted dash");
  assert.match(html, /<tr class='clickable' data-open='coverage'>/, "a team loop's row opens its drawer");
  assert.match(html, /<tr><td class='c-x'><\/td><td title='2026-09-29 15:29:00'>/, "a row for a loop no longer in the team is plain and carries no toggle");
  assert.match(html, /5m ago/);
  assert.match(html, /#5/);
  assert.match(html, /<span class='res t-indigo'>Waiting to merge<\/span>/);
  assert.match(html, /<td class='num c-dur'>45s<\/td>/);
  assert.match(html, /<td class='num c-dur'>4m<\/td>/);
  assert.match(html, /<td class='num c-dur'>—<\/td>/, "a missing duration is a dash, never NaN");
  assert.doesNotMatch(html, /NaN|<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  // The per-row drill-down toggle: a team loop's row carries one, addressed by role+tick.
  assert.match(html, /data-tickdetail='1' data-role='coverage' data-tick='5' aria-expanded='false'/);
  assert.match(html, /data-tickdetail='1' data-role='qa' data-tick='2'/);
  // The outcome filter's buckets.
  const bucketCases = ["changed", "queued", "no_change", "skipped", "user_aborted", "error", "rejected"];
  assert.deepEqual(bucketCases.map(historyClass),
    ["changes", "changes", "none", "none", "none", "problems", "problems"]);
  // The browser copy is pinned to the CLI's canonical rule (history-data.ts's historyClass):
  // any change to one copy without the other fails here, so the two cannot drift.
  assert.deepEqual(bucketCases.map(historyClass), bucketCases.map(sharedHistoryClass));
  const problems = historyTableHtml(rows, "problems", new Set());
  assert.equal((problems.match(/<tr>/g) ?? []).length, 2, "the header row and the one error row");
  assert.match(historyTableHtml(rows, "changes", new Set()), /bumped coverage/);
  assert.match(historyTableHtml([], "all", new Set()), /No runs yet/);
  // A server-side grep that matched nothing names the search, never the empty log.
  assert.match(historyTableHtml([], "all", new Set(), "widget"), /No runs match this search/);
  assert.doesNotMatch(historyTableHtml([], "all", new Set(), "widget"), /No runs yet/);
  assert.match(historyTableHtml(null, "all", new Set(), "widget"), /No runs match this search/, "a response without rows under a search reads as no match, not an empty log");
  assert.match(historyTableHtml([], "all", new Set(), undefined, "1d"), /No runs in the last day/, "an empty selected window is named, not read as an empty log");
  assert.match(historyTableHtml([], "all", new Set(), undefined, "nonsense"), /No runs yet/, "a stale window key falls back to the plain empty state");
  assert.match(historyTableHtml(rows.slice(1, 2), "changes", new Set()), /No runs match this filter/);
  assert.match(historyTableHtml(null, "all", new Set()), /No runs yet/, "a response without rows reads as none");
});

test("the History toolbar carries the search field, recalled and persisted", () => {
  // The search input lives inside the toolbar markup, between its opening and the card body.
  const toolbar = GUI_CLIENT_HISTORY_JS.slice(
    GUI_CLIENT_HISTORY_JS.indexOf("class='toolbar'"),
    GUI_CLIENT_HISTORY_JS.indexOf("<div class='card' id='histbody'>"),
  );
  assert.match(toolbar, /id='histgrep'/);
  // Its pattern persists like the loop and count selections.
  assert.match(GUI_CLIENT_HISTORY_JS, /recall\("hist-grep"\)/);
  assert.match(GUI_CLIENT_HISTORY_JS, /store\("hist-grep", histGrep\)/);
});

/** Run the whole history blob (the served constant) in one function scope with stand-ins for
 * everything it reaches, then hand back fetchHistory. The DOM- and status-touching paths return
 * early (buildOnce false, $ undefined), so only the /api/history request is observable. */
function historyFetchScope(recallGrep: string | null, paths: string[]) {
  const code = [ESC_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory };"].join("\n");
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  const run = new Function(...keys, code) as (...args: unknown[]) => { fetchHistory(throttled?: boolean): Promise<void> };
  return run(
    (key: string) => (key === "hist-grep" ? recallGrep : null),
    () => {},
    () => false,
    () => undefined,
    iconStub,
    null,
    () => {},
    (title: string) => title,
    async (path: string) => {
      paths.push(path);
      return { rows: [] };
    },
  );
}

test("fetchHistory appends the encoded grep only when a pattern is set", async () => {
  const bare: string[] = [];
  await historyFetchScope(null, bare).fetchHistory(false);
  assert.deepEqual(bare, ["/api/history?n=50&summary=1"]);
  const searched: string[] = [];
  await historyFetchScope("sorted imports", searched).fetchHistory(false);
  assert.deepEqual(searched, ["/api/history?n=50&grep=sorted%20imports&summary=1"]);
});

test("historyQuery picks the count or trailing-window shape and composes the role", () => {
  const { historyQuery } = clientScope<{ historyQuery(count: number, role: string, sinceKey: string): string }>(
    HISTORY_REGIONS,
    ["historyQuery"],
    { icon: iconStub },
  );
  assert.equal(historyQuery(50, "", ""), "/api/history?n=50&summary=1");
  assert.equal(historyQuery(50, "clean", ""), "/api/history?n=50&role=clean&summary=1");
  assert.equal(historyQuery(50, "", "1d"), "/api/history?sinceMs=86400000&summary=1", "a window replaces the count shape");
  assert.equal(historyQuery(50, "clean", "7d"), "/api/history?sinceMs=604800000&role=clean&summary=1", "role composes with the window");
  assert.equal(historyQuery(50, "", "nonsense"), "/api/history?n=50&summary=1", "an unknown window key falls back to the count");
});

test("the History toolbar carries the four trailing-window options in the #histcount select", () => {
  const { histWindowOptions } = clientScope<{ histWindowOptions(): string }>(HISTORY_REGIONS, ["histWindowOptions"], { icon: iconStub });
  const options = histWindowOptions();
  for (const [value, label] of [
    ["1h", "The last hour"],
    ["6h", "The last 6 hours"],
    ["1d", "The last day"],
    ["7d", "The last 7 days"],
  ] as [string, string][]) {
    assert.match(options, new RegExp("<option value='" + value + "'>" + label + "</option>"), `the ${value} window option`);
  }
  // The options are inserted into that select's markup (the count options then the windows).
  assert.match(GUI_CLIENT_HISTORY_JS, /id='histcount'>"[\s\S]*?histWindowOptions\(\)/);
});

test("historyNoteHtml renders the server's sparse-window note and nothing when empty", () => {
  const { historyNoteHtml } = clientScope<{ historyNoteHtml(note: string): string }>(HISTORY_REGIONS, ["historyNoteHtml"], { icon: iconStub });
  assert.equal(historyNoteHtml(""), "");
  const html = historyNoteHtml(SPARSE_WINDOW_NOTE);
  assert.match(html, /window-note/);
  assert.match(html, /oldest retained event lies inside this window/);
  assert.match(html, /log&#39;s/, "the note is escaped like every other rendered string");
});

test("fetchHistory normalizes a persisted tick count the toolbar does not offer", async () => {
  // Only the picker's four counts are ever written, but a persisted hist-n from another build
  // (or a hand edit) can be anything. The picker can then not represent it, so the viewed count
  // and the requested count would disagree; normalize at read to the default the picker shows.
  const paths: string[] = [];
  const code = [ESC_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory };"].join("\n");
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  const run = new Function(...keys, code) as (...args: unknown[]) => { fetchHistory(throttled?: boolean): Promise<void> };
  await run(
    (key: string) => (key === "hist-n" ? "30" : null),
    () => {},
    () => false,
    () => undefined,
    iconStub,
    null,
    () => {},
    (title: string) => title,
    async (path: string) => {
      paths.push(path);
      return { rows: [] };
    },
  ).fetchHistory(false);
  assert.deepEqual(paths, ["/api/history?n=50&summary=1"], "an off-menu persisted count falls back to the default the picker shows");
});

test("histDetailCardHtml branches on the entry's state: loading, error, then the fetched card", () => {
  const { histDetailCardHtml } = clientScope<{ histDetailCardHtml(entry: unknown): string }>(
    HISTORY_REGIONS,
    ["histDetailCardHtml"],
    { icon: iconStub },
  );
  // Absent and loading entries render the placeholder — a truthy-but-loading entry can never
  // fall into the fetched path and read as an empty trail.
  assert.match(histDetailCardHtml(undefined), /Loading run detail…/);
  assert.match(histDetailCardHtml({ state: "loading" }), /Loading run detail…/);
  assert.doesNotMatch(histDetailCardHtml({ state: "loading" }), /No events/);
  // An errored fetch shows the server's message, escaped.
  assert.match(histDetailCardHtml({ state: "error", message: "no tick #9 for clean <b>" }), /no tick #9 for clean &lt;b&gt;/);
  assert.match(histDetailCardHtml({ state: "error" }), /Run detail unavailable/, "a message-less failure still reads as one");
  // A fetched entry: the first line is the summary header, the rest the events, escaped.
  const card = histDetailCardHtml({ state: "ok", text: "clean tick #9 — changed · 46s\nevent one\nevent <two>" });
  assert.match(card, /hist-detail-head/);
  assert.match(card, /clean tick #9 — changed · 46s/);
  assert.match(card, /event one/);
  assert.match(card, /event &lt;two&gt;/);
  // A text with only the header line (an event-less block) says so instead of an empty pre.
  assert.match(histDetailCardHtml({ state: "ok", text: "clean tick #1 — unpaired" }), /No events in this run's block/);
  // The commit stat shows under the trail when present, and is absent otherwise.
  assert.match(histDetailCardHtml({ state: "ok", text: "h\ne", stat: " a.ts | 2 +-" }), /hist-detail-stat.*a\.ts \| 2 \+-/);
  assert.doesNotMatch(histDetailCardHtml({ state: "ok", text: "h\ne", stat: "" }), /hist-detail-stat/);
});

test("the drill-down toggle expands one row's card, caches it, and collapses on re-toggle", async () => {
  const calls: string[] = [];
  let renders = 0;
  const scope = clientScope<{
    histDetails: Map<string, { state: string; text?: string; message?: string }>;
    histDetailOpen: string;
    toggleHistDetail(role: string, tick: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, sinceKey?: string): string;
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
  const rows = [{ ts: 0, time: "t", role: "clean", run: 9, result: "changed", durationMs: 46_000, usage: "", detail: "d" }];
  const htmlWith = () => historyTableHtml(rows, "all", new Set(["clean"]));

  // Expanding installs the loading entry synchronously and paints it before the fetch answers.
  toggleHistDetail("clean", "9");
  assert.equal(histDetails.get("clean#9")?.state, "loading", "the loading entry is the fetch's synchronous prefix");
  assert.match(htmlWith(), /<tr class='detail-row'><td colspan='9'><div class='empty'>Loading run detail…<\/div>/);
  assert.match(htmlWith(), /aria-expanded='true'/, "the open row's toggle says so");

  // The fetch answers into the cache; the card then shows the pre-rendered trail.
  await sleep(0);
  assert.deepEqual(calls, ["/api/run?role=clean&run=9"]);
  assert.equal(histDetails.get("clean#9")?.state, "ok");
  const card = htmlWith();
  assert.match(card, /clean tick #9 — changed · 46s/);
  assert.match(card, /event one/);
  assert.doesNotMatch(card, /Loading run detail…/);

  // Collapsing closes the card; re-expanding reuses the cached one without refetching.
  toggleHistDetail("clean", "9");
  assert.doesNotMatch(htmlWith(), /detail-row/);
  toggleHistDetail("clean", "9");
  assert.match(htmlWith(), /event one/);
  assert.deepEqual(calls, ["/api/run?role=clean&run=9"], "the cached card is reused, not refetched");

  // A refetch invalidates the cache (fetchHistory clears it), so the next expand fetches again.
  histDetails.clear();
  toggleHistDetail("clean", "9"); // collapse the still-open card first
  toggleHistDetail("clean", "9"); // expand again: the cache is empty, so this fetches
  await sleep(0);
  assert.equal(calls.length, 2, "the cleared cache fetches anew");
  assert.ok(renders >= 4, "each transition repaints the view");
});

test("a failed detail fetch renders the server's message in the card, not a stuck loading state", async () => {
  const scope = clientScope<{
    histDetails: Map<string, { state: string; message?: string }>;
    toggleHistDetail(role: string, tick: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, sinceKey?: string): string;
  }>(HISTORY_REGIONS, ["histDetails", "toggleHistDetail", "historyTableHtml"], {
    icon: iconStub,
    getJson: () => Promise.reject(new Error("no tick #9 for clean in the scanned window")),
    renderHistory: () => {},
  });
  const { histDetails, toggleHistDetail, historyTableHtml } = scope;
  toggleHistDetail("clean", "9");
  await sleep(0);
  assert.equal(histDetails.get("clean#9")?.state, "error");
  const html = historyTableHtml([{ ts: 0, time: "t", role: "clean", run: 9, result: "changed", durationMs: null, usage: "", detail: "d" }], "all", new Set(["clean"]));
  assert.match(html, /no tick #9 for clean in the scanned window/);
  assert.doesNotMatch(html, /Loading run detail…/);
  // And the errored entry is cached: re-expanding reuses it without a second request.
  toggleHistDetail("clean", "9");
  toggleHistDetail("clean", "9");
  assert.equal(histDetails.get("clean#9")?.state, "error", "the error caches like an answer");
});

test("the fetched tick detail keeps the server's stat, and an older server's missing stat is not an error", async () => {
  for (const [answer, shown] of [[{ text: "h\ne", stat: " a.ts | 2 +-" }, true], [{ text: "h\ne" }, false]] as const) {
    const scope = clientScope<{
      histDetails: Map<string, { state: string; stat?: string }>;
      toggleHistDetail(role: string, tick: string): void;
      historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, sinceKey?: string): string;
    }>(HISTORY_REGIONS, ["histDetails", "toggleHistDetail", "historyTableHtml"], {
      icon: iconStub,
      getJson: () => Promise.resolve(answer),
      renderHistory: () => {},
    });
    scope.toggleHistDetail("clean", "9");
    await sleep(0);
    assert.equal(scope.histDetails.get("clean#9")?.state, "ok");
    const html = scope.historyTableHtml([{ ts: 0, time: "t", role: "clean", run: 9, result: "changed", durationMs: null, usage: "", detail: "d" }], "all", new Set(["clean"]));
    assert.equal(html.includes("hist-detail-stat"), shown);
    if (shown) assert.match(html, /a\.ts \| 2 \+-/);
  }
});

test("a malformed tick-detail payload errors naming the endpoint, the tick, and the likely cause", async () => {
  const scope = clientScope<{
    histDetails: Map<string, { state: string; message?: string }>;
    toggleHistDetail(role: string, tick: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, sinceKey?: string): string;
  }>(HISTORY_REGIONS, ["histDetails", "toggleHistDetail", "historyTableHtml"], {
    icon: iconStub,
    getJson: () => Promise.resolve({}), // a 200 body without the promised text field
    renderHistory: () => {},
  });
  const { histDetails, toggleHistDetail, historyTableHtml } = scope;
  toggleHistDetail("clean", "9");
  await sleep(0);
  assert.equal(histDetails.get("clean#9")?.state, "error");
  const html = historyTableHtml([{ ts: 0, time: "t", role: "clean", run: 9, result: "changed", durationMs: null, usage: "", detail: "d" }], "all", new Set(["clean"]));
  assert.match(html, /\/api\/run answered clean run 9 without a text field/);
  assert.match(html, /tumwater may not match/, "the card's esc() escapes the message's apostrophe");
});

test("fetchHistory drops and re-persists a loop scope the team no longer lists", async () => {
  // A persisted hist-role naming a retired loop: syncHistoryRoles repaints the picker to All
  // loops, and the scope variable must follow it. Otherwise the picker shows All loops while
  // the request keeps `&role=<vanished>`, so the view reads as an empty log the operator cannot
  // explain. The report views' syncRoles already falls back and persists; History must match.
  const paths: string[] = [];
  const stored: Array<[string, string]> = [];
  const select = { innerHTML: "", value: "gone-loop" };
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  // The report-role region supplies rolePickerOptions, which syncHistoryRoles repaints the
  // picker through — the same shared helper the report views use.
  const code = [ESC_LINE, clientRegion("report-role"), GUI_CLIENT_HISTORY_JS, "return { fetchHistory };"].join("\n");
  const run = new Function(...keys, code) as (...args: unknown[]) => { fetchHistory(throttled?: boolean): Promise<void> };
  await run(
    (key: string) => (key === "hist-role" ? "gone-loop" : null),
    (key: string, value: string) => { stored.push([key, value]); },
    () => false, // buildHistoryView returns early; only the fetch is observed
    (id: string) => (id === "histrole" ? select : undefined),
    iconStub,
    { roles: [{ role: "feature" }, { role: "qa" }] },
    () => {},
    (title: string) => title,
    async (path: string) => { paths.push(path); return { rows: [] }; },
  ).fetchHistory(false);
  assert.equal(select.value, "", "the picker falls back to All loops");
  assert.deepEqual(paths, ["/api/history?n=50&summary=1"], "and the request drops the vanished role");
  assert.deepEqual(stored, [["hist-role", ""]], "the fallback persists so a reload does not resurrect it");
});

test("histSummaryHtml paints one row per loop plus the total, with the report formatters and a dash for a never-changed loop", () => {
  const { histSummaryHtml } = clientScope<{ histSummaryHtml(summary: unknown): string }>(
    ["format", "labels", "history-summary"],
    ["histSummaryHtml"],
    { icon: iconStub },
  );
  const now = Date.now();
  const summary = {
    roles: [
      { role: "clean", runs: 2, changes: 2, none: 0, problems: 0, tokens: 500, costUsd: 0.25, durationMs: 3_600_000, lastChangeTs: now - 5 * 60_000 },
      { role: "feature", runs: 1, changes: 0, none: 1, problems: 0, tokens: 0, costUsd: 0, lastChangeTs: null },
      { role: "qa", runs: 1, changes: 0, none: 0, problems: 1, tokens: 12_500, costUsd: 0, lastChangeTs: null },
    ],
    total: { role: "total", runs: 4, changes: 2, none: 1, problems: 1, tokens: 13_000, costUsd: 0.25, durationMs: 3_600_000, lastChangeTs: now - 5 * 60_000 },
  };
  const html = histSummaryHtml(summary);
  // The column set mirrors history --summary: loop, ticks, changes, none, problems, tokens,
  // cost, time, last change, so the dashboard and the CLI cannot drift column for column.
  for (const h of ["Role", "Runs", "Merged", "None", "Problems", "Tokens", "Cost", "Time", "Last change"]) {
    assert.match(html, new RegExp("<th[^>]*>" + h + "</th>"), "the " + h + " header");
  }
  // The time cell folds the loop's run spans via fmtSpan (an hour reads "60m", its minute bucket);
  // a loop whose rows carried no span shows a dash.
  assert.match(html, /<td class='num'>60m<\/td>/, "the timed loop's run time via fmtSpan");
  assert.match(html, /<td class='num'>—<\/td>/, "a loop without a timed span shows a dash");
  // One row per loop plus the total, the total row marked.
  assert.equal((html.match(/<tr/g) ?? []).length, 5, "the header row, the three loops, and the total");
  assert.match(html, /<tr class='hist-total'><td class='mono'>total<\/td>/);
  // Every number comes from the server's summary — never re-derived — and the token/cost cells
  // reuse the report charts' formatters (compact tokens, $).
  assert.match(html, /<td class='num'>12\.5k<\/td>/, "tokens format like the report charts");
  assert.match(html, /<td class='num'>13\.0k<\/td>/);
  assert.match(html, /<td class='num'>\$0\.25<\/td>/);
  // A changed loop's last change is the newest change's age; a never-changed loop's is a dash.
  assert.match(html, /<td>5m ago<\/td>/);
  assert.match(html, /<td>—<\/td>/);
});

test("the toolbar carries the Table/Summary toggle, recalled and persisted like the filter", () => {
  const toolbar = GUI_CLIENT_HISTORY_JS.slice(
    GUI_CLIENT_HISTORY_JS.indexOf("class='toolbar'"),
    GUI_CLIENT_HISTORY_JS.indexOf("<div class='card' id='histbody'>"),
  );
  assert.match(toolbar, /id='histsum'/);
  assert.match(toolbar, /data-histsum='" \+ m\[0\] \+ "'>" \+ m\[1\]/);
  assert.match(GUI_CLIENT_HISTORY_JS, /const HIST_MODES = \[\["table", "Table"\], \["summary", "Summary"\]\]/);
  assert.match(GUI_CLIENT_HISTORY_JS, /recall\("hist-mode"\)/);
  assert.match(GUI_CLIENT_HISTORY_JS, /store\("hist-mode", histMode\)/);
});

test("fetchHistory rides the server summary and a persisted Summary mode survives a reload", async () => {
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  const code = [ESC_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory, getHistSummary: () => histSummary, histMode };"].join("\n");
  const run = new Function(...keys, code) as (...args: unknown[]) => {
    fetchHistory(throttled?: boolean): Promise<void>;
    getHistSummary(): { roles: unknown[] } | null;
    histMode: string;
  };
  const scope = run(
    (key: string) => (key === "hist-mode" ? "summary" : null),
    () => {},
    () => false,
    () => undefined,
    iconStub,
    null,
    () => {},
    (title: string) => title,
    async () => ({ rows: [{ role: "clean" }], summary: { roles: [{ role: "clean" }], total: { role: "total" } } }),
  );
  assert.equal(scope.histMode, "summary", "the persisted mode restores on load");
  await scope.fetchHistory(false);
  assert.deepEqual(scope.getHistSummary()?.roles, [{ role: "clean" }], "the fetched summary rides beside the rows, so toggling never refetches");
});
