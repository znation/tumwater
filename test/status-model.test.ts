/** The status-model suite: loopPhase and the per-loop display model, plus the moved
 * workingDetail's tests (the helper now lives in src/ui/tick-progress-model.ts, its suite
 * kept here beside loopPhase's, which consumes it). Split
 * out of status-render.test.ts, whose name promised the rendered table but also carried this
 * whole suite — src/ui/status-model.ts now has its tests under its own name and its own
 * fixture imports (shared builders live in status-fixtures.ts). The header badges travel
 * with their module in test/badges.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { backdate } from "./backdate.js";
import { parseProgress, stalledToolLabel } from "../src/ui/progress-data.js";
import { isActivePhase, loopPhase, loopRank, loopRowCells, sortLoopsByState } from "../src/ui/status-model.js";
import { workingDetail } from "../src/ui/tick-progress-model.js";
import { fleetAlerts } from "../src/ui/fleet-alerts.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { tmpdir } from "./repo-fixtures.js";
import { assistantLine } from "./pi-events.js";
import { GATE_SESSION, SESSION, snapshotWith, toolStart, writePiLog } from "./status-fixtures.js";

test("workingDetail without a pi log shows only the elapsed time", () => {
  const root = tmpdir();
  assert.equal(workingDetail(root, freshLoopState("clean")), "working");
  const s = freshLoopState("clean");
  s.lastTickStartedAt = Date.now() - 90_000;
  // ±1s of drift between setting the timestamp and formatting it.
  assert.match(workingDetail(root, s), /^working 1m(29|30|31)s$/);
});

test("workingDetail folds live progress into turn, context, and last tool", () => {
  const root = tmpdir();
  writePiLog(root, "clean", [
    SESSION,
    assistantLine("looking around", { tokens: 4015 }),
    toolStart("read", { path: "/deep/dir/README.md" }),
    assistantLine("now the tests", { tokens: 22_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshLoopState("clean");
  s.lastTickStartedAt = Date.now() - 5_000;
  const detail = workingDetail(root, s);
  assert.match(detail, /^working \ds · /, `unexpected shape: ${detail}`);
  assert.ok(detail.includes("turn 3"), "two completed turns means the third is in flight");
  assert.ok(detail.includes("ctx 22.0k"), "latest context size compact-formatted");
  assert.ok(detail.endsWith("bash npm test"), "most recent tool call last");
});

test("workingDetail omits the ctx part when no tokens are known yet", () => {
  const root = tmpdir();
  writePiLog(root, "clean", [SESSION, assistantLine("starting")]); // no usage
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /ctx/);
});

test("workingDetail flags a stalled run only after at least five minutes of silence", () => {
  const root = tmpdir();
  const file = writePiLog(root, "clean", [SESSION, assistantLine("hanging", { tokens: 100 })]);
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /no pi output/);
  // Four minutes of silence is still below the five-minute threshold.
  backdate(file, 4 * 60_000);
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /no pi output/);
  // Six minutes of silence crosses it.
  backdate(file, 6 * 60_000);
  assert.match(workingDetail(root, freshLoopState("clean")), /no pi output for 6m/);
});

test("a tick's baseline check shows no previous run's detail and no false quiet alarm", () => {
  const root = tmpdir();
  // The log's newest write is the PREVIOUS run's: 29 minutes old — past the five-minute
  // stall threshold — carrying that run's turn count, context, and last tool call.
  const file = writePiLog(root, "clean", [
    SESSION,
    assistantLine("the earlier tick's work", { tokens: 44_200 }),
    toolStart("read", { path: "src/change/change-render.ts" }),
  ]);
  backdate(file, 29 * 60_000);
  // A new tick started 99s ago and is still in its baseline check: pi has written nothing yet.
  const s = freshLoopState("clean");
  s.running = true;
  s.lastTickStartedAt = Date.now() - 99_000;
  // The cell carries nothing of the earlier run — and no quiet time measured from before the
  // tick started, which fleetAlerts' STALL pattern would read as "looks stuck".
  assert.equal(workingDetail(root, s), "working 1m39s");
  // The same rule drives the phase string the alert pattern-matches (and the GUI payload reads).
  assert.equal(loopPhase(s, true, root), "working 1m39s");
  // Once this tick's pi run writes its first line, the live detail returns.
  fs.appendFileSync(file, SESSION + "\n" + assistantLine("this tick's first words", { tokens: 4_100 }) + "\n");
  assert.match(workingDetail(root, s), /^working 1m(39|40|41)s · turn 2 · ctx 4100$/, workingDetail(root, s));
});

test("a quiet tail predating the tick never reaches the token metrics either", async () => {
  const repo = tmpdir();
  // Same shape as the payload's combined-metrics fixture: persisted totals from completed
  // ticks plus a live tail. Here the tail is the PREVIOUS run's (29 minutes old) and the
  // new tick's baseline is still running — the previous run's output must not ride into
  // this tick's `generated` figure a second time.
  const file = writePiLog(repo, "feature", [
    SESSION,
    assistantLine("the earlier run", { tokens: 12_000, output: 800 }),
  ]);
  backdate(file, 29 * 60_000);
  const s = freshLoopState("feature");
  s.generatedTokens = 1_000;
  s.peakContextTokens = 6_000;
  s.running = true;
  s.lastTickStartedAt = Date.now() - 99_000;
  const snap = snapshotWith([{ role: "feature", running: true, lastTickStartedAt: s.lastTickStartedAt }]);
  snap.running = true; // the orchestrator is up, so loopRowCells renders the live phase
  const cells = loopRowCells(snap, repo, s);
  assert.equal(cells.generated, 1_000, "only the persisted total — the stale tail contributes nothing");
  assert.equal(cells.peakCtx, 6_000);
  assert.equal(cells.phase, "working 1m39s");
});

// The stall flag (BUGS.md 2026-09-13 sibling): a tool call open and silent past the threshold
// names itself in the state cell — the same rule as runPi's warning event.

test("workingDetail names a stalled tool call in the state cell", () => {
  const root = tmpdir();
  const s = freshLoopState("clean");
  s.lastTickStartedAt = Date.now() - 5_000;
  // A hand-built live tail (what readLiveProgress returns) with one open call backdated past
  // the five-minute stall threshold.
  const p = parseProgress([SESSION, toolStart("bash", { command: "find / -name x" })], 0);
  assert.equal(p.stalledTool, undefined, "a freshly fed call is not stalled");
  const call = p.openToolCalls?.[0];
  assert.ok(call, "the open call is tracked");
  call.lastActivityAt -= 301_000;
  p.stalledTool = stalledToolLabel(p.openToolCalls); // what readLiveProgress recomputes per read
  const detail = workingDetail(root, s, p);
  assert.ok(detail.includes("tool call stalled: bash find / -name x"), `unexpected shape: ${detail}`);
  assert.equal(
    detail.split("find / -name x").length - 1,
    1,
    "the command appears once — the flag takes lastTool's slot, not alongside it",
  );
});

test("workingDetail does not flag a fresh tool call as stalled", () => {
  const root = tmpdir();
  writePiLog(root, "clean", [SESSION, assistantLine("starting"), toolStart("bash", { command: "npm test" })]);
  const s = freshLoopState("clean");
  s.lastTickStartedAt = Date.now() - 5_000;
  const detail = workingDetail(root, s);
  assert.ok(detail.endsWith("bash npm test"), `unexpected shape: ${detail}`);
  assert.doesNotMatch(detail, /tool call stalled/);
});

test("loopPhase surfaces the live detail only while a tick is in flight", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  const s = freshLoopState("feature");
  assert.equal(loopPhase(s, true), "queued", "idle loop is not working");
  s.running = true;
  s.lastTickStartedAt = Date.now() - 5_000;
  assert.match(loopPhase(s, true, root), /^working \ds · turn 2/);
});

test("loopPhase live detail degrades to plain working when the tick has no start time", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  const s = freshLoopState("feature");
  s.running = true;
  assert.equal(loopPhase(s, true, root), "working · turn 2 · ctx 3000");
});

test("loopPhase shows the review gate label without a log to read from", () => {
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review";
  s.lastTickStartedAt = Date.now() - 90_000;
  // ±1s of drift between setting the timestamp and formatting it.
  assert.match(loopPhase(s, true), /^reviewing 1m(29|30|31)s$/);

  const bare = freshLoopState("feature");
  bare.running = true;
  bare.phase = "review";
  assert.equal(loopPhase(bare, true), "reviewing"); // no start time: nothing to show elapsed for
});

test("loopPhase shows the reviewer run's live detail while a tick is under review", () => {
  const root = tmpdir();
  // The reviewer writes to the same per-role raw log, starting a fresh session IN THE ROLE'S
  // LANDER WORKTREE (its session event's cwd names it) — so the gate accumulator, not the
  // author's, carries the reviewer's progress (BUGS.md 2026-09-22).
  writePiLog(root, "feature", [
    GATE_SESSION(root, "feature"),
    assistantLine("reviewing the diff", { tokens: 22_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review";
  s.lastTickStartedAt = Date.now() - 5_000;
  const phase = loopPhase(s, true, root);
  assert.match(phase, /^reviewing \ds · /, `unexpected shape: ${phase}`);
  assert.ok(phase.includes("turn 2"), "one completed reviewer turn means the second is in flight");
  assert.ok(phase.includes("ctx 22.0k"), "latest context size compact-formatted");
  assert.ok(phase.endsWith("bash npm test"), "most recent tool call last");
});

test("loopPhase flags a stalled reviewer run after five minutes of silence", () => {
  const root = tmpdir();
  const file = writePiLog(root, "feature", [SESSION, assistantLine("reviewing", { tokens: 100 })]);
  backdate(file, 6 * 60_000);
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review";
  assert.match(loopPhase(s, true, root), /no pi output for 6m/);
});

// duration()'s hours bucket (>= 1h): every elapsed fixture above stays under an hour, so the
// `XhYm` branch — what operators actually see for long ticks and long silences in the status
// table, TUI, and GUI — was untested. The review-gate label is the purest read of it (no log
// tail involved); the stall flag covers its second call site.

test("elapsed labels bucket into hours once a tick passes an hour", () => {
  const reviewing = (msAgo: number): string => {
    const s = freshLoopState("feature");
    s.running = true;
    s.phase = "review";
    s.lastTickStartedAt = Date.now() - msAgo;
    return loopPhase(s, true);
  };

  // Two and a half hours in: floor to whole hours, minutes rounded — not 150m.
  assert.match(reviewing((2 * 3600 + 30 * 60) * 1000), /^reviewing 2h30m$/);

  // The bucket boundary: ten seconds under an hour stays in the minutes branch (59m5Xs),
  // and at exactly an hour the label switches to hours with zero minutes.
  assert.match(reviewing((3600 - 10) * 1000), /^reviewing 59m(49|50|51)s$/);
  assert.match(reviewing(3600 * 1000), /^reviewing 1h0m$/);
});

test("workingDetail's stall flag uses the hours bucket for long silences", () => {
  const root = tmpdir();
  const file = writePiLog(root, "clean", [SESSION, assistantLine("hanging", { tokens: 100 })]);
  // Ninety minutes without pi output: the stall part must read 1h30m, not 90m.
  backdate(file, 5400_000);
  assert.match(workingDetail(root, freshLoopState("clean")), /no pi output for 1h30m/);
});

test("loopPhase reads budget paused for idle role loops while the cap is reached", () => {
  const s = freshLoopState("feature");
  // Not paused: ordinary phase labels are untouched.
  assert.equal(loopPhase(s, true, undefined, false), "queued");
  // Paused: an idle role loop shows why it isn't ticking — ahead of its sleep/queue state.
  assert.equal(loopPhase(s, true, undefined, true), "budget paused");

  // A sleeping loop is paused too (the cap holds it past nextRunAt).
  const sleeping = freshLoopState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(loopPhase(sleeping, true, undefined, false), "sleeping (for 1h)");
  assert.equal(loopPhase(sleeping, true, undefined, true), "budget paused");

  // The director is exempt from the cap: its phase never changes.
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true, undefined, true), "waiting for prompts");

  // In-flight ticks finish even while paused — only NEW ticks are blocked.
  const running = freshLoopState("feature");
  running.running = true;
  assert.equal(loopPhase(running, true, undefined, true), "working");

  // A stopped orchestrator still reads stopped (nothing is ticking at all).
  assert.equal(loopPhase(s, false, undefined, true), "stopped");
});

test("loopPhase reads cap paused for idle role loops held by their own per-role cap", () => {
  const s = freshLoopState("feature");
  // Not held: ordinary phase labels are untouched.
  assert.equal(loopPhase(s, true, undefined, false, null, false, undefined, undefined, false), "queued");
  // Held by its own cap: the label names the specific spend state, ahead of its sleep/queue
  // state and ahead of the fleet's budget pause (which is the less specific one).
  assert.equal(loopPhase(s, true, undefined, false, null, false, undefined, undefined, true), "cap paused");
  assert.equal(loopPhase(s, true, undefined, true, null, false, undefined, undefined, true), "cap paused");

  // User intent still wins: an operator-paused loop reads `paused` even while over its cap.
  assert.equal(loopPhase(s, true, undefined, false, null, true, undefined, undefined, true), "paused");

  // A sleeping loop is cap-paused too (the cap holds it past nextRunAt).
  const sleeping = freshLoopState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(loopPhase(sleeping, true, undefined, false, null, false, undefined, undefined, true), "cap paused");

  // The director is exempt from the cap, like the scheduler's gate: its phase never changes.
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true, undefined, false, null, false, undefined, undefined, true), "waiting for prompts");

  // In-flight ticks finish even while held — only NEW ticks are blocked.
  const running = freshLoopState("feature");
  running.running = true;
  assert.equal(loopPhase(running, true, undefined, false, null, false, undefined, undefined, true), "working");

  // The held loop groups with the other paused states in the shared rank.
  assert.equal(loopRank("cap paused"), 3);
});

test("loopPhase shows main red for idle loops whose last tick was blocked by a red main", () => {
  // Blocked: the label explains why the loop keeps waking and landing nothing — ahead of its
  // sleep/queue state, like budget paused.
  const s = freshLoopState("feature");
  s.lastResult = "main_red";
  assert.equal(loopPhase(s, true), "main red", "queued loop shows the blockage");
  s.nextRunAt = Date.now() + 3_600_000;
  assert.equal(loopPhase(s, true), "main red", "sleeping loop shows the blockage too");

  // Other results keep their ordinary labels; a green wake overwrites lastResult and self-corrects.
  const other = freshLoopState("feature");
  other.lastResult = "no_change";
  assert.equal(loopPhase(other, true), "queued");

  // In-flight ticks are untouched (the label describes the finished tick only).
  const running = freshLoopState("feature");
  running.running = true;
  running.lastResult = "main_red";
  assert.equal(loopPhase(running, true), "working");

  // A stopped orchestrator still reads stopped.
  assert.equal(loopPhase(s, false), "stopped");
});

// BUGS.md 2026-09-30 — a main_red verdict outlived main's recovery: the phase came from the
// loop's own last tick result and nothing compared it with main's newer green check, so the
// GUI raised "main is red — 1 loop is blocked" while the sidebar read "Main green". Main's
// newest merge-scope check (mainCheck) is fresher fleet-level evidence; only a PASSED one
// stamped after the red tick ended retires the label.
test("loopPhase retires a stale main red when main's newest check passed after it", () => {
  const s = freshLoopState("feature");
  s.lastResult = "main_red";
  s.lastTickEndedAt = Date.now() - 300_000; // the red tick ended 5m ago
  s.nextRunAt = Date.now() + 3_600_000; // and its next tick is an hour away
  // A green merge-scope check landed AFTER the red tick: main is green now, so the label
  // falls through to the ordinary sleep state and the banner never raises.
  assert.match(
    loopPhase(s, true, undefined, false, undefined, false, undefined, { status: "passed", at: Date.now() - 60_000 }),
    /^sleeping/,
    "a newer passed check is fresher evidence than the loop's own red",
  );
  // A passed check from BEFORE the red tick says nothing about main now.
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, undefined, { status: "passed", at: Date.now() - 600_000 }),
    "main red",
    "a check older than the red tick keeps the blockage",
  );
  // A newer failed check means main is genuinely still red.
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, undefined, { status: "failed", at: Date.now() - 60_000 }),
    "main red",
  );
  // A skipped check is not green evidence either.
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, undefined, { status: "skipped", at: Date.now() - 60_000 }),
    "main red",
  );
  // No recorded tick end: the comparison cannot be made, so the blockage stands.
  const undated = freshLoopState("feature");
  undated.lastResult = "main_red";
  assert.equal(
    loopPhase(undated, true, undefined, false, undefined, false, undefined, { status: "passed", at: Date.now() }),
    "main red",
    "no tick end keeps the blockage (conservative)",
  );
  // Without a mainCheck at all the old behavior stands (direct callers, hand-built states).
  assert.equal(loopPhase(s, true), "main red");
});

// The same staleness through the single-homed row derivation and the alert it feeds: the
// banner (fleetAlerts) reads the rendered phase, so a retired phase must raise no mainred.
test("loopRowCells retires the stale main red and fleetAlerts raises no banner for it", () => {
  const s = freshLoopState("feature");
  s.lastResult = "main_red";
  s.lastTickEndedAt = Date.now() - 300_000;
  const snap = snapshotWith([{ role: "feature", lastResult: "main_red", lastTickEndedAt: s.lastTickEndedAt }]);
  snap.running = true;
  snap.mainCheck = { status: "passed", at: Date.now() - 60_000 };
  const cells = loopRowCells(snap, tmpdir(), s);
  assert.notEqual(cells.phase, "main red", "the row derivation sees the snapshot's newer green check");
  assert.equal(
    fleetAlerts(snap, [], [{ role: "feature", phase: cells.phase, inFlight: false }], Date.now())
      .some((a) => a.key === "mainred"),
    false,
    "no 'main is red' banner for a loop whose blockage main has already recovered from",
  );
  // And the banner still raises while the phase genuinely reads main red (an older check).
  snap.mainCheck = { status: "passed", at: Date.now() - 600_000 };
  const stale = loopRowCells(snap, tmpdir(), s).phase;
  assert.equal(stale, "main red");
  assert.ok(
    fleetAlerts(snap, [], [{ role: "feature", phase: stale, inFlight: false }], Date.now())
      .some((a) => a.key === "mainred"),
  );
});

test("loopPhase shows failing for a quiet-kill streak at the give-up threshold", () => {
  // BUGS.md 2026-09-18: a loop stuck retrying a session the backend will not schedule looked
  // exactly like a sleeping loop while it burned an hour of slot time per tick.
  const s = freshLoopState("feature");
  s.lastResult = "quiet_killed";
  s.quietKillStreak = 3;
  s.nextRunAt = Date.now() + 1_800_000;
  assert.equal(loopPhase(s, true), "failing", "the streak at the threshold outranks sleep");

  // Below the threshold the loop keeps its ordinary label — a couple of transients are
  // retryable, not a health state.
  const shallow = freshLoopState("feature");
  shallow.lastResult = "quiet_killed";
  shallow.quietKillStreak = 2;
  shallow.nextRunAt = Date.now() + 1_800_000;
  assert.match(loopPhase(shallow, true), /^sleeping/);
});

// The operator pause (PLANS.md, fleet-pause plan): while the `tumwater pause` marker exists,
// every idle role loop's state cell reads `paused` — after the director exemption and ahead
// of budget paused / main red, because user intent is the most specific reason: it tells the
// operator what to do (`resume`).

test("loopPhase reads paused for idle role loops while the fleet is user-paused", () => {
  const s = freshLoopState("feature");
  // Not paused (the flag defaults off): ordinary phase labels are untouched.
  assert.equal(loopPhase(s, true), "queued");
  // Paused: an idle role loop shows why it isn't ticking — ahead of its sleep/queue state.
  assert.equal(loopPhase(s, true, undefined, false, undefined, true), "paused");

  // A sleeping loop is paused too (the marker holds it past nextRunAt).
  const sleeping = freshLoopState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(loopPhase(sleeping, true), "sleeping (for 1h)");
  assert.equal(loopPhase(sleeping, true, undefined, false, undefined, true), "paused");

  // The director is exempt from the operator pause: its phase never changes.
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true, undefined, false, undefined, true), "waiting for prompts");

  // In-flight ticks finish even while paused — only NEW ticks are blocked, so a running loop
  // keeps its live detail instead of reading `paused`.
  const running = freshLoopState("feature");
  running.running = true;
  assert.equal(loopPhase(running, true, undefined, false, undefined, true), "working");

  // A stopped orchestrator still reads stopped (nothing is ticking at all).
  assert.equal(loopPhase(s, false, undefined, false, undefined, true), "stopped");
});

test("loopPhase prefers paused over budget paused and main red", () => {
  const s = freshLoopState("feature");
  // All three hold: the user pause wins — while both gates block, `paused` names the fix.
  s.lastResult = "main_red";
  assert.equal(loopPhase(s, true, undefined, true, undefined, true), "paused");

  // User-paused + main-red without budget reads paused too.
  const red = freshLoopState("feature");
  red.lastResult = "main_red";
  assert.equal(loopPhase(red, true, undefined, false, undefined, true), "paused");

  // Without the user pause the other labels keep their own precedence (budget before main red).
  assert.equal(loopPhase(s, true, undefined, true), "budget paused");
});

// The landing cell (BUGS.md 2026-09-22, re-opened 2026-09-23): the marker's stage scopes the
// cell to the phase the landing is in. This used to pin a bare `landing <elapsed>` as the
// correct output for every landing — the featureless countdown the bug is about.
test("loopPhase renders the landing cell ahead of every idle state, only when the record is passed", () => {
  const s = freshLoopState("clean");
  s.nextRunAt = Date.now() + 90_000; // would read "sleeping (for 2m)" without the record
  const startedAt = Date.now() - 90_000; // 90s of landing → "1m30s"
  // The record wins over the idle state…
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, { status: "landing", startedAt, stage: "merging" }),
    "landing 1m30s · merging",
  );
  // …and it is the caller's job to pass it only for the landing role: without it the loop
  // keeps its ordinary state (the "other roles" case — the record is filtered upstream).
  assert.match(loopPhase(s, true), /^sleeping \(for 2m\)$/);
  // A stopped harness never shows it — a dead fleet's marker is stale by definition.
  assert.equal(loopPhase(s, false, undefined, false, undefined, false, { status: "landing", startedAt, stage: "merging" }), "stopped");
  // Only a record with no stage at all — an older writer's marker mid-upgrade — keeps the
  // bare elapsed label: there is nothing more it can honestly say.
  assert.equal(loopPhase(s, true, undefined, false, undefined, false, { status: "landing", startedAt }), "landing 1m30s");
  // A change the vetting stage approved waits for the merge slot: it reads that state instead —
  // no elapsed and no stage, because nothing of its own is running (BUGS.md 2026-09-23).
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, { status: "vetted", startedAt, stage: "merging" }),
    "vetted, awaiting merge",
  );
});

test("the build-check and merging landing stages render their label and never read the log", () => {
  const root = tmpdir();
  // The log's newest run is a FINISHED reviewer (a previous landing's), silent for ten
  // minutes: read during a stage with no live pi run, it would show stale turns/context and
  // a false `no pi output` flag counted against a run that ended long ago.
  const file = writePiLog(root, "clean", [
    GATE_SESSION(root, "clean"),
    assistantLine("an old review", { tokens: 40_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  backdate(file, 10 * 60_000);
  const s = freshLoopState("clean");
  const startedAt = Date.now() - 90_000;
  for (const [stage, label] of [
    ["rebasing", "rebasing"],
    ["check-wait", "waiting for a check slot"],
    ["build-check", "build check"],
    ["merging", "merging"],
  ] as const) {
    const phase = loopPhase(s, true, root, false, null, false, { status: "landing", startedAt, stage });
    assert.match(phase, new RegExp(`^landing 1m3[01]s · ${label}$`), `${stage}: ${phase}`);
  }
});

test("the reviewing landing stage carries the reviewer run's live detail, timed from the landing", () => {
  const root = tmpdir();
  // The landing's reviewer writes the role's own raw log from its lander worktree — the gate
  // accumulator, exactly what a reviewing tick's cell reads (BUGS.md 2026-09-22).
  writePiLog(root, "clean", [
    SESSION, // the authoring tick's finished run
    assistantLine("the author's work", { tokens: 9_000 }),
    JSON.stringify({ type: "tumwater_run", label: "review" }),
    GATE_SESSION(root, "clean"),
    assistantLine("reviewing the diff", { tokens: 22_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshLoopState("clean");
  // The authoring tick started an hour ago; the cell's elapsed is the LANDING's (90s), and
  // the frame's `live` for a non-running loop is null — the branch reads the gate itself.
  s.lastTickStartedAt = Date.now() - 3_600_000;
  const phase = loopPhase(s, true, root, false, null, false, { status: "landing", startedAt: Date.now() - 90_000, stage: "reviewing" });
  assert.match(phase, /^landing 1m3[01]s · reviewing · turn 2 · ctx 22\.0k · bash npm test$/, `unexpected shape: ${phase}`);

  // No log to read (or no root): the honest stage label alone.
  const bare = loopPhase(s, true, undefined, false, null, false, { status: "landing", startedAt: Date.now() - 90_000, stage: "reviewing" });
  assert.equal(bare, "landing 1m30s · reviewing");
});

test("a landing cell with no recorded start renders the bare `landing` head", () => {
  // A change record from an older writer can carry no startedAt (the marker shape allows it):
  // no honest elapsed exists, so the head degrades to the bare label — staged or not.
  const s = freshLoopState("feature");
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, { status: "landing", startedAt: undefined, stage: "merging" }),
    "landing · merging",
  );
  assert.equal(
    loopPhase(s, true, undefined, false, undefined, false, { status: "landing", startedAt: undefined }),
    "landing",
  );
});

test("a new landing's reviewing cell starts at its run's label line, not at the previous review's counts", () => {
  const root = tmpdir();
  // A previous review ran to completion; the next landing's reviewer has only written its
  // label line so far (runPi writes it before pi spawns). The stage already says reviewing.
  writePiLog(root, "clean", [
    JSON.stringify({ type: "tumwater_run", label: "review" }),
    GATE_SESSION(root, "clean"),
    assistantLine("the previous review", { tokens: 50_000 }),
    assistantLine("VERDICT: approve", { tokens: 51_000 }),
    toolStart("read", { path: "src/old.ts" }),
    JSON.stringify({ type: "tumwater_run", label: "review" }),
  ]);
  const phase = loopPhase(freshLoopState("clean"), true, root, false, null, false, {
    status: "landing",
    startedAt: Date.now() - 5_000,
    stage: "reviewing",
  });
  assert.match(phase, /^landing \ds · reviewing · turn 1$/, `the previous review bled through: ${phase}`);
});

test("loopPhase describes each loop state", () => {
  const s = freshLoopState("clean");
  assert.equal(loopPhase(s, false), "stopped");
  assert.equal(loopPhase(s, true), "queued");
  s.running = true;
  assert.equal(loopPhase(s, true), "working");
  s.running = false;
  s.nextRunAt = Date.now() + 90_000;
  // Sleeping is a present state: the label shows the remaining duration ("for …"),
  // not a future start ("in …"). 90s buckets to "2m" in humanSeconds.
  assert.match(loopPhase(s, true), /^sleeping \(for 2m\)$/);
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true), "waiting for prompts");
});


// BUGS.md 2026-09-24 — the display must mirror the concurrency cap: a tick parked in the
// semaphore queue holds no permit, so it renders its true state (`awaiting slot`) and stays
// out of the active set an operator counts against maxConcurrent.
test("a parked waiter renders `awaiting slot` and stays out of the active set", () => {
  const s = freshLoopState("clean");
  s.running = true;
  s.parkedSince = Date.now() - 5_000;
  assert.match(loopPhase(s, true), /^awaiting slot 5s$/);
  // Permit granted (the orchestrator clears parkedSince at acquire): the same loop becomes
  // an active, permit-holding working tick again.
  s.parkedSince = undefined;
  assert.equal(loopPhase(s, true), "working");
  // The parked label is not an active phase: sortLoopsByState puts it behind the working and
  // landing rows, so active-row counting never includes a waiter.
  const sorted = sortLoopsByState([
    { role: "clean", phase: "awaiting slot 5s" },
    { role: "feature", phase: "working 5s" },
    { role: "bugfix", phase: "landing 5s" },
  ]);
  assert.deepEqual(sorted.map((r) => r.role), ["bugfix", "feature", "clean"]);
});

// BUGS.md 2026-10-06 — the director bypasses maxConcurrent (`usesSlot` is false for it), so a
// running director must not render as a permit-holder `working` row or inflate the active set
// an operator counts against the cap. It gets a phase of its own that isActivePhase excludes,
// ranks ahead of the permit holders (rank -1), and keeps its live work visible.
test("a running director renders its own phase, outside the cap's active set", () => {
  const d = freshLoopState("director");
  d.running = true;
  assert.equal(loopPhase(d, true), "director working");
  assert.equal(loopPhase(freshLoopState("director"), true), "waiting for prompts", "an idle director keeps its exempt label");
  const root = tmpdir();
  d.lastTickStartedAt = Date.now() - 90_000;
  assert.match(loopPhase(d, true, root), /^director working 1m(29|30|31)s$/);
  // Its own label is not a permit-holder phase: the active set against the cap is permit holders.
  assert.equal(isActivePhase(loopPhase(d, true)), false);
  assert.equal(isActivePhase("working 5s"), true);
  assert.equal(isActivePhase("landing 5s"), true);
  // It ranks and sorts ahead of the permit holders (rank -1), so its work stays visible.
  assert.equal(loopRank("director working 1m"), -1);
  assert.equal(loopRank("working 5s"), 0);
  const sorted = sortLoopsByState([
    { role: "clean", phase: "queued" },
    { role: "director", phase: "director working 1m" },
    { role: "feature", phase: "working 5s" },
  ]);
  assert.deepEqual(sorted.map((r) => r.role), ["director", "feature", "clean"]);
});

// The inFlight flag excludes the running director, so the stuck alert must accept its own
// running phase too, or a stalled director would go unalerted (BUGS.md 2026-10-06).
test("a stalled running director still raises the stuck alert", () => {
  const snap = snapshotWith([{ role: "director" }]);
  const stalled = [{ role: "director", phase: "director working 6m · tool call stalled: bash find /", inFlight: false }];
  assert.ok(
    fleetAlerts(snap, [], stalled, Date.now()).some((a) => a.key === "stuck"),
    "a stalled director is stuck even though it holds no permit",
  );
  const idle = [{ role: "director", phase: "waiting for prompts", inFlight: false }];
  assert.equal(
    fleetAlerts(snap, [], idle, Date.now()).some((a) => a.key === "stuck"),
    false,
    "an idle director raises nothing",
  );
});

// Per-role quiet hours (PLANS.md quietHoursPerRole): an idle loop inside its own window
// reads the fleet gate's own quiet wording, scoped to its window — `quiet until <end>`.
test("loopPhase reads quiet until <end> for idle loops held by their own quietHoursPerRole window", () => {
  const s = freshLoopState("feature");
  // Not held: ordinary phase labels are untouched.
  assert.equal(loopPhase(s, true, undefined, false, null, false, undefined, undefined, false), "queued");
  // Held by its own wrapping window: the fleet badge's wording with the loop's own end.
  assert.equal(
    loopPhase(s, true, undefined, false, null, false, undefined, undefined, false, "23:00-07:00"),
    "quiet until 07:00",
  );
  // The loop's own schedule is more specific than the fleet's budget pause.
  assert.equal(
    loopPhase(s, true, undefined, true, null, false, undefined, undefined, false, "23:00-07:00"),
    "quiet until 07:00",
  );
  // User intent still wins: an operator-paused loop reads `paused` even inside its window.
  assert.equal(
    loopPhase(s, true, undefined, false, null, true, undefined, undefined, false, "23:00-07:00"),
    "paused",
  );
  // In-flight ticks finish even while held — only NEW ticks are blocked.
  const running = freshLoopState("feature");
  running.running = true;
  assert.equal(
    loopPhase(running, true, undefined, false, null, false, undefined, undefined, false, "23:00-07:00"),
    "working",
  );
});
