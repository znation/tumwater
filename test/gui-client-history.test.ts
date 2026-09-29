import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_HISTORY_JS } from "../src/ui/gui-client-history.js";
import { GUI_CLIENT_JS } from "../src/ui/gui-client.js";
import { clientScope } from "./gui-client-scope.js";

// The dashboard's History view (src/ui/gui-client-history.ts): the table it paints from
// /api/history's rows, and its place in the assembled script.

test("GUI_CLIENT_JS carries the history module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_HISTORY_JS), "the module's constant appears verbatim in the assembled script");
});

test("the History table renders tick rows, escapes them, and filters by outcome", () => {
  const { historyTableHtml, historyClass } = clientScope<{
    historyTableHtml(rows: object[] | null, filter: string, known: Set<string>): string;
    historyClass(result: string): string;
  }>(["format", "view-model", "history-table"], ["historyTableHtml", "historyClass"]);
  const now = Date.now();
  const rows = [
    { ts: now - 5 * 60_000, time: "2026-09-29 15:33:31", loop: "coverage", tick: 5, result: "queued", durationMs: 45_000, usage: "12.0k tok · $0.04", detail: "bumped coverage" },
    { ts: now - 9 * 60_000, time: "2026-09-29 15:29:00", loop: "gone-loop", tick: 7, result: "no_change", durationMs: null, usage: "", detail: "" },
    { ts: now - 20 * 60_000, time: "2026-09-29 15:18:00", loop: "qa", tick: 2, result: "error", durationMs: 240_000, usage: "900 tok", detail: "<script>x</script>" },
  ];
  const html = historyTableHtml(rows, "all", new Set(["coverage", "qa"]));
  assert.match(html, /<tr class='clickable' data-open='coverage'>/, "a fleet loop's row opens its drawer");
  assert.match(html, /<tr><td title='2026-09-29 15:29:00'>/, "a row for a loop no longer in the fleet is plain");
  assert.match(html, /5m ago/);
  assert.match(html, /#5/);
  assert.match(html, /<span class='res t-indigo'>Queued to land<\/span>/);
  assert.match(html, /<td class='num c-dur'>45s<\/td>/);
  assert.match(html, /<td class='num c-dur'>4m<\/td>/);
  assert.match(html, /<td class='num c-dur'>—<\/td>/, "a missing duration is a dash, never NaN");
  assert.doesNotMatch(html, /NaN|<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
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

