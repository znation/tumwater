import test from "node:test";
import assert from "node:assert/strict";
import { DEFER_MAX_MS, deferTick, dueForPrune, fairOrder, isEligible, workLanded } from "../src/scheduling.js";
import { OBSERVER_ROLES, ROLES } from "../src/roles.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/state.js";
import { makeRepo } from "./util.js";

/** Unit tests for the pure tick-scheduling policy in src/scheduling.ts — eligibility, fair
 * order, work-landed/deferral, and the once-per-day prune gate. Moved out of
 * orchestrator.e2e.test.ts, which now covers only the orchestrator runtime, so the policy module
 * has the module-named test file the rest of src/ follows and its pure tests run in their own
 * parallel process. */

function runner(role: string): LoopRunner {
  return new LoopRunner(makeRepo(), role, defaultConfig(), "main");
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

test("isEligible gates on the role's own interval, not the global knob", () => {
  const now = Date.now();

  // Large per-role override over a small global: the loop stays ineligible inside its own
  // (long) window even though nextRunAt has passed AND main moved. If isEligible read
  // config.minTickIntervalSeconds directly (20s), it would have woken here — sinceLast is
  // 21s, past the global gap.
  const slow = defaultConfig();
  slow.minTickIntervalSeconds = 20;
  slow.roles.steward!.minTickIntervalSeconds = 3600;
  const r1 = new LoopRunner(makeRepo(), "steward", slow, "main");
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
  const r2 = new LoopRunner(makeRepo(), "qa", fast, "main");
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
  assert.equal(deferTick(base, "organize", false, false, NOW), true);

  // Each condition flipped → no deferral.
  const workLandedSinceLast = { ...base };
  assert.equal(deferTick(workLandedSinceLast, "organize", true, false, NOW), false); // work landed
  const changed = { ...base, lastResult: "changed" as const };
  assert.equal(deferTick(changed, "organize", false, false, NOW), false);
  for (const result of ["rejected", "error", "refused", "merge_conflict"] as const) {
    assert.equal(deferTick({ ...base, lastResult: result }, "organize", false, false, NOW), false);
  }
  const unseen = { ...base, lastMainHead: "" };
  assert.equal(deferTick(unseen, "organize", false, false, NOW), false); // never ticked → first tick runs

  // Work-tier roles and unknown/custom roles never defer, even with no_change + no work.
  for (const role of ["feature", "bugfix", "plan", "director", "my-custom-loop"]) {
    assert.equal(deferTick(base, role, false, false, NOW), false);
  }
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
        assert.equal(
          deferTick(s, role, work, backlog, NOW),
          false,
          `${role} (work=${work}, backlog=${backlog}) never defers`,
        );
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
  assert.equal(deferTick(base, "organize", true, true, NOW), true);
  assert.equal(deferTick(base, "organize", false, true, NOW), true);

  // Pending business (any non-no_change outcome) never defers, backlog open or not — a loop's
  // own unfinished work must not stall behind the fleet's.
  for (const result of ["changed", "rejected", "error", "refused", "merge_conflict"] as const) {
    assert.equal(deferTick({ ...base, lastResult: result }, "organize", true, true, NOW), false);
    assert.equal(deferTick({ ...base, lastResult: result }, "organize", false, true, NOW), false);
  }

  // Never-ticked roles and work/custom roles are unaffected by the backlog.
  assert.equal(deferTick({ ...base, lastMainHead: "" }, "organize", true, true, NOW), false);
  for (const role of ["feature", "bugfix", "plan", "director", "my-custom-loop"]) {
    assert.equal(deferTick(base, role, true, true, NOW), false);
  }
});

test("deferTick: a deferral that outlasts DEFER_MAX_MS stops deferring (the latch)", () => {
  const base = freshLoopState("organize");
  base.lastResult = "no_change";
  base.lastMainHead = "abc123";
  base.nextRunAt = 1_000_000;
  // Just due: deferred (backlog open, no work landed).
  assert.equal(deferTick(base, "organize", false, true, 1_000_000), true);
  // Still inside the window: deferred.
  assert.equal(deferTick(base, "organize", false, true, 1_000_000 + DEFER_MAX_MS - 1), true);
  // Past the window: the due tick runs regardless, refreshing lastResult and breaking the
  // no_change → defer → no_change cycle. This is the regression for the permanent latch.
  assert.equal(deferTick(base, "organize", false, true, 1_000_000 + DEFER_MAX_MS), false);
  assert.equal(deferTick(base, "organize", true, true, 1_000_000 + DEFER_MAX_MS), false);
  // A never-scheduled role (nextRunAt 0) is never expired by the cap.
  assert.equal(deferTick({ ...base, nextRunAt: 0 }, "organize", false, true, 1_000_000 + DEFER_MAX_MS), true);
});

test("dueForPrune: the once-per-day gate with fake timestamps", () => {
  const day = 24 * 3600 * 1000;
  // Due when a full day has passed since the last prune.
  assert.equal(dueForPrune(1_000, 1_000 + day, 7), true);
  // Not due within a day — one millisecond short is still inside the window.
  assert.equal(dueForPrune(1_000, 1_000 + day - 1, 7), false);
  // Never due at retention 0, whether or not a prune has run before.
  assert.equal(dueForPrune(null, Number.MAX_SAFE_INTEGER, 0), false);
  assert.equal(dueForPrune(1_000, 1_000 + day * 2, 0), false);
  // Never pruned (null) → immediately due when retention is positive.
  assert.equal(dueForPrune(null, 1_000, 7), true);
});
