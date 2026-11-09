/** The merge drain merges a kept pin that has no queue file (Subtract part 3h/7) — the crash
 * window between a run's commit and its queue write, and the pin-only writers of Subtract
 * parts 3e/7 and 3i/7: the serial drain's one gate-then-merge task gates and merges the pin on
 * a poll, with no queue file written. Stale and conflict-capped pins keep their existing
 * behavior (deleted / left for the author's hand-back), and a queued entry drains before any
 * pin. The driver is the mergeHead shape (orchestrator-fixtures.ts): drainMergeQueue on a real
 * repo with real RoleRunners, so each merge resolves its author's wiring; no live orchestrator. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_CONFLICT_LIMIT } from "../src/runner/runner-leftover.js";
import { drainMergeQueue } from "../src/merge/merge-drain.js";
import { mergeTasks } from "../src/merge/merge-pipeline.js";
import { enqueueMerge, queueDepth } from "../src/merge/merge-queue.js";
import { mergeRefName } from "../src/paths.js";
import { refSha, setRef } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { APPROVE, allTasks, drained, entry, makePipeline, pumpUntil, runnersFor } from "./fixtures/merge-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { mainSha, makeRepo, pinOffMain, sh, writeBacklogFile } from "./fixtures/repo-fixtures.js";

test("a pin with no queue file is gated and merged on a poll", async () => {
  const root = makeRepo();
  const sha = pinOffMain(
    root,
    (d) => fs.writeFileSync(path.join(d, "pin.txt"), "pinned work\n"),
    "work by improve\n\nRun: improve #7 · turns 1 · ctx 1k",
    { reset: true },
  );
  await setRef(root, mergeRefName("improve"), sha);
  const [runner] = runnersFor(root, ["improve"]);
  assert.ok(runner);
  runner.state.runs = 7;
  const { ctx, pipeline } = makePipeline(root, [runner]);

  await withPi(APPROVE(), async () => {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the pin's gate-then-merge task to settle");
    await Promise.allSettled(allTasks(pipeline));
  });

  assert.equal(mainSha(root), sha, "the pinned commit merged onto main");
  assert.equal(await refSha(root, mergeRefName("improve")).catch(() => null), null, "the pin was deleted with the merge");
  assert.equal(queueDepth(root), 0, "no queue file was written");
  assert.ok(readEvents(root).some((e) => e.type === "merge_done"), "merge_done fired");
  // A pin-only writer is not a recovery: the merged event names the change's own subject,
  // not the recovered-leftover label the leftover path uses.
  assert.equal(
    readEvents(root).find((e) => e.type === "merged")?.summary,
    "work by improve",
    "the merged summary is the commit's own subject",
  );
});

test("a pin whose commit main already contains is deleted without a gate", async () => {
  const root = makeRepo();
  const sha = mainSha(root);
  await setRef(root, mergeRefName("improve"), sha);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await drainMergeQueue(ctx, pipeline);

  assert.equal(mergeTasks(pipeline).length, 0, "no gate-then-merge task started");
  assert.equal(await refSha(root, mergeRefName("improve")).catch(() => null), null, "the stale pin was deleted");
  assert.ok(
    !readEvents(root).some((e) => e.type === "merge_done" || e.type === "merge_failed"),
    "no outcome was written",
  );
});

test("a pin at MERGE_CONFLICT_LIMIT is neither merged nor deleted by the drain", async () => {
  const root = makeRepo();
  const sha = pinOffMain(
    root,
    (d) => fs.writeFileSync(path.join(d, "cap.txt"), "cap work\n"),
    "conflicted work",
    { reset: true },
  );
  await setRef(root, mergeRefName("improve"), sha);
  const [runner] = runnersFor(root, ["improve"]);
  assert.ok(runner);
  runner.state.mergeConflicts = { sha, count: MERGE_CONFLICT_LIMIT };
  const { ctx, pipeline } = makePipeline(root, [runner]);

  await drainMergeQueue(ctx, pipeline);

  assert.equal(mergeTasks(pipeline).length, 0, "no gate-then-merge task started");
  assert.equal(await refSha(root, mergeRefName("improve")).catch(() => null), sha, "the pin stays for its author's hand-back");
  assert.equal(queueDepth(root), 0, "no queue file was written");
});

test("a withdrawn claim's pin is left for its role's next run to set aside", async () => {
  const root = makeRepo();
  const sha = pinOffMain(
    root,
    (d) => fs.writeFileSync(path.join(d, "withdrawn.txt"), "withdrawn work\n"),
    "withdrawn work",
    { reset: true },
  );
  await setRef(root, mergeRefName("improve"), sha);
  const [runner] = runnersFor(root, ["improve"]);
  assert.ok(runner);
  runner.state.withdrawn = { file: "PLANS.md", key: "withdrawn-key", title: "a withdrawn plan" };
  const { ctx, pipeline } = makePipeline(root, [runner]);

  await drainMergeQueue(ctx, pipeline);

  assert.equal(mergeTasks(pipeline).length, 0, "no gate-then-merge task started");
  assert.equal(await refSha(root, mergeRefName("improve")).catch(() => null), sha, "the pin waits for setAsideWithdrawnWork");
  assert.equal(queueDepth(root), 0, "no queue file was written");
});

test("a pin whose still-owed claim main no longer lists waits for its role's next run", async () => {
  // The scheduling pass that turns a deleted claim into RunnerState.withdrawn runs after the
  // drain, so the first poll after a withdrawal has no marker yet. The drain must read the
  // live claim itself: a pin-only commit carries no claim for the merge's own check.
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned", body: "### Beta (planned 2026-01-01 by operator)\n\nBody." },
    { heading: "## Done" },
  ]);
  sh(root, "git", "add", "PLANS.md");
  sh(root, "git", "commit", "-m", "plans");
  const sha = pinOffMain(
    root,
    (d) => fs.writeFileSync(path.join(d, "beta.ts"), "beta work\n"),
    "beta work\n\nRun: feature #7 · turns 1 · ctx 1k",
    { reset: true },
  );
  await setRef(root, mergeRefName("feature"), sha);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned" }, { heading: "## Done" }]);
  sh(root, "git", "add", "PLANS.md");
  sh(root, "git", "commit", "-m", "withdraw beta");
  const [runner] = runnersFor(root, ["feature"]);
  assert.ok(runner);
  runner.state.runs = 7;
  runner.state.claim = {
    file: "PLANS.md",
    key: "Beta",
    title: "Beta (planned 2026-01-01 by operator)",
    at: Date.now(),
    source: "assigned",
  };
  runner.state.resumePending = true;
  const { ctx, pipeline } = makePipeline(root, [runner]);

  await drainMergeQueue(ctx, pipeline);

  assert.equal(mergeTasks(pipeline).length, 0, "no gate-then-merge task started before the marker exists");
  assert.equal(await refSha(root, mergeRefName("feature")).catch(() => null), sha, "the pin waits for setAsideWithdrawnWork");
  assert.equal(queueDepth(root), 0, "no queue file was written");
});

test("a queued entry drains before a pin that has no queue file", async () => {
  const root = makeRepo();
  const queuedSha = pinOffMain(
    root,
    (d) => fs.writeFileSync(path.join(d, "queued.txt"), "queued work\n"),
    "queued work",
    { reset: true },
  );
  await setRef(root, mergeRefName("improve"), queuedSha);
  enqueueMerge(root, entry("improve", queuedSha));
  const pinSha = pinOffMain(
    root,
    (d) => fs.writeFileSync(path.join(d, "pinned.txt"), "pinned work\n"),
    "pinned work",
    { reset: true },
  );
  await setRef(root, mergeRefName("dedupe"), pinSha);
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve", "dedupe"]));

  await withPi(APPROVE(), async () => {
    // Poll 1 starts the queue head's task, never the pin-only merge.
    await drainMergeQueue(ctx, pipeline);
    const first = pipeline.merge;
    assert.ok(first !== null, "the first poll started the queue head's task");
    await first.promise;
    assert.equal(mainSha(root), queuedSha, "the queued entry merged first");
    assert.equal(
      await refSha(root, mergeRefName("dedupe")).catch(() => null),
      pinSha,
      "the pin-only change waits through the first poll",
    );
    // The next poll merges the pin.
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the pin's gate-then-merge task to settle");
    await Promise.allSettled(allTasks(pipeline));
  });

  // The pin's change rebased onto the moved main, so the head is a new sha; what the merge
  // guarantee is that both changes' files landed and both pins were deleted with them.
  assert.ok(fs.existsSync(path.join(root, "queued.txt")), "the queued change's file is on main");
  assert.ok(fs.existsSync(path.join(root, "pinned.txt")), "the pinned change's file is on main");
  assert.equal(await refSha(root, mergeRefName("improve")).catch(() => null), null, "the queued change's pin was deleted with its merge");
  assert.equal(await refSha(root, mergeRefName("dedupe")).catch(() => null), null, "the pin-only change's pin was deleted with its merge");
  assert.equal(queueDepth(root), 0, "no queue file remains");
});
