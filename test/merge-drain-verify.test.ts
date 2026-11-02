import test from "node:test";
import assert from "node:assert/strict";
import { drainMergeQueue } from "../src/merge/merge-drain.js";
import { mergeTasks } from "../src/merge/merge-pipeline.js";
import { readEvents } from "../src/events/event-read.js";
import { defaultConfig } from "../src/config/config.js";
import {
  APPROVE,
  allTasks,
  busySlot,
  drained,
  makePipeline,
  pumpUntil,
  queueChanges,
  runnersFor,
} from "./fixtures/merge-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";

process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

/** Second slice of the merge-drain suite — the verification-permit and merge-slot tests beside
 * merge-drain.test.ts (which carries the dedupe tests, including the one ~10.5s stress
 * test) and merge-pipeline(-2).test.ts — split so node --test runs the slices in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process. The slices are balanced by measured per-test duration (~6.9s vs ~10.6s at
 * 2026-10-04); keep them roughly equal when moving tests between the files. */

test("every approved change merges one at a time through mergeApprovedChange, no shared stack check", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const config = { ...defaultConfig(), check: { command: "true" } };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 3, "all three to be approved");
    pipeline.merge = null;
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual(mergeTasks(pipeline).flatMap((t) => t.roles), roles, "one merge whose record names every approved role, in queue order");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

    // A merge is a rebase and a fast-forward (parts 4l/3 and 4m/3): no shared scope-`batch`
    // stack check and no in-lock merge check — every approved change merges one at a time
    // through mergeApprovedChange.
    const checks = readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate");
    assert.deepEqual(checks, [], "no shared batch check and no in-lock merge check run");
    assert.deepEqual(eventsOfType(root, "merged").map((e) => e.source), roles, "one merged event per change, in queue order");
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});
