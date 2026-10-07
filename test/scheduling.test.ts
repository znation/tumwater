import test from "node:test";
import assert from "node:assert/strict";
import { DEFER_MAX_MS, deferTick, deferTickReason, fairOrder, isEligible, workLanded } from "../src/scheduling/scheduling.js";
import { configForRole } from "../src/config/config-views.js";
import { OBSERVER_ROLES, ROLES } from "../src/roles/roles.js";
import { LoopRunner } from "../src/loop/loop.js";
import { defaultConfig } from "../src/config/config.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { clearBackoff } from "../src/scheduling/backoff.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";

/** Unit tests for the pure tick-scheduling policy in src/scheduling/scheduling.ts — eligibility, fair
 * order, and work-landed/deferral. Moved out of
 * orchestrator.e2e.test.ts, which now covers only the orchestrator runtime, so the policy module
 * has the module-named test file the rest of src/ follows and its pure tests run in their own
 * parallel process. */

function runner(role: string): LoopRunner {
  return makeLoopRunner(makeRepo(), role);
}

test("a fresh loop is eligible at startup", () => {
  const r = runner("clean");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, true);
});

test("a running or recently-finished loop is not eligible", () => {
  const r = runner("clean");
  r.state.running = true;
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  r.state.running = false;
  r.state.lastTickEndedAt = Date.now();
  r.state.nextRunAt = 0;
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
});

test("a sleeping loop wakes when main moves, respecting the min gap", () => {
  const r = runner("clean");
  const now = Date.now();
  const gap = r.config.minTickIntervalSeconds * 1000;
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - gap - 1000;
  r.state.nextRunAt = now + 60_000;
  r.state.lastMainHead = "old";
  assert.equal(isEligible(r, now, "old", 0).run, false);
  const woken = isEligible(r, now, "new", 0);
  assert.equal(woken.run, true);
  assert.equal(woken.reason, "main moved");
  // But not if it just finished a tick.
  r.state.lastTickEndedAt = now - 1000;
  assert.equal(isEligible(r, now, "new", 0).run, false);
});

test("yield scaling stretches a quiet search role's gap — including the main-moved wake", () => {
  // Yield-scaled clocks (PLANS.md): sixteen consecutive counted empties earn ×4, so a
  // role with a 20 s clock must not tick — on schedule or on a main move — until 80 s
  // have passed since its last tick, even though nextRunAt is long past.
  const r = runner("clean");
  const now = Date.now();
  const gap = configForRole(r.config, "clean").minTickIntervalSeconds * 1000; // 20 s
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - 3 * gap; // past the plain gap, inside the stretched one
  r.state.nextRunAt = now + 60_000; // the main-moved branch is only reached past nextRunAt
  r.state.lastMainHead = "old";
  r.state.recentOutcomes = "n".repeat(16);
  assert.equal(isEligible(r, now, "abc", 0).run, false, "held inside the stretched gap");
  assert.equal(isEligible(r, now, "new", 0).run, false, "a main move does not cut the stretch");
  // Past the stretched gap the wake fires again.
  r.state.lastTickEndedAt = now - (4 * gap + 1);
  const due = isEligible(r, now, "new", 0);
  assert.equal(due.run, true);
  assert.equal(due.reason, "main moved");
});

test("yield scaling: a wake and a queued prompt bypass the stretch; observers scale too", () => {
  const r = runner("clean");
  const now = Date.now();
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - 1000; // deep inside any stretched gap
  r.state.nextRunAt = now + 60_000;
  r.state.recentOutcomes = "n".repeat(20); // ×8
  assert.equal(isEligible(r, now, "abc", 0).run, false);
  // A queued per-role prompt never reaches the gap check at all.
  assert.equal(isEligible(r, now, "abc", 1).run, true, "inbox bypasses the stretch");
  // An operator wake is an explicit demand: it overrides the gap exactly as it overrides
  // the plain one (the gap exemption alone does not make the loop due — the wake test
  // above pairs it with a past nextRunAt, and so does this one).
  r.state.wokenAt = now;
  r.state.nextRunAt = now - 1000;
  assert.equal(isEligible(r, now, "abc", 0).run, true);
  r.state.wokenAt = undefined;
  // The observers are scalable: qa's two-hour clock stretches to sixteen hours at ×8.
  const q = runner("qa");
  q.state.ticks = 1;
  q.state.lastTickEndedAt = now - 2 * 3600_000; // past qa's plain clock
  q.state.nextRunAt = now + 3600_000;
  q.state.recentOutcomes = "n".repeat(20);
  assert.equal(isEligible(q, now, "abc", 0).run, false, "qa's stretched clock holds");
});

test("yield scaling never applies to feature, plan, or the director", () => {
  const now = Date.now();
  for (const role of ["feature", "plan"]) {
    const r = runner(role);
    const gap = configForRole(r.config, role).minTickIntervalSeconds * 1000;
    r.state.ticks = 1;
    r.state.lastTickEndedAt = now - gap - 1000; // past the PLAIN gap
    r.state.nextRunAt = now - 1000;
    r.state.recentOutcomes = "n".repeat(20); // would be ×8 if the role scaled
    assert.equal(isEligible(r, now, "abc", 0).run, true, `${role} keeps its plain gap`);
  }
});

test("an operator wake newer than the last tick overrides the min gap", () => {
  // qa's default clock is two hours: a loop that ticked five minutes ago is inside its own
  // gap window even with backoffSeconds 0 — exactly the state `tumwater wake --role qa`
  // (and a queued per-role prompt's auto-wake) must be able to pull out of.
  const r = runner("qa");
  const now = Date.now();
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - 5 * 60 * 1000;
  r.state.nextRunAt = now + 2 * 3600 * 1000;
  r.state.backoffSeconds = 0;
  r.state.lastMainHead = "abc";
  assert.equal(isEligible(r, now, "abc", 0).run, false, "asleep inside its own gap");
  // What requestWake and runner.wake() both do:
  Object.assign(r.state, clearBackoff(r.state, now));
  const woken = isEligible(r, now, "abc", 0);
  assert.equal(woken.run, true, "the wake brings the loop in within one poll");
  assert.equal(woken.reason, "scheduled");
});

test("a wake older than the last tick restores the ordinary min gap", () => {
  // Self-clearing: the tick the wake caused re-stamps lastTickEndedAt past wokenAt, so a
  // stale wake must not keep exempting every later gap window.
  const r = runner("qa");
  const now = Date.now();
  r.state.ticks = 2;
  r.state.wokenAt = now - 10 * 60 * 1000;
  r.state.lastTickEndedAt = now - 5 * 60 * 1000;
  r.state.nextRunAt = now + 2 * 3600 * 1000;
  r.state.backoffSeconds = 0;
  r.state.lastMainHead = "abc";
  assert.equal(isEligible(r, now, "abc", 0).run, false);
});

test("a queued per-role prompt is due by itself, past every schedule gate", () => {
  // The durable form of wake due-ness: the queue file, not the wake marker, carries the
  // demand. A wake consumed while a tick is in flight is clobbered by that tick's end-save
  // (wokenAt and nextRunAt both overwritten), but the prompt it enqueued survives — so a
  // loop inside a fresh min-gap, hours from its clock, even backing off, must run the
  // queued request on the first poll after its current tick ends.
  const r = runner("qa");
  const now = Date.now();
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - 5 * 60 * 1000;
  r.state.nextRunAt = now + 2 * 3600 * 1000;
  r.state.lastMainHead = "abc";
  assert.equal(isEligible(r, now, "abc", 0).run, false, "asleep inside its own gap");
  const due = isEligible(r, now, "abc", 1);
  assert.equal(due.run, true, "the queued prompt pulls the loop in");
  assert.equal(due.reason, "inbox");
  // A raised backoff ladder does not hold a user request either — the director's inbox
  // never waited for one.
  r.state.backoffSeconds = 900;
  assert.equal(isEligible(r, now, "abc", 1).run, true, "backoff does not gate a queued prompt");
});

test("a queued per-role prompt does not preempt a pending resume's deliberate wait", () => {
  // A resuming tick assembles buildResumePrompt and never dequeues the per-role queue, so
  // letting the inbox check fire here would only resume sooner than its cut-off wait while
  // still not running the prompt. It stays queued for the fresh tick the resume's end makes
  // due immediately.
  const r = runner("qa");
  const now = Date.now();
  r.state.resumePending = true;
  r.state.nextRunAt = now + 2 * 3600 * 1000;
  assert.equal(isEligible(r, now, "abc", 1).run, false);
  assert.equal(isEligible(r, now, "abc", 1).reason, undefined);
});

test("isEligible gates on the role's own interval, not the global knob", () => {
  const now = Date.now();

  // Large per-role override over a small global: the loop stays ineligible inside its own
  // (long) window even though nextRunAt has passed AND main moved. If isEligible read
  // config.minTickIntervalSeconds directly (20s), it would have woken here — sinceLast is
  // 21s, past the global gap.
  const slow = defaultConfig();
  slow.minTickIntervalSeconds = 20;
  slow.roles.steward!.minTickIntervalSeconds = 3600;
  const r1 = makeLoopRunner(makeRepo(), "steward", slow);
  r1.state.ticks = 1;
  r1.state.lastTickEndedAt = now - 21_000; // past the global gap, deep inside the role's own
  r1.state.nextRunAt = now - 1000; // its schedule has passed too
  r1.state.lastMainHead = "old";
  assert.equal(
    isEligible(r1, now, "new", 0).run,
    false,
    "the per-role gap must gate main-moved wakes",
  );

  // The inverse: a small override over a large global wakes at the shorter value. If
  // isEligible read config.minTickIntervalSeconds directly (3600s), it would still be
  // asleep here — sinceLast is only 21s.
  const fast = defaultConfig();
  fast.minTickIntervalSeconds = 3600;
  fast.roles.qa!.minTickIntervalSeconds = 20;
  const r2 = makeLoopRunner(makeRepo(), "qa", fast);
  r2.state.ticks = 1;
  r2.state.lastTickEndedAt = now - 21_000; // past the role's own gap, deep inside the global
  r2.state.nextRunAt = now + 60_000; // schedule NOT passed — only a main-moved wake can run it
  r2.state.lastMainHead = "old";
  const woken = isEligible(r2, now, "new", 0);
  assert.equal(woken.run, true, "the shorter per-role gap must allow the wake");
  assert.equal(woken.reason, "main moved");
});

test("an interrupted tick resumes promptly on restart despite the min gap", () => {
  const r = runner("clean");
  const now = Date.now();
  // Aborted (or crashed) moments ago — far inside the role's min gap, which would otherwise
  // hold its half-finished work for a full interval (e.g. the steward's ~6 h).
  r.state.ticks = 5;
  r.state.lastTickEndedAt = now - 1000;
  r.state.nextRunAt = now - 1000; // aborted ticks schedule at "now"
  r.state.resumePending = true;
  const eligible = isEligible(r, now, "abc", 0);
  assert.equal(eligible.run, true, "the min gap must not hold an interrupted tick");
  assert.equal(eligible.reason, "resume");
});

test("a cut-off resume still waits out its interval even with the min-gap bypass", () => {
  const r = runner("clean");
  const now = Date.now();
  r.state.ticks = 5;
  r.state.lastTickEndedAt = now - 1000; // inside the min gap
  r.state.nextRunAt = now + 60_000; // cut-off ticks schedule one interval out
  r.state.resumePending = true;
  assert.equal(isEligible(r, now, "abc", 0).run, false);
});

test("the director only runs when the inbox has work", () => {
  const r = runner("director");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  const eligible = isEligible(r, Date.now(), "abc", 2);
  assert.equal(eligible.run, true);
  assert.equal(eligible.reason, "inbox");
});

test("the director ignores the min gap and backoff: queued prompts run back to back", () => {
  const r = runner("director");
  const now = Date.now();
  r.state.lastTickEndedAt = now - 1000; // Just finished — a role loop would be gated.
  r.state.nextRunAt = now + 3600_000; // Even a (stale) backoff must not block prompts.
  assert.equal(isEligible(r, now, "abc", 1).run, true);
  assert.equal(isEligible(r, now, "abc", 0).run, false);
});

test("fairOrder puts the director first even when it ticked most recently", () => {
  const director = runner("director");
  director.state.lastTickEndedAt = 9999;
  const feature = runner("feature");
  feature.state.lastTickEndedAt = 1;
  const fresh = runner("clean");
  // The work tier (feature) now outranks maintenance (clean) whatever their recency.
  assert.deepEqual(
    fairOrder([fresh, feature, director]).map((r) => r.role),
    ["director", "feature", "clean"],
  );
});

test("role catalog puts shipping work before hygiene", () => {
  const ids = ROLES.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 4), ["feature", "bugfix", "plan", "readme"]);
  for (const hygiene of ["organize", "coverage", "clean", "dry"]) {
    assert.ok(ids.indexOf(hygiene) > ids.indexOf("readme"), `${hygiene} should rank below readme`);
  }
});

test("fairOrder orders the work tier ahead of maintenance; LRU (catalog order for fresh ties) within a tier", () => {
  const staleFeature = runner("feature");
  staleFeature.state.lastTickEndedAt = 1000; // A stale-ticked feature still outranks…
  const freshOrganize = runner("organize"); // …a never-ticked maintenance role.
  const recentClean = runner("clean");
  recentClean.state.lastTickEndedAt = 2000;
  const olderDry = runner("dry");
  olderDry.state.lastTickEndedAt = 1500; // Within-tier LRU: dry before clean.
  const freshImprove = runner("improve"); // Fresh tie with organize: input order decides.
  assert.deepEqual(
    fairOrder([staleFeature, recentClean, freshOrganize, olderDry, freshImprove]).map((r) => r.role),
    ["feature", "organize", "improve", "dry", "clean"],
  );
});

// --- Need-based prioritization (workLanded / deferTick) ---

test("workLanded: feature/bugfix/director and human subjects count; other roles do not", () => {
  assert.equal(workLanded(["tumwater(feature): land a plan"]), true);
  assert.equal(workLanded(["tumwater(bugfix): fix the crash"]), true);
  // A director commit is user-directed work: after a pure-director burst the maintenance
  // roles must resync, so it counts like feature/bugfix.
  assert.equal(workLanded(["tumwater(director): implement the request"]), true);
  // Markdown/hygiene landings are not work for a maintenance role to react to.
  assert.equal(
    workLanded([
      "tumwater(plan): write a plan",
      "tumwater(readme): sync status",
      "tumwater(steward): curate PLANS.md",
      "tumwater(organize): move module",
    ]),
    false,
  );
  // A human commit (no tumwater( prefix) is work: the world changed in a way the fleet
  // cannot generate itself.
  assert.equal(workLanded(["fix the flaky test by hand"]), true);
  assert.equal(
    workLanded(["tumwater(readme): sync", "tumwater(bugfix): fix it"]),
    true,
  );
  assert.equal(workLanded([]), false); // nothing landed since
});

test("deferTick: only a deferrable no_change role that has seen main and got no work defers", () => {
  const NOW = Date.now();
  const base = freshLoopState("organize");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  assert.equal(deferTick(base, "organize", false, false, false, NOW), true);

  // Each condition flipped → no deferral.
  const workLandedSinceLast = { ...base };
  assert.equal(deferTick(workLandedSinceLast, "organize", true, false, false, NOW), false); // work landed
  const changed = { ...base, lastResult: "changed" as const };
  assert.equal(deferTick(changed, "organize", false, false, false, NOW), false);
  for (const result of ["rejected", "error", "refused", "merge_conflict"] as const) {
    assert.equal(deferTick({ ...base, lastResult: result }, "organize", false, false, false, NOW), false);
  }
  const unseen = { ...base, lastMainHead: "" };
  assert.equal(deferTick(unseen, "organize", false, false, false, NOW), false); // never ticked → first tick runs

  // Work-tier roles and unknown/custom roles never defer, even with no_change + no work.
  // bugfix is the work-tier exception: it defers only while its backlog is empty (the tests
  // below), so with an open bug it sits in this list too.
  for (const role of ["feature", "plan", "director", "my-custom-loop"]) {
    assert.equal(deferTick(base, role, false, false, false, NOW), false);
  }
  assert.equal(deferTick(base, "bugfix", false, false, true, NOW), false);
});

test("deferTick: observers never defer, under every input", () => {
  // plans/observer-roles.md 1/2: an observer's input is the running product or the event log,
  // neither a function of whether main moved, so deferral's premise does not hold.
  const NOW = Date.now();
  for (const role of OBSERVER_ROLES) {
    const s = freshLoopState(role);
    s.lastResult = "no_change";
    s.lastMainHead = "abc123";
    for (const work of [false, true]) {
      for (const backlog of [false, true]) {
        for (const openBugs of [false, true]) {
          assert.equal(
            deferTick(s, role, work, backlog, openBugs, NOW),
            false,
            `${role} (work=${work}, backlog=${backlog}, openBugs=${openBugs}) never defers`,
          );
        }
      }
    }
  }
});

test("deferTick: an open backlog defers idle maintenance even when work landed; pending business never defers", () => {
  const NOW = Date.now();
  const base = freshLoopState("organize");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  // Backlog open → deferred regardless of the work-landed verdict.
  assert.equal(deferTick(base, "organize", true, true, false, NOW), true);
  assert.equal(deferTick(base, "organize", false, true, false, NOW), true);

  // Pending business (any non-no_change outcome) never defers, backlog open or not — a loop's
  // own unfinished work must not stall behind the fleet's.
  for (const result of ["changed", "rejected", "error", "refused", "merge_conflict"] as const) {
    assert.equal(deferTick({ ...base, lastResult: result }, "organize", true, true, false, NOW), false);
    assert.equal(deferTick({ ...base, lastResult: result }, "organize", false, true, false, NOW), false);
  }

  // Never-ticked roles and work/custom roles are unaffected by the backlog.
  assert.equal(deferTick({ ...base, lastMainHead: "" }, "organize", true, true, false, NOW), false);
  for (const role of ["feature", "plan", "director", "my-custom-loop"]) {
    assert.equal(deferTick(base, role, true, true, false, NOW), false);
  }
});

test("deferTickReason: names the clause that deferred — open backlog, else no work landed", () => {
  const NOW = Date.now();
  const base = freshLoopState("organize");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  // Backlog open → "backlog", with or without work landed (the caller short-circuits the query).
  assert.equal(deferTickReason(base, "organize", true, true, false, NOW), "backlog");
  assert.equal(deferTickReason(base, "organize", false, true, false, NOW), "backlog");
  // No backlog: the clause is the work-landed verdict — no work → "no-work", work → admitted.
  assert.equal(deferTickReason(base, "organize", false, false, false, NOW), "no-work");
  assert.equal(deferTickReason(base, "organize", true, false, false, NOW), null);
  // bugfix in search mode drops the backlog clause, so open plans still read "no-work".
  const search = freshLoopState("bugfix");
  search.lastResult = "no_change";
  search.lastMainHead = "abc123";
  assert.equal(deferTickReason(search, "bugfix", false, true, false, NOW), "no-work");
  assert.equal(deferTickReason(search, "bugfix", true, true, false, NOW), null);
  // Not a deferral at all → null (no clause to report).
  assert.equal(
    deferTickReason({ ...base, lastResult: "changed" as const }, "organize", false, true, false, NOW),
    null,
  );
});

test("deferTick: bugfix with no open bugs defers like a maintenance role", () => {
  const NOW = Date.now();
  const base = freshLoopState("bugfix");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  // Its backlog is empty by precondition (openBugsNow false), so the backlog-open clause is
  // dropped: it defers exactly while no feature/bugfix/director/human commit landed since its
  // last tick — including while PLANS.md has open plans (a backlog open elsewhere does not
  // stand in for the work-landed verdict, and a feature landing is exactly what creates bugs).
  assert.equal(deferTick(base, "bugfix", false, false, false, NOW), true);
  assert.equal(deferTick(base, "bugfix", false, true, false, NOW), true);
  assert.equal(deferTick(base, "bugfix", true, true, false, NOW), false); // work landed

  // Each shared condition still applies: a productive tick, pending business, a never-ticked
  // role, an unknown role, and the DEFER_MAX_MS cap all behave as for a maintenance role.
  assert.equal(deferTick({ ...base, lastResult: "changed" as const }, "bugfix", false, false, false, NOW), false);
  assert.equal(deferTick({ ...base, lastResult: "rejected" as const }, "bugfix", false, false, false, NOW), false);
  assert.equal(deferTick({ ...base, lastMainHead: "" }, "bugfix", false, false, false, NOW), false);
  const latch = { ...base, nextRunAt: 1_000_000 };
  assert.equal(deferTick(latch, "bugfix", false, false, false, 1_000_000 + DEFER_MAX_MS), false);

  // A fresh operator wake overrides the deferral, as for any deferrable role.
  base.lastTickEndedAt = NOW - 2000;
  const woken = clearBackoff(base, NOW - 500);
  woken.nextRunAt = NOW - 1000;
  assert.equal(deferTick(woken, "bugfix", false, false, false, NOW), false);
});

test("deferTick: bugfix with an open bug never defers, under any input", () => {
  const NOW = Date.now();
  const s = freshLoopState("bugfix");
  s.lastResult = "no_change";
  s.lastMainHead = "abc123";
  for (const work of [false, true]) {
    for (const backlog of [false, true]) {
      assert.equal(
        deferTick(s, "bugfix", work, backlog, true, NOW),
        false,
        `bugfix with an open bug (work=${work}, backlog=${backlog}) never defers`,
      );
    }
  }
});

test("deferTick: a deferral that outlasts DEFER_MAX_MS stops deferring (the latch)", () => {
  const base = freshLoopState("organize");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  base.nextRunAt = 1_000_000;
  // Just due: deferred (backlog open, no work landed).
  assert.equal(deferTick(base, "organize", false, true, false, 1_000_000), true);
  // Still inside the window: deferred.
  assert.equal(deferTick(base, "organize", false, true, false, 1_000_000 + DEFER_MAX_MS - 1), true);
  // Past the window: the due tick runs regardless, refreshing lastResult and breaking the
  // no_change → defer → no_change cycle. This is the regression for the permanent latch.
  assert.equal(deferTick(base, "organize", false, true, false, 1_000_000 + DEFER_MAX_MS), false);
  assert.equal(deferTick(base, "organize", true, true, false, 1_000_000 + DEFER_MAX_MS), false);
  // A never-scheduled role (nextRunAt 0) is never expired by the cap.
  assert.equal(deferTick({ ...base, nextRunAt: 0 }, "organize", false, true, false, 1_000_000 + DEFER_MAX_MS), true);
});

test("deferTick: a fresh operator wake overrides the need-based deferral (an explicit demand runs)", () => {
  const NOW = Date.now();
  const base = freshLoopState("clean");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  // A completed idle tick: the gap window opened 2 s ago.
  base.lastTickEndedAt = NOW - 2000;
  // The operator's wake, stamped 0.5 s ago by requestWake's clearBackoff — newer than the gap
  // window's opening tick, the same predicate isEligible's min-gap exemption keys on. This is
  // the exact state a consumed `tumwater wake --role clean` leaves (BUGS.md 2026-09-25):
  // without the wake honored here, the explicit "try again now" defers for up to DEFER_MAX_MS.
  const woken = clearBackoff(base, NOW - 500);
  woken.nextRunAt = NOW - 1000; // due on the clock too (the wake pulled it to now)
  assert.equal(deferTick(woken, "clean", false, false, false, NOW), false);
  // An open backlog does not keep the demanded tick parked either.
  assert.equal(deferTick(woken, "clean", false, true, false, NOW), false);
  // A wake older than the last tick's end was already consumed by the tick that ran after it:
  // that state is idle maintenance again, and still defers.
  const stale = clearBackoff(base, NOW - 5000);
  assert.equal(deferTick(stale, "clean", false, false, false, NOW), true);
});

test("once mode overrides the scheduled clock, not just the min gap", () => {
  const r = runner("clean");
  const now = Date.now();
  // State left by a productive daemon tick seconds ago: the min-interval clock is fresh —
  // scheduleAtMinInterval wrote nextRunAt a full interval away and left backoffSeconds 0.
  // Once mode exists for exactly this (`run --once` right after a daemon run), so the clock
  // must not gate the round: overriding only the gap check would leave the same interval
  // enforced through nextRunAt and the round would do nothing.
  Object.assign(r.state, {
    ticks: 1,
    lastResult: "changed",
    lastTickEndedAt: now - 5_000,
    lastMainHead: "abc",
    nextRunAt: now + 30 * 60 * 1000,
    backoffSeconds: 0,
  });
  assert.equal(isEligible(r, now, "abc", 0, { once: true }).run, true);
  // Without once the clock still gates: the daemon's own cadence is untouched.
  assert.equal(isEligible(r, now, "abc", 0).run, false);
});

test("once mode still honors a raised backoff, which shares nextRunAt with the clock", () => {
  const r = runner("clean");
  const now = Date.now();
  // A backed-off role (error or idle ladder): nextRunAt in the future AND backoffSeconds
  // raised — the only way to tell a backoff deadline from the scheduled clock.
  Object.assign(r.state, {
    ticks: 3,
    lastResult: "error",
    lastTickEndedAt: now - 5_000,
    nextRunAt: now + 60_000,
    backoffSeconds: 60,
  });
  assert.equal(isEligible(r, now, "abc", 0, { once: true }).run, false);
});
