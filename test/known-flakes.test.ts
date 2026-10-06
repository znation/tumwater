/** Unit tests for the gate's flake-memory matcher (src/review/known-flakes.ts): the reading
 * rules are pure, so they are pinned here rather than only through the gate's integration test.
 * The prefix extraction, the shared failure-cluster normalization, and the 24 h window. */
import test from "node:test";
import assert from "node:assert/strict";
import { FLAKY_WARNING_PREFIX, flakeKeys } from "../src/review/known-flakes.js";
import type { HarnessEvent } from "../src/events/events.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function warning(message: string, ts = NOW): HarnessEvent {
  return { ts, loop: "improve", type: "warning", message };
}

test("flakeKeys extracts the headline after the prefix and normalizes its volatile parts", () => {
  const keys = flakeKeys(
    [warning(`${FLAKY_WARNING_PREFIX}✖ waits 123ms at /a/b/c.test.ts on 2024-01-02 (7 tests)`)],
    NOW,
  );
  assert.deepEqual([...keys], ["✖ waits <dur> at <path> on <ts> (<n> tests)"]);
});

test("flakeKeys ignores non-warning events and warnings without the prefix", () => {
  const keys = flakeKeys(
    [
      { ts: NOW, loop: "improve", type: "tick_end" },
      { ts: NOW, loop: "improve", type: "warning", message: "reviewer re-ran the suite" },
      { ts: NOW, loop: "improve", type: "warning" },
    ],
    NOW,
  );
  assert.equal(keys.size, 0);
});

test("flakeKeys ignores flake warnings older than the window", () => {
  const inside = flakeKeys([warning(`${FLAKY_WARNING_PREFIX}same headline`, NOW - 23 * HOUR)], NOW);
  const outside = flakeKeys([warning(`${FLAKY_WARNING_PREFIX}same headline`, NOW - 25 * HOUR)], NOW);
  assert.equal(inside.size, 1);
  assert.equal(outside.size, 0);
});

test("flakeKeys keeps distinct test names distinct", () => {
  const keys = flakeKeys(
    [
      warning(`${FLAKY_WARNING_PREFIX}✖ test one — AssertionError: boom`),
      warning(`${FLAKY_WARNING_PREFIX}✖ test two — AssertionError: boom`),
    ],
    NOW,
  );
  assert.equal(keys.size, 2);
});
