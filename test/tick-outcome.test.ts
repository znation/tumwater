import test from "node:test";
import assert from "node:assert/strict";
import { applyLandingOutcome, applyTickOutcome } from "../src/tick-outcome.js";
import {
  clearBackoff,
  nextBackoffSeconds,
  restoreMidTickWake,
  YIELD_RING,
  yieldMultiplier,
} from "../src/backoff.js";
import { freshLoopState } from "../src/loop-state.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import { defaultConfig } from "../src/config.js";
import { OBSERVER_ROLES } from "../src/roles.js";
import { todayStamp } from "../src/budget.js";

/** The per-loop scheduling policy's tests (src/tick-outcome.ts for the outcome application,
 * src/backoff.ts for the clock): what a finished tick or landing does to the loop's state and
 * clock — the wake semantics, the backoff ladders, the bounded cut-off/quiet-kill resume
 * streaks — and the review-verdict record. Moved out of
 * loop-state.test.ts when the policy split out of loop-state.ts, whose own tests (load/save,
 * zeroCounters) stayed there. */

test("clearBackoff zeroes the backoff and pulls nextRunAt to now, preserving everything else", () => {
  const s = freshLoopState("clean");
  s.ticks = 12;
  s.commits = 5;
  s.generatedTokens = 987654;
  s.totalCostUsd = 3.14;
  s.nextRunAt = 1_700_000_000_000; // two hours out — deep backoff
  s.backoffSeconds = 7680;
  s.lastMainHead = "abc123";
  s.lastResult = "no_change";
  s.lastSummary = "found nothing";
  s.dayStamp = todayStamp(); // daily budget window — must survive a wake
  s.dayCostUsd = 12.5;

  const now = 1_700_000_001_000;
  const w = clearBackoff(s, now);
  assert.equal(w.backoffSeconds, 0);
  assert.equal(w.nextRunAt, now);
  // Waking is a scheduling operation, not an observation-window reset: counters, wake
  // tracking, last-result fields, and the daily budget window are untouched.
  assert.equal(w.ticks, 12);
  assert.equal(w.commits, 5);
  assert.equal(w.generatedTokens, 987654);
  assert.equal(w.totalCostUsd, 3.14);
  assert.equal(w.lastMainHead, "abc123");
  assert.equal(w.lastResult, "no_change");
  assert.equal(w.lastSummary, "found nothing");
  assert.equal(w.dayStamp, s.dayStamp);
  assert.equal(w.dayCostUsd, 12.5);
  // Pure: the input is unchanged and the result is a new object.
  assert.equal(s.backoffSeconds, 7680);
  assert.notEqual(w, s);
});

test("restoreMidTickWake re-applies a wake that was consumed while the tick was in flight", () => {
  // The residual race the queue-due-ness fix leaves (BUGS.md 2026-09-25): a plain
  // `tumwater wake --role` with an empty queue consumed mid-tick is clobbered by the
  // end-save — applyTickOutcome re-stamps lastTickEndedAt past wokenAt and schedules
  // nextRunAt a fresh interval out, so the demand silently waits out qa's two-hour clock.
  // restoreMidTickWake, called by the tick's end-save after applyTickOutcome, re-applies the
  // demand exactly like a wake arriving one poll after the tick ended.
  const s = freshLoopState("qa");
  const start = Date.now() - 2000; // the tick began two seconds ago and is still running
  s.lastTickStartedAt = start;
  s.running = true;
  s.nextRunAt = start + 2 * 3600 * 1000;
  // One second into the tick, the operator wakes the loop — what consumeWakeRequest's
  // r.wake() does to the in-memory state the in-flight tick holds.
  Object.assign(s, clearBackoff(s, start + 1000));
  assert.equal(s.wokenAt, start + 1000);
  // The tick ends: the outcome's own schedule overwrites the wake.
  applyTickOutcome(s, testConfig(), "qa", { result: "no_change" });
  assert.ok(s.nextRunAt > (s.lastTickEndedAt ?? 0), "the outcome's fresh gap clock is armed");
  assert.ok((s.wokenAt ?? 0) < (s.lastTickEndedAt ?? 0), "wokenAt no longer exempts the fresh gap");
  // The end-save path re-applies the mid-tick wake.
  assert.equal(restoreMidTickWake(s), true);
  assert.equal(s.backoffSeconds, 0);
  assert.ok(s.nextRunAt <= Date.now() + 1, "due now, like a wake arriving after the tick (the +1 floors a same-ms wokenAt tie)");
  assert.ok((s.wokenAt ?? 0) > (s.lastTickEndedAt ?? 0), "the min-gap exemption is re-armed");
});

test("restoreMidTickWake leaves a wake older than the tick's start alone", () => {
  // Self-clearing must hold: a wake honored by the tick that just ran (stamped before its
  // start, e.g. an old wokenAt carried in state) must not re-arm itself at every end-save.
  const s = freshLoopState("qa");
  const now = Date.now();
  s.lastTickStartedAt = now - 60_000;
  s.wokenAt = now - 120_000;
  s.nextRunAt = now + 2 * 3600 * 1000;
  applyTickOutcome(s, testConfig(), "qa", { result: "no_change" });
  const scheduled = s.nextRunAt;
  assert.equal(restoreMidTickWake(s), false);
  assert.equal(s.nextRunAt, scheduled, "the outcome's own schedule stands");
});

test("restoreMidTickWake does not pull a cut-off resume past its deliberate wait", () => {
  // A cut-off outcome deliberately waits one interval before resuming the compacted session;
  // a mid-tick wake must not shortcut that wait (the resume is the loop acting on a demand
  // already — isEligible's resume gate is documented as intentional).
  const s = freshLoopState("qa");
  const start = Date.now();
  s.lastTickStartedAt = start;
  s.running = true;
  Object.assign(s, clearBackoff(s, start + 1000));
  applyTickOutcome(s, testConfig(), "qa", { result: "no_change", cutOff: true });
  assert.equal(s.resumePending, true);
  const scheduled = s.nextRunAt;
  assert.equal(restoreMidTickWake(s), false);
  assert.equal(s.nextRunAt, scheduled, "the resume's deliberate wait stands");
});

test("nextBackoffSeconds caps an initial above max and treats non-positive current as first", () => {
  const ladder = { initialSeconds: 100, factor: 2, maxSeconds: 30 };
  assert.equal(nextBackoffSeconds(0, ladder), 30); // min(initial, max)
  assert.equal(nextBackoffSeconds(-5, ladder), 30); // current <= 0 → initial (capped)
  assert.equal(nextBackoffSeconds(29, ladder), 30); // growth still capped at max
});

// --- Yield-scaled clocks: the ring and the multiplier it feeds (PLANS.md) ---

test("yieldMultiplier: ten consecutive empty ticks double the gap, and it caps at 8", () => {
  // Below ten empties the plain gap stands — the ring has to say something before it
  // stretches anything.
  assert.equal(yieldMultiplier([]), 1);
  assert.equal(yieldMultiplier("n".repeat(9).split("")), 1);
  assert.equal(yieldMultiplier("n".repeat(10).split("")), 2);
  // Doubling per five further empties: 15 → 4, 20 → 8, and the cap holds past it.
  assert.equal(yieldMultiplier("n".repeat(14).split("")), 2);
  assert.equal(yieldMultiplier("n".repeat(15).split("")), 4);
  assert.equal(yieldMultiplier("n".repeat(19).split("")), 4);
  assert.equal(yieldMultiplier("n".repeat(20).split("")), 8);
  assert.equal(yieldMultiplier("n".repeat(30).split("")), 8);
});

test("yieldMultiplier: one landing in the last ten counted ticks resets it to 1", () => {
  // A landing anywhere in the recent window is the evidence the clock trusts — even with
  // nine empties stacked in front of it.
  assert.equal(yieldMultiplier("nnnnnnnnnL".split("")), 1);
  assert.equal(yieldMultiplier(("n".repeat(19) + "L").split("")), 1);
  // But a landing older than the last ten does not: it has aged out of the recent window,
  // and the empties since it are what the clock now answers for (nineteen empties → ×4).
  assert.equal(yieldMultiplier(("L" + "n".repeat(19)).split("")), 4);
  // A landing exactly ten ticks back is still inside the recent window — the tenth entry.
  assert.equal(yieldMultiplier(("nnnnnnnnnnL" + "n".repeat(9)).split("")), 1);
});

test("applyTickOutcome maintains the yield ring: landings and empties recorded, the error class skipped", () => {
  const s = freshLoopState("perf");
  // Read through a fresh call each time: the assertions below must see the ring as
  // applyTickOutcome left it, not a narrowed snapshot of an earlier value.
  const ringOf = (): string => s.recentOutcomes ?? "";
  applyTickOutcome(s, testConfig(), "perf", { result: "no_change" });
  assert.equal(s.recentOutcomes, "n");
  applyTickOutcome(s, testConfig(), "perf", { result: "refused" });
  applyTickOutcome(s, testConfig(), "perf", { result: "rejected" });
  assert.equal(s.recentOutcomes, "nnn", "every non-landing counted result is an empty");
  applyTickOutcome(s, testConfig(), "perf", { result: "error" });
  applyTickOutcome(s, testConfig(), "perf", { result: "aborted" });
  applyTickOutcome(s, testConfig(), "perf", { result: "quiet_killed" });
  assert.equal(s.recentOutcomes, "nnn", "the error class is no yield evidence — neither raises nor resets");
  applyTickOutcome(s, testConfig(), "perf", { result: "queued" });
  applyTickOutcome(s, testConfig(), "perf", { result: "changed" });
  assert.equal(s.recentOutcomes, "nnnLL", "a landing (changed or queued) records L");
  // The ring is bounded: past YIELD_RING the oldest entries fall off.
  for (let i = 0; i < YIELD_RING; i++) applyTickOutcome(s, testConfig(), "perf", { result: "no_change" });
  assert.equal(ringOf().length, YIELD_RING);
  assert.equal(ringOf(), "n".repeat(YIELD_RING));
  // And a full ring of empties is exactly the cap-earning state the multiplier reads.
  assert.equal(yieldMultiplier(ringOf().split("")), 8);
});

// --- Post-tick outcome recording + next-run scheduling (extracted from LoopRunner.tick) ---

/** A queued tick's pinned commit — the key its stashed summary is filed under. */
const PINNED = "a".repeat(40);

/** A config with a small idle backoff so the assertions below stay readable. */
function testConfig(): TumwaterConfig {
  const cfg = defaultConfig(); // minTickIntervalSeconds: 20
  cfg.idleBackoff = { initialSeconds: 30, factor: 2, maxSeconds: 3600 };
  return cfg;
}

test("applyTickOutcome records the outcome and schedules a changed tick at the role's minimum interval", () => {
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review"; // set around the gate's run — must not linger after the tick
  s.commits = 4;
  s.lastApprovedPatchId = "p1"; // a leftover-recovery landing's approval, spent once it lands
  const cfg = testConfig();
  const before = Date.now();
  applyTickOutcome(s, cfg, "feature", { result: "changed", summary: "did it" });
  assert.equal(s.running, false);
  assert.equal(s.phase, undefined);
  assert.equal(s.lastApprovedPatchId, undefined);
  assert.equal(s.lastResult, "changed");
  assert.equal(s.lastSummary, "did it");
  const endedAt = s.lastTickEndedAt;
  assert.ok(endedAt !== undefined && endedAt >= before && endedAt <= Date.now(), "lastTickEndedAt stamped");
  assert.equal(s.commits, 5);
  assert.equal(s.backoffSeconds, 0);
  assert.ok(
    s.nextRunAt >= before + 20_000 && s.nextRunAt <= Date.now() + 20_000,
    "waits at least the minimum interval",
  );
});

test("applyTickOutcome: rejected and skipped ticks wait the minimum interval without counting a commit", () => {
  for (const result of ["rejected", "skipped"] as const) {
    const s = freshLoopState(result === "rejected" ? "feature" : "director");
    s.commits = 2;
    applyTickOutcome(s, testConfig(), s.role, { result });
    assert.equal(s.lastResult, result);
    assert.equal(s.commits, 2, `${result} lands nothing on main`);
    assert.equal(s.backoffSeconds, 0);
    assert.ok(
      s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 21_000,
      `next run is due after the minimum interval (${result})`,
    );
  }
});

test("applyTickOutcome: a queued tick schedules like a change without counting a commit", () => {
  // Merge queue 3/5: the tick committed and enqueued — productive work, so the minimum-interval
  // schedule applies — but `commits` keeps meaning "landed on main": applyLandingOutcome
  // increments it when the landing slot actually merges.
  const s = freshLoopState("feature");
  s.commits = 4;
  s.phase = "review"; // any marker from around the pin — must not linger after the tick
  s.lastResult = "refused";
  s.lastSummary = "objected to the plan";
  applyTickOutcome(s, testConfig(), "feature", { result: "queued", summary: "did it", commit: PINNED });
  // `queued` is in-flight work, not a completed result (BUGS.md 2026-09-23): the last-result
  // pair keeps the prior outcome WITH its own summary — the queued tick's summary must not be
  // shown beside a result it did not produce — and the summary is stashed, keyed by the pinned
  // sha, for the landing to pair with its result.
  assert.equal(s.lastResult, "refused", "the prior completed result stays while the change is pending");
  assert.equal(s.lastSummary, "objected to the plan", "…next to its own summary");
  assert.deepEqual(s.queuedSummary, { sha: PINNED, summary: "did it" });
  assert.ok(s.lastTickEndedAt !== undefined, "the tick itself did end");
  assert.equal(s.commits, 4, "the commit is not counted until it lands");
  assert.equal(s.backoffSeconds, 0);
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 21_000,
    "next run is due after the minimum interval",
  );
});

test("applyLandingOutcome folds the landing's result into the authoring state", () => {
  const change = { sha: PINNED, summary: "did it" };
  // A landed change counts the commit the tick queued and clears the gate's phase marker.
  const s = freshLoopState("feature");
  s.phase = "review";
  s.lastApprovedPatchId = "p1";
  applyLandingOutcome(s, "changed", change);
  assert.equal(s.lastResult, "changed");
  assert.equal(s.commits, 1);
  assert.equal(s.phase, undefined);
  // The landed patch's approval is spent: the same patch authored again is a new change.
  assert.equal(s.lastApprovedPatchId, undefined);

  // Non-terminal outcomes record the failure, count no commit, and clear the marker — the
  // retry rides next-tick leftover recovery, so the state just has to show the failure.
  for (const result of ["rejected", "review_error", "merge_conflict", "merge_blocked", "error"] as const) {
    const n = freshLoopState("feature");
    n.lastApprovedPatchId = "p1";
    applyLandingOutcome(n, result, change);
    assert.equal(n.lastResult, result);
    assert.equal(n.commits, 0, `${result} lands nothing on main`);
    assert.equal(n.phase, undefined);
    // Nothing landed, so the approval stands: a re-land whose rebase leaves the patch alone reuses it.
    assert.equal(n.lastApprovedPatchId, "p1", `${result} keeps the patch-id approval`);
  }

  // An aborted landing keeps the marker: a shutdown mid-review must re-review the pinned work
  // fresh on the next launch, and the dashboard shows the landing as interrupted, not done.
  const a = freshLoopState("feature");
  a.phase = "review";
  applyLandingOutcome(a, "aborted", change);
  assert.equal(a.lastResult, "aborted");
  assert.equal(a.commits, 0);
  assert.equal(a.phase, "review");
});

// A pin that keeps failing to merge used to re-queue forever (land-queue speed 3c made recovery
// re-queue instead of the next authored commit dropping it): the streak leftover recovery caps
// counts consecutive merge_conflict landings of ONE sha.
test("applyLandingOutcome counts consecutive merge conflicts per pinned sha", () => {
  const s = freshLoopState("feature");
  applyLandingOutcome(s, "merge_conflict", { sha: "aaa", summary: "x" });
  applyLandingOutcome(s, "merge_conflict", { sha: "aaa", summary: "x" });
  assert.deepEqual(s.mergeConflicts, { sha: "aaa", count: 2 });
  // Outcomes that keep the pin as it was leave the count standing.
  for (const result of ["review_error", "merge_blocked", "main_red", "aborted"] as const) {
    applyLandingOutcome(s, result, { sha: "aaa", summary: "x" });
  }
  assert.deepEqual(s.mergeConflicts, { sha: "aaa", count: 2 });
  applyLandingOutcome(s, "merge_conflict", { sha: "aaa", summary: "x" });
  assert.deepEqual(s.mergeConflicts, { sha: "aaa", count: 3 });
  // A different sha (the pin rebased cleanly onto a moved main) is a new attempt.
  applyLandingOutcome(s, "merge_conflict", { sha: "bbb", summary: "x" });
  assert.deepEqual(s.mergeConflicts, { sha: "bbb", count: 1 });
  // Landing or rejection ends the pin's life, and the streak with it.
  for (const result of ["changed", "rejected"] as const) {
    const n = freshLoopState("feature");
    n.mergeConflicts = { sha: "aaa", count: 2 };
    n.landingCheckFailures = { patchId: "p1", count: 1 };
    applyLandingOutcome(n, result, { sha: "aaa", summary: "x" });
    assert.equal(n.mergeConflicts, undefined, `${result} clears the streak`);
    assert.equal(n.landingCheckFailures, undefined, `${result} clears the red-landing-check streak`);
  }
});

test("the conflict-discard note is cleared once the role queues or lands its next change", () => {
  for (const result of ["queued", "changed"] as const) {
    const s = freshLoopState("feature");
    s.conflictDiscard = { sha: "aaa", summary: "old work", attempts: 3, at: 1 };
    applyTickOutcome(s, testConfig(), "feature", { result, summary: "new work", commit: "ccc" });
    assert.equal(s.conflictDiscard, undefined, `${result} delivers the note`);
  }
  // A tick that produced nothing keeps it for the next prompt.
  const s = freshLoopState("feature");
  s.conflictDiscard = { sha: "aaa", summary: "old work", attempts: 3, at: 1 };
  applyTickOutcome(s, testConfig(), "feature", { result: "error", summary: "pi died" });
  assert.deepEqual(s.conflictDiscard, { sha: "aaa", summary: "old work", attempts: 3, at: 1 });
});

test("a resolved landing pairs its result with the summary of the change it landed", () => {
  // BUGS.md 2026-09-23, the second window: the queued tick held its summary back, so the
  // landing's result must arrive with THAT summary — never beside the prior tick's.
  for (const result of ["changed", "rejected", "merge_conflict", "aborted"] as const) {
    const s = freshLoopState("feature");
    applyTickOutcome(s, testConfig(), "feature", { result: "no_change", summary: "found nothing" });
    applyTickOutcome(s, testConfig(), "feature", {
      result: "queued",
      summary: "did it (high friction: 90 turns / 45m)",
      commit: PINNED,
    });
    applyLandingOutcome(s, result, { sha: PINNED, summary: "did it" });
    assert.equal(s.lastResult, result);
    assert.equal(
      s.lastSummary,
      "did it (high friction: 90 turns / 45m)",
      `the tick's own summary — annotation included — pairs with ${result}`,
    );
    assert.equal(s.queuedSummary, undefined, "the stash is consumed by the landing");
  }

  // No stash for this sha — a crash between enqueue and the tick's state save, or a landing
  // that resolved before its tick's outcome was applied: the entry's own summary names the
  // change, so the prior tick's summary still never pairs with the landing's result.
  const lost = freshLoopState("feature");
  lost.lastResult = "no_change";
  lost.lastSummary = "found nothing";
  applyLandingOutcome(lost, "changed", { sha: PINNED, summary: "did it" });
  assert.equal(lost.lastSummary, "did it");
  const other = freshLoopState("feature");
  other.queuedSummary = { sha: "c".repeat(40), summary: "some other change" };
  applyLandingOutcome(other, "changed", { sha: PINNED, summary: "did it" });
  assert.equal(other.lastSummary, "did it", "a stash naming another sha is not this change's");
  assert.equal(other.queuedSummary, undefined);
});

test("any completed tick clears a stale queued-summary stash", () => {
  // A role with a queued landing never ticks, so a stash that survives to a later tick names a
  // change that is no longer waiting: the completed tick records its own pair and drops it.
  const s = freshLoopState("feature");
  s.queuedSummary = { sha: PINNED, summary: "did it" };
  applyTickOutcome(s, testConfig(), "feature", { result: "no_change", summary: "found nothing" });
  assert.equal(s.lastResult, "no_change");
  assert.equal(s.lastSummary, "found nothing");
  assert.equal(s.queuedSummary, undefined);
});

test("applyTickOutcome: an aborted tick resumes promptly — role via resumePending, director via re-queue", () => {
  const s = freshLoopState("feature");
  s.phase = "review"; // interruption hit mid-review: the next launch must recover + re-review
  applyTickOutcome(s, testConfig(), "feature", { result: "aborted" });
  assert.equal(s.resumePending, true);
  assert.equal(s.phase, "review", "kept so recovery re-reviews instead of resuming the author session");
  assert.ok(Math.abs(s.nextRunAt - Date.now()) < 5_000, "due immediately on restart");

  const d = freshLoopState("director");
  applyTickOutcome(d, testConfig(), "director", { result: "aborted" });
  assert.equal(d.resumePending, undefined, "the director reruns its re-queued prompt fresh");
});

test("applyTickOutcome: a user-aborted tick backs off like an unproductive one and sets no resume", () => {
  // A deliberate stop is not an interruption: the worktree was already reset to main, so there
  // is nothing to recover or re-review — idle backoff applies instead of prompt resume.
  const s = freshLoopState("feature");
  s.phase = "review"; // set around the gate's run — must not linger after a user-abort either
  applyTickOutcome(s, testConfig(), "feature", { result: "user_aborted" });
  assert.equal(s.lastResult, "user_aborted");
  assert.equal(s.resumePending, undefined, "a deliberate stop leaves nothing to resume");
  assert.equal(s.phase, undefined);
  assert.equal(s.backoffSeconds, 30, "initial idle backoff, like an unproductive tick");
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 31_000,
    "due after the backoff, not immediately",
  );

  // A second user-abort grows the backoff like any other unproductive tick.
  const s2 = freshLoopState("feature");
  s2.backoffSeconds = 30;
  applyTickOutcome(s2, testConfig(), "feature", { result: "user_aborted" });
  assert.equal(s2.backoffSeconds, 60); // 30 × factor 2
});

test("applyTickOutcome: cut-off ticks resume the compacted session until the streak limit, then back off", () => {
  const cfg = testConfig();
  // Under the limit (3): each consecutive cut-off resumes promptly and grows the streak.
  for (let streak = 0; streak < 3; streak++) {
    const s = freshLoopState("feature");
    s.cutOffStreak = streak;
    applyTickOutcome(s, cfg, "feature", { result: "no_change", cutOff: true });
    assert.equal(s.resumePending, true, `cut-off ${streak + 1} resumes`);
    assert.equal(s.cutOffStreak, streak + 1);
    assert.equal(s.backoffSeconds, 0, "a cut-off is not idleness");
    assert.ok(s.nextRunAt <= Date.now() + 21_000);
  }
  // Past the limit: give up on the task — normal backoff, no resume. The streak keeps counting
  // (only a non-cut-off tick clears it): the next fresh tick's prompt names how many attempts
  // the window has eaten (buildCutOffNote), and the next cut-off also backs off.
  const s = freshLoopState("feature");
  s.cutOffStreak = 3;
  applyTickOutcome(s, cfg, "feature", { result: "no_change", cutOff: true });
  assert.equal(s.resumePending, undefined);
  assert.equal(s.backoffSeconds, 30); // initial backoff
  assert.equal(s.cutOffStreak, 4);
});

test("applyTickOutcome: quiet kills resume the starved session until the streak limit, then back off", () => {
  const cfg = testConfig();
  // Under the limit (3): each consecutive kill resumes promptly and grows the streak.
  for (let streak = 0; streak < 3; streak++) {
    const s = freshLoopState("feature");
    s.quietKillStreak = streak;
    applyTickOutcome(s, cfg, "feature", { result: "quiet_killed" });
    assert.equal(s.resumePending, true, `quiet kill ${streak + 1} resumes`);
    assert.equal(s.resumeCause, "hung-tool");
    assert.equal(s.quietKillStreak, streak + 1);
    assert.equal(s.backoffSeconds, 0, "a quiet kill is not idleness");
    assert.ok(s.nextRunAt <= Date.now() + 1_000, "resumes promptly");
  }
  // Past the limit: abandon the starved session and take a fresh tick on the idle ladder
  // (BUGS.md 2026-09-18). Before the fix the branch resumed forever with no backoff.
  const s = freshLoopState("feature");
  s.quietKillStreak = 3;
  applyTickOutcome(s, cfg, "feature", { result: "quiet_killed" });
  assert.equal(s.resumePending, false, "no resume — the next tick starts fresh");
  assert.equal(s.resumeCause, undefined);
  assert.equal(s.backoffSeconds, 30); // idle initial
  assert.equal(s.quietKillStreak, 4, "the streak keeps counting for the warning note");
});

test("applyTickOutcome: any non-quiet-kill outcome resets the quiet-kill streak", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  s.quietKillStreak = 2;
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.quietKillStreak, 0);
  // The error streak and the quiet-kill streak stay independent: an error resets one
  // without arming the other.
  applyTickOutcome(s, cfg, "feature", { result: "error" });
  assert.equal(s.quietKillStreak, 0);
  assert.equal(s.consecutiveErrors, 1);
});

test("applyTickOutcome: other unproductive outcomes grow the idle backoff and clear the cut-off streak", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  s.backoffSeconds = 30;
  s.cutOffStreak = 2; // a prior cut-off — this tick finished normally, so it resets
  applyTickOutcome(s, cfg, "feature", { result: "merge_conflict" });
  assert.equal(s.lastResult, "merge_conflict");
  assert.equal(s.backoffSeconds, 60); // 30 × factor 2
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 61_000,
    "due after the grown backoff",
  );
  assert.equal(s.cutOffStreak, 0);

  // A summary-less outcome keeps the previous lastSummary (stale beats wiped).
  const s2 = freshLoopState("feature");
  s2.lastSummary = "previous";
  applyTickOutcome(s2, cfg, "feature", { result: "no_change" });
  assert.equal(s2.lastSummary, "previous");
});

test("applyTickOutcome: an observer's no_change schedules at its interval without climbing the idle ladder", () => {
  // plans/observer-roles.md 1/2: qa's no_change means "checked, all well", so it must not be
  // punished with a doubling sleep. The interval is the only cadence knob left for it.
  const cfg = testConfig(); // minTickIntervalSeconds: 20
  for (const role of OBSERVER_ROLES) {
    const s = freshLoopState(role);
    s.backoffSeconds = 300; // a grown backoff from an earlier episode — must reset, not build on it
    const before = Date.now();
    applyTickOutcome(s, cfg, role, { result: "no_change" });
    assert.equal(s.backoffSeconds, 0, `${role}: a passing check leaves no backoff`);
    assert.ok(
      s.nextRunAt >= before + 20_000 && s.nextRunAt <= Date.now() + 20_000,
      `${role}: scheduled at minTickIntervalSeconds, not the idle ladder`,
    );
  }
  // A non-observer's no_change still climbs the idle ladder, byte-identical to before.
  const s = freshLoopState("organize");
  s.backoffSeconds = 30;
  applyTickOutcome(s, cfg, "organize", { result: "no_change" });
  assert.equal(s.backoffSeconds, 60);
});

test("applyTickOutcome: an observer still climbs the error ladder and idles on a user-abort", () => {
  // The idle branch is the only one the observer predicate reaches: a broken toolchain and a
  // deliberate operator stop keep the ordinary backoff (invariant 1 of plans/observer-roles.md).
  const cfg = testConfig();
  for (const role of OBSERVER_ROLES) {
    const err = freshLoopState(role);
    applyTickOutcome(err, cfg, role, { result: "error", summary: "git is broken" });
    assert.equal(err.backoffSeconds, 30, `${role}: a broken toolchain still parks it`);
    assert.ok(err.nextRunAt <= Date.now() + 31_000, `${role}: retries on the short error ladder`);

    const aborted = freshLoopState(role);
    applyTickOutcome(aborted, cfg, role, { result: "user_aborted" });
    assert.equal(aborted.backoffSeconds, 30, `${role}: a deliberate stop still backs off`);
  }
});

// --- Error ladder: a failed tick retries in minutes, never the idle ladder's cap
// (BUGS.md 2026-09-15: one broken `git` parked the whole fleet for hours) ---

test("applyTickOutcome: consecutive error ticks climb a short ladder capped in minutes", () => {
  const cfg = testConfig();
  const s = freshLoopState("bugfix");
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    applyTickOutcome(s, cfg, "bugfix", { result: "error", summary: "git is broken" });
    seen.push(s.backoffSeconds);
  }
  // 30 → 60 → 120 → 240 → 480, then pinned at the error cap — free failures must never
  // reach the idle ladder's 10-hour sleep.
  assert.deepEqual(seen, [30, 60, 120, 240, 480, 600, 600, 600, 600, 600]);
  assert.ok(s.backoffSeconds <= 600, "a minute-order cap, not the idle ladder's 10 h");
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 601_000,
    "the next retry is due within the error cap",
  );
  assert.equal(s.lastResult, "error");
  assert.equal(s.lastSummary, "git is broken", "the failure is observable in state");
});

test("applyTickOutcome: the error streak counts consecutive failures and resets on any other result", () => {
  const cfg = testConfig();
  const s = freshLoopState("clean");
  applyTickOutcome(s, cfg, "clean", { result: "no_change" });
  assert.equal(s.consecutiveErrors, 0, "a healthy tick leaves the streak at zero");
  applyTickOutcome(s, cfg, "clean", { result: "error", summary: "git is broken" });
  applyTickOutcome(s, cfg, "clean", { result: "error", summary: "git is broken" });
  assert.equal(s.consecutiveErrors, 2, "two consecutive failures");
  applyTickOutcome(s, cfg, "clean", { result: "no_change" });
  assert.equal(s.consecutiveErrors, 0, "one healthy tick breaks the episode");
  applyTickOutcome(s, cfg, "clean", { result: "error" });
  assert.equal(s.consecutiveErrors, 1, "the next episode re-arms from scratch");
});

test("applyTickOutcome: a recovery landing failure feeds the error streak on a healthy tick", () => {
  // BUGS.md 2026-09-21: a dead reviewer backend leaves every leftover pin failing to land
  // while the tick's own authoring run succeeds (`no_change`/`queued`). The streak must count
  // that landing failure, or it resets every tick and the alarm never fires.
  const cfg = testConfig();
  const s = freshLoopState("clean");
  applyTickOutcome(s, cfg, "clean", {
    result: "no_change",
    recoveryFailure: "review failed: no parseable VERDICT",
  });
  assert.equal(s.consecutiveErrors, 1, "the landing failure arms the streak");
  applyTickOutcome(s, cfg, "clean", {
    result: "queued",
    recoveryFailure: "review failed: no parseable VERDICT",
  });
  assert.equal(s.consecutiveErrors, 2, "a queued tick that also failed recovery keeps counting");
  // A tick with no recovery failure at all is healthy and breaks the episode.
  applyTickOutcome(s, cfg, "clean", { result: "no_change" });
  assert.equal(s.consecutiveErrors, 0, "a healthy tick with no landing failure resets the streak");
});

test("applyTickOutcome: no_change laddering is unchanged by the error ladder", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 30, "the first no-change tick takes the idle initial");
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 60, "the second doubles it, as before the fix");
  // The idle cap is still reachable for the case it was written for: an idle loop can
  // reach its full 3600 s ceiling, an error loop cannot.
  for (let i = 0; i < 20; i++) applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 3600);
});

test("applyTickOutcome: an error after idle backoff caps at the error ceiling, and productive ticks zero it", () => {
  const cfg = testConfig();
  // A loop deep in idle backoff that then fails its tick retries within the error cap,
  // not the idle cap — the ladders share backoffSeconds and each caps the step it takes.
  const s = freshLoopState("feature");
  s.backoffSeconds = 3600;
  applyTickOutcome(s, cfg, "feature", { result: "error" });
  assert.equal(s.backoffSeconds, 600); // min(3600 × 2, error cap 600)
  // A no-change tick after the error streak resumes the idle ladder from the current
  // value: backoff never shrinks below what the streak earned.
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 1200); // min(600 × 2, idle cap 3600)

  // A productive tick zeroes the backoff regardless of which ladder fed it.
  for (const result of ["changed", "rejected"] as const) {
    const z = freshLoopState("feature");
    z.backoffSeconds = 600;
    applyTickOutcome(z, cfg, "feature", { result });
    assert.equal(z.backoffSeconds, 0, `${result} zeroes the backoff`);
  }
});
