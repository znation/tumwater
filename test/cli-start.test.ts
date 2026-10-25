import test from "node:test";
import assert from "node:assert/strict";

import { ONCE_FAILURE_RESULTS, armDeadlineTimer, dashboardChildEnv, guiChildPlan, inheritedWindowStart, onceFailures, onceReport, onceSummary, parseRunWindow, renderOnceSummary, windowReport, windowSummary, type WindowReport } from "../src/cli/cli-start.js";
import { summarizeRunRows, type RunRow } from "../src/history/history-data.js";
import { SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { expectFail, expectOk } from "./helpers/exit-capture.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { pauseTeam } from "../src/team/team-state.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { sleep } from "./helpers/wait.js";

// Unit seam for cli/cli-start-summary.ts's onceSummary — the one-line `tumwater start --once`
// summary a
// cron log keeps. The orchestrator-level behavior (which settle reason a real round hands back,
// deferred included) is pinned end to end by test/orchestrator-once.e2e.test.ts; these tests
// pin the summary's own accounting at unit level: run counting against the pre-round
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
// here the same parse is pinned through the helper cmdStart itself calls) ---

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
// (whose cmdStart would otherwise supervise a second dashboard), and reports whether the
// supervisor should start one. Pinned here so the stripping cannot silently drop.
test("guiChildPlan strips --gui and reports it, leaving other args untouched", () => {
  assert.deepEqual(guiChildPlan(["--gui"]), {
    spawnGui: true,
    spawnTui: false,
    guiArgs: [],
    guiToken: undefined,
    orchestratorArgs: [],
    childStdio: "inherit",
  });
  assert.deepEqual(guiChildPlan(["--branch", "x", "--gui", "--for", "2h"]), {
    spawnGui: true,
    spawnTui: false,
    guiArgs: [],
    guiToken: undefined,
    orchestratorArgs: ["--branch", "x", "--for", "2h"],
    childStdio: "inherit",
  });
  assert.deepEqual(guiChildPlan(["--once", "--role", "clean"]), {
    spawnGui: false,
    spawnTui: false,
    guiArgs: [],
    guiToken: undefined,
    orchestratorArgs: ["--once", "--role", "clean"],
    childStdio: "inherit",
  });
});

// `run --gui --port N`: the port rides on the dashboard child and is stripped from the
// orchestrator generation (whose cmdStart, seeing --port without --gui, would refuse it). A
// mid-line `--port N` disappears entirely while the surrounding args survive.
test("guiChildPlan threads --port onto the dashboard child and strips it from the orchestrator", () => {
  assert.deepEqual(guiChildPlan(["--gui", "--port", "8123"]), {
    spawnGui: true,
    spawnTui: false,
    guiArgs: ["--port", "8123"],
    guiToken: undefined,
    orchestratorArgs: [],
    childStdio: "inherit",
  });
  assert.deepEqual(guiChildPlan(["--branch", "x", "--gui", "--port", "8123", "--for", "2h"]), {
    spawnGui: true,
    spawnTui: false,
    guiArgs: ["--port", "8123"],
    guiToken: undefined,
    orchestratorArgs: ["--branch", "x", "--for", "2h"],
    childStdio: "inherit",
  });
});

// `run --gui` also threads --all-interfaces onto the dashboard child and returns the --token
// secret as `guiToken` (the remaining `tumwater gui` dashboard flags, in the fixed order
// and strips all three from the orchestrator generation (whose cmdStart, seeing any dashboard
// flag without --gui, would refuse it, and whose self-redeploy must never forward a dashboard
// flag it is not serving itself). The secret is returned separately and reaches the child via
// its env — never via guiArgs/argv, which the OS process table exposes to every local user and
// which a child's self-reload re-runs verbatim onto each new generation.
test("guiChildPlan threads --all-interfaces onto the dashboard child, returns --token as guiToken, and strips them from the orchestrator", () => {
  assert.deepEqual(guiChildPlan(["--gui", "--all-interfaces", "--token", "s3cret"]), {
    spawnGui: true,
    spawnTui: false,
    guiArgs: ["--all-interfaces"],
    guiToken: "s3cret",
    orchestratorArgs: [],
    childStdio: "inherit",
  });
  assert.deepEqual(
    guiChildPlan(["--branch", "x", "--gui", "--port", "8123", "--all-interfaces", "--token", "s3cret", "--for", "2h"]),
    {
      spawnGui: true,
      spawnTui: false,
      guiArgs: ["--port", "8123", "--all-interfaces"],
      guiToken: "s3cret",
      orchestratorArgs: ["--branch", "x", "--for", "2h"],
      childStdio: "inherit",
    },
  );
});

// The dashboard-half env wiring that guiChildPlan's `guiToken` feeds (the BUGS-FIXED.md
// dashboard gate-token fix): superviseDashboard builds the child env from the plan's token, so
// a `--gui` gate token must reach the dashboard child under GUI_TOKEN_ENV (`TUMWATER_GUI_TOKEN`)
// — never the child's argv, which `ps` exposes to every local user and which the child's
// self-reload (reexecSelf, env-propagating) re-runs verbatim onto each fresh generation.
// The BUGS-FIXED.md entry flagged this child-env wiring as the one link the suite did not pin;
// this closes it: a rename of GUI_TOKEN_ENV or a token silently slipping off the env fails here.
test("dashboardChildEnv carries a guiToken under GUI_TOKEN_ENV and marks the sponsoring supervisor", () => {
  // With a token: the child is marked with the sponsor's pid and the secret rides only in env.
  assert.deepEqual(dashboardChildEnv("TUMWATER_DASHBOARD_CHILD", "s3cret", 1234), {
    TUMWATER_DASHBOARD_CHILD: "1234",
    TUMWATER_GUI_TOKEN: "s3cret",
  });
  // Without a token the marker is still set (the child's reload watch needs it), but no
  // GUI_TOKEN_ENV — a token-less dashboard reads nothing secret.
  assert.deepEqual(dashboardChildEnv("TUMWATER_DASHBOARD_CHILD", undefined, 5678), {
    TUMWATER_DASHBOARD_CHILD: "5678",
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
    guiArgs: [],
    guiToken: undefined,
    orchestratorArgs: [],
    childStdio: ["ignore", "ignore", "ignore"],
  });
  assert.deepEqual(guiChildPlan(["--gui", "--tui"]), {
    spawnGui: true,
    spawnTui: true,
    guiArgs: [],
    guiToken: undefined,
    orchestratorArgs: [],
    childStdio: ["ignore", "ignore", "ignore"],
  });
  assert.deepEqual(guiChildPlan(["--branch", "x", "--tui", "--for", "2h"]), {
    spawnGui: false,
    spawnTui: true,
    guiArgs: [],
    guiToken: undefined,
    orchestratorArgs: ["--branch", "x", "--for", "2h"],
    childStdio: ["ignore", "ignore", "ignore"],
  });
});

// --- armDeadlineTimer: the deadline timer cmdStart arms for `run --for` ---

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

test("counts the round's runs and buckets them by last result, sorted by key", () => {
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

  // Only the runs this round advanced count: qa had 1 run before, so 2 of its 3 are new.
  assert.equal(line, "once: 5 runs — 1 changed, 1 error, 1 no_change");
});

test("one advanced run reads singular; zero runs read `nothing ran`", () => {
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

test("onceReport returns the structured round facts, and renderOnceSummary matches onceSummary", () => {
  const root = makeRepo();
  // One advanced run per result plus one skipped role: the same seeded shapes the onceSummary
  // tests use — a round of 2 new runs (clean advanced 2, docs 1 of its 2), a skipped role, and
  // a failure — collected into the object a `--once --json` caller parses.
  saveRunnerState(root, state("clean", { runs: 2, lastResult: "changed" }));
  saveRunnerState(root, state("docs", { runs: 2, lastResult: "error" }));
  saveRunnerState(root, state("qa", { runs: 1 }));

  const roles = ["clean", "docs", "qa"];
  const runsBefore = new Map([
    ["clean", 0],
    ["docs", 1],
    ["qa", 1],
  ]);
  const settled = new Map([["qa", "idle"]]);
  const report = onceReport(root, roles, runsBefore, settled);

  assert.equal(report.runs, 3);
  assert.deepEqual(report.outcomes, { changed: 1, error: 1 });
  assert.deepEqual(report.skipped, [{ role: "qa", reason: "idle" }]);
  assert.deepEqual(report.failures, [{ role: "docs", result: "error" }]);
  assert.equal(onceSummary(root, roles, runsBefore, settled), renderOnceSummary(report));
});

test("a role the settle map lacks falls back to state, via the pause marker", () => {
  const root = makeRepo();
  pauseTeam(root);
  saveRunnerState(root, state("clean", { runs: 1 }));

  const line = onceSummary(root, ["clean"], new Map([["clean", 1]]), new Map());

  assert.equal(line, "once: 0 runs — nothing ran, 1 skipped (paused)");
});

test("a role enabled mid-round counts by the round's runs-done map, not its whole history", () => {
  const root = makeRepo();
  // The role joined the runners array after the round's start (live config reload), so it is
  // in neither `roles` nor runsBefore: its persisted runs (5) are not this round's, and
  // only the orchestrator's runs-done map knows it ran exactly one (BUGS.md 2026-09-25).
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
  // A run that advanced the counter without writing lastResult — the field is optional on
  // RunnerState — still counts, bucketed under the same `no_change` key a recorded no-change
  // run uses, rather than dropping out of the counts line.
  saveRunnerState(root, state("clean", { runs: 1 }));

  assert.equal(
    onceSummary(root, ["clean"], new Map([["clean", 0]]), undefined),
    "once: 1 run — 1 no_change",
  );
});

test("a role the round's runs-done map lacks counts zero and settles, not its history", () => {
  const root = makeRepo();
  // The mid-round map is the source of truth for who ran: a role listed in `roles` but
  // absent from it ran zero runs this round — its persisted history (runs 4) must not
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
  // The shape a productive run leaves behind: backoffSeconds 0 with a future nextRunAt —
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
  // A cut-off run waits one interval with backoffSeconds 0 and a future nextRunAt: the
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

test("onceFailures reports roles that ran this round and ended in a failure result", () => {
  const root = makeRepo();
  saveRunnerState(root, state("clean", { runs: 1, lastResult: "error" }));
  assert.deepEqual(onceFailures(root, ["clean"], new Map(), new Map([["clean", 1]])), [{ role: "clean", result: "error" }]);
  assert.deepEqual(onceFailures(root, ["clean"], new Map(), new Map([["clean", 0]])), [], "did not run this round");
  assert.deepEqual(onceFailures(root, ["clean"], new Map([["clean", 0]])), [{ role: "clean", result: "error" }]);
  assert.deepEqual(onceFailures(root, ["clean"], new Map([["clean", 1]])), [], "no new run");
  assert.deepEqual(onceFailures(root, [], new Map(), new Map([["clean", 1]])), [{ role: "clean", result: "error" }], "runs-done-only role");
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

const runRow = (role: string, result: string, run: number): RunRow =>
  ({ ts: 1_700_000_000_000 + run, time: "", role, run: run, result, model: null, durationMs: 1, tokens: 0, costUsd: 0, usage: "", detail: "" });

test("windowSummary counts every run once by outcome class, with the history table", () => {
  const out = windowSummary("2h", summarizeRunRows([runRow("clean", "changed", 1), runRow("clean", "no_change", 2), runRow("clean", "refused", 3), runRow("qa", "error", 1)]), true);
  const lines = out.split("\n");
  assert.equal(lines[0], "for 2h: 4 runs — 1 changes, 1 none, 1 refused, 1 problems");
  assert.match(lines[1] ?? "", /^role\s+runs\s+changes\s+none\s+refused\s+problems\s+tokens\s+cost\s+time\s+last change$/);
  assert.deepEqual(lines.slice(2).map((l) => l.split(/\s+/)[0]), ["clean", "qa", "total"]);
});

test("windowSummary says nothing ran for an empty window and notes a sparse one", () => {
  assert.equal(windowSummary("2h", summarizeRunRows([]), true), "for 2h: 0 runs — nothing ran");
  assert.equal(windowSummary("2h", summarizeRunRows([]), false), `for 2h: 0 runs — nothing ran\n${SPARSE_WINDOW_NOTE}`);
  assert.ok(windowSummary("2h", summarizeRunRows([runRow("a", "changed", 1)]), false).endsWith(SPARSE_WINDOW_NOTE));
});

test("windowReport mirrors windowSummary's rows as one JSON object", () => {
  const summary = summarizeRunRows([runRow("clean", "changed", 1), runRow("qa", "no_change", 2)]);
  const report: WindowReport = windowReport("2h", summary, true);
  assert.deepEqual(report, { window: "2h", covered: true, roles: summary.roles, total: summary.total });
  const sparse: WindowReport = windowReport("2h", summary, false);
  assert.equal(sparse.covered, false);
  assert.deepEqual(sparse.roles, summary.roles);
  assert.deepEqual(sparse.total, summary.total);
  // The JSON contract never appends the prose sparse-window note; covered:false is the fact.
  assert.ok(!JSON.stringify(sparse).includes(SPARSE_WINDOW_NOTE));
});

test("inheritedWindowStart adopts only a positive past integer, else now", () => {
  assert.equal(inheritedWindowStart(undefined, 1000), 1000);
  assert.equal(inheritedWindowStart("abc", 1000), 1000);
  // A spelling Number() would silently coerce (hex, exponent) is not a window start the
  // supervisor ever writes — the plain-decimal rule rejects it as not-an-integer.
  assert.equal(inheritedWindowStart("0x1f0", 1000), 1000);
  assert.equal(inheritedWindowStart("1e3", 1000), 1000);
  assert.equal(inheritedWindowStart("0", 1000), 1000);
  assert.equal(inheritedWindowStart("2000", 1000), 1000);
  assert.equal(inheritedWindowStart("500", 1000), 500);
});
