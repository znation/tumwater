import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore, isEligible } from "../src/orchestrator.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig } from "../src/config.js";
import { nextBackoffSeconds } from "../src/state.js";
import { makeRepo } from "./util.js";

function runner(role: string): LoopRunner {
  return new LoopRunner(makeRepo(), role, defaultConfig(), "main");
}

test("semaphore bounds concurrency", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, async () => {
    await sem.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    sem.release();
  });
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.equal(running, 0);
});

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

test("the director only runs when the inbox has work", () => {
  const r = runner("director");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  const eligible = isEligible(r, Date.now(), "abc", 2);
  assert.equal(eligible.run, true);
  assert.equal(eligible.reason, "inbox");
});

test("backoff grows by the factor and caps at max", () => {
  const config = defaultConfig();
  config.idleBackoff = { initialSeconds: 10, factor: 3, maxSeconds: 50 };
  let backoff = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    backoff = nextBackoffSeconds(backoff, config);
    seen.push(backoff);
  }
  assert.deepEqual(seen, [10, 30, 50, 50]);
});
