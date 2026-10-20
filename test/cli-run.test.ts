import test from "node:test";
import assert from "node:assert/strict";

import { ONCE_FAILURE_RESULTS, armDeadlineTimer, guiChildPlan, inheritedWindowStart, onceFailures, onceSummary, parseRunWindow, windowSummary } from "../src/cli/cli-run.js";
import { summarizeTickRows, type TickRow } from "../src/history/history-data.js";
import { SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { expectFail, expectOk } from "./helpers/exit-capture.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { pauseTeam } from "../src/team/team-state.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { sleep } from "./helpers/wait.js";

// Unit seam for cli/cli-run.ts's onceSummary — the one-line `tumwater run --once` summary a cron
// log keeps. The orchestrator-level behavior (which settle reason a real round hands back,
// deferred included) is pinned end to end by test/orchestrator-once.e2e.test.ts; these tests
// pin the summary's own accounting at unit level: tick counting against the pre-round
// snapshot, bucketing by last result, and skip reasons reported verbatim from the
// orchestrator's settle map — the 2026-09-25 BUGS.md fix that stopped a deferred role from
// being re-derived from state as "idle". The state-derived classification appears only as the
// documented fallback for a role the settle map lacks (asserted once, via the unambiguous
// pause-marker branch).

function state(role: string, over: Partial<RunnerState>): RunnerState {
  return { ...freshRunnerState(role), ...over };
}

// --- parseRunWindow: the run --for body rules (the dispatcher's durationFlagSpec("run --for") gate
// has
// already named a malformed value with parseDurationFlag's wording by the time these run;
// here the same parse is pinned through the helper cmdRun itself calls) ---

test("parseRunWindow parses --for's duration and returns null without the flag", () => {
  assert.equal(expectOk(() => parseRunWindow(["--for", "2h"], false)), 2 * 60 * 60 * 1000);
  assert.equal(expectOk(() => parseRunWindow(["--once"], false)), null);
});

test("parseRunWindow fails a malformed --for with the duration wording", () => {
  const r = expectFail(() => parseRunWindow(["--for", "abc"], false));
  assert.match(r.stderr, /--for needs a duration like 45s, 90m, 1h30m, or 2d \(got "abc"\)/);
  // A trailing bare --for fails the same way (the dispatcher's gate names it first in real use).
  const bare = expectFail(() => parseRunWindow(["--for"], false));
  assert.match(bare.stderr, /start --for needs a value/);
});

test("parseRunWindow rejects --for together with --once", () => {
  const r = expectFail(() => parseRunWindow(["--once", "--for", "5m"], true));
  assert.match(r.stderr, /--for cannot be combined with --once/);
});

test("parseRunWindow enforces pause --for's 90-day cap", () => {
  const r = expectFail(() => parseRunWindow(["--for", "200d"], false));
  assert.match(r.stderr, /--for is capped at 90d \(got 200d\)/);
});

// --- guiChildPlan: the run --gui arg split the supervisor spawns from ---

// `run --gui` strips --gui before handing the args to the supervised orchestrator generation
// (whose cmdRun would otherwise supervise a second dashboard), and reports whether the
// supervisor should start one. Pinned here so the stripping cannot silently drop.
test("guiChildPlan strips --gui and reports it, leaving other args untouched", () => {
  assert.deepEqual(guiChildPlan(["--gui"]), {
    spawnGui: true,
    spawnTui: false,
    orchestratorArgs: [],
    childStdio: "inherit",
  });
  assert.deepEqual(guiChildPlan(["--branch", "x", "--gui", "--for", "2h"]), {
    spawnGui: true,
    spawnTui: false,
    orchestratorArgs: ["--branch", "x", "--for", "2h"],
    childStdio: "inherit",
  });
  assert.deepEqual(guiChildPlan(["--once", "--role", "clean"]), {
    spawnGui: false,
    spawnTui: false,
    orchestratorArgs: ["--once", "--role", "clean"],
    childStdio: "inherit",
  });
});

// `run --tui` gets the same treatment as `--gui`: `--tui` is stripped so a self-redeploy
// generation never re-attaches a TUI in a terminal the parent owns, and reported so the
// supervisor hosts it. The two flags together stay allowed (dashboard child + in-terminal TUI
// are orthogonal) and both are stripped.
test("guiChildPlan strips --tui (and --gui), reports spawnTui and silences the child's stdio", () => {
  assert.deepEqual(guiChildPlan(["--tui"]), {
    spawnGui: false,
    spawnTui: true,
    orchestratorArgs: [],
    childStdio: ["ignore", "ignore", "ignore"],
  });
  assert.deepEqual(guiChildPlan(["--gui", "--tui"]), {
    spawnGui: true,
    spawnTui: true,
    orchestratorArgs: [],
    childStdio: ["ignore", "ignore", "ignore"],
  });
  assert.deepEqual(guiChildPlan(["--branch", "x", "--tui", "--for", "2h"]), {
    spawnGui: false,
    spawnTui: true,
    orchestratorArgs: ["--branch", "x", "--for", "2h"],
    childStdio: ["ignore", "ignore", "ignore"],
  });
});

// --- armDeadlineTimer: the deadline timer cmdRun arms for `run --for` ---

// A duration over setTimeout's 32-bit signed limit (2_147_483_647 ms ≈ 24.8 days) is clamped
// by Node to 1ms with a TimeoutOverflowWarning, so the deadline would fire immediately and a
// windowed run would stop the instant it booted. `run --for` accepts durations up to the
// 90-day pause cap, so durations past the limit are ordinary inputs, not errors — the arming
// helper must chunk them. Without the chunking this test observes the immediate fire.
test("armDeadlineTimer does not fire an over-32-bit duration immediately", async () => {
  let fired = 0;
  const timer = armDeadlineTimer(90 * 24 * 60 * 60 * 1000, () => fired++);
  await sleep(100);
  assert.equal(fired, 0, "an overflow duration must be chunked, not clamped to 1ms");
  timer.clear();
});

test("armDeadlineTimer fires a short duration on schedule and clear() retracts it", async () => {
  let fired = 0;
  const firedTimer = armDeadlineTimer(50, () => fired++);
  await sleep(300);
  assert.equal(fired, 1);
  const cleared = armDeadlineTimer(50, () => fired++);
  cleared.clear();
  await sleep(300);
  assert.equal(fired, 1, "clear() must retract the armed timer");
  firedTimer.clear(); // Already fired; clear() is still safe.
});

test("counts the round's ticks and buckets them by last result, sorted by key", () => {
  const root = makeRepo();
  saveRunnerState(root, state("clean", { runs: 2, lastResult: "changed" }));
  saveRunnerState(root, state("docs", { runs: 1, lastResult: "no_change" }));
  saveRunnerState(root, state("qa", { runs: 3, lastResult: "error" }));

  const line = onceSummary(
    root,
    ["clean", "docs", "qa"],
    new Map([
      ["clean", 0],
      ["docs", 0],
      ["qa", 1],
    ]),
    undefined,
  );

  // Only the ticks this round advanced count: qa had 1 tick before, so 2 of its 3 are new.
  assert.equal(line, "once: 5 runs — 1 changed, 1 error, 1 no_change");
});

test("one advanced tick reads singular; zero ticks read `nothing ran`", () => {
  const root = makeRepo();
  saveRunnerState(root, state("clean", { runs: 1, lastResult: "no_change" }));
  assert.equal(
    onceSummary(root, ["clean"], new Map([["clean", 0]]), undefined),
    "once: 1 run — 1 no_change",
  );
  // A role that never advanced is skipped with the settle reason too (here: idle, from the map).
  assert.equal(
    onceSummary(root, ["docs"], new Map([["docs", 0]]), new Map([["docs", "idle"]])),
    "once: 0 runs — nothing ran, 1 skipped (idle)",
  );
});

test("a skipped role reports the orchestrator's settle reason verbatim, not a state re-derivation", () => {
  const root = makeRepo();
  // clean's state would read as idle by derivation (past nextRunAt, no pause marker) — the
  // pre-fix mislabel the 2026-09-25 BUGS.md entry records; the settle map says deferred.
  saveRunnerState(root, state("clean", { runs: 4, nextRunAt: Date.now() - 60_000 }));

  const line = onceSummary(
    root,
    ["clean"],
    new Map([["clean", 4]]),
    new Map([["clean", "deferred"]]),
  );

  assert.equal(line, "once: 0 runs — nothing ran, 1 skipped (deferred)");
});

test("skip reasons are reported verbatim and in role order", () => {
  const root = makeRepo();
  saveRunnerState(root, state("clean", { runs: 1 }));
  saveRunnerState(root, state("docs", { runs: 1 }));
  saveRunnerState(root, state("qa", { runs: 1 }));

  const line = onceSummary(
    root,
    ["clean", "docs", "qa"],
    new Map([
      ["clean", 1],
      ["docs", 1],
      ["qa", 1],
    ]),
    new Map([
      ["clean", "deferred"],
      ["docs", "disabled"],
      ["qa", "backoff"],
    ]),
  );

  assert.equal(line, "once: 0 runs — nothing ran, 3 skipped (deferred, disabled, backoff)");
});

test("a role the settle map lacks falls back to state, via the pause marker", () => {
  const root = makeRepo();
  pauseTeam(root);
  saveRunnerState(root, state("clean", { runs: 1 }));

  const line = onceSummary(root, ["clean"], new Map([["clean", 1]]), new Map());

  assert.equal(line, "once: 0 runs — nothing ran, 1 skipped (paused)");
});

test("a role enabled mid-round counts by the round's ticks-run map, not its whole history", () => {
  const root = makeRepo();
  // The role joined the runners array after the round's start (live config reload), so it is
  // in neither `roles` nor ticksBefore: its persisted ticks (5) are not this round's, and
  // only the orchestrator's ticks-run map knows it ran exactly one (BUGS.md 2026-09-25).
  saveRunnerState(root, state("improve", { runs: 6, lastResult: "changed" }));

  const line = onceSummary(
    root,
    ["clean"],
    new Map([["clean", 0]]),
    new Map([["clean", "idle"]]),
    new Map([
      ["clean", 0],
      ["improve", 1],
    ]),
  );

  assert.equal(line, "once: 1 run — 1 changed, 1 skipped (idle)");
});

test("a ran role with no recorded last result buckets as no_change", () => {
  const root = makeRepo();
  // A tick that advanced the counter without writing lastResult — the field is optional on
  // RunnerState — still counts, bucketed under the same `no_change` key a recorded no-change
  // tick uses, rather than dropping out of the counts line.
  saveRunnerState(root, state("clean", { runs: 1 }));

  assert.equal(
    onceSummary(root, ["clean"], new Map([["clean", 0]]), undefined),
    "once: 1 run — 1 no_change",
  );
});

test("a role the round's ticks-run map lacks counts zero and settles, not its history", () => {
  const root = makeRepo();
  // The mid-round map is the source of truth for who ran: a role listed in `roles` but
  // absent from it ran zero ticks this round — its persisted history (ticks 4) must not
  // leak into the summary, and it reports the settle reason like any skipped role.
  saveRunnerState(root, state("clean", { runs: 4 }));
  saveRunnerState(root, state("improve", { runs: 1, lastResult: "changed" }));

  const line = onceSummary(
    root,
    ["clean"],
    new Map([["clean", 0]]),
    new Map([["clean", "idle"]]),
    new Map([["improve", 1]]),
  );

  assert.equal(line, "once: 1 run — 1 changed, 1 skipped (idle)");
});

test("the fallback reads a scheduled-clock wait as idle, not backoff", () => {
  const root = makeRepo();
  // The shape a productive tick leaves behind: backoffSeconds 0 with a future nextRunAt —
  // the scheduled clock, not a backoff deadline. The old fallback keyed backoff on
  // nextRunAt alone (the same clock-vs-backoff conflation the 2026-09-25 settleSkipped
  // fix removed), so a merely not-due role in a settle-map-missing round's summary read
  // as "backoff".
  saveRunnerState(
    root,
    state("clean", { runs: 1, backoffSeconds: 0, nextRunAt: Date.now() + 600_000 }),
  );

  assert.equal(
    onceSummary(root, ["clean"], new Map([["clean", 1]]), new Map()),
    "once: 0 runs — nothing ran, 1 skipped (idle)",
  );
});

test("the fallback reads a raised backoffSeconds as backoff", () => {
  const root = makeRepo();
  saveRunnerState(
    root,
    state("qa", { runs: 1, backoffSeconds: 42, nextRunAt: Date.now() + 42_000 }),
  );

  assert.equal(
    onceSummary(root, ["qa"], new Map([["qa", 1]]), new Map()),
    "once: 0 runs — nothing ran, 1 skipped (backoff)",
  );
});

test("the fallback reads a pending resume as pending work, not backoff or idle", () => {
  const root = makeRepo();
  // A cut-off tick waits one interval with backoffSeconds 0 and a future nextRunAt: the
  // resume check must outrank the clock, or the wait reads as backoff (or, post-fix, as
  // idle — both hide that half-finished work is pending).
  saveRunnerState(
    root,
    state("improve", { runs: 1, resumePending: true, nextRunAt: Date.now() + 600_000 }),
  );

  assert.equal(
    onceSummary(root, ["improve"], new Map([["improve", 1]]), new Map()),
    "once: 0 runs — nothing ran, 1 skipped (resume pending)",
  );
});

test("onceFailures reports roles that ticked this round and ended in a failure result", () => {
  const root = makeRepo();
  saveRunnerState(root, state("clean", { runs: 1, lastResult: "error" }));
  assert.deepEqual(onceFailures(root, ["clean"], new Map(), new Map([["clean", 1]])), [{ role: "clean", result: "error" }]);
  assert.deepEqual(onceFailures(root, ["clean"], new Map(), new Map([["clean", 0]])), [], "did not tick this round");
  assert.deepEqual(onceFailures(root, ["clean"], new Map([["clean", 0]])), [{ role: "clean", result: "error" }]);
  assert.deepEqual(onceFailures(root, ["clean"], new Map([["clean", 1]])), [], "no new tick");
  assert.deepEqual(onceFailures(root, [], new Map(), new Map([["clean", 1]])), [{ role: "clean", result: "error" }], "ticks-run-only role");
});

test("onceFailures reports every ONCE_FAILURE_RESULTS member and ignores the rest", () => {
  const root = makeRepo();
  for (const result of ONCE_FAILURE_RESULTS) {
    saveRunnerState(root, state("clean", { runs: 1, lastResult: result }));
    assert.deepEqual(onceFailures(root, ["clean"], new Map(), new Map([["clean", 1]])), [{ role: "clean", result }]);
  }
  for (const result of ["rejected", "refused", "no_change", "changed"] as const) {
    saveRunnerState(root, state("clean", { runs: 1, lastResult: result }));
    assert.deepEqual(onceFailures(root, ["clean"], new Map(), new Map([["clean", 1]])), [], result);
  }
});

const tickRow = (role: string, result: string, tick: number): TickRow =>
  ({ ts: 1_700_000_000_000 + tick, time: "", role, run: tick, result, model: null, durationMs: 1, tokens: 0, costUsd: 0, usage: "", detail: "" });

test("windowSummary counts every tick once by outcome class, with the history table", () => {
  const out = windowSummary("2h", summarizeTickRows([tickRow("clean", "changed", 1), tickRow("clean", "no_change", 2), tickRow("clean", "refused", 3), tickRow("qa", "error", 1)]), true);
  const lines = out.split("\n");
  assert.equal(lines[0], "for 2h: 4 runs — 1 changes, 1 none, 1 refused, 1 problems");
  assert.match(lines[1] ?? "", /^role\s+runs\s+changes\s+none\s+refused\s+problems\s+tokens\s+cost\s+time\s+last change$/);
  assert.deepEqual(lines.slice(2).map((l) => l.split(/\s+/)[0]), ["clean", "qa", "total"]);
});

test("windowSummary says nothing ran for an empty window and notes a sparse one", () => {
  assert.equal(windowSummary("2h", summarizeTickRows([]), true), "for 2h: 0 runs — nothing ran");
  assert.equal(windowSummary("2h", summarizeTickRows([]), false), `for 2h: 0 runs — nothing ran\n${SPARSE_WINDOW_NOTE}`);
  assert.ok(windowSummary("2h", summarizeTickRows([tickRow("a", "changed", 1)]), false).endsWith(SPARSE_WINDOW_NOTE));
});

test("inheritedWindowStart adopts only a positive past integer, else now", () => {
  assert.equal(inheritedWindowStart(undefined, 1000), 1000);
  assert.equal(inheritedWindowStart("abc", 1000), 1000);
  assert.equal(inheritedWindowStart("0", 1000), 1000);
  assert.equal(inheritedWindowStart("2000", 1000), 1000);
  assert.equal(inheritedWindowStart("500", 1000), 500);
});
