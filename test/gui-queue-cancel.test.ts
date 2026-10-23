import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleQueueCancel } from "../src/gui/gui-endpoint-commands.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";
import { makeRepo, pinOffMain } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { enqueueMerge, queuedMergeFiles, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { mergeRefName, mergeStatePath, orchestratorStatePath } from "../src/paths.js";
import { refSha, setRef } from "../src/git/git.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";

// POST /api/queue-cancel (src/gui/gui-operator-commands.ts): the Merge queue card row's
// two-click Cancel, the browser twin of `tumwater queue --cancel <n>` — through the same
// cancelQueuedMergeBySha removal, so the endpoint and the CLI delete the same pin and file and
// log the same merge_cancelled event shape.

const post = (root: string, body: unknown) => captureJson((res) => handleQueueCancel(fakeReq(JSON.stringify(body)), res, root));

function entry(role: string, sha: string, summary = `summary ${role}`): MergeEntry {
  return { role, sha, run: 1, summary, enqueuedAt: Date.now() };
}

/** A repo with one queued merge pinned off main, whose merge pin exists. */
async function oneQueued(): Promise<string> {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "f.txt"), "x\n"), "add f");
  assert.ok(await setRef(root, mergeRefName("feature"), sha));
  enqueueMerge(root, entry("feature", sha, "add f"));
  return root;
}

test("POST /api/queue-cancel { sha } answers 200 cancelled, removes the queue file, and deletes the pin", async () => {
  const root = await oneQueued();
  const sha = queuedMerges(root)[0]!.sha;
  const { captured, data } = await post(root, { sha });
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; status: string; role: string; commit: string; summary: string; message: string };
  assert.equal(d.ok, true);
  assert.equal(d.status, "cancelled");
  assert.equal(d.role, "feature");
  assert.equal(d.commit, sha);
  assert.equal(d.summary, "add f");
  assert.match(d.message, /^cancelled the merge of [0-9a-f]{8} — add f$/);
  assert.equal(queuedMerges(root).length, 0, "the queue file is removed");
  assert.equal(await refSha(root, mergeRefName("feature")), null, "the role's pin is deleted");
  const cancelled = eventsOfType(root, "merge_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.source, "feature");
  assert.equal(cancelled[0]!.commit, sha);
});

test("POST /api/queue-cancel an unknown sha answers 200 gone and writes nothing", async () => {
  const root = await oneQueued();
  const before = queuedMergeFiles(root).length;
  const { captured, data } = await post(root, { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  assert.equal(captured.status, 200);
  assert.deepEqual((data as { ok: boolean; status: string }).status, "gone");
  assert.equal(queuedMergeFiles(root).length, before, "nothing is removed");
  assert.ok(await refSha(root, mergeRefName("feature")), "the pin survives");
  assert.equal(eventsOfType(root, "merge_cancelled").length, 0, "no event is logged");
});

test("POST /api/queue-cancel a sha a live merge marker names answers 409 — case-insensitively — and leaves the file and pin", async () => {
  const repo = await oneQueued();
  const sha = queuedMerges(repo)[0]!.sha;
  // This test process stands in for a live orchestrator (its pid is alive); the marker names
  // the queued sha mid-merge.
  writeFileDeep(orchestratorStatePath(repo), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  writeFileDeep(mergeStatePath(repo), JSON.stringify({ role: "feature", sha, summary: "add f", startedAt: Date.now() - 120_000, stage: "reviewing" }));
  // Post the sha UPPERCASED: without the case-insensitive in-flight guard this falls through
  // to 200 cancelled and removes the entry — this assertion is the guard's regression pin.
  const { captured, data } = await post(repo, { sha: sha.toUpperCase() });
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /is being merged right now — wait for it to land, then `tumwater revert /);
  assert.equal(queuedMerges(repo).length, 1, "the queue file survives");
  assert.ok(await refSha(repo, mergeRefName("feature")), "the pin survives");
});

test("POST /api/queue-cancel a missing or non-hex sha answers 400 and writes nothing", async () => {
  const root = await oneQueued();
  const before = queuedMergeFiles(root).length;
  for (const body of [{}, { sha: "main" }, { sha: "--json" }, { sha: 42 }]) {
    const { captured, data } = await post(root, body);
    assert.equal(captured.status, 400, JSON.stringify(body));
    assert.doesNotMatch((data as { error: string }).error, /got undefined/);
  }
  assert.equal(queuedMergeFiles(root).length, before, "nothing is removed");
  assert.equal(eventsOfType(root, "merge_cancelled").length, 0, "no event is logged");
});
