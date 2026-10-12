import test from "node:test";
import assert from "node:assert/strict";
import { clipToWidth, displayWidth } from "../src/text/text-width.js";
import { clipSpans, renderStatusSpans, type StatusSpan } from "../src/ui/status-render.js";
import { eventKind } from "../src/ui/tone.js";
import type { FleetAlert } from "../src/ui/fleet-alerts.js";
import { snapshot } from "../src/status/status-data.js";
import { initProject } from "../src/init/init.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import {
  alertLines,
  eventTone,
  hintLine,
  prefixWidth,
  promptPrefix,
  sanitizeFrameLines,
  tabStrip,
  toneLine,
  transcriptTone,
} from "../src/ui/tui/tui-frame.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { clientScope } from "./helpers/gui-client-scope.js";

// The TUI frame's pure pieces (src/ui/tui/tui-frame.ts) and the toned status spans they paint
// (status-render.ts): the frame builders must never move a column or a cut.

const plain = (line: readonly StatusSpan[]) => line.map((s) => s.text).join("");

test("clipSpans cuts a toned line exactly where clipToWidth cuts its text", () => {
  const lines: StatusSpan[][] = [
    [{ text: "tumwater", tone: "brand" }, { text: " · demo · " }, { text: "running", tone: "green" }, { text: " (pid 12)" }],
    [{ text: "漢字", tone: "red" }, { text: "abc" }, { text: "😀x", tone: "blue" }],
    [{ text: "" }, { text: "short" }],
  ];
  for (const line of lines) {
    for (let w = 0; w <= displayWidth(plain(line)) + 2; w++) {
      const clipped = clipSpans(line, w);
      assert.equal(plain(clipped), clipToWidth(plain(line), w), `width ${w}: ${plain(line)}`);
    }
  }
  // Surviving spans keep their tones; the ellipsis joins the last one.
  const cut = clipSpans(lines[0]!, 14);
  assert.deepEqual(cut.map((s) => s.tone), ["brand", undefined]);
  assert.ok(plain(cut).endsWith("…"));
});

test("a status render's spans read exactly as the plain text, clipped to width", async () => {
  const repo = makeRepo();
  await initProject(repo, "tui frame test");
  writeOrchestratorMarker(repo, ["clean", "feature"]);
  const s = freshLoopState("clean");
  s.lastResult = "error";
  s.lastError = "boom";
  s.consecutiveErrors = 9;
  saveLoopState(repo, s);
  const snap = snapshot(repo);
  for (const width of [undefined, 160, 90, 40]) {
    const { lines } = renderStatusSpans(repo, snap, width);
    if (width !== undefined) for (const l of lines) assert.ok(displayWidth(plain(l)) <= width, "no line outgrows the terminal");
  }
  // The failing loop's state reads red, and the render reports its phase for the alerts.
  const { lines, loops } = renderStatusSpans(repo, snap, 160);
  assert.ok(lines.some((l) => l.some((sp) => sp.text.startsWith("failing") && sp.tone === "red")));
  assert.deepEqual(loops.find((l) => l.role === "clean"), { role: "clean", phase: "failing", inFlight: false, lastError: "boom" });
  assert.equal(lines[0]?.[0]?.tone, "brand", "the header opens with the name");
});

test("attention lines mark each alert and fold the overflow into a count", () => {
  const alert = (key: string, tone: FleetAlert["tone"], title: string, detail = ""): FleetAlert => ({ key, tone, title, detail, actions: [] });
  const alerts = [
    alert("failing", "red", "qa is failing tick after tick", "qa: 429"),
    alert("questions", "indigo", "1 question needs your answer", "Q1"),
    alert("build", "blue", "main is 2 commits ahead of the running build", "Restart tumwater run to pick it up."),
    alert("stopped", "gray", "The fleet is not running"),
  ];
  const lines = alertLines(alerts, 200).map(plain);
  assert.deepEqual(lines, [
    "! qa is failing tick after tick — qa: 429",
    "? 1 question needs your answer — Q1",
    "  +2 more — the dashboard lists them all",
  ]);
  assert.deepEqual(alertLines(alerts.slice(0, 3), 200).map(plain).at(-1), "i main is 2 commits ahead of the running build — Restart tumwater run to pick it up.");
  assert.equal(alertLines(alerts.slice(0, 1), 12).map(plain)[0], clipToWidth("! qa is failing tick after tick — qa: 429", 12));
  assert.deepEqual(alertLines([], 80), []);
});

test("the tab strip names every view and brackets the current one", () => {
  assert.equal(plain(tabStrip({ kind: "activity" }, 200)), "[Activity]  Transcript  Backlog  Usage  Failures  History  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14, note: false, change: false }, 200)), "Activity  [Transcript: qa (3/14)]  Backlog  Usage  Failures  History  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14, note: true, change: false }, 200)), "Activity  [Notebook: qa (3/14)]  Backlog  Usage  Failures  History  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14, note: false, change: true }, 200)), "Activity  [Change: qa (3/14)]  Backlog  Usage  Failures  History  Pending  Queued   Ctrl+T next");
  const usage = tabStrip({ kind: "usage", scope: null, window: null }, 200);
  assert.deepEqual(usage.filter((s) => s.tone === "brand").map((s) => s.text), ["[Usage]"], "only the current view is bright");
  assert.equal(plain(tabStrip({ kind: "usage", scope: "feature", window: "1h" }, 200)), "Activity  Transcript  Backlog  [Usage: feature]  Failures  History  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "failures", scope: "clean", window: null }, 200)), "Activity  Transcript  Backlog  Usage  [Failures: clean]  History  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [History]  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: "feature", grep: null, trail: false }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [History: feature]  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: "qa", grep: null, trail: true }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [Tick: qa]  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: null, grep: null, trail: true }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [Tick]  Pending  Queued   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "queued" }, 200)), "Activity  Transcript  Backlog  Usage  Failures  History  Pending  [Queued]   Ctrl+T next");
  assert.ok(displayWidth(plain(tabStrip({ kind: "backlog" }, 20))) <= 20);
});

test("the hint line says what the keys do in each view and mode", () => {
  const hint = (view: Parameters<typeof hintLine>[0], budget = false, rolePromptFor: string | null = null) => plain(hintLine(view, { budget, rolePromptFor }, 300));
  assert.equal(hint({ kind: "activity" }), "Enter send · ↑↓ history · PgUp/PgDn scroll · Ctrl+T next view · Ctrl+B daily cap · Ctrl+F pause fleet · Ctrl+C interrupt director · Ctrl+D quit");
  assert.equal(
    hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: false }),
    "Enter send · ↑↓ history · Ctrl+R prompt qa · Ctrl+N notebook · Ctrl+P pause/resume · Ctrl+W wake · Ctrl+A abort · Ctrl+T next view · Ctrl+D quit",
  );
  assert.equal(
    hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: true, change: false }),
    "Enter send · ↑↓ history · Ctrl+R prompt qa · Ctrl+N change · Ctrl+P pause/resume · Ctrl+W wake · Ctrl+A abort · Ctrl+T next view · Ctrl+D quit",
  ); // the notebook's next step is the change view
  assert.equal(
    hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: true }),
    "Enter send · ↑↓ history · Ctrl+R prompt qa · Ctrl+N transcript · Ctrl+P pause/resume · Ctrl+W wake · Ctrl+A abort · Ctrl+T next view · Ctrl+D quit",
  ); // the cycle's last step names the way back
  assert.match(hint({ kind: "backlog" }), /↑↓ open entries · PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "failures", scope: null, window: null }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "usage", scope: "feature", window: null }), /Ctrl\+G scope: feature/);
  assert.match(hint({ kind: "failures", scope: "clean", window: "1h" }), /Ctrl\+G scope: clean/);
  assert.match(hint({ kind: "usage", scope: null, window: null }), /Ctrl\+G scope: fleet/);
  // The Usage and Failures panes name their trailing report window in the Ctrl+E hint,
  // default or active; the two report panes share the same hint shape.
  assert.match(hint({ kind: "usage", scope: null, window: "1h" }), /Ctrl\+E window: 1h/);
  assert.match(hint({ kind: "usage", scope: null, window: null }), /Ctrl\+E window: default/);
  assert.match(hint({ kind: "failures", scope: null, window: "7d" }), /Ctrl\+E window: 7d/);
  assert.match(hint({ kind: "failures", scope: null, window: null }), /Ctrl\+E window: default/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "pending" }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "queued" }), /PgUp\/PgDn scroll/);
  assert.equal(hint({ kind: "activity" }, true), "Enter save the daily cap · Esc cancel · Ctrl+D quit");
  assert.equal(hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: false }, false, "qa"), "Enter send to qa · ↑↓ history · Esc cancel · Ctrl+D quit");
  // The History pane names its trailing window in the Ctrl+S hint, default or active.
  assert.match(hint({ kind: "history", since: "1h", result: null, role: null, grep: null, trail: false }), /Ctrl\+S window: 1h/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+S window: default/);
  // The History pane names its outcome class in the Ctrl+O hint, "all" or the active class.
  assert.match(hint({ kind: "history", since: null, result: "problems", role: null, grep: null, trail: false }), /Ctrl\+O result: problems/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+O result: all/);
  // The History pane names its exact-loop scope in the Ctrl+G hint, the raw id or the fleet.
  assert.match(hint({ kind: "history", since: null, result: null, role: "feature", grep: null, trail: false }), /Ctrl\+G scope: feature/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+G scope: fleet/);
  // The History pane names its free-text search in the `/` hint, "search" or the pattern.
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: "widget", trail: false }), /\/ search: widget/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /\/ search/);
  // The History pane names its tick-trail toggle in the Ctrl+N hint, the row list or the trail.
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+N tick trail/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: true }), /Ctrl\+N history/);
  // Every view names Ctrl+D as quit; the director prompt line additionally names Ctrl+C.
  for (const v of [
    { kind: "activity" } as const,
    { kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: false } as const,
    { kind: "backlog" } as const,
    { kind: "usage", scope: null, window: null } as const,
    { kind: "failures", scope: null, window: null } as const,
    { kind: "history", since: null, result: null, role: null, grep: null, trail: false } as const,
    { kind: "pending" } as const,
    { kind: "queued" } as const,
  ]) assert.match(plain(hintLine(v, { budget: false, rolePromptFor: null }, 300)), /Ctrl\+D quit/);
  // Keys stand out from what they do.
  const spans = hintLine({ kind: "activity" }, { budget: false, rolePromptFor: null }, 300);
  assert.deepEqual(spans.filter((s) => s.tone === "bold").map((s) => s.text), ["Enter", "↑↓", "PgUp/PgDn", "Ctrl+T", "Ctrl+B", "Ctrl+F", "Ctrl+C", "Ctrl+D"]);
});

test("the prompt line names who Enter sends to", () => {
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null })), "director › ");
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: "qa" })), "qa › ");
  assert.equal(plain(promptPrefix({ budget: true, rolePromptFor: null })), "daily cap $ ");
  assert.equal(prefixWidth(promptPrefix({ budget: false, rolePromptFor: null })), 11);
});

test("activity and transcript lines take the tones of what they report", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ ts: 1, loop: "qa", type, ...extra }) as Parameters<typeof eventTone>[0];
  assert.equal(eventTone(ev("merged")), "green");
  assert.equal(eventTone(ev("tick_end", { result: "error" })), "red");
  assert.equal(eventTone(ev("tick_end", { result: "rejected" })), "yellow");
  assert.equal(eventTone(ev("tick_end", { result: "no_change" })), "dim");
  assert.equal(eventTone(ev("build_check", { status: "failed" })), "red");
  assert.equal(eventTone(ev("question_posted")), "magenta");
  assert.equal(eventTone(ev("fleet_paused")), undefined);
  assert.equal(eventTone(ev("tick_start")), "dim");
  assert.equal(transcriptTone("── run @ 2026-09-29 16:07:56 ──"), "bold");
  assert.equal(transcriptTone("→ bash npm test"), "cyan");
  assert.equal(transcriptTone("· thinking about it"), "dim");
  assert.equal(transcriptTone("⚠ retry 1/3: 429"), "yellow");
  assert.equal(transcriptTone("  plain assistant text"), undefined);
});

test("sanitizeFrameLines strips terminal controls from attention and pane lines", () => {
  // The two TUI paths the review flagged: a QUESTIONS.md title in a fleet alert's detail, and
  // a backlog line (backlogLines -> toneLine). Both are composed into the final line list that
  // tui.tsx runs through sanitizeFrameLines before ink draws it.
  const osc = "\u001b]52;c;AAAA\u0007";
  const attention = alertLines(
    [{ key: "questions", tone: "indigo", title: `${osc}2 questions need your answer`, detail: `${osc}title`, actions: [] }],
    200,
  );
  const backlog = toneLine(`${osc}open questions (1):`, 200);
  const out = sanitizeFrameLines([...attention, backlog]);
  const rendered = out.map(plain).join("\n");
  assert.ok(!rendered.includes("\u001b"), "ESC must not survive the TUI boundary");
  assert.ok(!rendered.includes("\u0007"), "BEL must not survive the TUI boundary");
  // The visible text around the removed controls is preserved.
  assert.ok(rendered.includes("2 questions need your answer"));
  assert.ok(rendered.includes("open questions (1):"));
});

test("the page's event kinds are tone's", () => {
  const { eventKind: pageKind } = clientScope<{ eventKind(item: { type: string; result?: string }): string }>(["format", "view-model"], ["eventKind"]);
  const cases: Array<[string, string | undefined]> = [
    ["merged", undefined], ["question_posted", undefined], ["tick_end", "error"], ["tick_end", "queued"], ["tick_end", "no_change"],
    ["tick_end", "quiet_killed"], ["build_check", "passed"], ["build_check", "failed"], ["build_check", "skipped"], ["land_failed", undefined],
    ["review_rejected", undefined], ["tick_start", undefined], ["landed", undefined], ["fleet_paused", undefined], ["orchestrator_start", undefined],
    ["warning", undefined], ["brand_new_event", undefined],
  ];
  for (const [type, result] of cases) {
    assert.equal(pageKind({ type, ...(result === undefined ? {} : { result }) }), eventKind(type, result), `${type}/${result}`);
  }
});
