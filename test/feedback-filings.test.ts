import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FEEDBACK_FILINGS_MAX,
  readFeedbackFilings,
  recordFiled,
  renderFilingsBlock,
} from "../src/run/feedback-filings.js";
import { feedbackFilingsPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** The `feedback` observer's per-install filing ledger (plans/feedback-role.md 2/2): what this
 * install already filed as GitHub issues on znation/tumwater, so a fresh session's charter
 * dedupes against a "previously filed" block instead of the network alone. Runtime state under
 * .tumwater/state/, degrading to empty on any missing or malformed file. */

function root(): string {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  return dir;
}

test("recordFiled writes the ledger and readFeedbackFilings reads it back", () => {
  const dir = root();
  recordFiled(dir, 12, "a bug", 1_800_000_000_000);
  const filings = readFeedbackFilings(dir);
  assert.equal(filings.length, 1);
  assert.deepEqual(filings[0], { issue: 12, title: "a bug", filedAt: 1_800_000_000_000 });
});

test("recordFiled keeps only the newest FEEDBACK_FILINGS_MAX entries", () => {
  const dir = root();
  const now = 1_800_000_000_000;
  for (let i = 0; i < FEEDBACK_FILINGS_MAX + 10; i++) {
    recordFiled(dir, 1000 + i, `bug ${i}`, now + i);
  }
  const filings = readFeedbackFilings(dir);
  assert.equal(filings.length, FEEDBACK_FILINGS_MAX);
  // The newest entries survive, newest first.
  assert.equal(filings[0]!.issue, 1000 + FEEDBACK_FILINGS_MAX + 9);
  assert.equal(filings[filings.length - 1]!.issue, 1000 + 10);
});

test("a malformed ledger reads as empty", () => {
  const dir = root();
  fs.writeFileSync(feedbackFilingsPath(dir), "not json");
  assert.deepEqual(readFeedbackFilings(dir), []);
  fs.writeFileSync(feedbackFilingsPath(dir), JSON.stringify({ filings: "nope" }));
  assert.deepEqual(readFeedbackFilings(dir), []);
  fs.writeFileSync(feedbackFilingsPath(dir), JSON.stringify({ filings: [{ issue: "x" }] }));
  assert.deepEqual(readFeedbackFilings(dir), []);
});

test("an empty ledger renders no block; a non-empty one renders newest-first with ages", () => {
  const dir = root();
  assert.equal(renderFilingsBlock(readFeedbackFilings(dir)), undefined);
  const now = 1_800_000_000_000;
  recordFiled(dir, 9, "old", now - 86400_000 * 2);
  recordFiled(dir, 4, "recent", now - 60_000);
  const block = renderFilingsBlock(readFeedbackFilings(dir), now)!;
  assert.ok(block.includes("Previously filed from this install:"));
  // Newest first.
  assert.ok(block.indexOf("#4 recent") < block.indexOf("#9 old"), block);
  assert.match(block, /#4 recent \(1m\)/);
  assert.match(block, /#9 old \(2d\)/);
});
