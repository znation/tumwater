import { sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_HISTORY_JS } from "../src/ui/gui/gui-client-history.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { historyClass as sharedHistoryClass } from "../src/history/history-data.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { clientRegion, clientScope, ESC_LINE, iconStub, CAPITALIZE_LINE } from "./helpers/gui-client-scope.js";

// The dashboard's History view (src/ui/gui/gui-client-history.ts): the table it paints from
// /api/history's rows, its run drill-down (the per-row details toggle and the card /api/run
// serves), and its place in the assembled script.

test("GUI_CLIENT_JS carries the history module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_HISTORY_JS), "the module's constant appears verbatim in the assembled script");
});

// The regions the History view's pieces run with: the shared format/view-model helpers, the
// drill-down state and card renderer, then the table.
const HISTORY_REGIONS = ["format", "labels", "view-model", "err-message", "history-detail", "history-table"];

test("the History table renders run rows, escapes them, and filters by outcome", () => {
  const { historyTableHtml, historyClass } = clientScope<{
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, grep?: string, sinceKey?: string): string;
    historyClass(result: string): string;
  }>(HISTORY_REGIONS, ["historyTableHtml", "historyClass"], { icon: iconStub });
  const now = Date.now();
  const rows = [
    { ts: now - 5 * 60_000, time: "2026-09-29 15:33:31", role: "coverage", run: 5, result: "queued", model: "acme/m1", durationMs: 45_000, usage: "12.0k tok · $0.04", detail: "bumped coverage" },
    { ts: now - 9 * 60_000, time: "2026-09-29 15:29:00", role: "gone-loop", run: 7, result: "no_change", model: null, durationMs: null, usage: "", detail: "", cutOff: true },
    { ts: now - 20 * 60_000, time: "2026-09-29 15:18:00", role: "qa", run: 2, result: "error", model: "claude/x", durationMs: 240_000, usage: "900 tok", detail: "<script>x</script>" },
  ];
  const html = historyTableHtml(rows, "all", new Set(["coverage", "qa"]));
  assert.match(html, /<th class='c-model'>Model<\/th>/, "the History table names a Model column after Result");
  assert.match(html, /<td class='c-model'><span class='clamp1' title='acme\/m1'>acme\/m1<\/span><\/td>/, "a row that ran on a model shows its selector");
  assert.match(html, /<td class='c-model'><span class='clamp1' title='claude\/x'>claude\/x<\/span><\/td>/);
  assert.match(html, /<td class='c-model'><span class='clamp1' title=''><span class='muted'>—<\/span><\/span><\/td>/, "a row with no model shows a muted dash");
  assert.match(html, /<tr class='clickable' data-open='coverage'>/, "a team role's row opens its drawer");
  assert.match(html, /<tr><td class='c-x'><\/td><td title='2026-09-29 15:29:00'>/, "a row for a role no longer in the team is plain and carries no toggle");
  assert.match(html, /5m ago/);
  assert.match(html, /#5/);
  assert.match(html, /<span class='res t-indigo'>Waiting to merge<\/span>/);
  // A run cut off at its model's context ceiling marks its Result cell distinctly, and a
  // row without the flag renders no marker (the coverage row above has none).
  assert.match(html, /cut off/);
  assert.match(html, /title='cut off at the context ceiling'/);
  assert.equal((html.match(/<span class='muted' title='cut off at the context ceiling'>cut off<\/span>/g) ?? []).length, 1, "only the cut-off row carries the marker");
  assert.match(html, /<td class='num c-dur'>45s<\/td>/);
  assert.match(html, /<td class='num c-dur'>4m<\/td>/);
  assert.match(html, /<td class='num c-dur'>—<\/td>/, "a missing duration is a dash, never NaN");
  assert.doesNotMatch(html, /NaN|<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  // The per-row drill-down toggle: a team role's row carries one, addressed by role+run.
  assert.match(html, /data-rundetail='1' data-role='coverage' data-run='5' aria-expanded='false'/);
  assert.match(html, /data-rundetail='1' data-role='qa' data-run='2'/);
  // The outcome filter's buckets.
  const bucketCases = ["changed", "queued", "no_change", "skipped", "user_aborted", "refused", "error", "rejected"];
  assert.deepEqual(bucketCases.map(historyClass),
    ["changes", "changes", "none", "none", "none", "refused", "problems", "problems"]);
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
  // Its pattern persists like the role and count selections.
  assert.match(GUI_CLIENT_HISTORY_JS, /recall\("hist-grep"\)/);
  assert.match(GUI_CLIENT_HISTORY_JS, /store\("hist-grep", histGrep\)/);
});

/** Run the whole history blob (the served constant) in one function scope with stand-ins for
 * everything it reaches, then hand back fetchHistory. The DOM- and status-touching paths return
 * early (buildOnce false, $ undefined), so only the /api/history request is observable. */
function historyFetchScope(recallGrep: string | null, paths: string[]) {
  const code = [ESC_LINE, CAPITALIZE_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory, getHistNewest: () => histNewest, setHistNewest: (v) => { histNewest = v; } };"].join("\n");
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  const run = new Function(...keys, code) as (...args: unknown[]) => {
    fetchHistory(throttled?: boolean): Promise<void>;
    getHistNewest(): unknown;
    setHistNewest(v: unknown): void;
  };
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

test("fetchHistory drops a pinned Newest failure card on a refresh", async () => {
  // A refresh (or a role/window/count change) reruns the whole fetch path, which resets the
  // pinned card together with the drill-down cache, like the row cards.
  const scope = historyFetchScope(null, []);
  assert.equal(scope.getHistNewest(), null, "the fresh scope starts with no pinned card");
  scope.setHistNewest({ state: "error", message: "x" });
  await scope.fetchHistory(false);
  assert.equal(scope.getHistNewest(), null, "a refresh drops the pinned card with the drill-down cache");
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

test("fetchHistory normalizes a persisted run count the toolbar does not offer", async () => {
  // Only the picker's four counts are ever written, but a persisted hist-n from another build
  // (or a hand edit) can be anything. The picker can then not represent it, so the viewed count
  // and the requested count would disagree; normalize at read to the default the picker shows.
  const paths: string[] = [];
  const code = [ESC_LINE, CAPITALIZE_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory };"].join("\n");
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
  assert.match(histDetailCardHtml({ state: "error", message: "no run #9 for clean <b>" }), /no run #9 for clean &lt;b&gt;/);
  assert.match(histDetailCardHtml({ state: "error" }), /Run detail unavailable/, "a message-less failure still reads as one");
  // A fetched entry: the first line is the summary header, the rest the events, escaped.
  const card = histDetailCardHtml({ state: "ok", text: "clean run #9 — changed · 46s\nevent one\nevent <two>" });
  assert.match(card, /hist-detail-head/);
  assert.match(card, /clean run #9 — changed · 46s/);
  assert.match(card, /event one/);
  assert.match(card, /event &lt;two&gt;/);
  // A text with only the header line (an event-less block) says so instead of an empty pre.
  assert.match(histDetailCardHtml({ state: "ok", text: "clean run #1 — unpaired" }), /No events in this run's block/);
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
    toggleHistDetail(role: string, run: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, sinceKey?: string): string;
  }>(HISTORY_REGIONS, ["histDetails", "histDetailOpen", "toggleHistDetail", "historyTableHtml"], {
    icon: iconStub,
    getJson: (path: string) => {
      calls.push(path);
      return Promise.resolve({ text: "clean run #9 — changed · 46s\nevent one" });
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
  assert.match(card, /clean run #9 — changed · 46s/);
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
    toggleHistDetail(role: string, run: string): void;
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>, sinceKey?: string): string;
  }>(HISTORY_REGIONS, ["histDetails", "toggleHistDetail", "historyTableHtml"], {
    icon: iconStub,
    getJson: () => Promise.reject(new Error("no run #9 for clean in the scanned window")),
    renderHistory: () => {},
  });
  const { histDetails, toggleHistDetail, historyTableHtml } = scope;
  toggleHistDetail("clean", "9");
  await sleep(0);
  assert.equal(histDetails.get("clean#9")?.state, "error");
  const html = historyTableHtml([{ ts: 0, time: "t", role: "clean", run: 9, result: "changed", durationMs: null, usage: "", detail: "d" }], "all", new Set(["clean"]));
  assert.match(html, /no run #9 for clean in the scanned window/);
  assert.doesNotMatch(html, /Loading run detail…/);
  // And the errored entry is cached: re-expanding reuses it without a second request.
  toggleHistDetail("clean", "9");
  toggleHistDetail("clean", "9");
  assert.equal(histDetails.get("clean#9")?.state, "error", "the error caches like an answer");
});

test("the fetched run detail keeps the server's stat, and an older server's missing stat is not an error", async () => {
  for (const [answer, shown] of [[{ text: "h\ne", stat: " a.ts | 2 +-" }, true], [{ text: "h\ne" }, false]] as const) {
    const scope = clientScope<{
      histDetails: Map<string, { state: string; stat?: string }>;
      toggleHistDetail(role: string, run: string): void;
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

test("a malformed run-detail payload errors naming the endpoint, the run, and the likely cause", async () => {
  const scope = clientScope<{
    histDetails: Map<string, { state: string; message?: string }>;
    toggleHistDetail(role: string, run: string): void;
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

test("fetchHistory drops and re-persists a role scope the team no longer lists", async () => {
  // A persisted hist-role naming a retired role: syncHistoryRoles repaints the picker to All
  // roles, and the scope variable must follow it. Otherwise the picker shows All roles while
  // the request keeps `&role=<vanished>`, so the view reads as an empty log the operator cannot
  // explain. The report views' syncRoles already falls back and persists; History must match.
  const paths: string[] = [];
  const stored: Array<[string, string]> = [];
  const select = { innerHTML: "", value: "gone-loop" };
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  // The report-role region supplies rolePickerOptions, which syncHistoryRoles repaints the
  // picker through — the same shared helper the report views use.
  const code = [ESC_LINE, CAPITALIZE_LINE, clientRegion("report-role"), GUI_CLIENT_HISTORY_JS, "return { fetchHistory };"].join("\n");
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
  assert.equal(select.value, "", "the picker falls back to All roles");
  assert.deepEqual(paths, ["/api/history?n=50&summary=1"], "and the request drops the vanished role");
  assert.deepEqual(stored, [["hist-role", ""]], "the fallback persists so a reload does not resurrect it");
});

test("histSummaryHtml paints one row per role plus the total, with the report formatters and a dash for a never-changed role", () => {
  const { histSummaryHtml } = clientScope<{ histSummaryHtml(summary: unknown): string }>(
    ["format", "labels", "history-summary"],
    ["histSummaryHtml"],
    { icon: iconStub },
  );
  const now = Date.now();
  const summary = {
    roles: [
      { role: "clean", runs: 2, changes: 2, none: 0, refused: 0, problems: 0, tokens: 500, costUsd: 0.25, durationMs: 3_600_000, peakContextTokens: 110_000, lastChangeTs: now - 5 * 60_000 },
      { role: "feature", runs: 1, changes: 0, none: 1, refused: 0, problems: 0, tokens: 0, costUsd: 0, lastChangeTs: null },
      { role: "qa", runs: 1, changes: 0, none: 0, refused: 0, problems: 1, tokens: 12_500, costUsd: 0, lastChangeTs: null },
    ],
    total: { role: "total", runs: 4, changes: 2, none: 1, refused: 0, problems: 1, tokens: 13_000, costUsd: 0.25, durationMs: 3_600_000, peakContextTokens: 110_000, lastChangeTs: now - 5 * 60_000 },
  };
  const html = histSummaryHtml(summary);
  // The column set mirrors history --summary: role, runs, changes, none, refused, problems,
  // tokens, cost, time, last change, so the dashboard and the CLI cannot drift column for column.
  for (const h of ["Role", "Runs", "Merged", "None", "Refused", "Problems", "Tokens", "Peak ctx", "Cost", "Time", "Last change"]) {
    assert.match(html, new RegExp("<th[^>]*>" + h + "</th>"), "the " + h + " header");
  }
  // The time cell folds the role's run spans via fmtSpan (an hour reads "60m", its minute bucket);
  // a role whose rows carried no span shows a dash.
  assert.match(html, /<td class='num'>60m<\/td>/, "the timed role's run time via fmtSpan");
  assert.match(html, /<td class='num'>110\.0k<\/td>/, "the peak-carrying role's peak via fmtTokens");
  assert.match(html, /<td class='num'>—<\/td>/, "a role without a peak (or timed span) shows a dash");
  // One row per role plus the total, the total row marked.
  assert.equal((html.match(/<tr/g) ?? []).length, 5, "the header row, the three roles, and the total");
  assert.match(html, /<tr class='hist-total'><td class='mono'>total<\/td>/);
  // Every number comes from the server's summary — never re-derived — and the token/cost cells
  // reuse the report charts' formatters (compact tokens, $).
  assert.match(html, /<td class='num'>12\.5k<\/td>/, "tokens format like the report charts");
  assert.match(html, /<td class='num'>13\.0k<\/td>/);
  assert.match(html, /<td class='num'>\$0\.25<\/td>/);
  // A changed role's last change is the newest change's age; a never-changed role's is a dash.
  assert.match(html, /<td>5m ago<\/td>/);
  assert.match(html, /<td>—<\/td>/);
});

test("histModelSummaryHtml paints one row per model, (unknown) for null, an escaped id, and the total", () => {
  const { histModelSummaryHtml } = clientScope<{ histModelSummaryHtml(summary: unknown): string }>(
    ["format", "labels", "history-summary"],
    ["histModelSummaryHtml"],
    { icon: iconStub },
  );
  const z = { runs: 1, changes: 0, none: 1, refused: 0, problems: 0, tokens: 0, costUsd: 0, lastChangeTs: null };
  const html = histModelSummaryHtml({
    models: [{ model: "a<b", ...z }, { model: "claude", ...z }, { model: null, ...z }],
    total: { role: "total", ...z, runs: 3 },
  });
  assert.match(html, /<th>Model<\/th>/);
  assert.match(html, /<td class='mono'><button type='button' class='linkish mono' data-histmodel='a&lt;b'>a&lt;b<\/button><\/td>/, "the model id is escaped");
  assert.match(html, /data-histmodel='claude'>claude<\/button>/);
  assert.equal((html.match(/data-histmodel=/g) ?? []).length, 2, "no button for (unknown) or the total");
  assert.match(html, /<td class='mono'>\(unknown\)<\/td>/);
  assert.equal((html.match(/<tr/g) ?? []).length, 5, "header, three models, total");
  assert.match(html, /<tr class='hist-total'><td class='mono'>total<\/td>/);
});

test("fetchHistory keeps the server's modelSummary and a persisted By model mode survives a reload", async () => {
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  const code = [ESC_LINE, CAPITALIZE_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory, getModels: () => histModelSummary, histMode };"].join("\n");
  const run = new Function(...keys, code) as (...args: unknown[]) => {
    fetchHistory(throttled?: boolean): Promise<void>;
    getModels(): { models: unknown[] } | null;
    histMode: string;
  };
  const scope = run(
    (key: string) => (key === "hist-mode" ? "models" : null),
    () => {},
    () => false,
    () => undefined,
    iconStub,
    null,
    () => {},
    (title: string) => title,
    async () => ({ rows: [{ role: "clean" }], modelSummary: { models: [{ model: "m" }], total: { role: "total" } } }),
  );
  assert.equal(scope.histMode, "models");
  await scope.fetchHistory(false);
  assert.deepEqual(scope.getModels()?.models, [{ model: "m" }]);
});

test("the toolbar carries the Table/Summary toggle, recalled and persisted like the filter", () => {
  const toolbar = GUI_CLIENT_HISTORY_JS.slice(
    GUI_CLIENT_HISTORY_JS.indexOf("class='toolbar'"),
    GUI_CLIENT_HISTORY_JS.indexOf("<div class='card' id='histbody'>"),
  );
  assert.match(toolbar, /id='histsum'/);
  assert.match(toolbar, /data-histsum='" \+ m\[0\] \+ "'>" \+ m\[1\]/);
  assert.match(GUI_CLIENT_HISTORY_JS, /const HIST_MODES = \[\["table", "Table"\], \["summary", "Summary"\], \["models", "By model"\]\]/);
  assert.match(GUI_CLIENT_HISTORY_JS, /recall\("hist-mode"\)/);
  assert.match(GUI_CLIENT_HISTORY_JS, /store\("hist-mode", histMode\)/);
});

test("fetchHistory rides the server summary and a persisted Summary mode survives a reload", async () => {
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson"];
  const code = [ESC_LINE, CAPITALIZE_LINE, GUI_CLIENT_HISTORY_JS, "return { fetchHistory, getHistSummary: () => histSummary, histMode };"].join("\n");
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

test("the drill-down's revert button previews, then reverts, through /api/revert", async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const preview = { sha: "a".repeat(40), subject: "tumwater(feature): <b>x", paths: ["src/a.ts"], head: "b".repeat(40), primary: "main", applies: true, dirty: false };
  let answer: unknown = { ok: true, preview };
  const scope = clientScope<{
    histDetails: Map<string, Record<string, unknown>>;
    histDetailCardHtml(entry: unknown, key: string): string;
    previewHistRevert(key: string): Promise<void>;
    runHistRevert(key: string): Promise<void>;
  }>(HISTORY_REGIONS, ["histDetails", "histDetailCardHtml", "previewHistRevert", "runHistRevert"], {
    icon: iconStub,
    renderHistory: () => {},
    postJson: (path: string, body: Record<string, unknown>) => {
      posts.push({ path, body });
      return Promise.resolve(answer);
    },
  });
  const { histDetails, histDetailCardHtml, previewHistRevert, runHistRevert } = scope;
  const sha = "a".repeat(40);
  const card = () => histDetailCardHtml(histDetails.get("clean#9"), "clean#9");

  histDetails.set("clean#8", { state: "ok", text: "h", revertSha: null });
  assert.doesNotMatch(histDetailCardHtml(histDetails.get("clean#8"), "clean#8"), /data-hist-revert/, "no revertSha, no button");
  histDetails.set("clean#9", { state: "ok", text: "h", revertSha: sha });
  assert.match(card(), /data-hist-revert='clean#9'/);
  assert.doesNotMatch(card(), /data-hist-revert-go/, "never a commit button before the preview");

  await previewHistRevert("clean#9");
  assert.deepEqual(posts, [{ path: "/api/revert", body: { sha, dryRun: true } }]);
  assert.match(card(), /would revert aaaaaaaa tumwater\(feature\): &lt;b&gt;x/);
  assert.match(card(), /src\/a\.ts/);
  assert.match(card(), /data-hist-revert-go='clean#9'/);

  answer = { ok: true, message: "main is now abc1234 — the reverted role may redo the work" };
  await runHistRevert("clean#9");
  assert.deepEqual(posts[1], { path: "/api/revert", body: { sha } });
  assert.match(card(), /main is now abc1234/);
  assert.doesNotMatch(card(), /data-hist-revert-go/);

  // A preview that would conflict shows no commit button.
  answer = { ok: true, preview: { ...preview, applies: false } };
  await previewHistRevert("clean#9");
  assert.match(card(), /would conflict/);
  assert.doesNotMatch(card(), /data-hist-revert-go/);

  // A refusal shows the server's error.
  answer = { error: "abc is not on main" };
  await previewHistRevert("clean#9");
  assert.match(card(), /abc is not on main/);
});

test("historyQuery appends an encoded model after grep and before summary", () => {
  const { historyQuery } = clientScope<{ historyQuery(...a: unknown[]): string }>(HISTORY_REGIONS, ["historyQuery"], { icon: iconStub });
  assert.equal(historyQuery(50, "", "", "", "m-a"), "/api/history?n=50&model=m-a&summary=1");
  assert.equal(historyQuery(50, "", "", "x", "acme/m:1"), "/api/history?n=50&grep=x&model=acme%2Fm%3A1&summary=1");
  assert.equal(historyQuery(50, "", "", ""), "/api/history?n=50&summary=1");
});

test("clicking a By model button fetches that model's table; the chip clears it", async () => {
  type Listener = (ev: unknown) => void;
  const els = new Map<string, { listeners: Record<string, Listener[]>; style: Record<string, string>; textContent: string; value: string; innerHTML: string; addEventListener(t: string, f: Listener): void }>();
  const el = (id: string) => {
    let e = els.get(id);
    if (!e) {
      const listeners: Record<string, Listener[]> = {};
      e = { listeners, style: {}, textContent: "", value: "", innerHTML: "", addEventListener: (t, f) => { (listeners[t] ??= []).push(f); } };
      els.set(id, e);
    }
    return e;
  };
  let built = false;
  const paths: string[] = [];
  const stored: Array<[string, string]> = [];
  class FakeElement {
    constructor(private readonly b: unknown) {}
    closest(sel: string) { return sel.startsWith("button[data-histmodel") ? this.b : null; }
  }
  const keys = ["recall", "store", "buildOnce", "$", "icon", "lastStatus", "markActive", "errorPanel", "getJson", "Element"];
  const code = [ESC_LINE, CAPITALIZE_LINE, clientRegion("report-role"), GUI_CLIENT_HISTORY_JS, "return { fetchHistory, mode: () => histMode };"].join("\n");
  const scope = (new Function(...keys, code) as (...a: unknown[]) => { fetchHistory(): Promise<void>; mode(): string })(
    (k: string) => (k === "hist-mode" ? "models" : null),
    (k: string, v: string) => { stored.push([k, v]); },
    () => !built && (built = true), // true once: the builder wires the listeners a single time
    el,
    iconStub,
    null,
    () => {},
    (t: string) => t,
    async (p: string) => { paths.push(p); return { rows: [] }; },
    FakeElement,
  );
  await scope.fetchHistory();
  assert.equal(scope.mode(), "models");
  assert.equal(el("histmodel").style.display, "none", "the chip is hidden with no model");
  for (const f of el("histbody").listeners.click ?? []) f({ target: new FakeElement({ dataset: { histmodel: "acme/m1" } }) });
  // Every histbody click listener sees the event; only the data-histmodel one acts here.
  await sleep(0);
  assert.match(paths[paths.length - 1] ?? "", /&model=acme%2Fm1&/);
  assert.equal(scope.mode(), "table");
  assert.deepEqual(stored[stored.length - 1], ["hist-mode", "table"]);
  assert.equal(el("histmodel").textContent, "Model: acme/m1 ×");
  assert.equal(el("histmodel").style.display, "");
  for (const f of el("histmodel").listeners.click ?? []) f({});
  await sleep(0);
  assert.ok(!(paths[paths.length - 1] ?? "").includes("model="), "the chip refetches without model=");
  assert.equal(el("histmodel").style.display, "none");
});

test("the drill-down's Show patch button loads the patch on demand and toggles it", async () => {
  const urls: string[] = [];
  let fail = false;
  const scope = clientScope<{
    histDetails: Map<string, Record<string, unknown>>;
    histDetailCardHtml(entry: unknown, key: string): string;
    toggleHistPatch(key: string): Promise<void>;
  }>(HISTORY_REGIONS, ["histDetails", "histDetailCardHtml", "toggleHistPatch"], {
    icon: iconStub,
    renderHistory: () => {},
    getJson: (url: string) => {
      urls.push(url);
      return fail ? Promise.reject(new Error("boom")) : Promise.resolve({ patch: "+a < b" });
    },
  });
  const { histDetails, histDetailCardHtml, toggleHistPatch } = scope;
  const card = () => histDetailCardHtml(histDetails.get("clean#9"), "clean#9");

  histDetails.set("clean#7", { state: "ok", text: "h", hasCommit: false });
  histDetails.set("clean#8", { state: "ok", text: "h" });
  assert.doesNotMatch(histDetailCardHtml(histDetails.get("clean#7"), "clean#7"), /data-hist-patch/);
  assert.doesNotMatch(histDetailCardHtml(histDetails.get("clean#8"), "clean#8"), /data-hist-patch/);
  histDetails.set("clean#9", { state: "ok", text: "h", hasCommit: true });
  assert.match(card(), /data-hist-patch='clean#9'>Show patch</);

  fail = true;
  await toggleHistPatch("clean#9");
  assert.match(card(), /<div class='err'>boom<\/div>/);
  fail = false;
  await toggleHistPatch("clean#9");
  assert.equal(urls.length, 2, "an errored patch refetches");
  assert.match(urls[0]!, /&patch=1$/);
  assert.match(card(), /hist-detail-patch'>\+a &lt; b</);
  assert.match(card(), />Hide patch</);

  await toggleHistPatch("clean#9");
  assert.equal(urls.length, 2, "hiding does not refetch");
  assert.doesNotMatch(card(), /hist-detail-patch/);
  assert.match(card(), />Show patch</);
});

test("the drill-down's Show transcript button loads the transcript on demand and toggles it", async () => {
  const urls: string[] = [];
  let fail = false;
  const scope = clientScope<{
    histDetails: Map<string, Record<string, unknown>>;
    histDetailCardHtml(entry: unknown, key: string): string;
    toggleHistTranscript(key: string): Promise<void>;
  }>(HISTORY_REGIONS, ["histDetails", "histDetailCardHtml", "toggleHistTranscript"], {
    icon: iconStub,
    renderHistory: () => {},
    getJson: (url: string) => {
      urls.push(url);
      return fail ? Promise.reject(new Error("boom")) : Promise.resolve({ transcript: "a < b" });
    },
  });
  const { histDetails, histDetailCardHtml, toggleHistTranscript } = scope;
  const card = () => histDetailCardHtml(histDetails.get("clean#9"), "clean#9");

  histDetails.set("clean#9", { state: "ok", text: "h" });
  assert.match(card(), /data-hist-transcript='clean#9'>Show transcript</);

  fail = true;
  await toggleHistTranscript("clean#9");
  assert.match(card(), /<div class='err'>boom<\/div>/);
  fail = false;
  await toggleHistTranscript("clean#9");
  assert.equal(urls.length, 2, "an errored transcript refetches");
  assert.match(urls[0]!, /&transcript=1$/);
  assert.match(card(), /hist-detail-transcript'>a &lt; b</);
  assert.match(card(), />Hide transcript</);

  await toggleHistTranscript("clean#9");
  assert.equal(urls.length, 2, "hiding does not refetch");
  assert.doesNotMatch(card(), /hist-detail-transcript/);
  assert.match(card(), />Show transcript</);
});

test("the drill-down's Show prompts button reloads the transcript with prompts and toggles it", async () => {
  const urls: string[] = [];
  let fail = false;
  const scope = clientScope<{
    histDetails: Map<string, Record<string, unknown>>;
    histDetailCardHtml(entry: unknown, key: string): string;
    toggleHistTranscript(key: string): Promise<void>;
    toggleHistTranscriptPrompts(key: string): Promise<void>;
  }>(HISTORY_REGIONS, ["histDetails", "histDetailCardHtml", "toggleHistTranscript", "toggleHistTranscriptPrompts"], {
    icon: iconStub,
    renderHistory: () => {},
    getJson: (url: string) => {
      urls.push(url);
      if (fail) return Promise.reject(new Error("boom"));
      return Promise.resolve({ transcript: url.endsWith("&prompt=1") ? "with < prompt" : "plain" });
    },
  });
  const { histDetails, histDetailCardHtml, toggleHistTranscript, toggleHistTranscriptPrompts } = scope;
  const card = () => histDetailCardHtml(histDetails.get("clean#9"), "clean#9");

  histDetails.set("clean#9", { state: "ok", text: "h" });
  assert.doesNotMatch(card(), /data-hist-transcript-prompts/);
  await toggleHistTranscript("clean#9");
  assert.match(card(), /data-hist-transcript-prompts='clean#9'>Show prompts</);

  await toggleHistTranscriptPrompts("clean#9");
  assert.match(urls.at(-1)!, /&transcript=1&prompt=1$/);
  assert.match(card(), /hist-detail-transcript'>with &lt; prompt</);
  assert.match(card(), />Hide prompts</);

  const fetched = urls.length;
  await toggleHistTranscriptPrompts("clean#9");
  assert.equal(urls.length, fetched, "toggling back does not refetch");
  assert.match(card(), /hist-detail-transcript'>plain</);

  // A failure on a fresh card renders the error and the next call refetches.
  histDetails.set("clean#9", { state: "ok", text: "h", transcript: { state: "ok", text: "plain", open: true } });
  fail = true;
  await toggleHistTranscriptPrompts("clean#9");
  assert.match(card(), /<div class='err'>boom<\/div>/);
  fail = false;
  const before = urls.length;
  await toggleHistTranscriptPrompts("clean#9");
  assert.equal(urls.length, before + 1);
});

test("the open transcript's search box narrows it through &grep, drops a stale answer, and clears on the prompts toggle", async () => {
  const urls: string[] = [];
  let fail = false;
  let deferred: Promise<unknown> | null = null;
  const scope = clientScope<{
    histDetails: Map<string, Record<string, unknown>>;
    histDetailCardHtml(entry: unknown, key: string): string;
    toggleHistTranscript(key: string): Promise<void>;
    toggleHistTranscriptPrompts(key: string): Promise<void>;
    searchHistTranscript(key: string, value: string): Promise<void>;
  }>(
    HISTORY_REGIONS,
    ["histDetails", "histDetailCardHtml", "toggleHistTranscript", "toggleHistTranscriptPrompts", "searchHistTranscript"],
    {
      icon: iconStub,
      renderHistory: () => {},
      getJson: (url: string) => {
        urls.push(url);
        if (fail && url.includes("&grep=")) return Promise.reject(new Error("boom"));
        if (deferred && url.endsWith("&grep=a")) return deferred;
        const grep = /&grep=([^&]*)$/.exec(url);
        const transcript = grep ? (grep[1] === "b" ? "b-hit" : "only < match") : url.endsWith("&prompt=1") ? "prompted" : "plain";
        return Promise.resolve({ transcript });
      },
    },
  );
  const { histDetails, histDetailCardHtml, toggleHistTranscript, toggleHistTranscriptPrompts, searchHistTranscript } = scope;
  const card = () => histDetailCardHtml(histDetails.get("clean#9"), "clean#9");

  histDetails.set("clean#9", { state: "ok", text: "h" });
  assert.doesNotMatch(card(), /data-hist-transcript-grep/);
  await toggleHistTranscript("clean#9");
  assert.match(card(), /data-hist-transcript-grep='clean#9'[^>]*value=''/);

  await searchHistTranscript("clean#9", "  Boom ");
  assert.match(urls.at(-1)!, /&transcript=1&grep=Boom$/);
  assert.match(card(), /hist-detail-transcript'>only &lt; match</);
  assert.match(card(), /value='Boom'/);

  const fetched = urls.length;
  await searchHistTranscript("clean#9", "");
  assert.equal(urls.length, fetched, "a blank value does not fetch");
  assert.match(card(), />plain</);

  await toggleHistTranscriptPrompts("clean#9");
  await searchHistTranscript("clean#9", "x");
  assert.match(urls.at(-1)!, /&transcript=1&prompt=1&grep=x$/);
  await toggleHistTranscriptPrompts("clean#9");
  assert.match(card(), />plain</);
  assert.match(card(), /value=''/);

  // A stale answer (superseded by a newer search) is dropped.
  let release: (v: unknown) => void = () => {};
  deferred = new Promise((r) => (release = r));
  const slow = searchHistTranscript("clean#9", "a");
  await searchHistTranscript("clean#9", "b");
  release({ transcript: "a-hit" });
  await slow;
  assert.match(card(), /b-hit/);
  assert.doesNotMatch(card(), /a-hit/);

  fail = true;
  await searchHistTranscript("clean#9", "z");
  assert.match(card(), /<div class='err'>boom<\/div>/);
});

test("historyQuery steps a window back by its own length with untilMs", () => {
  const { historyQuery } = clientScope<{ historyQuery(...a: unknown[]): string }>(HISTORY_REGIONS, ["historyQuery"], { icon: iconStub });
  assert.equal(historyQuery(50, "", "1d", "", "", 1), "/api/history?sinceMs=172800000&untilMs=86400000&summary=1");
  assert.equal(historyQuery(50, "clean", "1h", "x", "", 2), "/api/history?sinceMs=10800000&untilMs=7200000&role=clean&grep=x&summary=1");
  assert.equal(historyQuery(50, "", "1d", "", "", 0), "/api/history?sinceMs=86400000&summary=1");
  assert.equal(historyQuery(50, "", "1d", "", "", undefined), "/api/history?sinceMs=86400000&summary=1");
  assert.equal(historyQuery(50, "", "", "", "", 3), "/api/history?n=50&summary=1");
});

test("histCanStepEarlier stops at the server's sinceMs cap", () => {
  const s = clientScope<{ HIST_MAX_MS: number; histCanStepEarlier(k: string, n: number): boolean }>(
    HISTORY_REGIONS,
    ["HIST_MAX_MS", "histCanStepEarlier"],
    { icon: iconStub },
  );
  assert.equal(s.HIST_MAX_MS, LOGS_SINCE_MAX_MS);
  assert.equal(s.histCanStepEarlier("7d", 0), false);
  assert.equal(s.histCanStepEarlier("1d", 5), true);
  assert.equal(s.histCanStepEarlier("1d", 6), false);
  assert.equal(s.histCanStepEarlier("6h", 26), true);
  assert.equal(s.histCanStepEarlier("6h", 27), false);
  assert.equal(s.histCanStepEarlier("", 0), false);
});

test("histWindowPhrase and historyStepHtml name a stepped window", () => {
  const s = clientScope<{ histWindowPhrase(k: string, n: number): string; historyStepHtml(k: string, n: number): string }>(
    HISTORY_REGIONS,
    ["histWindowPhrase", "historyStepHtml"],
    { icon: iconStub },
  );
  assert.equal(s.histWindowPhrase("1d", 0), "the last day");
  assert.equal(s.histWindowPhrase("1d", 1), "between 2 days and 1 day ago");
  assert.equal(s.histWindowPhrase("6h", 1), "between 12 hours and 6 hours ago");
  assert.equal(s.histWindowPhrase("6h", 4), "between 30 hours and 1 day ago");
  assert.equal(s.historyStepHtml("1d", 0), "");
  assert.ok(s.historyStepHtml("1d", 1).includes("Showing runs between 2 days and 1 day ago."));
});

test("historyTableHtml's empty stepped window names its bounds", () => {
  const { historyTableHtml } = clientScope<{ historyTableHtml(...a: unknown[]): string }>(
    HISTORY_REGIONS,
    ["historyTableHtml", "historyClass"],
    { icon: iconStub },
  );
  assert.match(historyTableHtml([], "all", new Set(), "", "1d", "", 1), /No runs between 2 days and 1 day ago/);
  assert.match(historyTableHtml([], "all", new Set(), "", "1d", "", 0), /No runs in the last day/);
});

test("the History toolbar holds the step buttons inside #histstep", () => {
  assert.match(GUI_CLIENT_HISTORY_JS, /id='histstep'[^>]*><button[^>]*id='histearlier'[\s\S]*?id='histlater'/);
});

test("the History toolbar carries a Newest failure button wired to openHistNewest", () => {
  const toolbar = GUI_CLIENT_HISTORY_JS.slice(
    GUI_CLIENT_HISTORY_JS.indexOf("class='toolbar'"),
    GUI_CLIENT_HISTORY_JS.indexOf("<div class='card' id='histbody'>"),
  );
  assert.match(toolbar, /id='histnewest'>Newest failure<\/button>/);
  assert.match(GUI_CLIENT_HISTORY_JS, /id='histnewest'[\s\S]*?openHistNewest/, "the button wires its click to openHistNewest");
});

test("the Newest failure button loads the newest failing run as a pinned card", async () => {
  const calls: string[] = [];
  // clientScope hands back a snapshot of `let histNewest` (it is reassigned, not mutated like
  // the Map), so this scope returns a live getter instead.
  const code = [ESC_LINE, ...HISTORY_REGIONS.map(clientRegion), "\nreturn { histNewest: () => histNewest, histDetails, openHistNewest, closeHistNewest, histNewestHtml };"].join("\n");
  const run = new Function("icon", "getJson", "renderHistory", code) as (...a: unknown[]) => {
    histNewest(): { state: string; key?: string; message?: string } | null;
    histDetails: Map<string, { state: string; text?: string }>;
    openHistNewest(): Promise<void>;
    closeHistNewest(): void;
    histNewestHtml(): string;
  };
  const scope = run(iconStub, (path: string) => {
    calls.push(path);
    return Promise.resolve({ role: "clean", run: 9, text: "clean run #9 — problems · 46s\nevent one", stat: " a.ts | 2 +-", revertSha: null, hasCommit: true });
  }, () => {});

  assert.equal(scope.histNewestHtml(), "", "no pinned card before the button is pressed");

  const p = scope.openHistNewest();
  assert.equal(scope.histNewest()?.state, "loading", "the loading entry is set synchronously");
  assert.match(scope.histNewestHtml(), /Loading newest failure/);

  await sleep(0);
  await p;
  assert.deepEqual(calls, ["/api/run?last=1&result=problems"], "the role-less `last` endpoint is asked");
  assert.equal(scope.histNewest()?.state, "ok");
  assert.equal(scope.histDetails.get("clean#9")?.state, "ok", "the run's card is cached under its real key");
  const html = scope.histNewestHtml();
  assert.match(html, /Newest failure of any role/);
  assert.match(html, /event one/);
  assert.match(html, /hist-detail-stat/);
  assert.match(html, /a\.ts \| 2 \+-/);
  assert.match(html, /data-hist-patch='clean#9'/, "the card's own patch button keys the run");
  assert.match(html, /data-hist-newest-close='1'/);

  scope.closeHistNewest();
  assert.equal(scope.histNewest(), null);
  assert.equal(scope.histNewestHtml(), "");
});

test("a Newest failure miss renders the server's message instead of a stuck loading state", async () => {
  // Same live-getter scope shape as the success test above.
  const code = [ESC_LINE, ...HISTORY_REGIONS.map(clientRegion), "\nreturn { histNewest: () => histNewest, openHistNewest, histNewestHtml };"].join("\n");
  const run = new Function("icon", "getJson", "renderHistory", code) as (...a: unknown[]) => {
    histNewest(): { state: string; message?: string } | null;
    openHistNewest(): Promise<void>;
    histNewestHtml(): string;
  };
  const scope = run(
    iconStub,
    () => Promise.reject(new Error('no completed run with result "problems" in the scanned window (the retained log may have rotated past it)')),
    () => {},
  );
  const p = scope.openHistNewest();
  await sleep(0);
  await p;
  assert.equal(scope.histNewest()?.state, "error");
  const html = scope.histNewestHtml();
  assert.match(html, /Newest failure unavailable/);
  assert.match(html, /the retained log may have rotated past it/, "the server's message is shown, escaped");
  assert.doesNotMatch(html, /Loading newest failure/);
});
