/** A change its gate kept for the main watch's verdict (GateResult.awaitingWatch) waits on that
 * verdict, not on main turning green: settleMergeOutcome records the commit it waits on, and the
 * poll's requeueMainRedPin re-queues it once the watch's newest observed verdict covers that
 * commit — main need not move — or once MAIN_RED_VERDICT_WAIT_MS has passed since it was kept.
 * The re-queued entry says which (`watchWait`), and a later re-queue drops it again. The plain
 * main_red re-queue lives in merge-requeue.test.ts. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { settleMergeOutcome } from "../src/merge/merge-pipeline.js";
import { MAIN_RED_VERDICT_WAIT_MS, requeueMainRedPin } from "../src/merge/merge-requeue.js";
import { enqueueMerge, headMerge, queuedMerges, type MergeEntry } from "../src/merge/merge-queue.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { noteGreenBaseline, noteInheritedGreen } from "../src/baseline/main-baseline.js";
import { mergeQueueDir, mergeRefName, statePath } from "../src/paths.js";
import { setRef } from "../src/git/git.js";
import { mainSha, makeRepo, pinOffMain, sh } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

const NO_USAGE = { tokens: 0, cost: 0, providerCost: {} };

/** Commit `file` on main with content no other test shares, so its SHA has no cached verdict
 * (the baseline cache is process-wide and keyed by SHA). Returns main's new SHA. */
function commitOnMain(root: string, file: string): string {
  fs.writeFileSync(path.join(root, file), `${process.pid}-${Date.now()}-${Math.random()}\n`);
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", `main adds ${file}`);
  return mainSha(root);
}

/** A change pinned off a main SHA of its own and settled `main_red` as kept for the watch:
 * `base` is the commit its gate waited on (main's tip when it was pinned). */
async function keptForWatch(entryExtra: Partial<MergeEntry> = {}): Promise<{
  root: string;
  base: string;
  state: ReturnType<typeof freshRunnerState>;
}> {
  const root = makeRepo();
  const base = commitOnMain(root, "unique.txt");
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "a.txt"), "a\n"), "add a");
  assert.ok(await setRef(root, mergeRefName("improve"), sha));
  const entry: MergeEntry = { role: "improve", sha, run: 7, summary: "add a", enqueuedAt: Date.now(), ...entryExtra };
  enqueueMerge(root, entry);
  const head = headMerge(root);
  assert.ok(head);
  const state = freshRunnerState("improve");
  await settleMergeOutcome(root, head.entry, state, "main_red", 5, NO_USAGE, head.file, "main", base);
  return { root, base, state };
}

test("a change kept for the watch records the commit it waits on and when it was kept", async () => {
  const before = Date.now();
  const { root, base, state } = await keptForWatch();
  assert.equal(queuedMerges(root).length, 0, "nothing is queued while it waits");
  assert.equal(state.mainRedRetry?.awaitingWatch, base);
  const since = state.mainRedRetry?.waitingSince ?? 0;
  assert.ok(since >= before && since <= Date.now(), "its wait starts when it was kept");
  assert.equal(loadRunnerState(root, "improve").mainRedRetry?.awaitingWatch, base, "persisted");
});

test("a change kept for the watch is re-queued once the watch checks its base, without main moving", async () => {
  const { root, base, state } = await keptForWatch();
  await requeueMainRedPin(root, "main", state, base);
  assert.equal(queuedMerges(root).length, 0, "no verdict yet");
  noteGreenBaseline(base);
  await requeueMainRedPin(root, "main", state, base);
  const [queued] = queuedMerges(root);
  assert.equal(queued?.watchWait, "covered");
  assert.equal(queued?.retry, "main_red");
  assert.equal(queued?.summary, "add a");
  assert.equal(state.mainRedRetry, undefined);
});

test("a verdict on a later main commit covers the base; an inherited green does not", async () => {
  const { root, state } = await keptForWatch();
  const docTip = commitOnMain(root, "doc.md");
  noteInheritedGreen(docTip, "0".repeat(40)); // carried over, never observed
  await requeueMainRedPin(root, "main", state, docTip);
  assert.equal(queuedMerges(root).length, 0, "an inherited green is no check of the base");
  const codeTip = commitOnMain(root, "code.txt");
  noteGreenBaseline(codeTip);
  await requeueMainRedPin(root, "main", state, codeTip);
  assert.equal(queuedMerges(root)[0]?.watchWait, "covered");
});

test("a change kept for the watch is re-queued as timed out once MAIN_RED_VERDICT_WAIT_MS passes", async () => {
  const { root, base, state } = await keptForWatch();
  const since = state.mainRedRetry?.waitingSince ?? 0;
  await requeueMainRedPin(root, "main", state, base, since + MAIN_RED_VERDICT_WAIT_MS - 1);
  assert.equal(queuedMerges(root).length, 0);
  await requeueMainRedPin(root, "main", state, base, since + MAIN_RED_VERDICT_WAIT_MS);
  assert.equal(queuedMerges(root)[0]?.watchWait, "timed_out");
  assert.equal(state.mainRedRetry, undefined);
});

test("a later re-queue drops the entry's watchWait", async () => {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, "a.txt"), "a\n"), "add a");
  assert.ok(await setRef(root, mergeRefName("improve"), sha));
  enqueueMerge(root, { role: "improve", sha, run: 7, summary: "add a", enqueuedAt: Date.now(), watchWait: "covered" });
  const head = headMerge(root);
  assert.equal(head?.entry.watchWait, "covered", "a valid watchWait rides the queue file");
  await settleMergeOutcome(root, head!.entry, freshRunnerState("improve"), "merge_blocked", 5, NO_USAGE, head!.file, "main");
  const [queued] = queuedMerges(root);
  assert.equal(queued?.retry, "merge_blocked");
  assert.equal(queued?.watchWait, undefined);
});

test("a queue entry or kept record with a malformed watch field reads as none", () => {
  const root = makeRepo();
  writeFileDeep(
    path.join(mergeQueueDir(root), "0000000000001-0-1.json"),
    JSON.stringify({ role: "improve", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1, watchWait: "soon" }),
  );
  assert.equal(queuedMerges(root).length, 0, "a bad watchWait is no entry");
  const state = { ...freshRunnerState("improve"), mainRedRetry: { head: "h", entry: { role: "improve", summary: "s" }, awaitingWatch: 5 } };
  writeFileDeep(statePath(root, "improve"), JSON.stringify(state));
  assert.equal(loadRunnerState(root, "improve").mainRedRetry, undefined, "a torn record reads as none");
});
