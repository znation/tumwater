/** The merge pipeline end to end when the main watch verifies main (a `check.gateCommand`): a
 * change whose gate check fails twice before the watch has checked its base is kept — `main_red`,
 * pin and all — with the commit it waits on recorded; the poll re-queues it once the watch's
 * verdict covers that commit, and its next verification judges it from that verdict. Main's full
 * check never runs on the gate's behalf. The gate's attribution alone is in
 * review-precheck-watch.test.ts, the re-queue alone in merge-requeue-watch.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requeueMainRedPin } from "../src/merge/merge-requeue.js";
import { queuedMerges } from "../src/merge/merge-queue.js";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
import { mergeRefName } from "../src/paths.js";
import { refSha } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { defaultConfig } from "../src/config/config.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { APPROVE, allTasks, drained, makePipeline, pumpUntil, queueChanges, runnersFor } from "./fixtures/merge-fixtures.js";
import { mainSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

test("a change the watch has not caught up with is kept, re-queued once the watch checks its base, then judged", async () => {
  const root = makeRepo();
  // A main SHA no other test shares: the baseline cache is process-wide and keyed by SHA.
  fs.writeFileSync(path.join(root, "unique.txt"), `${process.pid}-${Date.now()}-${Math.random()}\n`);
  sh(root, "git", "add", "unique.txt");
  sh(root, "git", "commit", "-m", "main moves on its own");
  const base = mainSha(root);
  const role = "improve";
  const shas = await queueChanges(root, [role]);
  // The check fails test X on the change's tree only (pinnedCommit writes improve.txt).
  const failing = "if [ -f improve.txt ]; then echo '✖ X (1ms)'; exit 1; fi";
  const config = { ...defaultConfig(), check: { command: failing, gateCommand: failing } };
  const runners = runnersFor(root, [role], undefined, config);
  const { ctx, pipeline } = makePipeline(root, runners, { cap: 1, config });
  const state = runners[0]!.state;
  await withPi(APPROVE(), async () => {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the kept verification to settle", 30_000);
    await Promise.allSettled(allTasks(pipeline));
    assert.equal(loadRunnerState(root, role).lastResult, "main_red", "kept, not judged");
    assert.equal(state.mainRedRetry?.awaitingWatch, base, "it waits on the commit it was rebased onto");
    assert.equal(await refSha(root, mergeRefName(role)), shas[role], "the pin stays");
    await requeueMainRedPin(root, "main", state, mainSha(root));
    assert.equal(queuedMerges(root).length, 0, "no re-queue before the watch has a verdict");

    noteGreenBaseline(base); // the watch checks main green; main has not moved
    await requeueMainRedPin(root, "main", state, mainSha(root));
    assert.equal(queuedMerges(root)[0]?.watchWait, "covered");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the re-queued verification to settle", 30_000);
    await Promise.allSettled(allTasks(pipeline));
    assert.equal(loadRunnerState(root, role).lastResult, "rejected", "the watch's green convicts the change");
  });
  const baselineRuns = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.equal(baselineRuns.length, 0, "main's full check never ran for the gate");
});
