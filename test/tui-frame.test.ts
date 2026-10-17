import test from "node:test";
import assert from "node:assert/strict";
import { clipToWidth, displayWidth } from "../src/text/text-width.js";
import { clipSpans, renderStatusSpans, type StatusSpan } from "../src/ui/status-render.js";
import { eventKind } from "../src/ui/tone.js";
import { eventTypeLabel } from "../src/events/event-labels.js";
import type { TeamAlert } from "../src/ui/team-alerts.js";
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
  assert.deepEqual(loops.find((l) => l.role === "clean"), { role: "clean", phase: "failing", errorStreak: true, inFlight: false, lastError: "boom", imageInput: null, imageReroute: null });
  assert.equal(lines[0]?.[0]?.tone, "brand", "the header opens with the name");
});

test("attention lines mark each alert and fold the overflow into a count", () => {
  const alert = (key: string, tone: TeamAlert["tone"], title: string, detail = ""): TeamAlert => ({ key, tone, title, detail, actions: [] });
  const alerts = [
    alert("failing", "red", "qa is failing run after run", "qa: 429"),
    alert("questions", "indigo", "1 question needs your answer", "Q1"),
    alert("build", "blue", "Update available (2 commits behind) — restarts when idle", "Restart tumwater start to pick it up."),
    alert("stopped", "gray", "tumwater is not running — start it with `tumwater start`"),
  ];
  const lines = alertLines(alerts, 200).map(plain);
  assert.deepEqual(lines, [
    "! qa is failing run after run — qa: 429",
    "? 1 question needs your answer — Q1",
    "  +2 more — the dashboard lists them all",
  ]);
  assert.deepEqual(alertLines(alerts.slice(0, 3), 200).map(plain).at(-1), "i Update available (2 commits behind) — restarts when idle — Restart tumwater start to pick it up.");
  assert.equal(alertLines(alerts.slice(0, 1), 12).map(plain)[0], clipToWidth("! qa is failing run after run — qa: 429", 12));
  assert.deepEqual(alertLines([], 80), []);
});

test("the tab strip names every view and brackets the current one", () => {
  assert.equal(plain(tabStrip({ kind: "activity", role: null, grep: null, type: null }, 200)), "[Activity]  Transcript  Backlog  Usage  Failures  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "activity", role: "feature", grep: null, type: null }, 200)), "[Activity: feature]  Transcript  Backlog  Usage  Failures  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14, note: false, change: false }, 200)), "Activity  [Transcript: qa (3/14)]  Backlog  Usage  Failures  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14, note: true, change: false }, 200)), "Activity  [Notes: qa (3/14)]  Backlog  Usage  Failures  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "transcript", role: "qa", index: 3, count: 14, note: false, change: true }, 200)), "Activity  [Change: qa (3/14)]  Backlog  Usage  Failures  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  const usage = tabStrip({ kind: "usage", scope: null, window: null }, 200);
  assert.deepEqual(usage.filter((s) => s.tone === "brand").map((s) => s.text), ["[Usage]"], "only the current view is bright");
  assert.equal(plain(tabStrip({ kind: "usage", scope: "feature", window: "1h" }, 200)), "Activity  Transcript  Backlog  [Usage: feature]  Failures  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "failures", scope: "clean", window: null }, 200)), "Activity  Transcript  Backlog  Usage  [Failures: clean]  History  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [History]  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: "feature", grep: null, trail: false }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [History: feature]  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: "qa", grep: null, trail: true }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [Run: qa]  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "history", since: null, result: null, role: null, grep: null, trail: true }, 200)), "Activity  Transcript  Backlog  Usage  Failures  [Run]  Pending  Inbox  Health  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "health" }, 200)), "Activity  Transcript  Backlog  Usage  Failures  History  Pending  Inbox  [Health]  Brief   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "brief" }, 200)), "Activity  Transcript  Backlog  Usage  Failures  History  Pending  Inbox  Health  [Brief]   Ctrl+T next");
  assert.equal(plain(tabStrip({ kind: "queued" }, 200)), "Activity  Transcript  Backlog  Usage  Failures  History  Pending  [Inbox]  Health  Brief   Ctrl+T next");
  assert.ok(displayWidth(plain(tabStrip({ kind: "backlog" }, 20))) <= 20);
});

test("the hint line says what the keys do in each view and mode", () => {
  const hint = (view: Parameters<typeof hintLine>[0], budget = false, rolePromptFor: string | null = null, deferMode = false, defer: string | null = null, queuedEditFor: { role: string; file: string } | null = null, answerFor: { position: number; title: string } | null = null) => plain(hintLine(view, { budget, rolePromptFor, deferMode, defer, queuedEditFor, answerFor }, 300));
  assert.equal(hint({ kind: "activity", role: null, grep: null, type: null }), "Enter send · ↑↓ history · PgUp/PgDn scroll · Ctrl+B daily cap · Ctrl+O type: all · Ctrl+G scope: team · / search · Ctrl+T next view · Ctrl+F pause team · Ctrl+Q stop later · Ctrl+C interrupt director · Ctrl+V attach image · Ctrl+R restart · Ctrl+D quit · Ctrl+L send later");
  // The Activity hint names the Ctrl+V image attach on the prompt line.
  assert.match(plain(hintLine({ kind: "activity", role: null, grep: null, type: null }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null }, 300)), /Ctrl\+V attach image/);
  // The Activity hint names the Ctrl+R restart command on the prompt line.
  assert.match(plain(hintLine({ kind: "activity", role: null, grep: null, type: null }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null }, 300)), /Ctrl\+R restart/);
  // The Activity pane names its exact-loop scope and its text search, the raw id or the team
  // and "search" or the active pattern, matching the History pane's conventions.
  assert.match(hint({ kind: "activity", role: "feature", grep: null, type: null }), /Ctrl\+G scope: feature · \/ search/);
  assert.match(hint({ kind: "activity", role: null, grep: "widget", type: null }), /Ctrl\+G scope: team · \/ search: widget/);
  // The Activity Ctrl+O hint names the active type label, "all" or the exact event type.
  assert.match(hint({ kind: "activity", role: null, grep: null, type: null }), /Ctrl\+O type: all/);
  assert.match(hint({ kind: "activity", role: null, grep: null, type: "run_end" }), new RegExp(`Ctrl\\+O type: ${eventTypeLabel("run_end")}`));
  // At the fake TTY's 100 columns the daily-cap key (placed before the new ones) stays visible.
  assert.match(plain(hintLine({ kind: "activity", role: null, grep: null, type: null }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null }, 100)), /Ctrl\+B daily cap/);
  assert.equal(
    hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: false }),
    "Enter send · ↑↓ history · Ctrl+R prompt qa · Ctrl+N notes · Ctrl+P pause/resume · Ctrl+W wake · Ctrl+A stop run · Ctrl+V reset counters · Ctrl+T next view · Ctrl+D quit · Ctrl+L send later",
  );
  assert.equal(
    hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: true, change: false }),
    "Enter send · ↑↓ history · Ctrl+R prompt qa · Ctrl+N change · Ctrl+X clear notes · Ctrl+P pause/resume · Ctrl+W wake · Ctrl+A stop run · Ctrl+V reset counters · Ctrl+T next view · Ctrl+D quit · Ctrl+L send later",
  ); // the notebook's next step is the change view
  assert.equal(
    hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: true }),
    "Enter send · ↑↓ history · Ctrl+R prompt qa · Ctrl+N transcript · Ctrl+P pause/resume · Ctrl+W wake · Ctrl+A stop run · Ctrl+V reset counters · Ctrl+T next view · Ctrl+D quit · Ctrl+L send later",
  ); // the cycle's last step names the way back
  assert.match(hint({ kind: "backlog" }), /↑↓ open entries · Ctrl\+X cancel entry · Ctrl\+R release entry · Ctrl\+V top entry · Ctrl\+E edit entry · Ctrl\+N new plan\/bug · Ctrl\+A answer question · PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "failures", scope: null, window: null }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "usage", scope: "feature", window: null }), /Ctrl\+G scope: feature/);
  assert.match(hint({ kind: "failures", scope: "clean", window: "1h" }), /Ctrl\+G scope: clean/);
  assert.match(hint({ kind: "usage", scope: null, window: null }), /Ctrl\+G scope: team/);
  // The Usage and Failures panes name their trailing report window in the Ctrl+E hint,
  // default or active; the two report panes share the same hint shape.
  assert.match(hint({ kind: "usage", scope: null, window: "1h" }), /Ctrl\+E window: 1h/);
  assert.match(hint({ kind: "usage", scope: null, window: null }), /Ctrl\+E window: default/);
  assert.match(hint({ kind: "failures", scope: null, window: "7d" }), /Ctrl\+E window: 7d/);
  assert.match(hint({ kind: "failures", scope: null, window: null }), /Ctrl\+E window: default/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "pending" }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "pending" }), /Ctrl\+R refresh/);
  assert.match(hint({ kind: "health" }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "health" }), /Ctrl\+D quit/);
  assert.match(hint({ kind: "health" }), /Ctrl\+R re-run checks/);
  assert.match(hint({ kind: "health" }), /Ctrl\+E reclaim disk/);
  assert.match(hint({ kind: "health", problems: false }), /Ctrl\+O all checks/);
  assert.match(hint({ kind: "health", problems: true }), /Ctrl\+O problems only/);
  assert.match(hint({ kind: "brief" }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "queued" }), /PgUp\/PgDn scroll/);
  assert.match(hint({ kind: "queued" }), /Ctrl\+V top/);
  assert.match(hint({ kind: "queued" }), /Ctrl\+E edit/);
  assert.match(hint({ kind: "queued" }), /Ctrl\+X cancel/);
  // The Queued editor names its save/cancel keys, like the budget and role editors.
  assert.equal(
    plain(hintLine({ kind: "queued" }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: { role: "clean", file: "a.md" }, answerFor: null }, 300)),
    "Enter save the edit · Esc cancel · Ctrl+D quit",
  );
  assert.equal(hint({ kind: "activity", role: null, grep: null, type: null }, true), "Enter save the daily cap · Esc cancel · Ctrl+D quit");
  assert.equal(hint({ kind: "activity", role: null, grep: null, type: null }, false, null, true), "Enter save the delay · Esc cancel · Ctrl+D quit");
  assert.match(hint({ kind: "activity", role: null, grep: null, type: null }, false, null, false, "45m"), /Ctrl\+L send later: 45m/);
  assert.equal(hint({ kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: false }, false, "qa"), "Enter send to qa · ↑↓ history · Esc cancel · Ctrl+D quit");
  // The History pane names its trailing window in the Ctrl+S hint, default or active.
  assert.match(hint({ kind: "history", since: "1h", result: null, role: null, grep: null, trail: false }), /Ctrl\+S window: 1h/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+S window: default/);
  // The History pane names its outcome class in the Ctrl+O hint, "all" or the active class.
  assert.match(hint({ kind: "history", since: null, result: "problems", role: null, grep: null, trail: false }), /Ctrl\+O result: problems/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+O result: all/);
  // The History pane names its exact-loop scope in the Ctrl+G hint, the raw id or the team.
  assert.match(hint({ kind: "history", since: null, result: null, role: "feature", grep: null, trail: false }), /Ctrl\+G scope: feature/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+G scope: team/);
  // The History pane names its free-text search in the `/` hint, "search" or the pattern.
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: "widget", trail: false }), /\/ search: widget/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /\/ search/);
  // The History pane names its tick-trail toggle in the Ctrl+N hint, the row list or the trail.
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false }), /Ctrl\+N run trail/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: true }), /Ctrl\+N history/);
  // The History pane names its Summary toggle in the Ctrl+Y hint, the summary or the rows.
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false, summary: false }), /Ctrl\+Y summary/);
  assert.match(hint({ kind: "history", since: null, result: null, role: null, grep: null, trail: false, summary: true }), /Ctrl\+Y rows/);
  // Every view names Ctrl+D as quit; the director prompt line additionally names Ctrl+C.
  for (const v of [
    { kind: "activity", role: null, grep: null, type: null } as const,
    { kind: "transcript", role: "qa", index: 1, count: 2, note: false, change: false } as const,
    { kind: "backlog" } as const,
    { kind: "usage", scope: null, window: null } as const,
    { kind: "failures", scope: null, window: null } as const,
    { kind: "history", since: null, result: null, role: null, grep: null, trail: false } as const,
    { kind: "pending" } as const,
    { kind: "queued" } as const,
    { kind: "health" } as const,
  ]) assert.match(plain(hintLine(v, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null }, 300)), /Ctrl\+D quit/);
  // Keys stand out from what they do.
  const spans = hintLine({ kind: "activity", role: null, grep: null, type: null }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null }, 300);
  assert.deepEqual(spans.filter((s) => s.tone === "bold").map((s) => s.text), ["Enter", "↑↓", "PgUp/PgDn", "Ctrl+B", "Ctrl+O", "Ctrl+G", "/", "Ctrl+T", "Ctrl+F", "Ctrl+Q", "Ctrl+C", "Ctrl+V", "Ctrl+R", "Ctrl+D", "Ctrl+L"]);
});

test("pause-edit mode shows its own hint keys and prompt prefix", () => {
  const base = { budget: false, rolePromptFor: null, deferMode: false, pauseEditMode: true, defer: null, queuedEditFor: null, answerFor: null };
  assert.deepEqual(hintLine({ kind: "activity", role: null, grep: null, type: null }, base, 300).filter((s) => s.tone === "bold").map((s) => s.text), ["Enter", "Esc", "Ctrl+D"]);
  assert.equal(plain(promptPrefix(base)), "pause › ");
  const forRole = { ...base, pauseEditRole: "qa" };
  assert.equal(plain(promptPrefix(forRole)), "pause qa › ");
  assert.deepEqual(hintLine({ kind: "activity", role: null, grep: null, type: null }, forRole, 300).map((s) => s.text).join("").includes("Enter pause qa"), true);
  const wake = { ...forRole, pauseEditWake: true };
  assert.equal(plain(promptPrefix(wake)), "wake qa › ");
  assert.equal(hintLine({ kind: "activity", role: null, grep: null, type: null }, wake, 300).map((s) => s.text).join("").includes("Enter wake qa"), true);
});

test("the prompt line names who Enter sends to", () => {
  const edit = { kind: "plan", position: 2, title: "t" } as const;
  const base = { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null };
  assert.equal(plain(promptPrefix({ ...base, entryEditFor: edit })), "edit plan #2 › ");
  assert.match(plain(hintLine({ kind: "backlog" }, { ...base, entryEditFor: edit }, 300)), /Enter save title/);
  assert.match(plain(hintLine({ kind: "backlog" }, { ...base, entryEditFor: edit }, 300)), /Ctrl\+E body file/);
  const filing = { kind: "bug", position: null, title: "" } as const;
  assert.equal(plain(promptPrefix({ ...base, entryEditFor: filing })), "new bug › ");
  const filingHint = plain(hintLine({ kind: "backlog" }, { ...base, entryEditFor: filing }, 300));
  assert.match(filingHint, /Enter file bug/);
  assert.match(filingHint, /Ctrl\+N switch to plan/);
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null })), "director › ");
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: "qa", deferMode: false, defer: null, queuedEditFor: null, answerFor: null })), "qa › ");
  assert.equal(plain(promptPrefix({ budget: true, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null })), "daily cap $ ");
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: true, defer: null, queuedEditFor: null, answerFor: null })), "send later › ");
  // A pending delay is named beside the target; the defer editor's own prefix never repeats it.
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: "45m", queuedEditFor: null, answerFor: null })), "director (in 45m) › ");
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: "qa", deferMode: false, defer: "1h", queuedEditFor: null, answerFor: null })), "qa (in 1h) › ");
  // A pending image count is named beside the director target, pluralized with the count.
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null, images: 2 })), "director (2 images) › ");
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null, images: 1 })), "director (1 image) › ");
  // A role-targeted prompt never carries the images, so the count is not named beside it.
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: "qa", deferMode: false, defer: null, queuedEditFor: null, answerFor: null, images: 2 })), "qa › ");
  // Attach mode names its own hint keys.
  assert.equal(plain(hintLine({ kind: "activity", role: null, grep: null, type: null }, { budget: false, rolePromptFor: null, deferMode: false, attachMode: true, defer: null, queuedEditFor: null, answerFor: null }, 300)), "Enter attach image path · Esc cancel · Ctrl+D quit");
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: { role: "clean", file: "a.md" }, answerFor: null })), "edit clean › ");
  assert.equal(prefixWidth(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null })), 11);
});

test("activity and transcript lines take the tones of what they report", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ ts: 1, source: "qa", type, ...extra }) as Parameters<typeof eventTone>[0];
  assert.equal(eventTone(ev("merged")), "green");
  assert.equal(eventTone(ev("run_end", { result: "error" })), "red");
  assert.equal(eventTone(ev("run_end", { result: "rejected" })), "yellow");
  assert.equal(eventTone(ev("run_end", { result: "no_change" })), "dim");
  assert.equal(eventTone(ev("build_check", { status: "failed" })), "red");
  assert.equal(eventTone(ev("question_posted")), "magenta");
  assert.equal(eventTone(ev("team_paused")), undefined);
  assert.equal(eventTone(ev("run_start")), "dim");
  assert.equal(transcriptTone("── run @ 2026-09-29 16:07:56 ──"), "bold");
  assert.equal(transcriptTone("→ bash npm test"), "cyan");
  assert.equal(transcriptTone("· thinking about it"), "dim");
  assert.equal(transcriptTone("⚠ retry 1/3: 429"), "yellow");
  assert.equal(transcriptTone("  plain assistant text"), undefined);
});

test("sanitizeFrameLines strips terminal controls from attention and pane lines", () => {
  // The two TUI paths the review flagged: a QUESTIONS.md title in a team alert's detail, and
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
  const { eventKind: pageKind } = clientScope<{ eventKind(item: { type: string; result?: string }): string }>(["format", "labels", "view-model"], ["eventKind"]);
  const cases: Array<[string, string | undefined]> = [
    ["merged", undefined], ["question_posted", undefined], ["run_end", "error"], ["run_end", "queued"], ["run_end", "no_change"],
    ["run_end", "quiet_killed"], ["build_check", "passed"], ["build_check", "failed"], ["build_check", "skipped"], ["merge_failed", undefined],
    ["review_rejected", undefined], ["run_start", undefined], ["merge_done", undefined], ["team_paused", undefined], ["orchestrator_start", undefined],
    ["warning", undefined], ["brand_new_event", undefined],
  ];
  for (const [type, result] of cases) {
    assert.equal(pageKind({ type, ...(result === undefined ? {} : { result }) }), eventKind(type, result), `${type}/${result}`);
  }
});

test("the answer editor names Enter record answer, drops the defer hint, and prefixes the line", () => {
  const hint = plain(hintLine({ kind: "backlog" }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: { position: 2, title: "q" } }, 300));
  assert.match(hint, /record answer/);
  assert.doesNotMatch(hint, /defer/);
  assert.equal(plain(promptPrefix({ budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: { position: 2, title: "q" } })), "answer #2 › ");
  assert.match(plain(hintLine({ kind: "backlog" }, { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null }, 300)), /Ctrl\+A answer question/);
});

test("the activity hint names Ctrl+Q and the stop editor reads `stop in ›` with a schedule-stop hint", () => {
  const base = { budget: false, rolePromptFor: null, deferMode: false, defer: null, queuedEditFor: null, answerFor: null };
  assert.match(plain(hintLine({ kind: "activity", role: null, grep: null, type: null }, base, 300)), /Ctrl\+Q stop later/);
  const edit = { ...base, pauseEditMode: true, pauseEditStop: true };
  assert.match(plain(promptPrefix(edit)), /stop in/);
  assert.match(plain(hintLine({ kind: "activity", role: null, grep: null, type: null }, edit, 300)), /schedule stop/);
});
