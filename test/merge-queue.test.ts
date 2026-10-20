/** Durable merge queue (plans/merge-queue.md 3/5): the file discipline — enqueue ordering,
 * head selection, per-role filter, drop, and the stat-keyed content cache. The pipeline's full
 * path (merge-drain.ts) is pinned through mergeHead in the runner tests and the orchestrator's
 * e2e; the interlock (a role with a queued or in-flight merge never ticks) is pinned in the
 * orchestrator tests too. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  enqueueMerge,
  dropMerge,
  headMerge,
  queueDepth,
  queuedMergeFiles,
  queuedMerges,
  readMergeQueue,
  staleHeadFile,
} from "../src/merge/merge-queue.js";
import { queueEntryMergeLabel, renderMergeQueue, revisionNote } from "../src/merge/merge-queue-render.js";
import { mergeQueueDir } from "../src/paths.js";
import type { MergeEntry } from "../src/merge/merge-queue.js";
import { dieMidWrite } from "./helpers/fs-faults.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

function entry(role: string, sha: string, run = 1): MergeEntry {
  return { role, sha, run, summary: `summary from ${role} #${run}`, enqueuedAt: Date.now() };
}

test("a missing queue dir reads as an empty queue; enqueue creates it", () => {
  const repo = makeRepo();
  assert.ok(!fs.existsSync(mergeQueueDir(repo)), "no queue dir before the first enqueue");
  assert.equal(queueDepth(repo), 0);
  assert.deepEqual(queuedMerges(repo), []);
  assert.equal(headMerge(repo), null);
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  assert.ok(fs.existsSync(mergeQueueDir(repo)));
  assert.equal(queueDepth(repo), 1);
});

test("entries read back in filename order and the head advances on drop", () => {
  const repo = makeRepo();
  // Same-millisecond enqueues tie on the timestamp prefix; the per-process counter breaks it.
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  enqueueMerge(repo, entry("organize", "b".repeat(40)));
  enqueueMerge(repo, entry("improve", "c".repeat(40), 2));
  assert.equal(queueDepth(repo), 3);
  assert.deepEqual(
    queuedMerges(repo).map((e) => e.role),
    ["improve", "organize", "improve"],
  );
  const head = headMerge(repo);
  assert.ok(head);
  assert.equal(head.entry.role, "improve");
  assert.equal(head.entry.sha, "a".repeat(40));
  dropMerge(head.file);
  assert.equal(headMerge(repo)!.entry.role, "organize", "the head advanced");
  dropMerge(headMerge(repo)!.file);
  assert.equal(headMerge(repo)!.entry.sha, "c".repeat(40));
  dropMerge(headMerge(repo)!.file);
  assert.equal(headMerge(repo), null);
  dropMerge(head.file); // ENOENT after a concurrent drop is a no-op, not an error
});

test("queuedMergeFiles carries every role's queued entries; a role filter reads them", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  enqueueMerge(repo, entry("organize", "b".repeat(40)));
  enqueueMerge(repo, entry("improve", "c".repeat(40), 2));
  // The entry stays in the queue until its merge completes, so one listing covers each
  // role's QUEUED and IN-FLIGHT merges at once — the orchestrator's interlock derives its
  // per-poll queued-roles set from exactly this read (one listing per poll, not per runner).
  const roles = queuedMergeFiles(repo).map((q) => q.entry.role);
  assert.equal(roles.filter((r) => r === "improve").length, 2);
  assert.equal(roles.filter((r) => r === "organize").length, 1);
  assert.deepEqual(roles.filter((r) => r === "readme"), []);
});

test("a torn or foreign file is skipped, never thrown on", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const dir = mergeQueueDir(repo);
  // A foreign file that sorts BEFORE the real one, and an unreadable (empty) one after:
  // both shapes are skipped by the content readers, never thrown on.
  fs.writeFileSync(path.join(dir, "0000000000-000000-1.json"), JSON.stringify({ nonsense: true }));
  // And an unreadable (empty) one after: both shapes are skipped by readEntry. The names
  // bracket the real entry's 13-digit timestamp: string sort orders 000… < real < 999….
  fs.writeFileSync(path.join(dir, "9999999999999-000000-1.json"), "");
  assert.equal(queueDepth(repo), 3, "depth counts files, not parseable entries");
  const entries = queuedMerges(repo);
  assert.equal(entries.length, 1, "unparseable files never surface");
  assert.equal(entries[0]!.role, "improve");
  // The torn file at the head holds the slot (the inbox.ts idiom): the head reads null, not
  // an error, until it is cleared — the orchestrator's drain does that clearing (one warning
  // per torn file), which merges the real entry (pinned in the orchestrator's drain e2e);
  // here the test clears it by hand. Then the real entry surfaces.
  assert.equal(headMerge(repo), null, "a torn head holds the slot without throwing");
  fs.rmSync(path.join(dir, "0000000000-000000-1.json"));
  const head = headMerge(repo);
  assert.ok(head, "the real entry is the head once the torn file is cleared");
  assert.equal(head.entry.role, "improve");
  dropMerge(head.file);
  assert.equal(headMerge(repo), null, "only torn files left: an empty head, not an error");
});

test("an entry missing a required field is skipped like a torn one", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const dir = mergeQueueDir(repo);
  // role and sha are present — the whole check the reader used to apply — but tick, summary,
  // and enqueuedAt are not: casting it as a MergeEntry handed the drain `undefined` for
  // each, which surfaced as a `tumwater-feature-undefined-review` session and an undefined
  // summary in the reviewer's prompt. It must read as no entry instead: the head is held (not
  // merged), the drain is told to drop it as an unreadable head, and the real entry behind it
  // still surfaces.
  const partial = path.join(dir, "0000000000-000000-1.json");
  fs.writeFileSync(partial, JSON.stringify({ role: "feature", sha: "b".repeat(40) }));
  assert.equal(queueDepth(repo), 2, "depth counts files, not parseable entries");
  assert.equal(headMerge(repo), null, "the partial head holds the slot without throwing");
  assert.equal(staleHeadFile(repo), partial, "the drain is told to drop it");
  assert.deepEqual(
    queuedMerges(repo).map((e) => e.role),
    ["improve"],
    "the real entry still surfaces",
  );
});

test("a required numeric field that is not finite is skipped like a torn one", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const dir = mergeQueueDir(repo);
  // JSON's 1e999 parses to Infinity, which a bare `typeof === "number"` accepts: the tick
  // would name a `tumwater-feature-Infinity-review` session and enqueuedAt would feed queue
  // arithmetic. All required fields but the non-finite ones are present, so only the numeric
  // guard can reject it. JSON.stringify would turn Infinity into null, so the raw text is written.
  const partial = path.join(dir, "0000000000-000000-1.json");
  fs.writeFileSync(
    partial,
    '{"role": "feature", "sha": "b".repeat(40), "tick": 1e999, "summary": "x", "enqueuedAt": 1e999}',
  );
  assert.equal(queueDepth(repo), 2, "depth counts files, not parseable entries");
  assert.equal(headMerge(repo), null, "the non-finite head holds the slot without throwing");
  assert.equal(staleHeadFile(repo), partial, "the drain is told to drop it");
  assert.deepEqual(
    queuedMerges(repo).map((e) => e.role),
    ["improve"],
    "the real entry still surfaces",
  );
});

test("staleHeadFile names the unreadable head for the drain to drop, null otherwise", () => {
  const repo = makeRepo();
  assert.equal(staleHeadFile(repo), null, "an empty queue has no stale head");
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  assert.equal(staleHeadFile(repo), null, "a healthy head is not stale");
  // A torn file that sorts BEFORE the real entry (an interrupted write of the same shape):
  // the drain's repair target is its path, so it can drop it and move on.
  const dir = mergeQueueDir(repo);
  const torn = path.join(dir, "0000000000-000000-1.json");
  fs.writeFileSync(torn, '{"role": "improve", "sha": "');
  assert.equal(staleHeadFile(repo), torn, "the torn head is named");
  fs.rmSync(torn);
  assert.equal(staleHeadFile(repo), null, "healthy again once the tear is cleared");
});

test("the stat-keyed cache serves repeated reads and re-reads a changed file", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const first = headMerge(repo);
  assert.ok(first);
  const again = headMerge(repo);
  assert.deepEqual(again!.entry, first.entry, "the cached read matches the first");
  // A changed file (different size) invalidates the stat key: the cache re-reads it.
  const changed = entry("improve", "e".repeat(40), 9);
  changed.summary = "rewritten";
  fs.writeFileSync(first.file, JSON.stringify(changed, null, 2));
  assert.equal(headMerge(repo)!.entry.run, 9, "the stat change forced a re-read");
  // The result is a copy: mutating it must not poison the cached value.
  (headMerge(repo)!.entry as { summary: string }).summary = "mutated";
  assert.equal(headMerge(repo)!.entry.summary, "rewritten");
});

test("queuedMergeFiles pairs each entry with its file in queue order — the batch drain's reader", () => {
  // Merge queue 5/5: the batch slot reads this slice because dropMerge needs the file,
  // which the bare-entry readers never return.
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  enqueueMerge(repo, entry("organize", "b".repeat(40)));
  const files = queuedMergeFiles(repo);
  assert.equal(files.length, 2, "both entries, oldest first");
  assert.equal(files[0]!.entry.role, "improve");
  assert.equal(files[1]!.entry.role, "organize");
  for (const f of files) {
    assert.ok(fs.existsSync(f.file), `the paired file exists: ${f.file}`);
    assert.equal(path.dirname(f.file), mergeQueueDir(repo), "the file is inside the queue dir");
  }
  assert.deepEqual(files.map((f) => f.entry), queuedMerges(repo), "same order and content as the bare reader");
  dropMerge(files[0]!.file);
  const after = queuedMergeFiles(repo);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.entry.role, "organize", "a drop on the paired file advances the slice");
});

test("a failed enqueue write never leaves a torn queue entry behind", () => {
  const repo = makeRepo();
  // Seed one healthy entry so a torn write of the NEXT entry sorts LAST in the queue — the
  // position the drain's head-only repair (staleHeadFile) never reaches, where it would
  // persist in the queue dir forever.
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  // Model a process killed mid-write: the writer merges a partial prefix of the JSON, then
  // throws — the shape a SIGKILL between write and close leaves, and the one ENOSPC/EIO
  // leaves. The enqueue must surface the failure and leave no file at the entry's path.
  const restore = dieMidWrite();
  try {
    assert.throws(
      () => enqueueMerge(repo, entry("organize", "b".repeat(40))),
      /killed mid-write/,
    );
  } finally {
    restore();
  }
  // The seed is untouched and the partial never became a queue file. A non-head torn entry
  // would be skipped by the content readers (queuedMerges) while the drain's head-only
  // repair never removed it.
  assert.deepEqual(queuedMerges(repo).map((e) => e.role), ["improve"]);
  assert.equal(queueDepth(repo), 1, "the failed enqueue left no file behind");
});

test("readMergeQueue returns readable entries in filename order with no skips", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  enqueueMerge(repo, entry("organize", "b".repeat(40)));
  enqueueMerge(repo, entry("improve", "c".repeat(40), 2));
  const view = readMergeQueue(repo);
  assert.deepEqual(
    view.entries.map((e) => e.role),
    ["improve", "organize", "improve"],
    "filename order matches queuedMerges",
  );
  assert.equal(view.unreadable, 0);
  assert.deepEqual(view.entries, queuedMerges(repo), "the view and the bare reader agree");
});

test("readMergeQueue skips a torn or foreign file and counts it as unreadable", () => {
  const repo = makeRepo();
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  const dir = mergeQueueDir(repo);
  // One foreign shape sorting before the real entry and one torn (empty) file after it: the
  // view surfaces only the healthy entry and reports both files as skipped.
  fs.writeFileSync(path.join(dir, "0000000000-000000-1.json"), JSON.stringify({ nonsense: true }));
  fs.writeFileSync(path.join(dir, "9999999999999-000000-1.json"), "");
  const view = readMergeQueue(repo);
  assert.equal(view.entries.length, 1, "only the readable entry surfaces");
  assert.equal(view.entries[0]!.role, "improve");
  assert.equal(view.unreadable, 2, "both unreadable files are counted");
});

test("renderMergeQueue prints the unreadable skip count exactly once", () => {
  const now = 1_000_000;
  const lines = renderMergeQueue(
    {
      entries: [{ role: "improve", sha: "a".repeat(40), run: 3, summary: "tidy", enqueuedAt: now - 5_000 }],
      unreadable: 2,
    },
    now,
  ).split("\n");
  assert.deepEqual(lines, [
    "merge queue (3):",
    "  1. improve run #3 · aaaaaaaa · 5s ago · tidy",
    "  (+2 unreadable queue files skipped)",
  ]);
  assert.equal(
    renderMergeQueue({ entries: [], unreadable: 1 }, now),
    "merge queue (1):\n  (+1 unreadable queue file skipped)",
    "a depth held only by skipped files states the skip once",
  );
});

test("revisionNote names a re-submitted change's revision round and prior objections", () => {
  assert.equal(revisionNote({}), "");
  assert.equal(revisionNote({ revisionRound: 1 }), "revision 1");
  assert.equal(revisionNote({ revisionRound: 2, priorReview: { sha: "a".repeat(40), reasons: ["x", "y"] } }), "revision 2 · 2 prior objections");
  // A priorReview with an empty reasons appends no objection clause.
  assert.equal(revisionNote({ revisionRound: 3, priorReview: { sha: "a".repeat(40), reasons: [] } }), "revision 3");
});

test("renderMergeQueue prints a re-submitted change's revision note before its summary", () => {
  const now = 1_000_000;
  const view = {
    entries: [
      { role: "improve", sha: "a".repeat(40), run: 3, summary: "tidy", enqueuedAt: now - 5_000 },
      { role: "feature", sha: "b".repeat(40), run: 7, summary: "revise the thing", enqueuedAt: now - 4_000, revisionRound: 1, priorReview: { sha: "c".repeat(40), reasons: ["x", "y"] } },
    ],
    unreadable: 0,
  };
  const lines = renderMergeQueue(view, now).split("\n");
  assert.equal(lines[1], "  1. improve run #3 · aaaaaaaa · 5s ago · tidy", "a fresh entry's line is unchanged");
  assert.equal(lines[2], "  2. feature run #7 · bbbbbbbb · 4s ago · revision 1 · 2 prior objections · revise the thing");
});

test("readMergeQueue reads a missing queue dir as empty with no skips", () => {
  const repo = makeRepo();
  assert.ok(!fs.existsSync(mergeQueueDir(repo)), "no queue dir before the first enqueue");
  assert.deepEqual(readMergeQueue(repo), { entries: [], unreadable: 0 });
});

test("renderMergeQueue marks entries with a live in-flight record and leaves the rest alone", () => {
  const now = 1_000_000_000;
  const mk = (role: string, sha: string): MergeEntry => ({ role, sha, run: 1, summary: `s ${role}`, enqueuedAt: now - 300_000 });
  const view = { entries: [mk("a", "1".repeat(40)), mk("b", "2".repeat(40)), mk("c", "3".repeat(40))], unreadable: 0 };
  const base = { role: "a", sha: "1".repeat(40), summary: "s", startedAt: now - 120_000 };
  const inFlight = {
    ...base,
    changes: [
      { role: "a", sha: "1".repeat(40), summary: "s", status: "merging" as const, startedAt: now - 120_000, stage: "reviewing" as const },
      { role: "b", sha: "2".repeat(40), summary: "s", status: "approved" as const },
    ],
  };
  const lines = renderMergeQueue(view, now, inFlight).split("\n");
  assert.match(lines[1]!, / · 5m ago · \[merging 2m · reviewing\] · s a$/);
  assert.match(lines[2]!, / · 5m ago · \[approved, waiting to merge\] · s b$/);
  assert.equal(lines[3], renderMergeQueue(view, now).split("\n")[3]);
  const plain = renderMergeQueue(view, now);
  const done = { ...inFlight, changes: [{ ...inFlight.changes[0]!, status: "done" as const }] };
  assert.equal(renderMergeQueue(view, now, done), plain);
  assert.equal(renderMergeQueue(view, now, { ...base, sha: "9".repeat(40), changes: undefined }), plain);
  assert.equal(renderMergeQueue(view, now, undefined), plain);
  const noStage = { ...inFlight, changes: [{ ...inFlight.changes[0]!, stage: undefined }] };
  assert.match(renderMergeQueue(view, now, noStage), /\[merging 2m\] · s a/);
  // A record carrying stageSince appends the per-stage elapsed after the stage (PLANS.md
  // 2026-10-15): `merging 2m · reviewing 30s`.
  const withSince = { ...inFlight, changes: [{ ...inFlight.changes[0]!, stageSince: now - 30_000 }] };
  assert.match(renderMergeQueue(view, now, withSince).split("\n")[1]!, /\[merging 2m · reviewing 30s\] · s a$/);
});

test("queueEntryMergeLabel reads an older-generation marker with no changes array as one merge record", () => {
  const now = 1_000_000_000;
  const old = { role: "a", sha: "1".repeat(40), summary: "s", startedAt: now - 60_000, stage: "merging" as const };
  assert.equal(queueEntryMergeLabel("1".repeat(40), old, now), "merging 1m · finishing the merge");
  assert.equal(queueEntryMergeLabel("2".repeat(40), old, now), "");
  // A newer generation's one-change marker carries stageSince at the top level; the label
  // appends it, while an old one without it keeps the current text.
  const withSince = { ...old, stageSince: now - 30_000 };
  assert.equal(queueEntryMergeLabel("1".repeat(40), withSince, now), "merging 1m · finishing the merge 30s");
});
