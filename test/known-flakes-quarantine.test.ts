/** Edge cases of the flake quarantine (src/review/known-flakes.ts) that known-flakes.test.ts's
 * basic add/repeat/release path leaves unpinned: the parser's cap, the store's size and
 * malformed-file reading, and a missing BUGS.md. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { quarantinePath } from "../src/paths.js";
import { FAILING_TESTS_MAX } from "../src/build/build-check-report.js";
import {
  QUARANTINE_MAX,
  loadQuarantine,
  markQuarantineFiled,
  onlyQuarantined,
  quarantinedTests,
  quarantineTests,
  releaseQuarantine,
} from "../src/review/known-flakes.js";

function writeStore(root: string, content: string): void {
  fs.mkdirSync(path.dirname(quarantinePath(root)), { recursive: true });
  fs.writeFileSync(quarantinePath(root), content);
}

test("quarantine: a failing list at the parser's cap is neither quarantined nor counted as only quarantined", () => {
  const root = tmpdir();
  const names = Array.from({ length: FAILING_TESTS_MAX }, (_, i) => `t${i}`);
  assert.deepEqual(quarantineTests(root, names, "out"), []);
  assert.deepEqual(quarantinedTests(root), []);
  assert.equal(fs.existsSync(quarantinePath(root)), false);
  quarantineTests(root, names.slice(0, -1), "out");
  quarantineTests(root, names.slice(-1), "out");
  assert.equal(onlyQuarantined(root, names.slice(0, -1))?.length, FAILING_TESTS_MAX - 1);
  assert.equal(onlyQuarantined(root, names), null);
});

test("quarantine: the store keeps the most recently seen tests, reads malformed entries as defaults, and counts a name once per call", () => {
  const full = tmpdir();
  const tests = Array.from({ length: QUARANTINE_MAX }, (_, i) => ({
    test: `q${i + 1}`,
    firstSeen: i + 1,
    lastSeen: i + 1,
    count: 1,
    bug: "",
  }));
  writeStore(full, JSON.stringify({ tests }));
  quarantineTests(full, ["new"], "");
  assert.equal(loadQuarantine(full).length, QUARANTINE_MAX);
  const names = quarantinedTests(full);
  assert.ok(names.includes("new") && names.includes("q2"));
  assert.ok(!names.includes("q1"));
  assert.equal("tail" in loadQuarantine(full).find((e) => e.test === "new")!, false);

  const messy = tmpdir();
  writeStore(
    messy,
    JSON.stringify({ tests: [{ test: "a", count: 0 }, { test: 5 }, "x", { test: "b", bug: 3, firstSeen: "y" }] }),
  );
  const defaults = { firstSeen: 0, lastSeen: 0, count: 1, bug: "" };
  assert.deepEqual(loadQuarantine(messy), [
    { test: "a", ...defaults },
    { test: "b", ...defaults },
  ]);
  writeStore(messy, "not json");
  assert.deepEqual(loadQuarantine(messy), []);

  const twice = tmpdir();
  assert.deepEqual(quarantineTests(twice, ["d", "d"], ["l1", "l2"]), ["d"]);
  const entry = loadQuarantine(twice)[0]!;
  assert.equal(entry.count, 1);
  assert.equal(entry.tail, "l1\nl2");
});

test("quarantine: a missing BUGS.md releases nothing, even a filed test", () => {
  const root = tmpdir();
  quarantineTests(root, ["a"], "out");
  markQuarantineFiled(root, new Map([["a", "`a` failed (quarantined)"]]));
  assert.deepEqual(releaseQuarantine(root), []);
  assert.deepEqual(quarantinedTests(root), ["a"]);
  const entry = loadQuarantine(root)[0]!;
  assert.equal(entry.bug, "`a` failed (quarantined)");
  assert.equal("tail" in entry, false);
});
