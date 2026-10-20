// Dashboard half of the "Script interfaces" rename: the dashboard script reads no retired payload
// key. Each producer's own test covers the server half.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";

// Old payload key names. Generic words (`tick`, `loop`) stay out of the list.
const RETIRED_CLIENT_READS = [
  "ticksByRole",
  "failedTicksByRole",
  "landingRuns",
  "landingTokens",
  "landingCostUsd",
  "landingFailed",
  "landedByRole",
  "landingFailedByRole",
  "loops",
  "lastTickEndedAt",
  "lastLandedAt",
  "landQueue",
  "landQueueLabels",
  "landingBadge",
  "ticks",
];

/** Lines of `source` that read a listed key as `.key` or as a quoted string key. */
function retiredReads(source: string, keys: readonly string[]): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    for (const key of keys) {
      const prop = new RegExp(`\\.${key}(?![A-Za-z0-9_$])`);
      // A quoted name right after `=` is an HTML attribute value (`class='ticks'`), not a key.
      const quoted = new RegExp(`(?<!=)["']${key}["']`);
      if (prop.test(line) || quoted.test(line)) {
        hits.push(`${key} on line ${i + 1}`);
      }
    }
  });
  return hits;
}

test("the dashboard script reads no retired payload key", () => {
  assert.deepEqual(retiredReads(GUI_CLIENT_JS, RETIRED_CLIENT_READS), []);
});

test("the dashboard script calls /api/run, not the retired /api/tick route", () => {
  assert.equal(GUI_CLIENT_JS.includes("/api/tick"), false);
  assert.ok(GUI_CLIENT_JS.includes("/api/run?role="));
});

test("the matcher flags a property read and a quoted key, and passes a longer name", () => {
  assert.deepEqual(retiredReads("x = d.ticksByRole;\ny = f(d, 'landingRuns');", RETIRED_CLIENT_READS), [
    "ticksByRole on line 1",
    "landingRuns on line 2",
  ]);
  assert.deepEqual(retiredReads("x = d.ticksByRoleExtra;", RETIRED_CLIENT_READS), []);
  assert.deepEqual(retiredReads("h = \"<ul class='ticks'>\"; k = d['ticks'];", RETIRED_CLIENT_READS), ["ticks on line 1"]);
});
