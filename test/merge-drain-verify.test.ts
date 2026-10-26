import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue } from "../src/merge/merge-drain.js";
import { mergeTasks } from "../src/merge/merge-pipeline.js";
import { slotsStatePath } from "../src/paths.js";
import { readSlotsState } from "../src/git/slots-state.js";
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
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { readJson } from "./helpers/json-read.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

/** Second slice of the merge-drain suite — the verification-permit and merge-slot tests beside
 * merge-drain.test.ts (which carries the dedupe tests, including the one ~10.5s stress
 * test) and merge-pipeline.test.ts — split so node --test runs the slices in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process. The slices are balanced by measured per-test duration (~6.9s vs ~10.6s at
 * 2026-10-04); keep them roughly equal when moving tests between the files. */

// A merged change queues a post-merge review for every role (feature commit a6d46e908), and it
// reuses this fake reviewer with a `-post-` session label. Skip it cleanly: answer it with an
// approve verdict (assistantLine-wrapped, the form reviewMergedCommit parses out of the run) so
// the review settles without filing an unreviewed-commit BUGS.md entry onto main, while still
// creating no run file / sample / flag. A bare exit is verdict-less, which the pipeline reads as
// a failed review and, at the failure limit, files as a BUGS.md commit — racing main's commit
// count (`rev-list` sees a 4th commit).
const skipPostReview = `for a in "$@"; do case "$a" in tumwater-review-*-post-*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`;

test("mergeBatchMax caps each merge's stack, read from the live config at each drain", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const config = { ...defaultConfig(), check: { command: "true" } };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 3, "all three to be approved");
    ctx.liveConfig = { ...config, mergeBatchMax: 2 }; // a live edit, as the scheduler hands it over
    pipeline.merge = null;
    await drainMergeQueue(ctx, pipeline);
    assert.deepEqual(mergeTasks(pipeline).flatMap((t) => t.roles), ["alpha", "beta"], "the first merge stacks two, in queue order");
    assert.deepEqual([...pipeline.approved.keys()], ["gamma"], "the third waits for the next merge");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

    const checks = readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate");
    assert.deepEqual(
      checks.map((e) => [e.source, e.scope]),
      [
        ["alpha", "batch"],
        ["gamma", "merge"],
      ],
      "one shared check for the stack of two, then gamma's own in-lock re-check on the main they moved",
    );
    assert.deepEqual(eventsOfType(root, "merged").map((e) => e.source), roles);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a verification runs in a pooled slot (purpose vet while it works, no lease after) and creates no _land-<role>", async () => {
  const root = makeRepo();
  const role = "alpha";
  await queueChanges(root, [role]);
  const flags = tmpdir("vet-slot-");
  await withPi(
    [
      // Part 3g/3: skip the merged change's post-merge review (a `-post-` session) so its run
      // does not overwrite the during.json slot snapshot taken by the verification under test.
      skipPostReview,
      `printf '%s\\n' "$PWD" >> '${flags}/cwd'`,
      `cp '${slotsStatePath(root)}' '${flags}/during.json' 2>/dev/null`,
      APPROVE(),
    ].join("\n"),
    async () => {
      const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role]));
      await pumpUntil(ctx, pipeline, drained(root, pipeline), "the change to merge");
      const cwd = fs.readFileSync(path.join(flags, "cwd"), "utf8").trim();
      assert.match(path.basename(cwd), /^_slot-\d+$/, "the reviewer ran in a pooled slot");
      assert.equal(fs.existsSync(path.join(root, ".tumwater", "worktrees", `_land-${role}`)), false, "no _land-<role> was created for the verification");
      const during = readJson(path.join(flags, "during.json")) as {
        slots: Array<{ dir: string; lease: { role: string; purpose: string } | null }>;
      };
      const leased = during.slots.find((s) => fs.realpathSync(s.dir) === fs.realpathSync(cwd));
      assert.equal(leased?.lease?.role, role, "the slot was leased for the change's role while the verification ran");
      assert.equal(leased?.lease?.purpose, "verify", "the lease's purpose was verify");
      assert.equal(readSlotsState(root).slots.every((s) => s.lease === null), true, "no lease survives the merge");
    },
  );
});
