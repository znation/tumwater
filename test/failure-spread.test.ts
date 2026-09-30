import test from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_SPREAD_COUNT,
  FAILURE_SPREAD_QUIET,
  FAILURE_SPREAD_WINDOW_MS,
  failureSpread,
  type FailureSpread,
} from "../src/failure-spread.js";
import { pollFailureSpread, type HoldInputs } from "../src/fleet-polls.js";
import { readEvents } from "../src/event-read.js";
import { tmpdir } from "./repo-fixtures.js";

// The fleet-wide wide-shallow storm alarm (src/failure-spread.ts; BUGS.md 2026-09-30, part
// (2) of the 2026-09-29 connection-storm entry): pure policy, so every clause — the raw
// failure count, the window, per-kind episodes, the dedupe of a re-read observation, the
// edge trigger, the re-arm, the new-kind episode — is pinned here without a fleet, plus one
// seam test for the orchestrator wiring (the single warning event). The shape this guards:
// many roles each failing a few times, spaced minutes apart — inside no other bar's reach.

const T0 = 1_000_000_000;

function obs(role: string, at: number, kind: "connection" | "rate-limit" = "connection"): {
  role: string;
  at: number;
  kind: "connection" | "rate-limit";
} {
  return { role, at, kind };
}

/** Six connection failures across six roles, spaced 4 minutes apart — wider than the hold's
 * two-minute window, shallower than any streak bar, yet six failures in half an hour. */
function wideShallowStorm(): { role: string; at: number; kind: "connection" | "rate-limit" }[] {
  const roles = ["bugfix", "clean", "coverage", "dry", "feature", "improve"];
  return roles.map((role, i) => obs(role, T0 + i * 4 * 60_000));
}

test("five failures of one kind in the window never trip the alarm, however they spread", () => {
  const five = wideShallowStorm().slice(0, 5);
  assert.equal(failureSpread(FAILURE_SPREAD_QUIET, five, T0 + 20 * 60_000).active, false);
  // The bar is the bug's own threshold — pinned so a recalibration is a deliberate act.
  assert.equal(FAILURE_SPREAD_COUNT, 6);
  assert.equal(failureSpread(FAILURE_SPREAD_QUIET, [], T0).active, false, "no observations, no alarm");
});

test("six failures of one kind within the window trip the alarm, naming the kind", () => {
  const next = failureSpread(FAILURE_SPREAD_QUIET, wideShallowStorm(), T0 + 20 * 60_000);
  assert.equal(next.active, true);
  assert.equal(next.kind, "connection");
  assert.equal(next.recent.length, 6);
});

test("the recorded shape trips: each role 1-2 times, none deep, failures spaced past the hold's window", () => {
  // The 2026-09-29 repro's recipe: failures >2 min apart defeat the hold, no role reaching
  // 3 consecutive defeats the streak bars — the alarm still sounds on the count alone.
  const spread = wideShallowStorm().concat([
    obs("bugfix", T0 + 22 * 60_000), // bugfix's second failure, 4+ min after its first
    obs("clean", T0 + 24 * 60_000),
  ]);
  const next = failureSpread(FAILURE_SPREAD_QUIET, spread, T0 + 24 * 60_000);
  assert.equal(next.active, true);
  assert.equal(next.kind, "connection");
});

test("one role failing six times trips too — a storm whatever its shape", () => {
  const oneRole = Array.from({ length: 6 }, (_, i) => obs("feature", T0 + i * 60_000));
  const next = failureSpread(FAILURE_SPREAD_QUIET, oneRole, T0 + 5 * 60_000);
  assert.equal(next.active, true);
  assert.equal(next.kind, "connection");
});

test("failures further apart than the window do not add up", () => {
  const stale = obs("readme", T0);
  const now = T0 + FAILURE_SPREAD_WINDOW_MS + 1;
  assert.equal(failureSpread(FAILURE_SPREAD_QUIET, [stale, ...wideShallowStorm().slice(0, 5).map((o) => ({ ...o, at: now - 60_000 }))], now).active, false);
  // Exactly at the window's edge still counts.
  const edge = T0 + FAILURE_SPREAD_WINDOW_MS;
  const atEdge = wideShallowStorm().map((o, i) => (i === 0 ? { ...o, at: edge } : o)).slice(0, 5);
  assert.equal(failureSpread(FAILURE_SPREAD_QUIET, [...atEdge, obs("dry", edge - 4 * 60_000)], edge).active, true);
});

test("an observation re-read poll after poll counts once", () => {
  // The runner's latest-failure observation repeats every poll until a newer run replaces
  // it; the same (role, kind, at) folded twice is still one failure.
  let state: FailureSpread = FAILURE_SPREAD_QUIET;
  const same = [obs("bugfix", T0), obs("clean", T0)];
  for (let i = 0; i < 10; i++) state = failureSpread(state, same, T0 + i * 2000);
  assert.equal(state.recent.length, 2, "ten polls of the same two failures are still two");
  assert.equal(state.active, false);
  // A newer failure from the same role adds exactly one more.
  state = failureSpread(state, [obs("bugfix", T0 + 20_000), obs("clean", T0)], T0 + 20_000);
  assert.equal(state.recent.length, 3);
});

test("different kinds never pool into one episode, and the strongest kind wins", () => {
  // Five connection + five rate-limit: each below the bar alone, pooled they would trip —
  // they must not.
  const mixed: { role: string; at: number; kind: "connection" | "rate-limit" }[] = [
    ...wideShallowStorm().slice(0, 5),
    ...wideShallowStorm().slice(0, 5).map((o) => ({ ...o, at: o.at + 1000, kind: "rate-limit" as const })),
  ];
  assert.equal(failureSpread(FAILURE_SPREAD_QUIET, mixed, T0 + 20 * 60_000).active, false);
  // Six connection plus three rate-limit: the connection episode sounds, not the pool.
  const next = failureSpread(FAILURE_SPREAD_QUIET, [...wideShallowStorm(), obs("dry", T0, "rate-limit"), obs("perf", T0, "rate-limit"), obs("readme", T0, "rate-limit")], T0 + 60_000);
  assert.equal(next.active, true);
  assert.equal(next.kind, "connection");
});

test("the alarm re-arms when the window thins below the bar, and a recurrence warns again", () => {
  const storm = wideShallowStorm();
  const t1 = T0 + 20 * 60_000;
  const active = failureSpread(FAILURE_SPREAD_QUIET, storm, t1);
  assert.equal(active.active, true);
  // Half an hour later every failure has aged out of the window — the roles' latest-failure
  // observations still report the same old ats, and the reducer skips them as stale — so the
  // alarm quiets and re-arms.
  const t2 = t1 + FAILURE_SPREAD_WINDOW_MS + 60_000;
  const quiet = failureSpread(active, storm, t2);
  assert.equal(quiet.active, false, "the window thinned below the bar");
  assert.equal(quiet.recent.length, 0);
  // A recurrence trips a fresh episode.
  const again = failureSpread(quiet, storm.map((o) => ({ ...o, at: o.at + 52 * 60_000 })), T0 + 72 * 60_000);
  assert.equal(again.active, true);
  assert.equal(again.kind, "connection");
});

test("a different kind reaching the bar while one is sounding is a new episode", () => {
  let state = failureSpread(FAILURE_SPREAD_QUIET, wideShallowStorm(), T0 + 20 * 60_000);
  assert.equal(state.kind, "connection");
  // A rate-limit storm builds on top, one failure stronger than the connection episode so
  // it is the strongest kind: the new kind names itself.
  const rate = Array.from({ length: 7 }, (_, i) => obs(["a", "b", "c", "d", "e", "f", "g"][i]!, T0 + 21 * 60_000, "rate-limit"));
  state = failureSpread(state, rate, T0 + 21 * 60_000);
  assert.equal(state.active, true);
  assert.equal(state.kind, "rate-limit", "the strongest kind is now the episode");
});

test("pollFailureSpread logs exactly one warning per episode and stays silent while held", () => {
  const root = tmpdir("tumwater-failure-spread-");
  const spreadEvents = () => readEvents(root).filter((e) => e.type === "warning" && String(e.message).includes("failure spread"));
  const runners = (ats: number[]): HoldInputs[] =>
    ats.map((at, i) => ({
      role: ["bugfix", "clean", "coverage", "dry", "feature", "improve"][i]!,
      lastBackendFailure: { at, kind: "connection" as const },
    }));

  // Five roles failing: no alarm, no event.
  let spread = pollFailureSpread(root, FAILURE_SPREAD_QUIET, runners([T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4]), T0 + 5);
  assert.equal(spread.active, false);
  assert.equal(spreadEvents().length, 0);

  // The sixth role crosses: one warning, carrying the count, kind, window, and roles.
  spread = pollFailureSpread(root, spread, runners([T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4, T0 + 5]), T0 + 6);
  assert.equal(spread.active, true);
  const events = spreadEvents();
  assert.equal(events.length, 1);
  const first = events[0] as { message?: string; kind?: string; roles?: string[]; count?: number; windowMs?: number };
  assert.equal(first.kind, "connection");
  assert.deepEqual(first.roles, ["bugfix", "clean", "coverage", "dry", "feature", "improve"]);
  assert.equal(first.count, 6);
  assert.equal(first.windowMs, FAILURE_SPREAD_WINDOW_MS);
  assert.match(String(first.message), /6 provider failures of one kind \(connection\)/);
  assert.match(String(first.message), /bugfix, clean, coverage, dry, feature, improve/);

  // Held, it is silent — the same observations re-read every poll log nothing more.
  spread = pollFailureSpread(root, spread, runners([T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4, T0 + 5]), T0 + 8);
  assert.equal(spreadEvents().length, 1, "a held episode logs nothing");

  // The window thins (failures age past 30 min): silent clear, re-armed.
  const late = T0 + FAILURE_SPREAD_WINDOW_MS + 60_000;
  spread = pollFailureSpread(root, spread, runners([late - 4 * 60_000, late - 4 * 60_000 + 1, late - 4 * 60_000 + 2, late - 4 * 60_000 + 3, late - 4 * 60_000 + 4]), late);
  assert.equal(spread.active, false);
  assert.equal(spreadEvents().length, 1, "clearing logs nothing");
});
