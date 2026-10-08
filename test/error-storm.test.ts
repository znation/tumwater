import test from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_STORM_ROLES,
  ERROR_STORM_QUIET,
  errorStorm,
  errorStormKnob,
  type ErrorStormObservation,
} from "../src/fleet/error-storm.js";
import { pollErrorStorm } from "../src/fleet/fleet-polls.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The fleet-wide error-storm warning (src/fleet/error-storm.ts; BUGS.md 2026-09-29 "A fleet-wide
// timeout storm raises no alarm"): pure policy, so every clause — the role bar, the shared
// normalized cause, the edge trigger, the clear/re-arm, the knob naming — is pinned here
// without a fleet, plus one seam test for the orchestrator wiring (the single warning event).

const TIMEOUT_KEY = "timed out after <dur>";

function obs(role: string, consecutiveErrors: number, lastError?: string): ErrorStormObservation {
  return { role, consecutiveErrors, lastError };
}

/** Three roles each at the warn bar (3 consecutive failures) timing out at the same budget. */
function timeoutStorm(): ErrorStormObservation[] {
  return [
    obs("clean", 3, "timed out after 1800s"),
    obs("coverage", 4, "timed out after 1800s"),
    obs("dry", 3, "timed out after 1800s"),
  ];
}

test("one role's long streak never storms, however deep it goes", () => {
  const deep = [obs("feature", 9, "timed out after 1800s")];
  assert.equal(errorStorm(ERROR_STORM_QUIET, deep), ERROR_STORM_QUIET, "an unchanged step returns prev itself");
  assert.equal(errorStorm(ERROR_STORM_QUIET, []).key, null, "no observations, no storm");
});

test("three roles at the warn bar sharing one cause trip the storm, naming them sorted", () => {
  // The bar is the bug's own threshold — "three or more roles timing out consecutively" —
  // pinned here so a recalibration of the constant is a deliberate act, not a drift.
  assert.equal(ERROR_STORM_ROLES, 3);
  const next = errorStorm(ERROR_STORM_QUIET, timeoutStorm());
  assert.equal(next.key, TIMEOUT_KEY);
  assert.deepEqual(next.roles, ["clean", "coverage", "dry"]);
});

test("roles below the warn bar do not count, and one role's repeats add no weight", () => {
  // Two roles at the bar plus one at 2: the pair is the per-role warnings' business.
  assert.equal(errorStorm(ERROR_STORM_QUIET, [...timeoutStorm().slice(0, 2), obs("dry", 2, "timed out after 1800s")]).key, null);
  // The same role listed three times (a state re-read, a retry) is still one role.
  const oneRoleThrice = (n: number) => [obs("feature", n, "timed out after 1800s")];
  assert.equal(errorStorm(ERROR_STORM_QUIET, oneRoleThrice(5)).key, null);
});

test("three roles on three different causes never pool into a storm", () => {
  const next = errorStorm(ERROR_STORM_QUIET, [
    obs("clean", 3, "timed out after 1800s"),
    obs("coverage", 3, "pi exited 1"),
    obs("dry", 3, "rebuild of abc1234def failed"),
  ]);
  assert.equal(next.key, null);
});

test("the strongest cause wins: most roles, ties broken by key", () => {
  const next = errorStorm(ERROR_STORM_QUIET, [
    ...timeoutStorm(),
    obs("bugfix", 3, "pi exited 1"),
    obs("improve", 3, "pi exited 1"),
  ]);
  assert.equal(next.key, TIMEOUT_KEY, "four roles on the timeout cause outrank two on pi exited 1");
  // A tie on strength falls to the lexicographically smaller key, so the choice is
  // deterministic across polls (three roles each on two causes).
  const tied = errorStorm(ERROR_STORM_QUIET, [
    obs("bugfix", 3, "pi exited 1"),
    obs("improve", 3, "pi exited 1"),
    obs("perf", 3, "pi exited 1"),
    obs("clean", 3, "pi exited 2"),
    obs("coverage", 3, "pi exited 2"),
    obs("dry", 3, "pi exited 2"),
  ]);
  assert.equal(tied.key, "pi exited 1");
});

test("a held storm returns prev itself: no re-warn while it merely persists", () => {
  const tripped = errorStorm(ERROR_STORM_QUIET, timeoutStorm());
  // The same storm next poll, a fourth role having joined: same cause, no new episode.
  const joined = errorStorm(tripped, [...timeoutStorm(), obs("perf", 3, "timed out after 1800s")]);
  assert.equal(joined, tripped, "membership growth inside one storm does not re-warn");
});

test("a storm whose members recover goes quiet and re-arms on a recurrence", () => {
  const tripped = errorStorm(ERROR_STORM_QUIET, timeoutStorm());
  assert.equal(errorStorm(tripped, [...timeoutStorm().slice(0, 2)]).key, null, "below the bar, quiet");
  const again = errorStorm(ERROR_STORM_QUIET, timeoutStorm());
  assert.notEqual(again, tripped, "a fresh storm object, so the wiring warns again");
});

test("a storm that switches cause is a new episode", () => {
  const tripped = errorStorm(ERROR_STORM_QUIET, timeoutStorm());
  const switched = errorStorm(tripped, [
    obs("clean", 3, "pi exited 1"),
    obs("coverage", 3, "pi exited 1"),
    obs("dry", 3, "pi exited 1"),
  ]);
  assert.equal(switched.key, "pi exited 1");
  assert.notEqual(switched, tripped, "the old cause no longer explains the fleet; the new one names itself");
});

test("the progressing timeout shape pools with the plain one into one storm", () => {
  // src/pi/pi.ts emits two tick-timeout messages: the plain one and the still-making-progress
  // variant (session and worktree preserved for resume). Both point at the same knob, so the
  // reducer pools them under one cause — a mixed fleet must not split 2/2 into two
  // sub-threshold clusters and stay quiet while the fleet is melting down.
  const progressing = "timed out after 1800s while still making progress — session and worktree edits preserved for resume";
  const mixed = errorStorm(ERROR_STORM_QUIET, [
    obs("clean", 3, progressing),
    obs("coverage", 3, progressing),
    obs("dry", 3, "timed out after 1800s"),
  ]);
  assert.equal(mixed.key, TIMEOUT_KEY, "two timeout shapes are one cause");
  assert.deepEqual(mixed.roles, ["clean", "coverage", "dry"]);
  const allProgressing = errorStorm(ERROR_STORM_QUIET, [
    obs("clean", 3, progressing),
    obs("coverage", 4, progressing),
    obs("dry", 3, progressing),
  ]);
  assert.equal(allProgressing.key, TIMEOUT_KEY);
});

test("a streak at the bar with no error message counts toward no storm", () => {
  // lastError is optional at the observation seam and can be absent in real state (a failed
  // tick whose run recorded no message); the `!lastError` half of the bar-guard skips those.
  // A whitespace-only message is the other half: it is truthy so it passes `!lastError`, but
  // normalizeClusterKey trims it to an empty key, and without the `!key` guard three such
  // roles would storm on a cause that names nothing — the warning stays silent until a
  // message actually explains the shared failure. All three members must be whitespace-only
  // for the mutation to show: an empty string is already skipped by `!lastError`, and one
  // real error among them leaves the empty-key cluster below the bar either way.
  assert.equal(
    errorStorm(ERROR_STORM_QUIET, [obs("clean", 3), obs("coverage", 3), obs("dry", 3)]).key,
    null,
    "no message at all: the role counts toward no cause",
  );
  assert.equal(
    errorStorm(ERROR_STORM_QUIET, [
      obs("clean", 3, "   "),
      obs("coverage", 3, " "),
      obs("dry", 3, "\t"),
    ]).key,
    null,
    "whitespace-only messages never become a shared cause — the empty key must not storm",
  );
});

test("an observation with no streak at all reads as healthy", () => {
  // consecutiveErrors is optional in ErrorStormObservation (a torn or older state read may
  // omit it); the `?? 0` treats a missing streak as healthy, so such a role adds no weight
  // to any cause — garbage state must never trip the fleet-wide warning by itself. All
  // three members must share one real cause for the mutation to show: a lone streakless
  // role beside a real storm adds no weight either way, so only an all-streakless trio on
  // one cause distinguishes the guard from its absence.
  // No cast: the optional field keeps this literal type-honest, so if the interface ever
  // widens the field back to required, tsc — not a runtime assertion — flags the drift.
  const noStreak = (role: string) => ({ role, lastError: "timed out after 1800s" });
  assert.equal(
    errorStorm(ERROR_STORM_QUIET, [noStreak("clean"), noStreak("coverage"), noStreak("dry")]).key,
    null,
    "a missing streak is not a failing one",
  );
});

test("errorStormKnob names tickTimeoutSeconds for the timeout cause and nothing else", () => {
  assert.equal(errorStormKnob(TIMEOUT_KEY), "tickTimeoutSeconds");
  assert.equal(errorStormKnob("pi exited 1"), undefined);
  assert.equal(errorStormKnob("rebuild of <sha> failed"), undefined);
});

test("pollErrorStorm logs exactly one warning on the crossing, naming the knob, and stays silent while held", () => {
  const root = tmpdir("tumwater-error-storm-");
  const stormEvents = () => readEvents(root).filter((e) => e.type === "warning" && (e as { cause?: string }).cause !== undefined);
  const runners = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: ["clean", "coverage", "dry", "perf"][i]!,
      state: { consecutiveErrors: 3, lastError: "timed out after 1800s" },
    }));

  // Two roles at the bar: no storm, no event.
  let storm = pollErrorStorm(root, ERROR_STORM_QUIET, runners(2));
  assert.equal(storm.key, null);
  assert.equal(stormEvents().length, 0);

  // The third role crosses: one warning, carrying the roles, the cause, and the knob.
  storm = pollErrorStorm(root, storm, runners(3));
  assert.equal(storm.key, TIMEOUT_KEY);
  const events = stormEvents();
  assert.equal(events.length, 1);
  const first = events[0]!;
  assert.equal((first as { knob?: string }).knob, "tickTimeoutSeconds");
  assert.match(String(first.message), /tickTimeoutSeconds/);
  assert.match(String(first.message), /clean, coverage, dry/);

  // Held, it is silent; a role recovering below the bar clears it silently too.
  assert.equal(pollErrorStorm(root, storm, runners(3)), storm, "prev passes through unchanged");
  storm = pollErrorStorm(
    root,
    storm,
    runners(3).map((r, i) => (i === 0 ? { ...r, state: { consecutiveErrors: 0 } } : r)),
  );
  assert.equal(storm.key, null);
  assert.equal(stormEvents().length, 1, "clearing logs nothing");
});

test("pollErrorStorm names the knob for a storm of progressing timeouts too", () => {
  const root = tmpdir("tumwater-error-storm-");
  const stormEvents = () => readEvents(root).filter((e) => e.type === "warning" && (e as { cause?: string }).cause !== undefined);
  const progressing = "timed out after 1800s while still making progress — session and worktree edits preserved for resume";
  const runners = ["clean", "coverage", "dry"].map((role) => ({
    role,
    state: { consecutiveErrors: 3, lastError: progressing },
  }));
  const storm = pollErrorStorm(root, ERROR_STORM_QUIET, runners);
  assert.equal(storm.key, TIMEOUT_KEY);
  const first = stormEvents()[0]!;
  assert.equal((first as { knob?: string }).knob, "tickTimeoutSeconds");
  assert.match(String(first.message), /tickTimeoutSeconds/);
});
