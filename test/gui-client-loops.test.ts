import test from "node:test";
import assert from "node:assert/strict";
import { clientScope, iconStub } from "./gui-client-scope.js";

// The dashboard's loops table, row by row (src/ui/gui-client-loops.ts's loops-table region):
// the status pill's second line (what the phase carried, when an idle loop wakes, the
// backoff and yield-scaled-clock notes) and each row's cells — the activity line's choice
// between live work, the landing placeholder, and the last result, the stalled-work red
// flag, and the per-row operator controls.

type PhaseInfo = { key: string; label: string; tone: string; live: boolean; detail: string };
type Loops = {
  phaseDetail(l: object, info: PhaseInfo, d: object): string;
  loopCells(l: object, d: object): { info: PhaseInfo; cells: string[] };
};
const { phaseDetail, loopCells } = clientScope<Loops>(
  ["format", "view-model", "loops-table"], ["phaseDetail", "loopCells"], {
    icon: iconStub,
    pill: (info: PhaseInfo) => "<span class='pill t-" + info.tone + "'>" + info.label + "</span>",
    landingSummary: (d: { landing?: Record<string, string> }, role: string) => (d.landing || {})[role] || "",
    abortConfirming: (role: string) => role === "confirming",
  });

const now = Date.now();
/** A row's cells by name, with the payload defaults loopCells assumes. */
const row = (l: object, d: object = {}): { status: string; activity: string; spend: string; actions: string } => {
  const c = loopCells({ todayUsd: 0, costUsd: 0, ...l }, d).cells.map(String);
  return { status: c[1] ?? "", activity: c[2] ?? "", spend: c[3] ?? "", actions: c[4] ?? "" };
};

test("a sleeping loop's second line says when it wakes, and names a backoff", () => {
  const info = { key: "sleeping", label: "Sleeping", tone: "gray", live: false, detail: "" };
  const l = (patch: object) => ({ phase: "sleeping", ...patch });
  // The countdown, from the payload's nextRunAt.
  assert.equal(phaseDetail(l({ nextRunAt: now + 120_000, backoffSeconds: 0 }), info, { running: true }), "wakes in 2m");
  // Due now.
  assert.equal(phaseDetail(l({ nextRunAt: now - 1_000, backoffSeconds: 0 }), info, { running: true }), "wakes now");
  // A fleet that is not running has no next run to speak of.
  assert.equal(phaseDetail(l({ nextRunAt: now + 120_000, backoffSeconds: 0 }), info, { running: false }), "");
  // Backing off after failures — named, not left to look like a normal schedule.
  assert.equal(phaseDetail(l({ nextRunAt: now + 120_000, backoffSeconds: 30 }), info, { running: true }),
    "backing off — retries in 2m");
  // A yield-scaled clock rides as a note: nothing landed lately, so it ticks less often.
  assert.equal(phaseDetail(l({ nextRunAt: now + 120_000, backoffSeconds: 0, yieldMultiplier: 3 }), info, { running: true }),
    "wakes in 2m · slowed ×3, nothing landed lately");
  assert.equal(phaseDetail(l({ nextRunAt: now + 120_000, backoffSeconds: 30, yieldMultiplier: 2 }), info, { running: true }),
    "backing off — retries in 2m · slowed ×2, nothing landed lately");
});

test("a queued loop's second line keeps the phase's reason, a working loop's keeps the phase detail", () => {
  const queued = { key: "queued", label: "Queued", tone: "gray", live: false, detail: "due — waiting for a free slot" };
  assert.equal(phaseDetail({ phase: "queued", nextRunAt: now - 5_000, backoffSeconds: 0 }, queued, { running: true }),
    "due — waiting for a free slot");
  // Backoff wins over the reason: when it will actually run again is the useful line.
  assert.equal(phaseDetail({ phase: "queued", nextRunAt: now + 60_000, backoffSeconds: 20 }, queued, { running: true }),
    "backing off — retries in 1m");
  const working = { key: "working", label: "Working", tone: "blue", live: true, detail: "3m12s · turn 4" };
  assert.equal(phaseDetail({ phase: "working 3m12s · turn 4" }, working, { running: true }), "3m12s · turn 4");
});

test("a live loop's activity shows its current work, or the stage's placeholder", () => {
  // Current work, full text in the title so a clamped line can still be read.
  const working = row({ role: "feature", phase: "working 3m · turn 4", currentWork: "Editing src/a.ts" });
  assert.ok(working.activity.includes(">Editing src/a.ts<"), "activity shows the current work");
  assert.ok(working.activity.includes("title='Editing src/a.ts'"), "full text rides in the title");
  // No work text yet — the stage's own placeholder, not a blank cell.
  assert.ok(row({ role: "feature", phase: "working 0s" }).activity.includes("Starting up…"));
  assert.ok(row({ role: "feature", phase: "reviewing 1m" }).activity.includes("Reviewing the change…"));
  // A landing in progress prefers its summary from the payload.
  assert.ok(row({ role: "feature", phase: "landing 1m" }, { landing: { feature: "Landing 3 commits" } })
    .activity.includes("Landing 3 commits"));
});

test("a stalled working loop's detail line is flagged red", () => {
  const stalled = row({ role: "feature", phase: "working 3m · tool call stalled 90s", currentWork: "x" });
  assert.ok(stalled.status.includes("class='sub t-red'"), "stalled detail carries the red tone");
  assert.ok(stalled.status.includes("tool call stalled 90s"), "the stall rides as the detail");
  // A healthy working loop stays unflagged.
  assert.ok(!row({ role: "feature", phase: "working 3m · turn 4", currentWork: "x" }).status.includes("t-red"));
});

test("an idle loop's activity is its last result in words with the reason that explains it", () => {
  const base = { role: "docs", phase: "sleeping", lastTickEndedAt: now - 90_000 };
  // A problem result shows the loop's own summary when it has one.
  const summarized = row({ ...base, lastResult: "error", lastSummary: "could not read the log" });
  assert.ok(summarized.activity.includes("<span class='res t-red'>Error</span>"));
  assert.ok(summarized.activity.includes("could not read the log"));
  assert.ok(summarized.activity.includes("2m ago"));
  // A problem result with no summary falls back to the recorded error.
  const errored = row({ ...base, lastResult: "review_error", lastError: "review crashed" });
  assert.ok(errored.activity.includes("Review failed"));
  assert.ok(errored.activity.includes("review crashed"));
  // A benign result carries neither.
  const clean = row({ ...base, lastResult: "no_change", lastError: "" });
  assert.ok(clean.activity.includes("<span class='res t-gray'>No change</span>"));
  assert.ok(!clean.activity.includes("review crashed"));
  // Never ticked.
  assert.ok(row({ role: "new", phase: "sleeping" }).activity.includes("No ticks yet"));
});

test("each row's actions match its state: wake when idle, abort (two-click) when in flight, resume when paused", () => {
  // Idle: wake and pause.
  assert.ok(row({ role: "docs", phase: "sleeping", inFlight: false }).actions.includes("data-action='wake'"));
  assert.ok(row({ role: "docs", phase: "sleeping", inFlight: false }).actions.includes("data-action='pause'"));
  // Paused: the target state is explicit — resume, not a toggle.
  assert.ok(row({ role: "docs", phase: "sleeping", inFlight: false }, { pausedRoles: ["docs"] }).actions.includes("data-action='resume'"));
  assert.ok(!row({ role: "docs", phase: "sleeping", inFlight: false }, { pausedRoles: ["docs"] }).actions.includes("data-action='pause'"));
  // In flight: the abort button, armed only after the confirming first click.
  const armed = row({ role: "confirming", phase: "working 3m", inFlight: true }).actions;
  assert.ok(armed.includes("confirming") && armed.includes("Abort?"));
  const inFlight = row({ role: "feature", phase: "working 3m", inFlight: true }).actions;
  assert.ok(inFlight.includes("data-action='abort'") && !inFlight.includes("Abort?"));
  assert.ok(!inFlight.includes("data-action='wake'"), "an in-flight loop has no wake button");
});

test("a row's name cell tags custom loops and queued prompts, and shows today's spend over the total", () => {
  const cells = loopCells({ role: "watcher", phase: "sleeping", custom: true, commits: 3, ticks: 12,
    todayUsd: 1.5, costUsd: 20.25 }, { roleInbox: { watcher: 2 } }).cells.map(String);
  const name = cells[0] ?? "";
  assert.ok(name.includes("custom"), "a user-defined loop says so");
  assert.ok(name.includes("2 prompts queued for this loop"));
  assert.ok(name.includes("3 commits · 12 ticks"));
  assert.equal(cells[3], "<div>$1.50</div><div class='sub'>$20.25 total</div>");
});

test("a loop row renders its model tier tag and selector when the payload carries them", () => {
  const cells = (l: object): string => loopCells({ todayUsd: 0, costUsd: 0, ...l }, {}).cells.map(String)[0] ?? "";
  const named = cells({ role: "plan", phase: "sleeping", ticks: 2, commits: 1, modelTier: "strong", model: "prov-s/model-s:high" });
  assert.match(named, /<span class='tag' title='[^']*'>strong<\/span>/);
  assert.match(named, /prov-s\/model-s:high/);
  // Without tier fields (no map declared) the row carries no tier tag and no selector.
  const plain = cells({ role: "clean", phase: "sleeping", ticks: 2, commits: 1 });
  assert.doesNotMatch(plain, /class='tag' title='[^']*'>strong</);
  assert.doesNotMatch(plain, /model-s/);
  // A tier tag without a resolved selector still renders, with no dangling separator.
  const tierOnly = cells({ role: "clean", phase: "sleeping", ticks: 2, commits: 1, modelTier: "strong" });
  assert.match(tierOnly, />strong<\/span>/);
  assert.doesNotMatch(tierOnly, /model-s/);
});
