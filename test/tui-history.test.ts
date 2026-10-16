/** `historyPaneText` (src/ui/tui/tui-history.ts): the TUI's History pane body. Pure over the
 * TickRow[] that history-data.ts already resolved, so these tests seed rows directly and pin
 * the one-line-per-row rendering — every field present, the null-duration dash, the omitted
 * empty usage/detail, and the no-rows empty string. */
import test from "node:test";
import assert from "node:assert/strict";
import { historyPaneText } from "../src/ui/tui/tui-history.js";
import { paneBody } from "../src/ui/tui/tui-pane.js";
import type { TickRow } from "../src/history/history-data.js";

function row(over: Partial<TickRow> = {}): TickRow {
  return {
    ts: 0,
    time: "14:03",
    role: "feature",
    run: 7,
    result: "changed",
    durationMs: 90_000,
    tokens: 0,
    costUsd: 0,
    usage: "$0.42",
    detail: "Add the history pane",
    ...over,
  };
}

test("a seeded row renders its time, loop, tick, result, duration, usage, and detail", () => {
  assert.equal(historyPaneText([row()]), "14:03  feature #7  changed  90s  $0.42  Add the history pane");
});

test("a null duration renders the em dash the CLI table uses", () => {
  assert.equal(historyPaneText([row({ durationMs: null, usage: "", detail: "" })]), "14:03  feature #7  changed  —");
});

test("an empty usage and an empty detail are omitted, not left as gaps", () => {
  assert.equal(historyPaneText([row({ usage: "", detail: "kept" })]), "14:03  feature #7  changed  90s  kept");
  assert.equal(historyPaneText([row({ usage: "$0.42", detail: "" })]), "14:03  feature #7  changed  90s  $0.42");
});

test("rows render newest-first, one line each, and no rows is the empty string", () => {
  const rows = [row({ run: 8, time: "14:05" }), row({ run: 7, time: "14:03" })];
  assert.equal(historyPaneText(rows), "14:05  feature #8  changed  90s  $0.42  Add the history pane\n14:03  feature #7  changed  90s  $0.42  Add the history pane");
  assert.equal(historyPaneText([]), "");
});

test("an empty history pane falls back to the no-ticks note, not entryBodyWindow's placeholder", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: "", noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const empty = paneBody({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(empty.body, []);
  assert.equal(empty.emptyNote, "(no runs yet)");

  const rows = paneBody({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state: { ...state, paneCache: historyPaneText([row()]) } });
  assert.equal(rows.body.length, 1);
  assert.equal(rows.emptyNote, "(no runs yet)");
});

test("a history pane's tick trail windows the cached detail and holds the no-trail note when null", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: "", noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const pane = { kind: "history", since: null, result: null, role: null, grep: null, trail: true } as const;
  const empty = paneBody(pane, { root: "/nonexistent", width: 300, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(empty.body, []);
  assert.equal(empty.emptyNote, "(no run trail)");

  const trail = "clean tick #1 — changed · 90s\n14:00 run_start\n14:01 landed";
  const shown = paneBody(pane, { root: "/nonexistent", width: 300, eventBudget: 5, entryBudget: 4, state: { ...state, trailCache: trail } });
  assert.equal(shown.body.map((l) => l.map((s) => s.text).join("")).join("\n"), trail);
  assert.equal(shown.emptyNote, "(no run trail)");
});

test("a null queued cache falls back to the no-queued-prompts note, and a cache windows its lines", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const empty = paneBody({ kind: "queued" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(empty.body, []);
  assert.equal(empty.emptyNote, "(inbox empty)");

  const list = "director:\n1. steer the director\nclean:\n1. clean one";
  const shown = paneBody({ kind: "queued" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state: { ...state, paneCache: list } });
  assert.equal(shown.body.map((l) => l.map((s) => s.text).join("")).join("\n"), list);
  assert.equal(shown.emptyNote, "(inbox empty)");
});

test("a null pending cache holds the loading note, and a resolved roster windows its text", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const loading = paneBody({ kind: "pending" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(loading.body, []);
  assert.equal(loading.emptyNote, "(loading pending changes…)");

  const roster = "feature: 2 commits ahead of main\nclean: 1 uncommitted file ahead of main";
  const resolved = paneBody({ kind: "pending" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state: { ...state, paneCache: roster } });
  assert.equal(resolved.body.map((l) => l.map((s) => s.text).join("")).join("\n"), roster);
  assert.equal(resolved.emptyNote, "(loading pending changes…)");
});

test("a null change cache holds the loading note, and a resolved change windows its text", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const pane = { kind: "transcript", role: "clean", index: 1, count: 1, note: false, change: true } as const;
  const loading = paneBody(pane, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(loading.body, []);
  assert.equal(loading.emptyNote, "(loading pending change…)");

  const change = "clean: tumwater/clean, 2 commits ahead of main\nabc1234 add a thing";
  const resolved = paneBody(pane, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state: { ...state, changeCache: change } });
  assert.equal(resolved.body.map((l) => l.map((s) => s.text).join("")).join("\n"), change);
  assert.equal(resolved.emptyNote, "(loading pending change…)");
});

test("an empty queued pane holds the no-prompts note, and a cached list windows its text", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: "", noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const empty = paneBody({ kind: "queued" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(empty.body, []);
  assert.equal(empty.emptyNote, "(inbox empty)");

  const list = "director:\n1. do the thing (queued 5m ago)\nclean:\n1. fix it (delivers in 1h)";
  const cached = paneBody({ kind: "queued" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state: { ...state, paneCache: list } });
  assert.equal(cached.body.map((l) => l.map((s) => s.text).join("")).join("\n"), list);
  assert.equal(cached.emptyNote, "(inbox empty)");
});

test("the health pane holds the loading note while uncached and windows the cached report once set", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const empty = paneBody({ kind: "health" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state });
  assert.deepEqual(empty.body, []);
  assert.equal(empty.emptyNote, "(running health checks…)");
  const report = "doctor\nok    node         fine\nhealthy";
  const shown = paneBody({ kind: "health" }, { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state: { ...state, paneCache: report } });
  assert.equal(shown.body.map((l) => l.map((x) => x.text).join("")).join("\n"), report);
});

test("the brief pane windows the cached brief and falls back to the init note when null", () => {
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: "README.md\nbuild it", noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const opts = { root: "/nonexistent", width: 80, eventBudget: 5, entryBudget: 4, state };
  assert.equal(paneBody({ kind: "brief" }, opts).body.length, 2);
  const empty = paneBody({ kind: "brief" }, { ...opts, state: { ...state, paneCache: null } });
  assert.deepEqual(empty.body, []);
  assert.match(empty.emptyNote, /run `tumwater init` first/);
});
