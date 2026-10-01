import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RetentionPruner, dueForPrune } from "../src/retention.js";
import { sessionsRootDir, toolOutputDir } from "../src/paths.js";
import { backdate } from "./backdate.js";
import { tmpdir } from "./repo-fixtures.js";
import { eventsOfType } from "./log-fixtures.js";

/** Unit tests for src/retention.ts — the session-retention prune gate (moved here from
 * test/scheduling.test.ts alongside its dueForPrune home) and the startup/poll state machine
 * the orchestrator now drives through a RetentionPruner instead of inline blocks. */

test("dueForPrune: the once-per-day gate with fake timestamps", () => {
  const day = 24 * 3600 * 1000;
  // Due when a full day has passed since the last prune.
  assert.equal(dueForPrune(1_000, 1_000 + day, 7), true);
  // Not due within a day — one millisecond short is still inside the window.
  assert.equal(dueForPrune(1_000, 1_000 + day - 1, 7), false);
  // Never due at retention 0, whether or not a prune has run before.
  assert.equal(dueForPrune(null, Number.MAX_SAFE_INTEGER, 0), false);
  assert.equal(dueForPrune(1_000, 1_000 + day * 2, 0), false);
  // Never pruned (null) → immediately due when retention is positive.
  assert.equal(dueForPrune(null, 1_000, 7), true);
});

/** An old-enough file that any positive window prunes it. */
function staleFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "x");
  backdate(file, 30 * 24 * 3600 * 1000);
  return file;
}

test("RetentionPruner: construction runs the startup prune at a positive window", () => {
  const root = tmpdir();
  const session = staleFile(sessionsRootDir(root), "session.jsonl");
  const toolOut = staleFile(toolOutputDir(root), "tool-out.txt");
  new RetentionPruner(root, 7);
  assert.equal(fs.existsSync(session), false);
  assert.equal(fs.existsSync(toolOut), false);
});

test("RetentionPruner: retention 0 disables the startup prune", () => {
  const root = tmpdir();
  const session = staleFile(sessionsRootDir(root), "session.jsonl");
  new RetentionPruner(root, 0);
  assert.equal(fs.existsSync(session), true);
  assert.equal(eventsOfType(root, "retention_changed").length, 0);
});

test("RetentionPruner: poll re-prunes immediately on a window change and logs one event", () => {
  const root = tmpdir();
  const pruner = new RetentionPruner(root, 7);
  const session = staleFile(sessionsRootDir(root), "session.jsonl");
  // A window change prunes right away even inside the once-per-day window…
  pruner.poll(root, 1);
  assert.equal(fs.existsSync(session), false);
  // …and every distinct value change logs exactly one retention_changed event, even when
  // nothing was pruned.
  pruner.poll(root, 1);
  pruner.poll(root, 1);
  const changes = eventsOfType(root, "retention_changed");
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.from, 7);
  assert.equal(changes[0]?.to, 1);
});
