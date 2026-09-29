import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_HISTORY_JS } from "../src/ui/gui-client-history.js";
import { GUI_CLIENT_JS } from "../src/ui/gui-client.js";

// The history tab's fetchHistory (gui-client-history.ts) runs in the browser, so it is
// exercised here through the same regex-extract + new Function seam as the report tip in
// gui-client-report.test.ts — with a minimal DOM shim standing in for document and the
// getJson/esc helpers reached through gui-client.ts's concatenation.

type Panel = { innerHTML: string };

function makeDocument(panel: Panel) {
  return { getElementById: (id: string) => (id === "history" ? panel : null) };
}

// The client's real esc, extracted from GUI_CLIENT_JS so the tests assert against the
// escaping the dashboard actually ships, not a lookalike copy.
function buildClient(escSource: string) {
  return (getJson: unknown, panel: Panel) => {
    const body = new Function(
      "getJson",
      "document",
      `${escSource}\n${GUI_CLIENT_HISTORY_JS}\nreturn { fetchHistory };`,
    ) as (gj: unknown, doc: unknown) => { fetchHistory(): Promise<void> };
    return body(getJson, makeDocument(panel));
  };
}

const ESC_LINE = GUI_CLIENT_JS.match(/const esc = .*$/m)![0];
const makeClient = buildClient(ESC_LINE);

test("GUI_CLIENT_JS carries the history module as a byte-exact contiguous splice", async () => {
  assert.equal(
    GUI_CLIENT_JS.includes(GUI_CLIENT_HISTORY_JS),
    true,
    "the history tab's client script must be spliced into the page script byte-exactly " +
      "(a mismatch means the interpolation gained or lost bytes at a splice boundary)",
  );
});

test("fetchHistory renders each row as a seven-column table row", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(
    async () => ({
      rows: [
        { time: "2026-09-28 10:00", loop: "tests", tick: "5", result: "landed", durationMs: 45000, usage: "$0.12", detail: "bumped coverage" },
        { time: "2026-09-28 10:05", loop: "bugfix", tick: "12", result: "no-change", durationMs: 240000, usage: "$0.30", detail: "nothing found" },
      ],
    }),
    panel,
  );
  await client.fetchHistory();
  assert.match(panel.innerHTML, /<table><thead><tr><th>time<\/th>/);
  assert.match(panel.innerHTML, /<th>loop<\/th><th>tick<\/th><th>result<\/th><th>duration<\/th><th>usage<\/th><th>detail<\/th><\/tr><\/thead>/);
  // Short spans render as seconds, longer ones as whole minutes — the client copy of the
  // CLI's shortSpanPhrase.
  assert.match(panel.innerHTML, /<td>45s<\/td>/);
  assert.match(panel.innerHTML, /<td>4m<\/td>/);
  assert.match(panel.innerHTML, /<td>#5<\/td>/);
  assert.match(panel.innerHTML, /<td>landed<\/td>/);
  assert.match(panel.innerHTML, /<td class='wide'>bumped coverage<\/td><\/tr>/);
  assert.match(panel.innerHTML, /<td class='wide'>nothing found<\/td><\/tr>/);
});

test("fetchHistory renders a dash for a missing duration, not NaN", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(async () => ({ rows: [{ time: "t", loop: "l", tick: "1", result: "started", durationMs: null, usage: "", detail: "" }] }), panel);
  await client.fetchHistory();
  assert.match(panel.innerHTML, /<td>—<\/td>/);
  assert.doesNotMatch(panel.innerHTML, /NaN/);
});

test("fetchHistory shows the no-ticks hint when the server has no rows", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(async () => ({ rows: [] }), panel);
  await client.fetchHistory();
  assert.equal(panel.innerHTML, "<span class='muted'>no ticks yet — click the tab again to refresh</span>");
});

test("fetchHistory escapes row values, so a tick's detail cannot inject markup", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(
    async () => ({ rows: [{ time: "t", loop: "<img>", tick: "1", result: "ok", durationMs: 1000, usage: "$0", detail: "<script>alert(1)</script>" }] }),
    panel,
  );
  await client.fetchHistory();
  assert.doesNotMatch(panel.innerHTML, /<script>/);
  assert.doesNotMatch(panel.innerHTML, /<img>/);
  assert.match(panel.innerHTML, /&lt;script&gt;/);
  assert.match(panel.innerHTML, /&lt;img&gt;/);
});

test("fetchHistory names the endpoint's failure in the muted hint", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(async () => {
    throw new Error("503");
  }, panel);
  await client.fetchHistory();
  assert.equal(panel.innerHTML, "<span class='muted'>history unavailable — 503</span>");
});

test("fetchHistory stays muted when the thrown value is not an Error", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(async () => {
    throw "socket closed";
  }, panel);
  await client.fetchHistory();
  assert.equal(panel.innerHTML, "<span class='muted'>history unavailable</span>");
});

test("fetchHistory tolerates a server response without rows", async () => {
  const panel: Panel = { innerHTML: "" };
  const client = makeClient(async () => ({}), panel);
  await client.fetchHistory();
  assert.equal(panel.innerHTML, "<span class='muted'>no ticks yet — click the tab again to refresh</span>");
});
