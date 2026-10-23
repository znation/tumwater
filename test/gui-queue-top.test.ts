import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleQueueTop } from "../src/gui/gui-endpoint-commands.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";
import { makeRepo, pinOffMain } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { enqueueMerge, queuedMergeFiles, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { mergeRefName, mergeStatePath, orchestratorStatePath } from "../src/paths.js";
import { setRef } from "../src/git/git.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";

// POST /api/queue-top (src/gui/gui-operator-commands.ts): the Merge queue card row's Move to
// top button, the browser twin of `tumwater queue --top <n>` — through the same
// moveQueuedMergeToTopBySha reorder, so the endpoint and the CLI move the same queue file and
// log the same merge_topped event shape.

const post = (root: string, body: unknown) => captureJson((res) => handleQueueTop(fakeReq(JSON.stringify(body)), res, root));

function entry(role: string, sha: string, summary = `summary ${role}`): MergeEntry {
  return { role, sha, run: 1, summary, enqueuedAt: Date.now() };
}

/** A repo with two queued merges pinned off main. */
async function twoQueued(): Promise<string> {
  const root = makeRepo();
  const shas: Record<string, string> = {};
  let n = 0;
  for (const role of ["organize", "feature"] as const) {
    const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, `f${n++}.txt`), `${role}\n`), `add ${role}`);
    assert.ok(await setRef(root, mergeRefName(role), sha));
    shas[role] = sha;
  }
  enqueueMerge(root, entry("organize", shas.organize!, "add organize"));
  enqueueMerge(root, entry("feature", shas.feature!, "add feature"));
  return root;
}

test("POST /api/queue-top { sha } moves the named entry's queue file to the front and answers 200 topped", async () => {
  const root = await twoQueued();
  const shas = queuedMerges(root).map((e) => e.sha);
  const secondSha = shas[1]!;
  const { captured, data } = await post(root, { sha: secondSha });
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; status: string; role: string; commit: string; summary: string; message: string };
  assert.equal(d.ok, true);
  assert.equal(d.status, "topped");
  assert.equal(d.role, "feature");
  assert.equal(d.commit, secondSha);
  assert.equal(d.summary, "add feature");
  assert.match(d.message, /^moved the merge of [0-9a-f]{8} to the front — add feature$/);
  const after = queuedMerges(root);
  assert.deepEqual(
    after.map((e) => e.role),
    ["feature", "organize"],
    "the named entry is now the head and the rest keep their order",
  );
  assert.equal(after[0]!.sha, secondSha);
  const topped = eventsOfType(root, "merge_topped");
  assert.equal(topped.length, 1);
  assert.equal(topped[0]!.source, "feature");
  assert.equal(topped[0]!.commit, secondSha);
});

test("POST /api/queue-top the leading sha answers 200 already-first and renames nothing", async () => {
  const root = await twoQueued();
  const before = queuedMergeFiles(root).map((q) => q.file);
  const headSha = queuedMerges(root)[0]!.sha;
  const { captured, data } = await post(root, { sha: headSha });
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; status: string; message: string };
  assert.equal(d.ok, true);
  assert.equal(d.status, "already-first");
  assert.match(d.message, /is already at the front/);
  assert.deepEqual(
    queuedMergeFiles(root).map((q) => q.file),
    before,
    "nothing is renamed",
  );
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event for a no-op");
});

test("POST /api/queue-top an unknown sha answers 200 gone and writes nothing", async () => {
  const root = await twoQueued();
  const before = queuedMergeFiles(root).map((q) => q.file);
  const { captured, data } = await post(root, { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  assert.equal(captured.status, 200);
  assert.deepEqual((data as { ok: boolean; status: string }).status, "gone");
  assert.deepEqual(
    queuedMergeFiles(root).map((q) => q.file),
    before,
    "nothing is renamed",
  );
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event is logged");
});

test("POST /api/queue-top a sha a live merge marker names answers 409 and leaves the file", async () => {
  const repo = await twoQueued();
  const sha = queuedMerges(repo)[0]!.sha;
  writeFileDeep(orchestratorStatePath(repo), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  writeFileDeep(mergeStatePath(repo), JSON.stringify({ role: "organize", sha, summary: "add organize", startedAt: Date.now() - 120_000, stage: "reviewing" }));
  const { captured, data } = await post(repo, { sha });
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /is being merged right now — wait for it to land, then `tumwater revert /);
  assert.equal(queuedMerges(repo).length, 2, "the queue files survive");
});

test("POST /api/queue-top a missing or non-hex sha answers 400 and writes nothing", async () => {
  const root = await twoQueued();
  const before = queuedMergeFiles(root).length;
  for (const body of [{}, { sha: "main" }, { sha: "--json" }, { sha: 42 }]) {
    const { captured, data } = await post(root, body);
    assert.equal(captured.status, 400, JSON.stringify(body));
    assert.doesNotMatch((data as { error: string }).error, /got undefined/);
  }
  assert.equal(queuedMergeFiles(root).length, before, "nothing is renamed");
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event is logged");
});
