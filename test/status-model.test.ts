/** The status-model suite: loopPhase, workingDetail, and the header badges (budgetBadge,
 * buildBadge, landingBadge). Split out of status-render.test.ts, whose name promised the
 * rendered table but also carried this whole suite — src/ui/status-model.ts now has its tests
 * under its own name and its own fixture imports (shared builders live in status-fixtures.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseProgress, stalledToolLabel } from "../src/ui/progress.js";
import { budgetBadge, landingBadge, loopPhase, pauseBadge, workingDetail } from "../src/ui/status-model.js";
import { freshLoopState } from "../src/loop-state.js";
import { tmpdir } from "./repo-fixtures.js";
import { assistantLine } from "./pi-events.js";
import { GATE_SESSION, SESSION, toolStart, writePiLog } from "./status-fixtures.js";

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
  const fourMinAgo = new Date(Date.now() - 4 * 60_000);
  fs.utimesSync(file, fourMinAgo, fourMinAgo);
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /no pi output/);
  // Six minutes of silence crosses it.
  const sixMinAgo = new Date(Date.now() - 6 * 60_000);
  fs.utimesSync(file, sixMinAgo, sixMinAgo);
  assert.match(workingDetail(root, freshLoopState("clean")), /no pi output for 6m/);
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
  fs.utimesSync(file, new Date(Date.now() - 6 * 60_000), new Date(Date.now() - 6 * 60_000));
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
  fs.utimesSync(file, new Date(Date.now() - 5400_000), new Date(Date.now() - 5400_000));
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

test("budgetBadge renders the standing daily-cost rule in every cap state", () => {
  // One home for the badge string (renderStatus's header and the payload's preformatted
  // budgetBadge field): n/a for an all-free fleet (checked first, in EVERY cap state — a
  // disabled free fleet still cannot accumulate spend), $X/$Y while enabled with priced
  // models, `· no cap` when disabled. Whole-dollar caps stay bare ($50); fractional ones
  // keep their cents ($12.34).
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 50, free: true, fallback: null }), " · budget: n/a", "all-free fleet reads n/a");
  assert.equal(budgetBadge({ spentUsd: 12.34, capUsd: 50, free: false, fallback: null }), " · budget: $12.34/$50 today", "whole-dollar cap stays bare");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 12.34, free: false, fallback: null }), " · budget: $0.00/$12.34 today", "fractional cap keeps its cents");
  assert.equal(budgetBadge({ spentUsd: 7.5, capUsd: 0, free: false, fallback: null }), " · budget: $7.50 today · no cap", "disabled: spend shown, gate off");
  assert.equal(budgetBadge({ spentUsd: 0, capUsd: 0, free: true, fallback: null }), " · budget: n/a", "free outranks disabled too");
});

// The cost n/a fallback model (plans/fallback-model.md): while it carries the fleet the badge
// names it, and the loops keep their ordinary state cells — they are working, not stopped.
test("budgetBadge names the fallback model only while it is carrying the fleet", () => {
  const fallback = { provider: "omlx", model: "local-free" };
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, free: false, fallback }),
    " · budget: $50.00/$50 today · fallback: local-free (cost n/a)",
    "at the cap with a usable fallback: the badge says what the fleet is running on now",
  );
  assert.equal(
    budgetBadge({ spentUsd: 10, capUsd: 50, free: false, fallback }),
    " · budget: $10.00/$50 today",
    "under the cap the fallback is not engaged, so the badge is byte-identical to before",
  );
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, free: false, fallback: null }),
    " · budget: $50.00/$50 today",
    "at the cap with no usable fallback: the fleet is paused, nothing to name",
  );
  // A fallback naming only a provider still identifies itself.
  assert.equal(
    budgetBadge({ spentUsd: 50, capUsd: 50, free: false, fallback: { provider: "omlx" } }),
    " · budget: $50.00/$50 today · fallback: omlx (cost n/a)",
  );
});

// Merge queue 4/5 — the land queue's one payload field, three renderers: the header badge,
// the marker-driven row label, and the payload's preformatted field.
test("landingBadge shows the land queue depth and stays empty when idle", () => {
  // Empty at depth 0 keeps every existing header byte identical; the count while anything
  // is queued or landing (in-flight landings always count toward depth — their entry stays
  // in the queue until its outcome).
  assert.equal(landingBadge({ depth: 0 }), "", "idle queue adds nothing to the header");
  assert.equal(landingBadge({ depth: 1 }), " · land queue: 1");
  assert.equal(landingBadge({ depth: 3 }), " · land queue: 3");
});

// The timed-pause countdown (PLANS.md "Pause countdown"): the badge stands only while a
// FUTURE fleet deadline stands, so a role-only or indefinite pause and an expired marker
// leave the header unchanged — the read side treats an expired marker as unpaused, and the
// badge must never claim a countdown that is over.
test("pauseBadge counts down a standing fleet timed pause and stays empty otherwise", () => {
  const now = 1_800_000_000_000;
  assert.equal(pauseBadge(undefined, now), "", "no timed pause: no badge");
  assert.equal(pauseBadge(now - 1, now), "", "an expired deadline renders nothing, matching the unpaused read");
  assert.equal(pauseBadge(now + 45_000, now), " · paused — auto-resumes in 45s", "sub-minute reads seconds");
  assert.equal(pauseBadge(now + 12 * 60_000, now), " · paused — auto-resumes in 12m", "sub-hour reads minutes");
  assert.equal(pauseBadge(now + 3 * 3_600_000, now), " · paused — auto-resumes in 3h", "hours read hours");
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
  fs.utimesSync(file, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
  const s = freshLoopState("clean");
  const startedAt = Date.now() - 90_000;
  for (const [stage, label] of [
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