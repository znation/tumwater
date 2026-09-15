/** Durable land queue (plans/merge-queue.md 3/5): the file discipline — enqueue ordering,
 * head selection, per-role filter, drop, and the stat-keyed content cache. The drain's full
 * path (landQueuedEntry) is pinned through landHead in the loop tests and the orchestrator's
 * e2e; the interlock (a role with a queued or in-flight landing never ticks) is pinned in the
 * orchestrator tests too. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  enqueueLanding,
  dropLanding,
  headLanding,
  landingFor,
  queueDepth,
  queuedLandings,
} from "../src/land-queue.js";
import { landQueueDir } from "../src/paths.js";
import type { LandingEntry } from "../src/types.js";
import { makeRepo } from "./util.js";

function entry(role: string, sha: string, tick = 1): LandingEntry {
  return { role, sha, tick, summary: `summary from ${role} #${tick}`, enqueuedAt: Date.now() };
}

test("a missing queue dir reads as an empty queue; enqueue creates it", () => {
  const repo = makeRepo();
  assert.ok(!fs.existsSync(landQueueDir(repo)), "no queue dir before the first enqueue");
  assert.equal(queueDepth(repo), 0);
  assert.deepEqual(queuedLandings(repo), []);
  assert.equal(headLanding(repo), null);
  enqueueLanding(repo, entry("improve", "a".repeat(40)));
  assert.ok(fs.existsSync(landQueueDir(repo)));
  assert.equal(queueDepth(repo), 1);
});

test("entries read back in filename order and the head advances on drop", () => {
  const repo = makeRepo();
  // Same-millisecond enqueues tie on the timestamp prefix; the per-process counter breaks it.
  enqueueLanding(repo, entry("improve", "a".repeat(40)));
  enqueueLanding(repo, entry("organize", "b".repeat(40)));
  enqueueLanding(repo, entry("improve", "c".repeat(40), 2));
  assert.equal(queueDepth(repo), 3);
  assert.deepEqual(
    queuedLandings(repo).map((e) => e.role),
    ["improve", "organize", "improve"],
  );
  const head = headLanding(repo);
  assert.ok(head);
  assert.equal(head.entry.role, "improve");
  assert.equal(head.entry.sha, "a".repeat(40));
  dropLanding(repo, head.file);
  assert.equal(headLanding(repo)!.entry.role, "organize", "the head advanced");
  dropLanding(repo, headLanding(repo)!.file);
  assert.equal(headLanding(repo)!.entry.sha, "c".repeat(40));
  dropLanding(repo, headLanding(repo)!.file);
  assert.equal(headLanding(repo), null);
  dropLanding(repo, head.file); // ENOENT after a concurrent drop is a no-op, not an error
});

test("landingFor filters by role across queued and in-flight entries", () => {
  const repo = makeRepo();
  enqueueLanding(repo, entry("improve", "a".repeat(40)));
  enqueueLanding(repo, entry("organize", "b".repeat(40)));
  enqueueLanding(repo, entry("improve", "c".repeat(40), 2));
  // The entry stays in the queue until its landing completes, so this filter covers the role's
  // QUEUED and IN-FLIGHT landings at once — the orchestrator's interlock reads exactly this.
  assert.equal(landingFor(repo, "improve").length, 2);
  assert.equal(landingFor(repo, "organize").length, 1);
  assert.deepEqual(landingFor(repo, "readme"), []);
});

test("a torn or foreign file is skipped, never thrown on", () => {
  const repo = makeRepo();
  enqueueLanding(repo, entry("improve", "a".repeat(40)));
  const dir = landQueueDir(repo);
  // A foreign file that sorts BEFORE the real one, and an unreadable (empty) one after:
  // both shapes are skipped by the content readers, never thrown on.
  fs.writeFileSync(path.join(dir, "0000000000-000000-1.json"), JSON.stringify({ nonsense: true }));
  // And an unreadable (empty) one after: both shapes are skipped by readEntry. The names
  // bracket the real entry's 13-digit timestamp: string sort orders 000… < real < 999….
  fs.writeFileSync(path.join(dir, "9999999999999-000000-1.json"), "");
  assert.equal(queueDepth(repo), 3, "depth counts files, not parseable entries");
  const entries = queuedLandings(repo);
  assert.equal(entries.length, 1, "unparseable files never surface");
  assert.equal(entries[0]!.role, "improve");
  // The torn file at the head holds the slot (the inbox.ts idiom): the head reads null, not
  // an error, until it is cleared — then the real entry surfaces.
  assert.equal(headLanding(repo), null, "a torn head holds the slot without throwing");
  fs.rmSync(path.join(dir, "0000000000-000000-1.json"));
  const head = headLanding(repo);
  assert.ok(head, "the real entry is the head once the torn file is cleared");
  assert.equal(head.entry.role, "improve");
  dropLanding(repo, head.file);
  assert.equal(headLanding(repo), null, "only torn files left: an empty head, not an error");
});

test("the stat-keyed cache serves repeated reads and re-reads a changed file", () => {
  const repo = makeRepo();
  enqueueLanding(repo, entry("improve", "a".repeat(40)));
  const first = headLanding(repo);
  assert.ok(first);
  const again = headLanding(repo);
  assert.deepEqual(again!.entry, first.entry, "the cached read matches the first");
  // A changed file (different size) invalidates the stat key: the cache re-reads it.
  const changed = entry("improve", "e".repeat(40), 9);
  changed.summary = "rewritten";
  fs.writeFileSync(first.file, JSON.stringify(changed, null, 2));
  assert.equal(headLanding(repo)!.entry.tick, 9, "the stat change forced a re-read");
  // The result is a copy: mutating it must not poison the cached value.
  (headLanding(repo)!.entry as { summary: string }).summary = "mutated";
  assert.equal(headLanding(repo)!.entry.summary, "rewritten");
});
