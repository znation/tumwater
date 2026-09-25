import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckEvent,
  buildCheckSkipWarning,
  MERGE_SCOPES,
  SCOPE_WORDS,
  timedOutPhrase,
} from "../src/build-check-events.js";
import type { BuildCheckRun } from "../src/build-check.js";

// Unit pins for the presentation half of the build check (src/build-check-events.ts): the
// timeout wording, the environmental-skip warning, and the build_check event's shape. These
// are pure functions shared by four surfaces (gate, landing, batch, red-main baseline), so a
// wording regression here mislabels the feed everywhere at once — including the false
// "timed out after 300s" claim BUGS.md 2026-09-21 recorded.

// --- timedOutPhrase: on-time vs late-firing deadlines ---

test("timedOutPhrase names the armed bound alone when the deadline fired on time", () => {
  assert.equal(timedOutPhrase(30_000), "timed out after 30s");
  // The run's own bound wins over the caller's when the run carried one.
  const run: BuildCheckRun = { spawnedAt: 1_000, settledAt: 31_000, timeoutMs: 60_000 };
  assert.equal(timedOutPhrase(30_000, run), "timed out after 60s");
});

test("timedOutPhrase reports the wall-clock time and lateness when the deadline fired late", () => {
  // 300s bound whose timer actually fired 412s late: the check ran 712s, so "timed out
  // after 300s" would be the false claim (BUGS.md 2026-09-21).
  const run: BuildCheckRun = {
    spawnedAt: 0,
    settledAt: 712_000,
    timeoutMs: 300_000,
    deadlineLateMs: 412_000,
  };
  assert.equal(
    timedOutPhrase(300_000, run),
    "timed out after 712s (its 300s deadline fired 412s late: the host was asleep or the harness stalled)",
  );
});

test("timedOutPhrase keeps sub-second deadline jitter out of the late wording", () => {
  // Lateness within the 5s tolerance reads as on-time; just past it rounds to one decimal.
  const jitter: BuildCheckRun = { spawnedAt: 0, settledAt: 30_002, timeoutMs: 30_000, deadlineLateMs: 2 };
  assert.equal(timedOutPhrase(30_000, jitter), "timed out after 30s");
  const late: BuildCheckRun = { spawnedAt: 0, settledAt: 35_100, timeoutMs: 30_000, deadlineLateMs: 5_100 };
  assert.equal(
    timedOutPhrase(30_000, late),
    "timed out after 35.1s (its 30s deadline fired 5.1s late: the host was asleep or the harness stalled)",
  );
});

// --- buildCheckSkipWarning: every environmental-skip branch ---

test("buildCheckSkipWarning words each environmental skip without ever naming a timeout", () => {
  assert.equal(buildCheckSkipWarning("no-npm", "build check", "proceeding to model review", 300_000),
    "no npm on PATH; skipping build check");
  assert.equal(buildCheckSkipWarning("toolchain", "build check", "proceeding to model review", 300_000),
    "the toolchain is broken; skipping build check; proceeding to model review");
});

test("buildCheckSkipWarning for a killed check uses the caller's signal and wall-clock when given", () => {
  assert.equal(
    buildCheckSkipWarning("killed", "landing build check", "proceeding to merge", 300_000, {
      signal: "SIGKILL",
      durationMs: 12_345,
    }),
    "landing build check was killed by SIGKILL after 12.345s; proceeding to merge",
  );
});

test("buildCheckSkipWarning for a timeout skip names the run's real deadline when it fired late", () => {
  // Plain timeout: the armed bound. With a late-firing run: the wall-clock phrase.
  assert.equal(
    buildCheckSkipWarning("timeout", "build check", "proceeding to model review", 300_000),
    "build check timed out after 300s; proceeding to model review",
  );
  const run: BuildCheckRun = { spawnedAt: 0, settledAt: 712_000, timeoutMs: 300_000, deadlineLateMs: 412_000 };
  assert.equal(
    buildCheckSkipWarning("timeout", "build check", "proceeding to model review", 300_000, undefined, run),
    "build check timed out after 712s (its 300s deadline fired 412s late: the host was asleep or the harness stalled); proceeding to model review",
  );
});

// --- buildCheckEvent: the one home of the event's shape ---

test("buildCheckEvent carries loop, scope, status, script, and duration, and run timings when present", () => {
  const bare = buildCheckEvent("coder", "gate", { status: "failed", script: "npm test" }, 1_500);
  assert.deepEqual(bare, { loop: "coder", type: "build_check", scope: "gate", status: "failed", script: "npm test", durationMs: 1_500 });

  const run: BuildCheckRun = { spawnedAt: 5_000, settledAt: 6_200, timeoutMs: 30_000 };
  const withRun = buildCheckEvent("harness", "baseline", { status: "passed", script: "npm run build", run }, 1_200);
  assert.deepEqual(withRun, {
    loop: "harness", type: "build_check", scope: "baseline", status: "passed",
    script: "npm run build", durationMs: 1_200,
    spawnedAt: 5_000, settledAt: 6_200,
  });
  // No deadlineLateMs: the timeout fields stay off the event, so a normal run is not
  // misread as one whose deadline fired.
  assert.equal(withRun.timeoutMs, undefined);
  assert.equal(withRun.deadlineLateMs, undefined);
});

test("buildCheckEvent records the armed bound and lateness only when the deadline fired late", () => {
  const run: BuildCheckRun = { spawnedAt: 0, settledAt: 712_000, timeoutMs: 300_000, deadlineLateMs: 412_000 };
  const event = buildCheckEvent("lander", "landing", { status: "skipped", script: "npm test", run }, 712_000);
  assert.equal(event.timeoutMs, 300_000);
  assert.equal(event.deadlineLateMs, 412_000);
});

// --- SCOPE_WORDS / MERGE_SCOPES: the scope vocabulary the three callers share ---

test("every scope has wording, and exactly the merge-gating scopes are listed", () => {
  assert.deepEqual(Object.keys(SCOPE_WORDS).sort(), ["batch", "gate", "landing"]);
  for (const scope of ["gate", "landing", "batch"] as const) {
    assert.ok(SCOPE_WORDS[scope].label.length > 0);
    assert.ok(SCOPE_WORDS[scope].proceeding.length > 0);
  }
  assert.deepEqual([...MERGE_SCOPES].sort(), ["batch", "landing"]);
  assert.ok(!MERGE_SCOPES.has("gate"), "the gate stays fail-open; model review stands behind it");
});
