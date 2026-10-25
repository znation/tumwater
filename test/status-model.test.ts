/** The status-model suite: rolePhase and the per-role display model, plus the moved
 * workingDetail's tests (the helper now lives in src/ui/run-progress-model.ts, its suite
 * kept here beside rolePhase's, which consumes it). Split
 * out of status-render.test.ts, whose name promised the rendered table but also carried this
 * whole suite — src/ui/status-model.ts now has its tests under its own name and its own
 * fixture imports (shared builders live in status-fixtures.ts). The header badges travel
 * with their module in test/badges.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { backdate } from "./helpers/backdate.js";
import { parseProgress, stalledToolLabel } from "../src/ui/progress-data.js";
import {
  idleClaimText,
  isActivePhase,
  rolePhase,
  roleRank,
  roleRowCells,
  ROLE_RANK_RULES,
  sortRolesByState,
} from "../src/ui/status-model.js";
import { phaseTone } from "../src/ui/tone.js";
import { workingDetail } from "../src/ui/run-progress-model.js";
import { teamAlerts } from "../src/ui/team-alerts.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { GATE_SESSION, SESSION, snapshotWith, toolStart, writePiLog } from "./fixtures/status-fixtures.js";

test("a parked waiter names its provider key when that key is the binding limit", () => {
  const root = tmpdir();
  const s = freshRunnerState("clean");
  s.running = true;
  s.parkedSince = Date.now() - 120_000;
  s.parkedOn = "omlx";
  const permits = {
    inUse: 5,
    limit: 8,
    reserve: 0,
    byKey: { omlx: { inUse: 3, limit: 3, waiting: 1 }, claude: { inUse: 1, limit: 6, waiting: 0 } },
  };
  const phase = (s2: typeof s) =>
    rolePhase(s2, true, root, false, null, false, null, undefined, false, undefined, false, false, undefined, permits);
  // omlx is at its cap (inUse 3 == limit 3): the parked waiter is queued on it.
  assert.match(phase(s), /^waiting for omlx 2m/);
  // Parked on a key under its cap (claude 1/6) is a team-total wait: bare `waiting to start`.
  s.parkedOn = "claude";
  assert.match(phase(s), /^waiting to start 2m/);
  // No permit snapshot published: bare `waiting to start` regardless of parkedOn.
  s.parkedOn = "omlx";
  assert.match(rolePhase(s, true), /^waiting to start 2m/);
});

test("workingDetail without a pi log shows only the elapsed time", () => {
  const root = tmpdir();
  assert.equal(workingDetail(root, freshRunnerState("clean")), "working");
  const s = freshRunnerState("clean");
  s.lastRunStartedAt = Date.now() - 90_000;
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
  const s = freshRunnerState("clean");
  s.lastRunStartedAt = Date.now() - 5_000;
  const detail = workingDetail(root, s);
  assert.match(detail, /^working \ds · /, `unexpected shape: ${detail}`);
  assert.ok(detail.includes("turn 3"), "two completed turns means the third is in flight");
  assert.ok(detail.includes("ctx 22.0k"), "latest context size compact-formatted");
  assert.ok(detail.endsWith("bash npm test"), "most recent tool call last");
});

test("workingDetail omits the ctx part when no tokens are known yet", () => {
  const root = tmpdir();
  writePiLog(root, "clean", [SESSION, assistantLine("starting")]); // no usage
  assert.doesNotMatch(workingDetail(root, freshRunnerState("clean")), /ctx/);
});

test("workingDetail flags a stalled run only after at least five minutes of silence", () => {
  const root = tmpdir();
  const file = writePiLog(root, "clean", [SESSION, assistantLine("hanging", { tokens: 100 })]);
  assert.doesNotMatch(workingDetail(root, freshRunnerState("clean")), /no pi output/);
  // Four minutes of silence is still below the five-minute threshold.
  backdate(file, 4 * 60_000);
  assert.doesNotMatch(workingDetail(root, freshRunnerState("clean")), /no pi output/);
  // Six minutes of silence crosses it.
  backdate(file, 6 * 60_000);
  assert.match(workingDetail(root, freshRunnerState("clean")), /no agent output for 6m/);
});

test("a run's baseline check shows no previous run's detail and no false quiet alarm", () => {
  const root = tmpdir();
  // The log's newest write is the PREVIOUS run's: 29 minutes old — past the five-minute
  // stall threshold — carrying that run's turn count, context, and last tool call.
  const file = writePiLog(root, "clean", [
    SESSION,
    assistantLine("the earlier run's work", { tokens: 44_200 }),
    toolStart("read", { path: "src/change/change-render.ts" }),
  ]);
  backdate(file, 29 * 60_000);
  // A new run started 99s ago and is still in its baseline check: pi has written nothing yet.
  const s = freshRunnerState("clean");
  s.running = true;
  s.lastRunStartedAt = Date.now() - 99_000;
  // The cell carries nothing of the earlier run — and no quiet time measured from before the
  // run started, which teamAlerts' STALL pattern would read as "looks stuck".
  assert.equal(workingDetail(root, s), "working 1m39s");
  // The same rule drives the phase string the alert pattern-matches (and the GUI payload reads).
  assert.equal(rolePhase(s, true, root), "working 1m39s");
  // Once the current agent run writes its first line, the live detail returns.
  fs.appendFileSync(file, SESSION + "\n" + assistantLine("this run's first words", { tokens: 4_100 }) + "\n");
  assert.match(workingDetail(root, s), /^working 1m(39|40|41)s · turn 2 · ctx 4100$/, workingDetail(root, s));
});

test("a quiet tail predating the run never reaches the token metrics either", async () => {
  const repo = tmpdir();
  // Same shape as the payload's combined-metrics fixture: persisted totals from completed
  // runs plus a live tail. Here the tail is the PREVIOUS run's (29 minutes old) and the
  // new run's baseline is still running — the previous run's output must not ride into
  // this run's `generated` figure a second time.
  const file = writePiLog(repo, "feature", [
    SESSION,
    assistantLine("the earlier run", { tokens: 12_000, output: 800 }),
  ]);
  backdate(file, 29 * 60_000);
  const s = freshRunnerState("feature");
  s.generatedTokens = 1_000;
  s.peakContextTokens = 6_000;
  s.running = true;
  s.lastRunStartedAt = Date.now() - 99_000;
  const snap = snapshotWith([{ role: "feature", running: true, lastRunStartedAt: s.lastRunStartedAt }]);
  snap.running = true; // the orchestrator is up, so roleRowCells renders the live phase
  const cells = roleRowCells(snap, repo, s);
  assert.equal(cells.generated, 1_000, "only the persisted total — the stale tail contributes nothing");
  assert.equal(cells.peakCtx, 6_000);
  assert.equal(cells.phase, "working 1m39s");
});

// The stall flag (BUGS.md 2026-09-13 sibling): a tool call open and silent past the threshold
// names itself in the state cell — the same rule as runPi's warning event.

test("workingDetail names a stalled tool call in the state cell", () => {
  const root = tmpdir();
  const s = freshRunnerState("clean");
  s.lastRunStartedAt = Date.now() - 5_000;
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
  const s = freshRunnerState("clean");
  s.lastRunStartedAt = Date.now() - 5_000;
  const detail = workingDetail(root, s);
  assert.ok(detail.endsWith("bash npm test"), `unexpected shape: ${detail}`);
  assert.doesNotMatch(detail, /tool call stalled/);
});

test("rolePhase surfaces the live detail only while a run is in flight", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  const s = freshRunnerState("feature");
  assert.equal(rolePhase(s, true), "due", "idle role is not working");
  s.running = true;
  s.lastRunStartedAt = Date.now() - 5_000;
  assert.match(rolePhase(s, true, root), /^working \ds · turn 2/);
});

test("rolePhase live detail degrades to plain working when the run has no start time", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  const s = freshRunnerState("feature");
  s.running = true;
  assert.equal(rolePhase(s, true, root), "working · turn 2 · ctx 3000");
});

test("rolePhase shows the review gate label without a log to read from", () => {
  const s = freshRunnerState("feature");
  s.running = true;
  s.phase = "review";
  s.lastRunStartedAt = Date.now() - 90_000;
  // ±1s of drift between setting the timestamp and formatting it.
  assert.match(rolePhase(s, true), /^reviewing 1m(29|30|31)s$/);

  const bare = freshRunnerState("feature");
  bare.running = true;
  bare.phase = "review";
  assert.equal(rolePhase(bare, true), "reviewing"); // no start time: nothing to show elapsed for
});

test("rolePhase shows the reviewer run's live detail while a run is under review", () => {
  const root = tmpdir();
  // The reviewer writes to the same per-role raw log, starting a fresh session IN THE ROLE'S
  // MERGE WORKTREE (its session event's cwd names it) — so the gate accumulator, not the
  // author's, carries the reviewer's progress (BUGS.md 2026-09-22).
  writePiLog(root, "feature", [
    GATE_SESSION(root, "feature"),
    assistantLine("reviewing the diff", { tokens: 22_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshRunnerState("feature");
  s.running = true;
  s.phase = "review";
  s.lastRunStartedAt = Date.now() - 5_000;
  const phase = rolePhase(s, true, root);
  assert.match(phase, /^reviewing \ds · /, `unexpected shape: ${phase}`);
  assert.ok(phase.includes("turn 2"), "one completed reviewer turn means the second is in flight");
  assert.ok(phase.includes("ctx 22.0k"), "latest context size compact-formatted");
  assert.ok(phase.endsWith("bash npm test"), "most recent tool call last");
});

test("rolePhase flags a stalled reviewer run after five minutes of silence", () => {
  const root = tmpdir();
  const file = writePiLog(root, "feature", [SESSION, assistantLine("reviewing", { tokens: 100 })]);
  backdate(file, 6 * 60_000);
  const s = freshRunnerState("feature");
  s.running = true;
  s.phase = "review";
  assert.match(rolePhase(s, true, root), /no agent output for 6m/);
});

// duration()'s hours bucket (>= 1h): every elapsed fixture above stays under an hour, so the
// `XhYm` branch — what operators actually see for long runs and long silences in the status
// table, TUI, and GUI — was untested. The review-gate label is the purest read of it (no log
// tail involved); the stall flag covers its second call site.

test("elapsed labels bucket into hours once a run passes an hour", () => {
  const reviewing = (msAgo: number): string => {
    const s = freshRunnerState("feature");
    s.running = true;
    s.phase = "review";
    s.lastRunStartedAt = Date.now() - msAgo;
    return rolePhase(s, true);
  };

  // Two and a half hours in: floor to whole hours, minutes rounded — not 150m.
  assert.match(reviewing((2 * 3600 + 30 * 60) * 1000), /^reviewing 2h30m$/);

  // The bucket boundary: ten seconds under an hour stays in the minutes branch (59m5Xs),
  // and at exactly an hour the label switches to hours with zero minutes.
  assert.match(reviewing((3600 - 10) * 1000), /^reviewing 59m(49|50|51)s$/);
  assert.match(reviewing(3600 * 1000), /^reviewing 1h0m$/);

  // The rounding carry at the top of the hour: 1h59m59s rounds to 60 minutes, which must
  // roll into the next hour (2h0m) instead of rendering the impossible "1h60m".
  assert.match(reviewing(7199 * 1000), /^reviewing 2h0m$/);
});

test("workingDetail's stall flag uses the hours bucket for long silences", () => {
  const root = tmpdir();
  const file = writePiLog(root, "clean", [SESSION, assistantLine("hanging", { tokens: 100 })]);
  // Ninety minutes without pi output: the stall part must read 1h30m, not 90m.
  backdate(file, 5400_000);
  assert.match(workingDetail(root, freshRunnerState("clean")), /no agent output for 1h30m/);
});

test("rolePhase names a consecutive no-change streak on the resting state cell", () => {
  // N=1 and an absent field render the ordinary label byte-identically: a single quiet run
  // is not yet a pattern.
  const s = freshRunnerState("feature");
  s.nextRunAt = Date.now() + 3_600_000;
  s.noChangeStreak = 1;
  assert.equal(rolePhase(s, true), "sleeping (for 1h)");
  s.noChangeStreak = 0;
  assert.equal(rolePhase(s, true), "sleeping (for 1h)");
  delete s.noChangeStreak;
  assert.equal(rolePhase(s, true), "sleeping (for 1h)");
  // Two or more consecutive no_change runs earn the suffix (run-apply
  // applyRunOutcome's noChangeStreak).
  s.noChangeStreak = 2;
  assert.equal(rolePhase(s, true), "sleeping (for 1h) · no change ×2");
  s.noChangeStreak = 5;
  assert.equal(rolePhase(s, true), "sleeping (for 1h) · no change ×5");
  // A context-ceiling episode wins over the no-change suffix it also feeds: a cut-off run is a
  // no_change, so noChangeStreak counts it too, but cut off names the costly cause.
  s.cutOffStreak = 2;
  s.noChangeStreak = 2;
  assert.equal(rolePhase(s, true), "sleeping (for 1h) · cut off ×2");
  // A single cut-off stays bare (N=1 is ordinary) so the no-change suffix carries again.
  s.cutOffStreak = 1;
  assert.equal(rolePhase(s, true), "sleeping (for 1h) · no change ×2");
  // Both absent renders the ordinary label byte-identically.
  delete s.cutOffStreak;
  delete s.noChangeStreak;
  assert.equal(rolePhase(s, true), "sleeping (for 1h)");
  // A dormant role's idle/skip labels carry it too.
  const idle = freshRunnerState("feature");
  idle.nextRunAt = 0;
  idle.skipReason = "no-free-entry";
  idle.noChangeStreak = 3;
  assert.match(rolePhase(idle, true), /idle: no unclaimed plans · no change ×3$/);
  // An error streak (failing) and live work never carry it: failing reads "failing" and a
  // working role's streak is stale until the run ends.
  const failing = freshRunnerState("feature");
  failing.consecutiveErrors = 3;
  failing.noChangeStreak = 2;
  assert.equal(rolePhase(failing, true), "failing");
  const running = freshRunnerState("feature");
  running.running = true;
  running.noChangeStreak = 2;
  assert.equal(rolePhase(running, true), "working");
});

test("rolePhase reads waiting: budget spent for idle roles while the cap is reached", () => {
  const s = freshRunnerState("feature");
  // Not paused: ordinary phase labels are untouched.
  assert.equal(rolePhase(s, true, undefined, false), "due");
  // Paused: an idle role shows why it isn't running — ahead of its sleep/queue state.
  assert.equal(rolePhase(s, true, undefined, true), "waiting: budget spent");

  // A sleeping role is paused too (the cap holds it past nextRunAt).
  const sleeping = freshRunnerState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(rolePhase(sleeping, true, undefined, false), "sleeping (for 1h)");
  assert.equal(rolePhase(sleeping, true, undefined, true), "waiting: budget spent");

  // The director is exempt from the cap: its phase never changes.
  const d = freshRunnerState("director");
  assert.equal(rolePhase(d, true, undefined, true), "ready for messages");

  // In-flight runs finish even while paused — only NEW runs are blocked.
  const running = freshRunnerState("feature");
  running.running = true;
  assert.equal(rolePhase(running, true, undefined, true), "working");

  // A stopped orchestrator still reads stopped (nothing is running at all).
  assert.equal(rolePhase(s, false, undefined, true), "stopped");
});

test("rolePhase reads waiting: daily cap spent for idle roles held by their own per-role cap", () => {
  const s = freshRunnerState("feature");
  // Not held: ordinary phase labels are untouched.
  assert.equal(rolePhase(s, true, undefined, false, null, false, undefined, undefined, false), "due");
  // Held by its own cap: the label names the specific spend state, ahead of its sleep/queue
  // state and ahead of the team's budget pause (which is the less specific one).
  assert.equal(rolePhase(s, true, undefined, false, null, false, undefined, undefined, true), "waiting: daily cap spent");
  assert.equal(rolePhase(s, true, undefined, true, null, false, undefined, undefined, true), "waiting: daily cap spent");

  // User intent still wins: an operator-paused role reads `paused` even while over its cap.
  assert.equal(rolePhase(s, true, undefined, false, null, true, undefined, undefined, true), "paused");

  // A sleeping role is cap-paused too (the cap holds it past nextRunAt).
  const sleeping = freshRunnerState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(rolePhase(sleeping, true, undefined, false, null, false, undefined, undefined, true), "waiting: daily cap spent");

  // The director is exempt from the cap, like the scheduler's gate: its phase never changes.
  const d = freshRunnerState("director");
  assert.equal(rolePhase(d, true, undefined, false, null, false, undefined, undefined, true), "ready for messages");

  // In-flight runs finish even while held — only NEW runs are blocked.
  const running = freshRunnerState("feature");
  running.running = true;
  assert.equal(rolePhase(running, true, undefined, false, null, false, undefined, undefined, true), "working");

  // The held role groups with the other paused states in the shared rank.
  assert.equal(roleRank("waiting: daily cap spent"), 3);
});

test("rolePhase shows main red for idle roles whose last run read main red", () => {
  // The label explains why the role keeps waking and merge nothing — ahead of its
  // sleep/queue state, like waiting: budget spent.
  const s = freshRunnerState("feature");
  s.lastResult = "main_red";
  assert.equal(rolePhase(s, true), "main's check is failing", "queued role reads main red");
  s.nextRunAt = Date.now() + 3_600_000;
  assert.equal(rolePhase(s, true), "main's check is failing", "sleeping role reads main red too");

  // Other results keep their ordinary labels; a green wake overwrites lastResult and self-corrects.
  const other = freshRunnerState("feature");
  other.lastResult = "no_change";
  assert.equal(rolePhase(other, true), "due");

  // In-flight runs are untouched (the label describes the finished run only).
  const running = freshRunnerState("feature");
  running.running = true;
  running.lastResult = "main_red";
  assert.equal(rolePhase(running, true), "working");

  // A stopped orchestrator still reads stopped.
  assert.equal(rolePhase(s, false), "stopped");
});

// BUGS.md 2026-09-30 — a main_red verdict outlived main's recovery: the phase came from the
// role's own last run result and nothing compared it with main's newer green check, so the
// GUI raised "main is red — 1 role is blocked" while the sidebar read "Main green". Main's
// newest merge-scope check (mainCheck) is fresher team-level evidence; only a PASSED one
// stamped after the red run ended retires the label.
test("rolePhase retires a stale main red when main's newest check passed after it", () => {
  const s = freshRunnerState("feature");
  s.lastResult = "main_red";
  s.lastRunEndedAt = Date.now() - 300_000; // the red run ended 5m ago
  s.nextRunAt = Date.now() + 3_600_000; // and its next run is an hour away
  // A green merge-scope check merged AFTER the red run: main is green now, so the label
  // falls through to the ordinary sleep state and the banner never raises.
  assert.match(
    rolePhase(s, true, undefined, false, undefined, false, undefined, { status: "passed", at: Date.now() - 60_000 }),
    /^sleeping/,
    "a newer passed check is fresher evidence than the role's own red",
  );
  // A passed check from BEFORE the red run says nothing about main now.
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, undefined, { status: "passed", at: Date.now() - 600_000 }),
    "main's check is failing",
    "a check older than the red run keeps the blockage",
  );
  // A newer failed check means main is genuinely still red.
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, undefined, { status: "failed", at: Date.now() - 60_000 }),
    "main's check is failing",
  );
  // A skipped check is not green evidence either.
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, undefined, { status: "skipped", at: Date.now() - 60_000 }),
    "main's check is failing",
  );
  // No recorded run end: the comparison cannot be made, so the blockage stands.
  const undated = freshRunnerState("feature");
  undated.lastResult = "main_red";
  assert.equal(
    rolePhase(undated, true, undefined, false, undefined, false, undefined, { status: "passed", at: Date.now() }),
    "main's check is failing",
    "no run end keeps the blockage (conservative)",
  );
  // Without a mainCheck at all the old behavior stands (direct callers, hand-built states).
  assert.equal(rolePhase(s, true), "main's check is failing");
});

// The same staleness through the single-homed row derivation and the alert it feeds: the
// banner (teamAlerts) reads the rendered phase, so a retired phase must raise no mainred.
test("roleRowCells retires the stale main red and teamAlerts raises no banner for it", () => {
  const s = freshRunnerState("feature");
  s.lastResult = "main_red";
  s.lastRunEndedAt = Date.now() - 300_000;
  const snap = snapshotWith([{ role: "feature", lastResult: "main_red", lastRunEndedAt: s.lastRunEndedAt }]);
  snap.running = true;
  snap.mainCheck = { status: "passed", at: Date.now() - 60_000 };
  const cells = roleRowCells(snap, tmpdir(), s);
  assert.notEqual(cells.phase, "main's check is failing", "the row derivation sees the snapshot's newer green check");
  assert.equal(
    teamAlerts(snap, [], [{ role: "feature", phase: cells.phase, errorStreak: false, inFlight: false }], Date.now())
      .some((a) => a.key === "mainred"),
    false,
    "no 'main is red' banner for a role whose blockage main has already recovered from",
  );
  // And the banner still raises while the phase genuinely reads main red (an older check).
  snap.mainCheck = { status: "passed", at: Date.now() - 600_000 };
  const stale = roleRowCells(snap, tmpdir(), s).phase;
  assert.equal(stale, "main's check is failing");
  assert.ok(
    teamAlerts(snap, [], [{ role: "feature", phase: stale, errorStreak: false, inFlight: false }], Date.now())
      .some((a) => a.key === "mainred"),
  );
});

test("rolePhase shows failing for a quiet-kill streak at the give-up threshold", () => {
  // BUGS.md 2026-09-18: a role stuck retrying a session the backend will not schedule looked
  // exactly like a sleeping role while it burned an hour of slot time per run.
  const s = freshRunnerState("feature");
  s.lastResult = "quiet_killed";
  s.quietKillStreak = 3;
  s.nextRunAt = Date.now() + 1_800_000;
  assert.equal(rolePhase(s, true), "failing", "the streak at the threshold outranks sleep");

  // Below the threshold the role keeps its ordinary label — a couple of transients are
  // retryable, not a health state.
  const shallow = freshRunnerState("feature");
  shallow.lastResult = "quiet_killed";
  shallow.quietKillStreak = 2;
  shallow.nextRunAt = Date.now() + 1_800_000;
  assert.match(rolePhase(shallow, true), /^sleeping/);
});

// The operator pause: while the `tumwater pause` marker exists,
// every idle role's state cell reads `paused` — after the director exemption and ahead
// of waiting: budget spent, because user intent is the most specific reason: it tells the
// operator what to do (`resume`).

test("rolePhase reads paused for idle roles while the team is user-paused", () => {
  const s = freshRunnerState("feature");
  // Not paused (the flag defaults off): ordinary phase labels are untouched.
  assert.equal(rolePhase(s, true), "due");
  // Paused: an idle role shows why it isn't running — ahead of its sleep/queue state.
  assert.equal(rolePhase(s, true, undefined, false, undefined, true), "paused");

  // A sleeping role is paused too (the marker holds it past nextRunAt).
  const sleeping = freshRunnerState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(rolePhase(sleeping, true), "sleeping (for 1h)");
  assert.equal(rolePhase(sleeping, true, undefined, false, undefined, true), "paused");

  // The director is exempt from the operator pause: its phase never changes.
  const d = freshRunnerState("director");
  assert.equal(rolePhase(d, true, undefined, false, undefined, true), "ready for messages");

  // In-flight runs finish even while paused — only NEW runs are blocked, so a running role
  // keeps its live detail instead of reading `paused`.
  const running = freshRunnerState("feature");
  running.running = true;
  assert.equal(rolePhase(running, true, undefined, false, undefined, true), "working");

  // A stopped orchestrator still reads stopped (nothing is running at all).
  assert.equal(rolePhase(s, false, undefined, false, undefined, true), "stopped");
});

// The timed per-role pause countdown (PLANS.md 2026-10-16): `pause --role <id> --for` writes a
// deadline that the CLI/TUI/`status --json` phase — all derived through rolePhase — shows as
// `paused · resumes in <s>`, mirroring the GUI role-list's phaseDetail so the operator can tell
// when the role comes back without dropping to the browser.
test("rolePhase appends the per-role pause resume countdown only for a live deadline", () => {
  const s = freshRunnerState("feature");
  const now = Date.now();

  // A future deadline renders the countdown in the team-header wording family.
  const future = now + 120_000; // ~120s → humanSeconds → "2m" (mid-bucket, deterministic)
  assert.equal(
    rolePhase(s, true, undefined, false, null, true, undefined, undefined, false, undefined, false, false, undefined, undefined, future),
    "paused · resumes in 2m",
  );

  // An indefinite per-role pause (no deadline) keeps the bare `paused`.
  assert.equal(
    rolePhase(s, true, undefined, false, null, true, undefined, undefined, false, undefined, false, false, undefined, undefined, undefined),
    "paused",
  );

  // An expired marker never renders a stale `resumes in 0s` — the guard drops it.
  assert.equal(
    rolePhase(s, true, undefined, false, null, true, undefined, undefined, false, undefined, false, false, undefined, undefined, now - 1_000),
    "paused",
  );

  // The timed phase stays grouped with the other paused states on every surface: it must not
  // fall through ROLE_RANK_RULES to idle rank 4 (which would reorder the CLI/TUI/dashboard
  // tables) or lose the paused yellow tone that phaseTone derives from that rank.
  const pausedRank = ROLE_RANK_RULES.find((r) =>
    (r.phases ?? []).includes("paused") || (r.prefixes ?? []).includes("paused"),
  )?.rank;
  assert.equal(pausedRank, 3, "a paused rule in ROLE_RANK_RULES carries rank 3");
  assert.equal(roleRank("paused · resumes in 2m"), pausedRank, "the timed pause ranks with the paused states");
  assert.equal(phaseTone("paused · resumes in 2m"), "yellow", "the timed pause keeps the paused yellow tone");
});

test("rolePhase prefers paused over waiting: budget spent and main red", () => {
  const s = freshRunnerState("feature");
  // All three hold: the user pause wins — while both gates block, `paused` names the fix.
  s.lastResult = "main_red";
  assert.equal(rolePhase(s, true, undefined, true, undefined, true), "paused");

  // User-paused + main-red without budget reads paused too.
  const red = freshRunnerState("feature");
  red.lastResult = "main_red";
  assert.equal(rolePhase(red, true, undefined, false, undefined, true), "paused");

  // Without the user pause the other labels keep their own precedence (budget before main red).
  assert.equal(rolePhase(s, true, undefined, true), "waiting: budget spent");
});

// The merge cell (BUGS.md 2026-09-22, re-opened 2026-09-23): the marker's stage scopes the
// cell to the phase the merge is in. This used to pin a bare `merge <elapsed>` as the
// correct output for every merge — the featureless countdown the bug is about.
test("rolePhase renders the merge cell ahead of every idle state, only when the record is passed", () => {
  const s = freshRunnerState("clean");
  s.nextRunAt = Date.now() + 90_000; // would read "sleeping (for 2m)" without the record
  const startedAt = Date.now() - 90_000; // 90s of merge → "1m30s"
  // The record wins over the idle state…
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, { status: "merging", startedAt, stage: "merging" }),
    "merging 1m30s · finishing the merge",
  );
  // …and it is the caller's job to pass it only for the merge role: without it the role
  // keeps its ordinary state (the "other roles" case — the record is filtered upstream).
  assert.match(rolePhase(s, true), /^sleeping \(for 2m\)$/);
  // A stopped harness never shows it — a dead team's marker is stale by definition.
  assert.equal(rolePhase(s, false, undefined, false, undefined, false, { status: "merging", startedAt, stage: "merging" }), "stopped");
  // Only a record with no stage at all — an older writer's marker mid-upgrade — keeps the
  // bare elapsed label: there is nothing more it can honestly say.
  assert.equal(rolePhase(s, true, undefined, false, undefined, false, { status: "merging", startedAt }), "merging 1m30s");
  // A change the verifying stage approved waits for the merge slot: it reads that state instead —
  // no elapsed and no stage, because nothing of its own is running (BUGS.md 2026-09-23).
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, { status: "approved", startedAt, stage: "merging" }),
    "approved, waiting to merge",
  );
});

test("the build-check and merging merge stages render their label and never read the log", () => {
  const root = tmpdir();
  // The log's newest run is a FINISHED reviewer (a previous merge's), silent for ten
  // minutes: read during a stage with no live pi run, it would show stale turns/context and
  // a false `no pi output` flag counted against a run that ended long ago.
  const file = writePiLog(root, "clean", [
    GATE_SESSION(root, "clean"),
    assistantLine("an old review", { tokens: 40_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  backdate(file, 10 * 60_000);
  const s = freshRunnerState("clean");
  const startedAt = Date.now() - 90_000;
  for (const [stage, label] of [
    ["rebasing", "rebasing"],
    ["check-wait", "waiting to check"],
    ["build-check", "checking"],
    ["resolve-wait", "waiting to resolve conflicts"],
    ["merging", "finishing the merge"],
  ] as const) {
    const phase = rolePhase(s, true, root, false, null, false, { status: "merging", startedAt, stage });
    assert.match(phase, new RegExp(`^merging 1m3[01]s · ${label}$`), `${stage}: ${phase}`);
  }
});

// The per-stage elapsed (PLANS.md 2026-10-15): a merge cell carrying stageSince appends it
// after the stage for every staged arm (build-check/merging and the reviewing/resolving tail),
// and omits it when absent, so an older generation's cell keeps its current label.
test("rolePhase appends the per-stage elapsed after a staged merge, when the cell carries stageSince", () => {
  const s = freshRunnerState("clean");
  const startedAt = Date.now() - 90_000; // 90s of merge → "1m30s"
  const stageSince = Date.now() - 30_000; // 30s in THIS stage → "30s"
  // build-check (a plain staged arm): the stage elapsed appends after the stage.
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, { status: "merging", startedAt, stage: "build-check", stageSince }),
    "merging 1m30s · checking 30s",
  );
  // Without stageSince the current label is unchanged (the old generation's cell).
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, { status: "merging", startedAt, stage: "build-check" }),
    "merging 1m30s · checking",
  );
  // reviewing (a scrutinized arm): the stage elapsed renders before the in-flight detail tail;
  // without a log the tail is the bare staged label carrying it.
  assert.equal(
    rolePhase(s, true, undefined, false, null, false, { status: "merging", startedAt, stage: "reviewing", stageSince }),
    "merging 1m30s · reviewing 30s",
  );
  assert.equal(
    rolePhase(s, true, undefined, false, null, false, { status: "merging", startedAt, stage: "reviewing" }),
    "merging 1m30s · reviewing",
  );
});

test("the reviewing merge stage carries the reviewer run's live detail, timed from the merge", () => {
  const root = tmpdir();
  // The merge's reviewer writes the role's own raw log from its merge slot worktree — the gate
  // accumulator, exactly what a reviewing run's cell reads (BUGS.md 2026-09-22).
  writePiLog(root, "clean", [
    SESSION, // the authoring role's finished run
    assistantLine("the author's work", { tokens: 9_000 }),
    JSON.stringify({ type: "tumwater_run", label: "review" }),
    GATE_SESSION(root, "clean"),
    assistantLine("reviewing the diff", { tokens: 22_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshRunnerState("clean");
  // The authoring run started an hour ago; the cell's elapsed is the MERGE's (90s), and
  // the frame's `live` for a non-running role is null — the branch reads the gate itself.
  s.lastRunStartedAt = Date.now() - 3_600_000;
  const phase = rolePhase(s, true, root, false, null, false, { status: "merging", startedAt: Date.now() - 90_000, stage: "reviewing" });
  assert.match(phase, /^merging 1m3[01]s · reviewing · turn 2 · ctx 22\.0k · bash npm test$/, `unexpected shape: ${phase}`);

  // No log to read (or no root): the honest stage label alone.
  const bare = rolePhase(s, true, undefined, false, null, false, { status: "merging", startedAt: Date.now() - 90_000, stage: "reviewing" });
  assert.equal(bare, "merging 1m30s · reviewing");
});

test("the resolving merge stage carries the conflict resolver's live detail, not the review's", () => {
  const root = tmpdir();
  // The verification's reviewer finished; the merge's resolver then started as another gate run,
  // and its `tumwater_run` marker reset the gate accumulator — the cell counts the resolver's
  // turns only.
  writePiLog(root, "clean", [
    JSON.stringify({ type: "tumwater_run", kind: "gate", label: "review" }),
    GATE_SESSION(root, "clean"),
    assistantLine("the review", { tokens: 50_000 }),
    assistantLine("VERDICT: approve", { tokens: 51_000 }),
    JSON.stringify({ type: "tumwater_run", kind: "gate" }),
    GATE_SESSION(root, "clean"),
    assistantLine("resolving PLANS.md", { tokens: 12_000 }),
    toolStart("bash", { command: "grep -n '<<<<<<<' PLANS.md" }),
  ]);
  const mergeCell = { status: "merging", startedAt: Date.now() - 90_000, stage: "resolving" } as const;
  const phase = rolePhase(freshRunnerState("clean"), true, root, false, null, false, mergeCell);
  assert.match(phase, /^merging 1m3[01]s · resolving conflicts · turn 2 · ctx 12\.0k · bash grep/, `unexpected shape: ${phase}`);
  assert.equal(rolePhase(freshRunnerState("clean"), true, undefined, false, null, false, mergeCell), "merging 1m30s · resolving conflicts");
});

test("a merge cell with no recorded start renders the bare `merge` head", () => {
  // A change record from an older writer can carry no startedAt (the marker shape allows it):
  // no honest elapsed exists, so the head degrades to the bare label — staged or not.
  const s = freshRunnerState("feature");
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, { status: "merging", startedAt: undefined, stage: "merging" }),
    "merging · finishing the merge",
  );
  assert.equal(
    rolePhase(s, true, undefined, false, undefined, false, { status: "merging", startedAt: undefined }),
    "merging",
  );
});

test("a new merge's reviewing cell starts at its run's label line, not at the previous review's counts", () => {
  const root = tmpdir();
  // A previous review ran to completion; the next merge's reviewer has only written its
  // label line so far (runPi writes it before pi spawns). The stage already says reviewing.
  writePiLog(root, "clean", [
    JSON.stringify({ type: "tumwater_run", label: "review" }),
    GATE_SESSION(root, "clean"),
    assistantLine("the previous review", { tokens: 50_000 }),
    assistantLine("VERDICT: approve", { tokens: 51_000 }),
    toolStart("read", { path: "src/old.ts" }),
    JSON.stringify({ type: "tumwater_run", label: "review" }),
  ]);
  const phase = rolePhase(freshRunnerState("clean"), true, root, false, null, false, {
    status: "merging",
    startedAt: Date.now() - 5_000,
    stage: "reviewing",
  });
  assert.match(phase, /^merging \ds · reviewing · turn 1$/, `the previous review bled through: ${phase}`);
});

test("rolePhase describes each role state", () => {
  const s = freshRunnerState("clean");
  assert.equal(rolePhase(s, false), "stopped");
  assert.equal(rolePhase(s, true), "due");
  s.running = true;
  assert.equal(rolePhase(s, true), "working");
  s.running = false;
  s.nextRunAt = Date.now() + 90_000;
  // Sleeping is a present state: the label shows the remaining duration ("for …"),
  // not a future start ("in …"). 90s buckets to "2m" in humanSeconds.
  assert.match(rolePhase(s, true), /^sleeping \(for 2m\)$/);
  const d = freshRunnerState("director");
  assert.equal(rolePhase(d, true), "ready for messages");
});

// BUGS.md 2026-09-24 — the display must mirror the concurrency cap: a run parked in the
// semaphore queue holds no permit, so it renders its true state (`waiting to start`) and stays
// out of the active set an operator counts against maxConcurrent.
test("a parked waiter renders `waiting to start` and stays out of the active set", () => {
  const s = freshRunnerState("clean");
  s.running = true;
  s.parkedSince = Date.now() - 5_000;
  assert.match(rolePhase(s, true), /^waiting to start 5s$/);
  // Permit granted (the orchestrator clears parkedSince at acquire): the same role becomes
  // an active, permit-holding working run again.
  s.parkedSince = undefined;
  assert.equal(rolePhase(s, true), "working");
  // The parked label is not an active phase: sortRolesByState puts it behind the working and
  // merge rows, so active-row counting never includes a waiter.
  const sorted = sortRolesByState([
    { role: "clean", phase: "waiting to start 5s" },
    { role: "feature", phase: "working 5s" },
    { role: "bugfix", phase: "merging 5s" },
  ]);
  assert.deepEqual(sorted.map((r) => r.role), ["bugfix", "feature", "clean"]);
});

// BUGS.md 2026-10-06 — the director bypasses maxConcurrent (`usesSlot` is false for it), so a
// running director must not render as a permit-holder `working` row or inflate the active set
// an operator counts against the cap. It gets a phase of its own that isActivePhase excludes,
// ranks ahead of the permit holders (rank -1), and keeps its live work visible.
test("a running director renders its own phase, outside the cap's active set", () => {
  const d = freshRunnerState("director");
  d.running = true;
  assert.equal(rolePhase(d, true), "director working");
  assert.equal(rolePhase(freshRunnerState("director"), true), "ready for messages", "an idle director keeps its exempt label");
  const root = tmpdir();
  d.lastRunStartedAt = Date.now() - 90_000;
  assert.match(rolePhase(d, true, root), /^director working 1m(29|30|31)s$/);
  // Its own label is not a permit-holder phase: the active set against the cap is permit holders.
  assert.equal(isActivePhase(rolePhase(d, true)), false);
  assert.equal(isActivePhase("working 5s"), true);
  assert.equal(isActivePhase("merging 5s"), true);
  // It ranks and sorts ahead of the permit holders (rank -1), so its work stays visible.
  assert.equal(roleRank("director working 1m"), -1);
  assert.equal(roleRank("working 5s"), 0);
  const sorted = sortRolesByState([
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
  const stalled = [{ role: "director", phase: "director working 6m · tool call stalled: bash find /", errorStreak: false, inFlight: false }];
  assert.ok(
    teamAlerts(snap, [], stalled, Date.now()).some((a) => a.key === "stuck"),
    "a stalled director is stuck even though it holds no permit",
  );
  const idle = [{ role: "director", phase: "ready for messages", errorStreak: false, inFlight: false }];
  assert.equal(
    teamAlerts(snap, [], idle, Date.now()).some((a) => a.key === "stuck"),
    false,
    "an idle director raises nothing",
  );
});

// Per-role quiet hours (PLANS.md quietHoursPerRole): an idle role inside its own window
// reads the team gate's own quiet wording, scoped to its window — `quiet until <end>`.
test("rolePhase reads quiet until <end> for idle roles held by their own quietHoursPerRole window", () => {
  const s = freshRunnerState("feature");
  // Not held: ordinary phase labels are untouched.
  assert.equal(rolePhase(s, true, undefined, false, null, false, undefined, undefined, false), "due");
  // Held by its own wrapping window: the team badge's wording with the role's own end.
  assert.equal(
    rolePhase(s, true, undefined, false, null, false, undefined, undefined, false, "23:00-07:00"),
    "quiet until 07:00",
  );
  // The role's own schedule is more specific than the team's budget pause.
  assert.equal(
    rolePhase(s, true, undefined, true, null, false, undefined, undefined, false, "23:00-07:00"),
    "quiet until 07:00",
  );
  // User intent still wins: an operator-paused role reads `paused` even inside its window.
  assert.equal(
    rolePhase(s, true, undefined, false, null, true, undefined, undefined, false, "23:00-07:00"),
    "paused",
  );
  // In-flight runs finish even while held — only NEW runs are blocked.
  const running = freshRunnerState("feature");
  running.running = true;
  assert.equal(
    rolePhase(running, true, undefined, false, null, false, undefined, undefined, false, "23:00-07:00"),
    "working",
  );
});

// The disk floor (plans/disk-floor.md, part 4/4): an idle role reads `waiting: low disk` while the
// gate holds — the team-wide verdict, ranked with the budget pause. In-flight runs keep
// their detail, the director keeps its prompt label, and a stopped orchestrator still reads
// stopped.
test("rolePhase reads waiting: low disk for idle roles while the disk floor holds", () => {
  const s = freshRunnerState("feature");
  assert.equal(rolePhase(s, true, undefined, false, null, false, undefined, undefined, false, undefined, false), "due");
  assert.equal(rolePhase(s, true, undefined, false, null, false, undefined, undefined, false, undefined, true), "waiting: low disk");
  const d = freshRunnerState("director");
  assert.equal(rolePhase(d, true, undefined, false, null, false, undefined, undefined, false, undefined, true), "ready for messages");
  const running = freshRunnerState("feature");
  running.running = true;
  assert.equal(rolePhase(running, true, undefined, false, null, false, undefined, undefined, false, undefined, true), "working");
  assert.equal(rolePhase(s, false, undefined, false, null, false, undefined, undefined, false, undefined, true), "stopped");
});

// New-project bootstrap (plans/work-ratio.md, part 2/2): an idle held role reads
// `waiting: bootstrap` — the team gate's own wording, ranked with the waiting: low disk. In-flight
// runs keep their detail, and a stopped orchestrator still reads stopped.
test("rolePhase reads waiting: bootstrap for idle roles while bootstrap holds", () => {
  const s = freshRunnerState("clean");
  assert.equal(rolePhase(s, true, undefined, false, null, false, undefined, undefined, false, undefined, false), "due");
  assert.equal(
    rolePhase(s, true, undefined, false, null, false, undefined, undefined, false, undefined, false, true),
    "waiting: bootstrap",
  );
  assert.equal(roleRank("waiting: bootstrap"), 3, "the hold ranks with the other paused states");
  assert.equal(roleRank("waiting: maintenance allowance used 32/32"), 3, "the allowance hold ranks as paused too");
  const running = freshRunnerState("clean");
  running.running = true;
  assert.equal(
    rolePhase(running, true, undefined, false, null, false, undefined, undefined, false, undefined, false, true),
    "working",
  );
  assert.equal(
    rolePhase(s, false, undefined, false, null, false, undefined, undefined, false, undefined, false, true),
    "stopped",
  );
});

// Parallel work instances, part 6/7: the idle/merge work text — the claim's title, the
// and null for everything else.
test("idleClaimText names the claimed entry, or why an extra instance is idle", () => {
  const claim = { file: "PLANS.md" as const, key: "plan a", title: "Plan A", at: 1, source: "assigned" as const };
  assert.equal(idleClaimText({ role: "feature", claim }, "due"), "Plan A");
  assert.equal(idleClaimText({ role: "feature", claim }, "sleeping (for 30m)"), "Plan A");
  assert.equal(idleClaimText({ role: "feature", claim }, "merging 3m"), "Plan A");
  // No claim: null — the phase label carries any idle reason itself.
  assert.equal(idleClaimText({ role: "feature-2" }, "due"), null);
  assert.equal(idleClaimText({ role: "feature" }, "due"), null);
  assert.equal(idleClaimText({ role: "feature-2" }, "sleeping (for 30m)"), null);
  assert.equal(idleClaimText({ role: "feature-2" }, "working 3m"), null);
});

test("rolePhase names the scheduling poll's skip for a due, idle role", () => {
  const due = (role: string, extra: Partial<ReturnType<typeof freshRunnerState>>) => ({ ...freshRunnerState(role), nextRunAt: Date.now() - 1_000, ...extra });
  assert.equal(rolePhase(due("feature-2", { skipReason: "no-free-entry" }), true), "idle: no unclaimed plans");
  assert.equal(rolePhase(due("bugfix-2", { skipReason: "no-free-entry" }), true), "idle: no unclaimed bugs");
  assert.equal(rolePhase(due("feature", { skipReason: "claim-hold" }), true), "idle: another feature instance is working on it");
  assert.equal(rolePhase(due("clean", { skipReason: "deferred-backlog" }), true), "deferred (backlog open)");
  assert.equal(rolePhase(due("clean", { skipReason: "deferred-no-work" }), true), "deferred (no new work)");
  assert.equal(rolePhase(due("plan", { skipReason: "deferred-plans-full" }), true), "deferred (plans full)");
  // A runner the poll declined and will keep declining never reads the bare "due — starts
  // on the next poll": the multi-instance cap, the maintenance headroom and the
  // yield-stretched gap each record a skipReason the cell names.
  assert.equal(rolePhase(due("feature-2", { skipReason: "instances-full" }), true), "idle: every feature instance is busy");
  assert.equal(rolePhase(due("clean", { skipReason: "maintenance-due-cap" }), true), "waiting: maintenance allowance spent this poll");
  assert.equal(rolePhase(due("clean", { skipReason: "yield-gap", recentOutcomes: "n".repeat(16) }), true), "idle: waiting out its yield gap ×4");
  assert.equal(rolePhase(due("clean", {}), true), "due");
  assert.match(rolePhase(due("clean", { skipReason: "claim-hold", nextRunAt: Date.now() + 600_000 }), true), /^sleeping \(/);
  assert.match(rolePhase(due("clean", { skipReason: "claim-hold", running: true, lastRunStartedAt: Date.now() - 90_000 }), true), /^working/);
});

// The row's paused cell reads the scheduler's verdict (pausedRunners), not the raw marker:
// a breaker-paused instance 1 (marker `feature-1`) pauses `feature` only, never `feature-2`.
test("roleRowCells pauses only the role pausedRunners names, not its sibling instance", () => {
  const snap = snapshotWith([{ role: "feature" }, { role: "feature-2" }], undefined, false, ["feature-1"]);
  snap.pausedRunners = ["feature"];
  snap.running = true;
  const cellsFor = (role: string) => roleRowCells(snap, tmpdir(), freshRunnerState(role)).phase;
  const single = snapshotWith([{ role: "feature" }], undefined, false, ["feature"]);
  single.running = true;
  const expected = roleRowCells(single, tmpdir(), freshRunnerState("feature")).phase;
  assert.equal(cellsFor("feature"), expected);
  assert.match(expected, /paused/);
  assert.doesNotMatch(cellsFor("feature-2"), /paused/);
});
