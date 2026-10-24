// The queue facet of the status-data suite: snapshot()'s director inbox, per-role prompt
// queues, and the merge queue with its per-change marker cross-check. Split by facet out of
// one status-data test file; the core contract and poll cache live in
// status-data.test.ts.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { snapshot } from "../src/status/status-data.js";
import { queueFileStamp } from "../src/files/file-queue.js";
import { renderStatus } from "../src/ui/status-render.js";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { mergeQueueDir, mergeStatePath, orchestratorStatePath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { dequeuePrompt, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { submitPrompt } from "../src/inbox/inbox-submit.js";
import { enqueueMerge, queuedMergeFiles } from "../src/merge/merge-queue.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";

test("snapshot carries queued director prompts as truncated previews, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "inbox snapshot test");
  assert.deepEqual(snapshot(repo).inboxPrompts, []); // no inbox dir yet

  submitPrompt(repo, "first prompt");
  submitPrompt(repo, "x".repeat(120)); // overlong: must come back as an ≤80-char preview
  let snap = snapshot(repo);
  assert.equal(snap.inbox, 2);
  assert.deepEqual(snap.inboxPrompts[0], "first prompt");
  // The same inbox pass pairs each preview with its queue-file basename (the
  // /api/prompt-cancel address): same order, same length, plain .md basenames only.
  assert.equal(snap.inboxFiles.length, snap.inboxPrompts.length);
  assert.ok(
    snap.inboxFiles.every((f) => f.endsWith(".md") && !f.includes("/") && !f.includes("\\")),
    `plain basenames: ${JSON.stringify(snap.inboxFiles)}`,
  );
  assert.notEqual(snap.inboxFiles[0], snap.inboxFiles[1]);
  // The same inbox pass pairs each preview with its enqueue stamp (the dashboard's Queued
  // tab shows the age from it): same order as inboxPrompts, parsed from the queue filename,
  // and null for a hand-placed name.
  assert.deepEqual(snap.inboxQueuedAt.length, snap.inboxPrompts.length);
  assert.deepEqual(snap.inboxQueuedAt[0], queueFileStamp(snap.inboxFiles[0]!));
  const preview = snap.inboxPrompts[1]!;
  assert.ok(preview.length <= 80 && preview.endsWith("…"), `preview truncated: ${JSON.stringify(preview)}`);

  // Fresh per poll like questions: a prompt enqueued between snapshots appears without a
  // restart, and the director consuming one drops it on the next.
  submitPrompt(repo, "third");
  assert.equal(snapshot(repo).inboxPrompts.length, 3);
  dequeuePrompt(repo);
  snap = snapshot(repo);
  assert.deepEqual(snap.inboxPrompts, [preview, "third"]);
});

// Merge queue 4/5 — the snapshot's mergeQueue: depth from the queue files, and inFlight only
// when the 4/5 marker, a matching queue entry, and a live orchestrator all agree. The
// cross-check is the crash-safety pin: a stale marker alone (any crash ordering) never
// displays, and neither does a dead harness — no cleanup pass needed.
test("snapshot reports the merge queue depth and the in-flight merge", async () => {
  const repo = makeRepo();
  await initProject(repo, "land queue snapshot");

  // Idle: depth 0, no inFlight, no entries (depth is unconditional, so JSON consumers see one
  // shape; the entries ride the same read pass and are absent when there is nothing to render —
  // the roleInboxPrompts discipline the merge queue drawer's plan names).
  let snap = snapshot(repo);
  assert.equal(snap.mergeQueue.depth, 0);
  assert.equal(snap.mergeQueue.inFlight, undefined);
  assert.equal(snap.mergeQueue.entries, undefined);

  // One queued entry (3/5's enqueue) lifts the depth — but a merely queued merge is not
  // in flight, and the queue file alone never names an in-flight record.
  enqueueMerge(repo, {
    role: "clean",
    sha: "abc1234",
    run: 1,
    summary: "tidy something",
    enqueuedAt: Date.now(),
  });
  snap = snapshot(repo);
  assert.equal(snap.mergeQueue.depth, 1);
  assert.equal(snap.mergeQueue.inFlight, undefined, "queued, not merge: no inFlight yet");
  // The queued change is listed in execution order with the fields the drawer paints —
  // role, sha, run, summary, enqueuedAt — without the entry's optional body/highFriction.
  assert.deepEqual(snap.mergeQueue.entries, [
    { role: "clean", sha: "abc1234", run: 1, summary: "tidy something", enqueuedAt: snap.mergeQueue.entries![0]!.enqueuedAt },
  ]);

  // Two queued entries list oldest first, in the queue's filename order; the second carries a
  // re-queue's `retry` and (a review_error) `notBefore`, which the payload forwards.
  enqueueMerge(repo, { role: "feature", sha: "def5678", run: 2, summary: "add a thing", enqueuedAt: Date.now(), retry: "review_error", notBefore: Date.now() + 60_000, retryCount: 3 });
  snap = snapshot(repo);
  assert.equal(snap.mergeQueue.depth, 2);
  assert.deepEqual(snap.mergeQueue.entries!.map((e) => e.role), ["clean", "feature"]);
  assert.deepEqual(
    snap.mergeQueue.entries!.map((e) => [e.sha, e.run, e.summary, typeof e.enqueuedAt]),
    [["abc1234", 1, "tidy something", "number"], ["def5678", 2, "add a thing", "number"]],
  );
  // The re-queued entry carries its retry and notBefore; a fresh entry's keys stay absent.
  assert.equal(snap.mergeQueue.entries![1]!.retry, "review_error");
  assert.equal(typeof snap.mergeQueue.entries![1]!.notBefore, "number");
  assert.equal(snap.mergeQueue.entries![1]!.retryCount, 3);
  assert.equal("retry" in snap.mergeQueue.entries![0]!, false);
  assert.equal("notBefore" in snap.mergeQueue.entries![0]!, false);
  assert.equal("retryCount" in snap.mergeQueue.entries![0]!, false);
  // The entries are shallow copies, not the queue's own objects (the drawer never mutates
  // them, and nothing the queue file held beyond the listed fields leaks into the payload).
  assert.equal("body" in snap.mergeQueue.entries![0]!, false);
  assert.equal("highFriction" in snap.mergeQueue.entries![0]!, false);

  // Back to the single queued entry the rest of this test reasons about.
  const featureFile = queuedMergeFiles(repo).find((e) => e.entry.sha === "def5678")!.file;
  fs.rmSync(featureFile);

  // The 4/5 marker plus a live orchestrator plus the matching entry → in flight, with the
  // marker's identity (the dashboard's `merge <elapsed>` label reads startedAt from it).
  const startedAt = Date.now();
  writeOrchestratorMarker(repo, ["clean"]);
  const infoFile = orchestratorStatePath(repo);
  writeJsonFile(mergeStatePath(repo), {
    role: "clean",
    sha: "abc1234",
    summary: "tidy something",
    startedAt,
  });
  snap = snapshot(repo);
  assert.equal(snap.running, true);
  assert.deepEqual(snap.mergeQueue.inFlight, { role: "clean", sha: "abc1234", summary: "tidy something", startedAt });

  // Crash orderings self-heal: a DEAD harness never displays in flight (the depth — queued
  // work that will drain on the next start — stays visible)…
  fs.rmSync(infoFile);
  snap = snapshot(repo);
  assert.equal(snap.running, false);
  assert.equal(snap.mergeQueue.depth, 1, "queued work is visible even while the team is down");
  assert.equal(snap.mergeQueue.inFlight, undefined, "a dead harness never shows a merge as in flight");

  // …and a marker whose sha no longer has a matching queue entry (a crash between the entry
  // drop and the marker removal) is stale — never displayed, even with a live orchestrator.
  writeOrchestratorMarker(repo, ["clean"]);
  writeJsonFile(mergeStatePath(repo), {
    role: "clean",
    sha: "deadbee",
    summary: "stale marker",
    startedAt: Date.now(),
  });
  snap = snapshot(repo);
  assert.equal(snap.running, true);
  assert.equal(snap.mergeQueue.inFlight, undefined, "a marker with no matching queue entry never displays");

  // The queue drains and the marker is removed (the drain's own bookkeeping): back to idle,
  // with the entries gone too.
  fs.rmSync(path.join(mergeQueueDir(repo), fs.readdirSync(mergeQueueDir(repo))[0]!));
  fs.rmSync(mergeStatePath(repo));
  snap = snapshot(repo);
  assert.equal(snap.mergeQueue.depth, 0);
  assert.equal(snap.mergeQueue.inFlight, undefined);
  assert.equal(snap.mergeQueue.entries, undefined);
});

// The marker carries one record per change the merge pipeline holds, and the snapshot
// cross-checks each against its still-queued entry: every row then reads its OWN change's
// state, and a change the merge is done with shows nothing (BUGS.md 2026-09-23 — a head-only
// marker kept a rejected head reading `merge` for a whole batch).
test("the marker is cross-checked per change and each row reads its own change's state", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch marker snapshot");
  const t0 = Date.now() - 20 * 60_000;
  for (const [role, sha] of [["clean", "c1ea000"], ["bugfix", "b0f1000"], ["feature", "fea7000"], ["dedupe", "d1a0000"]]) {
    enqueueMerge(repo, { role: role!, sha: sha!, run: 1, summary: `${role} work`, enqueuedAt: Date.now() });
  }
  writeOrchestratorMarker(repo, []);
  const betaStart = Date.now() - 90_000;
  writeJsonFile(mergeStatePath(repo), {
    role: "bugfix",
    sha: "b0f1000",
    summary: "bugfix work",
    startedAt: betaStart,
    changes: [
      { role: "clean", sha: "c1ea000", summary: "clean work", status: "done", startedAt: t0 },
      { role: "bugfix", sha: "b0f1000", summary: "bugfix work", status: "merging", startedAt: betaStart },
      { role: "feature", sha: "fea7000", summary: "feature work", status: "approved", startedAt: t0, stage: "merging" },
      { role: "dedupe", sha: "d1a0000", summary: "dedupe work", status: "merging", startedAt: t0, stage: "build-check" },
      // A record whose entry is gone (its outcome written, or a crash) is finished, whatever
      // its record last said: the cross-check drops it.
      { role: "plan", sha: "91a0000", summary: "plan work", status: "merging", startedAt: t0 },
    ],
  });
  let snap = snapshot(repo);
  assert.deepEqual(
    snap.mergeQueue.inFlight?.changes?.map((c) => c.role),
    ["clean", "bugfix", "feature", "dedupe"],
    "only the records whose entry is still queued survive the cross-check",
  );
  const text = renderStatus(repo, snap);
  assert.match(text, /^bugfix +merging 1m30s/m, "the change under review reads merge with its own elapsed");
  assert.match(text, /^feature +approved, waiting to merge/m);
  assert.match(text, /^dedupe +merging 20m\S* · checking/m, "a second verification in flight reads its own elapsed and stage");
  assert.doesNotMatch(text, /^clean +merging/m, "a finished change keeps no live merge label");
  assert.match(text, /^clean +due/m, "its row reads its own state again");
  assert.doesNotMatch(text, /^plan +merging/m, "a record with no queued entry never displays");

  // Only finished records left with a queued entry: nothing is in flight any more.
  for (const f of fs.readdirSync(mergeQueueDir(repo))) {
    if (!readJson<{ role: string }>(path.join(mergeQueueDir(repo), f)).role.startsWith("clean")) {
      fs.rmSync(path.join(mergeQueueDir(repo), f));
    }
  }
  snap = snapshot(repo);
  assert.equal(snap.mergeQueue.depth, 1);
  assert.equal(snap.mergeQueue.inFlight, undefined, "a marker whose live records are all done never displays");
  fs.rmSync(orchestratorStatePath(repo));
});

test("snapshot counts each role's own prompt queue and leaves the director to inbox", async () => {
  const repo = makeRepo();
  await initProject(repo, "roleInbox snapshot test");
  const one = enqueueRolePrompt(repo, "clean", "one");
  const two = enqueueRolePrompt(repo, "dedupe", "two");
  const three = enqueueRolePrompt(repo, "dedupe", "three");
  const snap = snapshot(repo);
  assert.equal(snap.roleInbox.clean, 1);
  assert.equal(snap.roleInbox.dedupe, 2);
  assert.ok(!("director" in snap.roleInbox), "the director's queue is the shared inbox, not roleInbox");
  assert.equal(snap.inbox, 0);
  // And it agrees with the queue files the CLI's --list reads.
  assert.deepEqual(queuedRolePrompts(repo, "dedupe"), ["two", "three"]);
  // Each queued prompt also carries its queue-file address (the /api/prompt-cancel target)
  // and the enqueue stamp parsed from that filename (null for a hand-placed name — see
  // file-queue.test.ts), execution order; roles with an empty queue are absent, like the
  // director.
  assert.deepEqual(snap.roleInboxPrompts.clean, [
    { file: path.basename(one), preview: "one", queuedAtMs: queueFileStamp(path.basename(one)), notBeforeMs: null },
  ]);
  assert.deepEqual(snap.roleInboxPrompts.dedupe, [
    { file: path.basename(two), preview: "two", queuedAtMs: queueFileStamp(path.basename(two)), notBeforeMs: null },
    { file: path.basename(three), preview: "three", queuedAtMs: queueFileStamp(path.basename(three)), notBeforeMs: null },
  ]);
  assert.ok(!("director" in snap.roleInboxPrompts), "the director's rows ride inboxFiles, not roleInboxPrompts");
});

test("snapshot's roleInbox deliverability advances with its pinned clock", async () => {
  const repo = makeRepo();
  await initProject(repo, "roleInbox clock seam test");
  const now = Date.now();
  const until = now + 30 * 60_000;
  enqueueRolePrompt(repo, "clean", "later", until);
  // Still deferred at the pinned instant: not deliverable, so not counted.
  assert.equal(snapshot(repo, undefined, now).roleInbox.clean, 0);
  // At the deferred time itself (deliverableAt is `at <= now`), it counts — a wall-clock read
  // would leave this at 0 and make deferred deliverability untestable through the seam.
  assert.equal(snapshot(repo, undefined, until).roleInbox.clean, 1);
});

test("snapshot's director inbox deliverability advances with its pinned clock", async () => {
  const repo = makeRepo();
  await initProject(repo, "inbox clock seam test");
  const now = Date.now();
  const until = now + 30 * 60_000;
  // A deferred director prompt (tumwater prompt --at): keyed to the shared inbox, not a role.
  submitPrompt(repo, "later", undefined, until);
  // Still deferred at the pinned instant: not deliverable, so not counted — but still listed,
  // so the Queued tab can show and cancel it, exactly as a deferred role prompt rides
  // roleInboxPrompts.
  const deferred = snapshot(repo, undefined, now);
  assert.equal(deferred.inbox, 0);
  assert.equal(deferred.inboxPrompts.length, 1);
  // At the deferred time itself (deliverableAt is `at <= now`), it counts.
  assert.equal(snapshot(repo, undefined, until).inbox, 1);
});

// --- pausedUntil: the team marker's standing timed-pause deadline (PLANS.md 2026-09-25) ---
