import test from "node:test";
import assert from "node:assert/strict";
import {
  QUARANTINE_WARN_COUNT,
  QUARANTINE_AGE_MS,
  RED_MAIN_WARN_MS,
  redMainWarning,
  quarantineWarning,
  guardrailWarnings,
} from "../src/baseline/main-guardrails.js";
import { DAY_MS } from "../src/text/datetime.js";
import type { HarnessEvent } from "../src/events/events.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

const MIN = 60_000;

// redMainWarning (G1): the doctor and selfcheck digest warn when main stays red over 30
// minutes (plans/fast-merge.md "Guardrails" G1). These fixtures build the main_check /
// main_red_hold event trail with an injected `now` so no test reads the clock.

const ev = (o: Record<string, unknown>): HarnessEvent => ({ source: "tumwater", ...o }) as unknown as HarnessEvent;

test("redMainWarning: a single main_red_hold 31 min ago warns naming sha and duration", () => {
  const now = 1_000_000_000_000;
  const out = redMainWarning([ev({ type: "main_red_hold", ts: now - 31 * MIN, sha: "abcdef123456", message: "main abc is red" })], now);
  assert.ok(out, "a 31-min red warns");
  assert.match(out!, /31 min/);
  assert.match(out!, /abcdef12/);
});

test("redMainWarning: a main_red_hold 29 min ago does not warn", () => {
  const now = 1_000_000_000_000;
  const out = redMainWarning([ev({ type: "main_red_hold", ts: now - 29 * MIN, sha: "abcdef123456" })], now);
  assert.equal(out, null);
});

test("redMainWarning: a cached main_check (durationMs 0) after the hold still warns", () => {
  const now = 1_000_000_000_000;
  const events = [
    ev({ type: "main_red_hold", ts: now - 31 * MIN, sha: "abcdef123456" }),
    ev({ type: "main_check", ts: now - 10 * MIN, sha: "abcdef123456", status: "passed", durationMs: 0 }),
  ];
  const out = redMainWarning(events, now);
  assert.ok(out, "a cached pass is ignored, so the red stands");
  assert.match(out!, /31 min/);
});

test("redMainWarning: a real passed main_check after the hold ends the red", () => {
  const now = 1_000_000_000_000;
  const events = [
    ev({ type: "main_red_hold", ts: now - 31 * MIN, sha: "abcdef123456" }),
    ev({ type: "main_check", ts: now - 10 * MIN, sha: "fedcba654321", status: "passed", durationMs: 120_000 }),
  ];
  assert.equal(redMainWarning(events, now), null);
});

test("redMainWarning: a pass 60 min ago then reds 40 and 20 min ago warns for 40 min", () => {
  const now = 1_000_000_000_000;
  const events = [
    ev({ type: "main_check", ts: now - 60 * MIN, sha: "aaaa1111", status: "passed", durationMs: 120_000 }),
    ev({ type: "main_red_hold", ts: now - 40 * MIN, sha: "bbbb2222" }),
    ev({ type: "main_red_hold", ts: now - 20 * MIN, sha: "cccc3333" }),
  ];
  const out = redMainWarning(events, now);
  assert.ok(out, "a 40-min red warns");
  assert.match(out!, /for 40 min/);
  // The red is "since" the first red after the pass (minute 40), not the newest red (minute 20).
  assert.match(out!, /red since bbbb2222 at/);
  assert.doesNotMatch(out!, /cccc3333/);
});

test("redMainWarning: a passed main_check carrying quarantined ends the red", () => {
  const now = 1_000_000_000_000;
  const events = [
    ev({ type: "main_red_hold", ts: now - 31 * MIN, sha: "abcdef123456" }),
    ev({ type: "main_check", ts: now - 10 * MIN, sha: "fedcba654321", status: "passed", durationMs: 120_000, quarantined: ["test/one.ts"] }),
  ];
  assert.equal(redMainWarning(events, now), null);
});

test("redMainWarning: reds with the oldest red at the window edge and no pass read more than 24 h", () => {
  const now = 1_000_000_000_000;
  const events = [
    ev({ type: "main_red_hold", ts: now - DAY_MS, sha: "bbbb2222" }),
    ev({ type: "main_red_hold", ts: now - 20 * MIN, sha: "cccc3333" }),
  ];
  const out = redMainWarning(events, now);
  assert.ok(out, "an unbroken red warns");
  assert.match(out!, /for more than 24 h/);
});

test("redMainWarning: reds spread within the window and no pass read more than 24 h", () => {
  const now = 1_000_000_000_000;
  const events = [
    ev({ type: "main_red_hold", ts: now - 20 * 60 * MIN, sha: "bbbb2222" }),
    ev({ type: "main_red_hold", ts: now - 2 * 60 * MIN, sha: "cccc3333" }),
  ];
  const out = redMainWarning(events, now);
  assert.ok(out, "a multi-red no-pass window warns");
  // G1: reds and no pass read "more than 24 h" regardless of where the first red sits — not
  // only when a red falls on the window's edge.
  assert.match(out!, /for more than 24 h/);
});

test("redMainWarning: a green main_check with no red warns nothing", () => {
  const now = 1_000_000_000_000;
  const out = redMainWarning([ev({ type: "main_check", ts: now - 60 * MIN, sha: "aaaa1111", status: "passed", durationMs: 120_000 })], now);
  assert.equal(out, null);
});

test("redMainWarning: events older than the 24 h window are ignored", () => {
  const now = 1_000_000_000_000;
  const out = redMainWarning([ev({ type: "main_red_hold", ts: now - 25 * DAY_MS, sha: "cccc3333" })], now);
  assert.equal(out, null);
});

test("redMainWarning: a red the watch blamed appends the merge", () => {
  const now = 1_000_000_000_000;
  const S = "abcdef1234567890";
  const events = [
    ev({ type: "main_check", ts: now - 31 * MIN, sha: S, status: "failed", durationMs: 120_000, failingTests: ["test/one.test.ts"] }),
    ev({ type: "main_culprit", ts: now - 5 * MIN, commit: S, runner: "feature" }),
  ];
  const out = redMainWarning(events, now);
  assert.ok(out, "a 31-min red warns");
  assert.match(out!, /the main watch blames feature's merge abcdef12/);
});

test("redMainWarning: a culprit blaming another commit still appends with no runner", () => {
  const now = 1_000_000_000_000;
  const S = "abcdef1234567890";
  const events = [
    ev({ type: "main_check", ts: now - 31 * MIN, sha: S, status: "failed", durationMs: 120_000, failingTests: ["test/one.test.ts"] }),
    ev({ type: "main_culprit", ts: now - 5 * MIN, commit: S }),
  ];
  const out = redMainWarning(events, now);
  assert.ok(out, "a 31-min red warns");
  assert.match(out!, /the main watch blames merge abcdef12/);
});

test("redMainWarning: a culprit for another commit or none leaves the phrase unchanged", () => {
  const now = 1_000_000_000_000;
  const S = "abcdef1234567890";
  const runFor = (extra: Record<string, unknown>) =>
    redMainWarning([ev({ type: "main_check", ts: now - 31 * MIN, sha: S, status: "failed", durationMs: 120_000, failingTests: ["test/one.test.ts"] }), ...(extra ? [ev(extra)] : [])], now)!;
  const other = runFor({ type: "main_culprit", ts: now - 5 * MIN, commit: "9999999999999999", runner: "feature" });
  assert.doesNotMatch(other, /blames/);
  const none = runFor({});
  assert.doesNotMatch(none, /blames/);
  assert.equal(other, none, "a mismatched culprit leaves the phrase byte-identical");
});

// quarantineWarning (G3): warn when a quarantined test ages past 3 days or the list grows
// past the 10-test ceiling (plans/fast-merge.md "Guardrails" G3).

const entry = (o: Record<string, unknown>): { test: string; firstSeen: number; bug?: string } =>
  ({ test: "test/one.test.ts", firstSeen: 0, bug: "flaky", ...o }) as { test: string; firstSeen: number; bug?: string };

test("quarantineWarning: an entry 4 days old warns with its age and BUGS.md heading", () => {
  const now = 1_000_000_000_000;
  const out = quarantineWarning([entry({ firstSeen: now - 4 * DAY_MS, bug: "A flaky test" })], now);
  assert.ok(out, "an old quarantined test warns");
  assert.match(out!, /4d ago/);
  assert.match(out!, /A flaky test/);
});

test("quarantineWarning: an unfiled entry says not filed", () => {
  const now = 1_000_000_000_000;
  const out = quarantineWarning([entry({ firstSeen: now - 4 * DAY_MS, bug: "" })], now);
  assert.ok(out);
  assert.match(out!, /not filed/);
});

test("quarantineWarning: a fresh entry under the age bar does not warn", () => {
  const now = 1_000_000_000_000;
  const out = quarantineWarning([entry({ firstSeen: now - MIN, bug: "A flaky test" })], now);
  assert.equal(out, null);
});

test("quarantineWarning: more than 10 fresh entries warns naming the count", () => {
  const now = 1_000_000_000_000;
  const entries = Array.from({ length: 11 }, (_, i) => entry({ test: `test/t${i}.test.ts`, firstSeen: now - MIN }));
  const out = quarantineWarning(entries, now);
  assert.ok(out, "an oversized quarantine warns");
  assert.match(out!, /11 tests/);
});

test("quarantineWarning: 10 fresh entries do not warn on size", () => {
  const now = 1_000_000_000_000;
  const entries = Array.from({ length: 10 }, (_, i) => entry({ test: `test/t${i}.test.ts`, firstSeen: now - MIN }));
  assert.equal(quarantineWarning(entries, now), null);
});


test("the guardrail constants match the documented thresholds", () => {
  assert.equal(RED_MAIN_WARN_MS, 30 * MIN);
  assert.equal(QUARANTINE_AGE_MS, 3 * DAY_MS);
  assert.equal(QUARANTINE_WARN_COUNT, 10);
});

test("no automatic revert rule warns on a revert burst (the removed G2 guardrail)", () => {
  const root = makeRepo();
  const now = Date.now();
  // Six reverts in the day are exactly what the removed G2 rate rule counted as a
  // burst (the deleted 5-revert ceiling): with main green since and a clean quarantine,
  // guardrailWarnings surfaces no revert line, so the doctor and the digest carry no revert
  // warning for them — operator_revert is a deliberate act now.
  writeEvents(root, [
    ...Array.from({ length: 6 }, (_, i) => ({
      ts: now - (10 - i) * 60_000,
      source: "tumwater",
      type: "operator_revert",
      commit: `cccccccccccc${i}`,
    })),
    { ts: now - 60_000, source: "tumwater", type: "main_check", sha: "abcdef123456", status: "passed", durationMs: 120_000 },
  ]);
  const warnings = guardrailWarnings(root);
  assert.ok(Array.isArray(warnings), "guardrailWarnings returns its phrase list");
  assert.doesNotMatch(warnings.join(" "), /revert|burst|ceiling/i, "no automatic revert rule warns on a revert burst");
});
