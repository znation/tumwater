import test from "node:test";
import assert from "node:assert/strict";
import { clipToWidth, displayWidth } from "../src/text-width.js";
import { clipSpans, renderStatus, renderStatusSpans, type StatusSpan } from "../src/ui/status-render.js";
import { eventKind } from "../src/ui/tone.js";
import type { FleetAlert } from "../src/ui/fleet-alerts.js";
import { snapshot } from "../src/status-data.js";
import { initProject } from "../src/init.js";
import { freshLoopState, saveLoopState } from "../src/loop-state.js";
import {
  alertLines,
  eventTone,
  hintLine,
  paintLine,
  prefixWidth,
  promptPrefix,
  resolveStyles,
  tabStrip,
  transcriptTone,
} from "../src/ui/tui-frame.js";
import { makeRepo } from "./repo-fixtures.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { clientScope } from "./gui-client-scope.js";

// The TUI frame's pure pieces (src/ui/tui-frame.ts) and the toned status spans they paint
// (status-render.ts): coloring must never move a column or a cut, and NO_COLOR must drop
// every escape while keeping every character.

const plain = (line: readonly StatusSpan[]) => line.map((s) => s.text).join("");
const SGR = /\x1b\[[0-9;]*m/g;

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

test("a painted status render reads exactly as the plain one, and NO_COLOR paints nothing", async () => {
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
    const painted = lines.map((l) => paintLine(resolveStyles(undefined), l)).join("\n");
    assert.equal(painted.replace(SGR, ""), renderStatus(repo, snap, width), `width ${width}`);
    assert.equal(lines.map((l) => paintLine(resolveStyles("1"), l)).join("\n"), renderStatus(repo, snap, width), "NO_COLOR is the plain text");
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
  assert.equal(plain(tabStrip({ kind: "activity" }, 200)), "[Activity]  Transcript  Backlog  Usage  Failures   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14 }, 200)), "Activity  [Transcript: qa (3/14)]  Backlog  Usage  Failures   Ctrl+T next");
  const usage = tabStrip({ kind: "usage" }, 200);
  assert.deepEqual(usage.filter((s) => s.tone === "brand").map((s) => s.text), ["[Usage]"], "only the current view is bright");
  assert.ok(displayWidth(plain(tabStrip({ kind: "backlog" }, 20))) <= 20);
});

test("the hint line says what the keys do in each view and mode", () => {
  const hint = (view: Parameters<typeof hintLine>[0], budget = false, rolePromptFor: string | null = null) => plain(hintLine(view, { budget, rolePromptFor }, 300));
  assert.equal(hint({ kind: "activity" }), "Enter send · ↑↓ history · Ctrl+T next view · Ctrl+B daily cap · Ctrl+C quit");
  assert.match(hint({ kind: "transcript", role: "qa", index: 1, count: 2 }), /^Enter send · ↑↓ history · Ctrl\+R prompt qa · Ctrl\+P pause\/resume · Ctrl\+W wake · Ctrl\+A abort/);
  assert.match(hint({ kind: "backlog" }), /↑↓ open entries · PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "failures" }), /PgUp\/PgDn scroll/);
  assert.equal(hint({ kind: "activity" }, true), "Enter save the daily cap · Esc cancel · Ctrl+C quit");
  assert.equal(hint({ kind: "transcript", role: "qa", index: 1, count: 2 }, false, "qa"), "Enter send to qa · ↑↓ history · Esc cancel · Ctrl+C quit");
  // Keys stand out from what they do.
  const spans = hintLine({ kind: "activity" }, { budget: false, rolePromptFor: null }, 300);
  assert.deepEqual(spans.filter((s) => s.tone === "bold").map((s) => s.text), ["Enter", "↑↓", "Ctrl+T", "Ctrl+B", "Ctrl+C"]);
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
