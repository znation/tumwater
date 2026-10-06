/** The shared test-fake catalog's own pin (test/fakes/, PLANS.md 2026-10-04): each fake
 * module's contract, exercised with no real process table, network, model, or clock — the
 * shapes the recurring `no-fake` validation gap could not confirm until the catalog existed. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./repo-fixtures.js";
import { failingThenIdle, transientErrorText, type TransientFailure } from "./fakes/transient.js";
import { fakeClock, sleepRecorder } from "./fakes/time.js";
import { reviewVerdict, buildCheck, tickEnd, tickStart, writeEventLog } from "./fakes/log.js";

test("failingThenIdle's script fails the first N runs on the chosen class, then succeeds", () => {
  const marker = path.join(tmpdir(), "fakes-retry");
  const script = failingThenIdle(marker, 2, "rateLimit", undefined, { hint: 3 }).join("\n");
  // Run the script three times with sh — the same boundary the fake-pi shim installs it at,
  // with no pi run at all: the retry sequence is the fake's own contract.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync("sh", ["-c", script], { env: { ...process.env } });
    if (attempt <= 2) {
      assert.equal(r.status, 1, `attempt ${attempt} must fail`);
      assert.ok(String(r.stdout).includes('429 "Rate limit exceeded"') === false && String(r.stdout).includes("429") && String(r.stdout).includes("retry after 3s"),
        `attempt ${attempt} must carry the rate-limit error line (quotes are JSON-escaped)`);
    } else {
      assert.equal(r.status, 0, `attempt ${attempt} succeeds`);
      assert.ok(String(r.stdout).includes("TUMWATER_NOTHING_TO_DO"));
    }
  }
});

test("transientErrorText covers every class the retry policy distinguishes", () => {
  const classes: TransientFailure[] = ["timeout", "rateLimit", "backend", "connection"];
  for (const kind of classes) assert.ok(transientErrorText(kind).length > 0, `${kind} has an error text`);
  assert.match(transientErrorText("rateLimit"), /^429 /);
  assert.match(transientErrorText("timeout"), /timed out/);
  assert.match(transientErrorText("backend"), /^HTTP 5/);
});

test("fakeClock's sleep advances the clock, so sleep-then-recheck sees time pass", async () => {
  const clock = fakeClock(1_000);
  assert.equal(clock.now(), 1_000);
  await clock.sleep(5_000);
  assert.equal(clock.now(), 6_000, "the sleep moved the clock a real setTimeout would have");
  clock.advance(60_000);
  assert.equal(clock.now(), 66_000);
  clock.advance(-60_000);
  assert.equal(clock.now(), 6_000, "window-boundary cases may step the clock backwards");
});

test("sleepRecorder records every wait and resolves instantly", async () => {
  const { sleeps, sleep } = sleepRecorder();
  await sleep(60_000);
  await sleep(1);
  assert.deepEqual(sleeps, [60_000, 1]);
});

test("the event-log builders stamp well-formed events a scratch repo's log reads back", () => {
  const root = tmpdir();
  writeEventLog(root, [
    tickStart({ ts: 1 }),
    tickEnd({ ts: 2, summary: "added a widget", tokens: 100, costUsd: 0.01 }),
    reviewVerdict("a".repeat(40), { ts: 3, reason: "principles upheld" }),
    buildCheck({ ts: 4, scope: "gate", status: "passed", script: "npm test", durationMs: 57_000 }),
  ]);
  const events = readEvents(root);
  assert.equal(events.length, 4);
  assert.equal(events[1]!.type, "tick_end");
  assert.equal((events[1] as { result?: string }).result, "changed");
  assert.equal(events[2]!.type, "review_verdict");
  assert.equal((events[3] as { scope?: string }).scope, "gate");
});