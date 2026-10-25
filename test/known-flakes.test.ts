/** Unit tests for the gate's flake-memory matcher (src/review/known-flakes.ts): the reading
 * rules are pure, so they are pinned here rather than only through the gate's integration test.
 * The prefix extraction, the shared failure-cluster normalization, and the 24 h window. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FLAKY_WARNING_PREFIX,
  MERGE_FLAKY_WARNING_PREFIX,
  flakeCounts,
  flakeKeys,
  loadQuarantine,
  markQuarantineFiled,
  onlyQuarantined,
  quarantinedTests,
  quarantineTests,
  releaseQuarantine,
  releaseQuarantinedTest,
} from "../src/review/known-flakes.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import type { HarnessEvent } from "../src/events/events.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function warning(message: string, ts = NOW): HarnessEvent {
  return { ts, source: "improve", type: "warning", message };
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
      { ts: NOW, source: "improve", type: "run_end" },
      { ts: NOW, source: "improve", type: "warning", message: "reviewer re-ran the suite" },
      { ts: NOW, source: "improve", type: "warning" },
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

test("flakeCounts tallies normalized headlines, most frequent first, ties in first-seen order", () => {
  assert.deepEqual(flakeCounts([]), []);
  assert.deepEqual(
    flakeCounts([
      warning(`${FLAKY_WARNING_PREFIX}test failed after 3s`),
      warning(`${FLAKY_WARNING_PREFIX}other one`),
      warning(`${FLAKY_WARNING_PREFIX}test failed after 9s`),
    ]),
    [
      ["test failed after <dur>", 2],
      ["other one", 1],
    ],
  );
  const tie = flakeCounts([
    warning(`${FLAKY_WARNING_PREFIX}beta`),
    warning(`${FLAKY_WARNING_PREFIX}alpha`),
  ]);
  assert.deepEqual(tie.map(([k]) => k), ["beta", "alpha"]);
});

test("flakeCounts ignores non-warnings and warnings without the prefix", () => {
  const events: HarnessEvent[] = [
    { ts: NOW, source: "improve", type: "run_end", message: `${FLAKY_WARNING_PREFIX}x` } as HarnessEvent,
    warning("some other warning"),
  ];
  assert.deepEqual(flakeCounts(events), []);
});

test("flakeKeys and flakeCounts read merge-check flake warnings too", () => {
  const events = [
    warning(`${FLAKY_WARNING_PREFIX}✖ the flaky test (1.2ms)`),
    warning(`${MERGE_FLAKY_WARNING_PREFIX}✖ the flaky test (3.4ms)`),
  ];
  const key = "✖ the flaky test (<dur>)";
  assert.deepEqual(flakeCounts(events), [[key, 2]]);
  assert.ok(flakeKeys(events, NOW).has(key));
});

test("quarantine: a new test is added once, a repeat counts, and only-quarantined needs every test listed", () => {
  const root = tmpdir();
  assert.deepEqual(quarantineTests(root, ["a", "b"], "out"), ["a", "b"]);
  assert.deepEqual(quarantineTests(root, ["a"], "out"), []);
  assert.equal(loadQuarantine(root).find((e) => e.test === "a")?.count, 2);
  assert.deepEqual(onlyQuarantined(root, ["a", "b"]), ["a", "b"]);
  assert.equal(onlyQuarantined(root, ["a", "c"]), null);
  assert.equal(onlyQuarantined(root, []), null);
  assert.deepEqual(quarantineTests(root, undefined, ""), []);
});

test("quarantine: a filed test leaves the list once its entry is not under ## Open", () => {
  const root = tmpdir();
  quarantineTests(root, ["a"], "out");
  releaseQuarantine(root);
  assert.deepEqual(quarantinedTests(root), ["a"], "an unfiled test is never released");
  markQuarantineFiled(root, new Map([["a", "`a` failed (quarantined)"]]));
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n### `a` failed (quarantined)\n\nbody\n");
  assert.deepEqual(releaseQuarantine(root), []);
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Open\n\n_None yet._\n\n## Fixed\n\n### `a` failed (quarantined)\n");
  assert.deepEqual(releaseQuarantine(root), ["a"]);
  assert.deepEqual(quarantinedTests(root), []);
});

test("releaseQuarantinedTest drops the named test and warns once", () => {
  const root = tmpdir();
  quarantineTests(root, ["a", "b"], "out");
  assert.equal(releaseQuarantinedTest(root, "a"), true);
  assert.deepEqual(quarantinedTests(root), ["b"]);
  assert.ok(
    warningMessages(root).some((m) => m.includes("a released from the flake quarantine at the user's request — the gate no longer excuses its failures")),
  );
  assert.equal(releaseQuarantinedTest(root, "a"), false, "a concurrent removal is answered false");
  assert.equal(warningMessages(root).filter((m) => m.includes("released from the flake quarantine")).length, 1, "no second warning");
  const neverSeen = loadQuarantine(root);
  assert.equal(releaseQuarantinedTest(root, "nope"), false, "a name never quarantined is false");
  assert.deepEqual(loadQuarantine(root), neverSeen, "the file is unchanged");
});
